/* eslint-disable no-console */
/* eslint-disable prefer-rest-params */

/*
 * stower — a simple persistent key/value store backed by a JSON file.
 *
 * Design overview:
 * - Keep a fast in-memory view for all reads.
 * - Track pending writes as a tiny operation overlay (set/remove per key).
 * - On write: lock file -> read latest disk state -> replay overlay -> atomic commit.
 *
 * This keeps logic easy to reason about and preserves correctness when many
 * processes/containers share one file.
 */

var fs = require('fs');
var path = require('path');
var os = require('os');
var lockfile = require('proper-lockfile');

var DEBOUNCE_MS = 1000;
var STARTUP_RETRIES = 10;
var STARTUP_RETRY_MS = 300;
var LOCK_STALE_MS = 15000;
var LOCK_RETRY_BASE_MS = 80;
var LOCK_RETRY_JITTER_MS = 160;
var LOCK_ATTEMPTS_NORMAL = 100;
var LOCK_ATTEMPTS_FLUSH = 320;
var FLUSH_RETRY_PASSES = 3;

var _FILE = '';
var _TEMP = '';
var _BACKUP = '';

var _store = createMap();
var _expires = createMap();

var _pendingOps = createMap();
var _clearPending = false;

var _lastMtime = 0;
var _timer = null;
var _debuggingEnabled = false;

/**
 * Create a map with no prototype.
 * @returns {Object} empty object map
 */
function createMap() {
    return Object.create(null);
}

/**
 * Clone map-like object.
 * @param {Object} source - Source object
 * @returns {Object} cloned object with null prototype
 */
function cloneMap(source) {
    var cloned = createMap();
    if (!source || typeof source !== 'object') return cloned;

    var sourceKeys = Object.keys(source);
    for (var i = 0; i < sourceKeys.length; i++) {
        cloned[sourceKeys[i]] = source[sourceKeys[i]];
    }

    return cloned;
}

/**
 * Normalize key for all operations.
 * @param {string} rawKey - Raw key
 * @returns {string} normalized key
 */
function normalizeKey(rawKey) {
    return String(rawKey || '').trim().toLowerCase();
}

/**
 * True when map has own key.
 * @param {Object} map - Map
 * @param {string} key - Key
 * @returns {boolean} whether key exists on map
 */
function hasOwn(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * Check if key is expired according to in-memory expiry map.
 * @param {string} key - Normalized key
 * @returns {boolean} true when key has expired
 */
function isExpired(key) {
    return _expires[key] !== undefined && Date.now() > _expires[key];
}

/**
 * Debug logger.
 * @returns {void}
 */
function log() {
    if (!_debuggingEnabled) return;

    var args = [].slice.call(arguments);
    console.log('[stower]', ...args);
}

/**
 * Returns cache path for module.
 * @param {string} moduleName - Name of module
 * @returns {string} cache directory path
 */
function getCachePath(moduleName) {
    var base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(base, moduleName);
}

/**
 * Sync sleep via short busy wait.
 * @param {number} ms - Milliseconds to pause
 * @returns {void}
 */
function sleepSync(ms) {
    var until = Date.now() + ms;
    while (Date.now() < until) { /* intentional spin */ }
}

/**
 * Normalize parsed expiry metadata.
 * @param {*} rawExpires - Untrusted expires map from disk
 * @returns {Object} clean expires map
 */
function normalizeExpires(rawExpires) {
    var clean = createMap();

    if (!rawExpires || typeof rawExpires !== 'object' || Array.isArray(rawExpires)) {
        return clean;
    }

    var expireKeys = Object.keys(rawExpires);
    for (var i = 0; i < expireKeys.length; i++) {
        var value = rawExpires[expireKeys[i]];
        if (typeof value === 'number' && isFinite(value)) {
            clean[expireKeys[i]] = value;
        }
    }

    return clean;
}

/**
 * Parse store JSON string into maps.
 * @param {string} json - Raw file JSON
 * @returns {{ store: Object, expires: Object }} parsed snapshot
 */
function parseStoreJson(json) {
    var parsed = JSON.parse(json);
    var root = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : createMap();

    var store = cloneMap(root);
    var expires = normalizeExpires(store.__expires__);
    delete store.__expires__;

    return {
        store: store,
        expires: expires
    };
}

/**
 * Read and parse current on-disk snapshot.
 * @returns {{ store: Object, expires: Object, mtime: number }} parsed snapshot and mtime
 */
function readDiskSnapshot() {
    var raw = fs.readFileSync(_FILE, 'utf8');
    var parsed = parseStoreJson(raw);

    return {
        store: parsed.store,
        expires: parsed.expires,
        mtime: fs.statSync(_FILE).mtimeMs
    };
}

/**
 * Ensure storage directory exists and is writable.
 * @param {string} dir - Target directory
 * @returns {void}
 */
function ensureWritableDir(dir) {
    for (var attempt = 1; attempt <= STARTUP_RETRIES; attempt++) {
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
            return;
        }
        catch (error) {
            if (attempt >= STARTUP_RETRIES) throw error;
            sleepSync(STARTUP_RETRY_MS);
        }
    }
}

/**
 * Remove orphaned temp files from previous crashed writers.
 * @param {string} dir - Directory to scan
 * @returns {void}
 */
function cleanOrphanedTempFiles(dir) {
    try {
        var dataName = path.basename(_FILE);
        var files = fs.readdirSync(dir);

        for (var i = 0; i < files.length; i++) {
            if (files[i].indexOf(dataName + '.') === 0 && files[i].slice(-4) === '.tmp') {
                try {
                    fs.unlinkSync(path.join(dir, files[i]));
                }
                catch (unlinkError) {
                    /* ignore orphan cleanup failures */
                }
            }
        }
    }
    catch (error) {
        log('temp cleanup skipped:', error.message);
    }
}

/**
 * Persist current in-memory key in pending op map as a set operation.
 * @param {string} key - Normalized key
 * @returns {void}
 */
function trackSet(key) {
    var op = {
        type: 'set',
        value: _store[key]
    };

    if (_expires[key] !== undefined) {
        op.expiresAt = _expires[key];
    }

    _pendingOps[key] = op;
}

/**
 * Persist remove operation into pending op map.
 * @param {string} key - Normalized key
 * @returns {void}
 */
function trackRemove(key) {
    _pendingOps[key] = { type: 'remove' };
}

/**
 * True when there is unsaved work.
 * @returns {boolean} true if pending ops exist or clear is pending
 */
function hasPendingChanges() {
    return _clearPending || Object.keys(_pendingOps).length > 0;
}

/**
 * Replay pending ops over provided baseline snapshot.
 * @param {Object} baseStore - Baseline store data
 * @param {Object} baseExpires - Baseline expires data
 * @returns {{ store: Object, expires: Object }} merged state
 */
function overlayPending(baseStore, baseExpires) {
    var mergedStore = _clearPending ? createMap() : cloneMap(baseStore);
    var mergedExpires = _clearPending ? createMap() : cloneMap(baseExpires);

    var opKeys = Object.keys(_pendingOps);
    for (var i = 0; i < opKeys.length; i++) {
        var key = opKeys[i];
        var op = _pendingOps[key];

        if (op.type === 'set') {
            mergedStore[key] = op.value;
            if (op.expiresAt !== undefined) {
                mergedExpires[key] = op.expiresAt;
            }
            else {
                delete mergedExpires[key];
            }
        }
        else {
            delete mergedStore[key];
            delete mergedExpires[key];
        }
    }

    return {
        store: mergedStore,
        expires: mergedExpires
    };
}

/**
 * Remove expired keys from merged snapshot before commit.
 * @param {Object} store - Store map
 * @param {Object} expires - Expiry map
 * @returns {void}
 */
function pruneExpired(store, expires) {
    var now = Date.now();
    var expireKeys = Object.keys(expires);

    for (var i = 0; i < expireKeys.length; i++) {
        if (now > expires[expireKeys[i]]) {
            delete store[expireKeys[i]];
            delete expires[expireKeys[i]];
        }
    }
}

/**
 * Reset state after a successful write commit.
 * @param {Object} store - Store map post-commit
 * @param {Object} expires - Expiry map post-commit
 * @returns {void}
 */
function finalizeCommit(store, expires) {
    _store = store;
    _expires = expires;
    _pendingOps = createMap();
    _clearPending = false;
    _lastMtime = fs.statSync(_FILE).mtimeMs;
}

/**
 * Acquire lock with retry/jitter strategy.
 * @param {number} maxAttempts - Retry attempts
 * @returns {Function|null} release callback or null
 */
function acquireLock(maxAttempts) {
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return lockfile.lockSync(_FILE, { stale: LOCK_STALE_MS });
        }
        catch (error) {
            if (attempt >= maxAttempts) return null;
            sleepSync(LOCK_RETRY_BASE_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
        }
    }

    return null;
}

/**
 * Rebuild in-memory view from disk snapshot while preserving pending ops.
 * @param {{ store: Object, expires: Object, mtime: number }} snapshot - Disk snapshot
 * @returns {void}
 */
function applyLoadedSnapshot(snapshot) {
    var merged = overlayPending(snapshot.store, snapshot.expires);
    _store = merged.store;
    _expires = merged.expires;
    _lastMtime = snapshot.mtime;
}

/**
 * Load initial disk state during persist(), backing up corrupt JSON files.
 * @returns {void}
 */
function loadInitialData() {
    if (!fs.existsSync(_FILE)) {
        _store = overlayPending(createMap(), createMap()).store;
        _expires = overlayPending(createMap(), createMap()).expires;
        _lastMtime = 0;
        return;
    }

    try {
        applyLoadedSnapshot(readDiskSnapshot());
    }
    catch (error) {
        if (error.code === 'EACCES') throw error;

        try {
            fs.renameSync(_FILE, _BACKUP);
            log('corrupt file backed up:', _BACKUP);
        }
        catch (renameError) {
            /* ignore backup failures */
        }

        _store = overlayPending(createMap(), createMap()).store;
        _expires = overlayPending(createMap(), createMap()).expires;
        _lastMtime = 0;
    }
}

/**
 * Schedule a debounced save.
 * @returns {void}
 */
function save() {
    clearTimeout(_timer);
    if (!_FILE) return;
    _timer = setTimeout(write, DEBOUNCE_MS);
}

/**
 * Flush pending writes immediately.
 * @returns {void}
 */
function flush() {
    clearTimeout(_timer);
    _timer = null;

    for (var pass = 0; pass < FLUSH_RETRY_PASSES; pass++) {
        if (!hasPendingChanges()) return;
        write(true);
    }
}

/**
 * Write to disk safely under lock.
 * @param {boolean} isFlush - true for process-exit flush path
 * @returns {void}
 */
function write(isFlush) {
    if (!_FILE || !hasPendingChanges()) return;

    if (!fs.existsSync(_FILE)) {
        try {
            fs.writeFileSync(_FILE, '{}');
        }
        catch (error) {
            log('could not create file for locking:', error.message);
            if (!isFlush) save();
            return;
        }
    }

    var release = acquireLock(isFlush ? LOCK_ATTEMPTS_FLUSH : LOCK_ATTEMPTS_NORMAL);
    if (!release) {
        log('lock acquisition failed after retries');
        if (!isFlush) save();
        return;
    }

    try {
        var baseline = _clearPending ? { store: createMap(), expires: createMap() } : readDiskSnapshot();
        var merged = overlayPending(baseline.store, baseline.expires);

        pruneExpired(merged.store, merged.expires);

        var persisted = cloneMap(merged.store);
        if (Object.keys(merged.expires).length > 0) {
            persisted.__expires__ = cloneMap(merged.expires);
        }

        fs.writeFileSync(_TEMP, JSON.stringify(persisted, null, 2));
        fs.renameSync(_TEMP, _FILE);

        finalizeCommit(merged.store, merged.expires);
        log('saved', Object.keys(_store).length, 'items');
    }
    catch (error) {
        log('write failed:', error.message);
        if (!isFlush) save();
    }

    try {
        release();
    }
    catch (error) {
        log('release failed:', error.message);
    }
}

/**
 * Refresh in-memory state when disk file changed.
 * @returns {void}
 */
function load() {
    if (!_FILE) return;

    try {
        var mtime = fs.statSync(_FILE).mtimeMs;
        if (mtime === _lastMtime) return;
        applyLoadedSnapshot(readDiskSnapshot());
    }
    catch (error) {
        log('load skipped:', error.message);
    }
}

/**
 * Store value by key.
 * @param {string} name - Key
 * @param {*} value - Value
 * @param {number} expiresInSeconds - Optional TTL in seconds
 * @returns {void}
 */
function set(name, value, expiresInSeconds) {
    if (name === undefined || name === null || value === undefined || value === null) return;

    var key = normalizeKey(name);
    if (!key || key === '__expires__') return;

    _store[key] = value;

    if (typeof expiresInSeconds === 'number' && expiresInSeconds > 0) {
        _expires[key] = Date.now() + (expiresInSeconds * 1000);
    }
    else {
        delete _expires[key];
    }

    trackSet(key);
    save();
}

/**
 * Get value by key, or null when missing/expired.
 * @param {string} name - Key
 * @returns {*|null} stored value or null
 */
function get(name) {
    load();
    var key = normalizeKey(name);
    if (!key || isExpired(key)) return null;
    return hasOwn(_store, key) ? _store[key] : null;
}

/**
 * Remove key.
 * @param {string} name - Key
 * @returns {void}
 */
function remove(name) {
    var key = normalizeKey(name);
    if (!key || key === '__expires__') return;

    delete _store[key];
    delete _expires[key];

    trackRemove(key);
    save();
}

/**
 * Key existence check (ignores expired keys).
 * @param {string} name - Key
 * @returns {boolean} whether key exists and is active
 */
function exists(name) {
    load();
    var key = normalizeKey(name);
    if (!key || isExpired(key)) return false;
    return hasOwn(_store, key);
}

/**
 * Return non-expired keys.
 * @returns {string[]} keys
 */
function keys() {
    load();
    return Object.keys(_store).filter(function (key) {
        return !isExpired(key);
    });
}

/**
 * Return non-expired values.
 * @returns {Array<*>} values
 */
function values() {
    load();
    return Object.keys(_store)
        .filter(function (key) {
            return !isExpired(key);
        })
        .map(function (key) {
            return _store[key];
        });
}

/**
 * Clear all values.
 * @returns {void}
 */
function clear() {
    _store = createMap();
    _expires = createMap();
    _pendingOps = createMap();
    _clearPending = true;
    save();
}

/**
 * Initialize persistence file.
 * @param {string} filename - Optional path to data file
 * @returns {void}
 */
function persist(filename) {
    filename = filename || path.join(getCachePath('stower'), 'data.json');
    if (path.extname(filename) !== '.json') filename += '.json';

    _FILE = path.resolve(filename);
    _TEMP = _FILE + '.' + process.pid + '.tmp';
    _BACKUP = _FILE + '.corrupt';

    _store = createMap();
    _expires = createMap();
    _pendingOps = createMap();
    _clearPending = false;
    _lastMtime = 0;

    var dir = path.dirname(_FILE);
    ensureWritableDir(dir);
    loadInitialData();
    cleanOrphanedTempFiles(dir);

    log('persist:', _FILE);
}

process.on('exit', flush);
process.on('SIGINT', function () {
    flush();
    process.exit();
});
process.on('SIGTERM', function () {
    flush();
    process.exit();
});

var api = {
    get: get,
    set: set,
    remove: remove,
    exists: exists,
    keys: keys,
    values: values,
    clear: clear,
    persist: persist
};

Object.defineProperty(api, 'debug', {
    get: function () {
        return _debuggingEnabled;
    },
    set: function (value) {
        _debuggingEnabled = (value === true);
    },
    enumerable: true,
    configurable: true
});

Object.defineProperty(api, 'filename', {
    get: function () {
        return _FILE;
    },
    enumerable: true,
    configurable: true
});

module.exports = api;
