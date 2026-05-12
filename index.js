/* eslint-disable no-console */
/* eslint-disable prefer-rest-params */

/*
 * stower — a simple persistent key/value store backed by a JSON file.
 *
 * How it works:
 *  1. Call persist(filename) once at startup to point the store at a JSON file.
 *     The file and its parent directory are created automatically if missing.
 *  2. Use set/get/remove/exists/keys/values/clear for day-to-day access.
 *  3. Reads (get, exists, keys, values) call load() first, which re-reads the
 *     file from disk only when its mtime has changed — cheap for the common case.
 *  4. Writes are debounced: set/remove/clear schedule a 1 s timer; the timer
 *     fires write(), which acquires a lock, merges dirty keys onto the current
 *     disk state, and commits atomically (write-to-temp → rename).
 *  5. On process exit / SIGINT / SIGTERM the pending timer is cancelled and
 *     write() is called synchronously so no data is lost.
 *
 * Multi-process safety:
 *  - proper-lockfile provides cross-process mutual exclusion during writes.
 *  - Each process tracks its own "dirty" keys and re-applies them on top of
 *    any freshly loaded disk state, so a concurrent write from another process
 *    never clobbers pending in-memory changes.
 *
 * TTL / expiry:
 *  - set(key, value, expiresInSeconds) stores an expiry timestamp alongside the
 *    value. Expired keys are invisible to reads and are pruned from disk on the
 *    next write. Re-setting a key without a TTL clears any existing expiry.
 *
 * Constraints:
 *  - Keys are normalised to trimmed lowercase — 'FOO' and 'foo' are the same key.
 *  - null / undefined values are silently ignored by set().
 *  - '__expires__' is a reserved key used to persist TTL data; it cannot be set.
 *  - Atomic rename() is POSIX-only — behaviour on Windows is best-effort.
 *  - The 1 s debounce means very recent writes can be lost if the process is
 *    killed with SIGKILL (untrappable) or a hard power-off occurs.
 */

/* ─────────────────────────────────────────────
   Dependencies
───────────────────────────────────────────── */

var fs = require('fs');
var path = require('path');
var os = require('os');
var lockfile = require('proper-lockfile');

/* ─────────────────────────────────────────────
   State
   All module-level variables live here so it's
   easy to see exactly what this module owns.
───────────────────────────────────────────── */

var _FILE = '';             // absolute path to the JSON file on disk
var _TEMP = null;           // per-process temp file used during atomic writes
var _BACKUP = null;         // path to back up a corrupt file before overwriting
var _store = Object.create(null);   // in-memory key/value store
var _expires = Object.create(null); // expiry timestamps (ms), keyed by store key
var _dirty = Object.create(null);   // keys changed by this process since last write
var _clearPending = false;  // true when clear() was called but not yet flushed to disk
var _lastMtime = 0;         // mtime of the file when we last read it (used to detect external writes)
var _timer = null;          // handle for the debounce timer used by save()
var _debuggingEnabled = false;

/* ─────────────────────────────────────────────
   Utilities
   Small, self-contained helpers. Read these
   first to understand the building blocks.
───────────────────────────────────────────── */

/**
 * Normalize key — always trimmed lowercase so 'FOO' and 'foo' are the same key
 * @param {string} rawKey - Raw key
 * @returns {string} - Normalised key
 */
function normalizeKey(rawKey) {
    return String(rawKey || '').trim().toLowerCase();
}

/**
 * Deep compare 2 values
 * @param {*} left - first value
 * @param {*} right - second value
 * @returns {boolean} - true if deeply equal
 */
function deepEqual(left, right) {
    if (left === right) return true;
    if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false;

    var leftKeys = Object.keys(left);
    var rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;

    for (var i = 0; i < leftKeys.length; i++) {
        var prop = leftKeys[i];
        if (!Object.prototype.hasOwnProperty.call(right, prop)) return false;
        if (!deepEqual(left[prop], right[prop])) return false;
    }

    return true;
}

/**
 * Check if a key has passed its expiry time
 * @param {string} normalizedKey - Normalised key
 * @returns {boolean} - True if the key has a TTL that has passed
 */
function isExpired(normalizedKey) {
    return _expires[normalizedKey] !== undefined && Date.now() > _expires[normalizedKey];
}

/**
 * console.log helper — only logs when debug is enabled
 * @param {...*} args - Arguments to pass to console.log
 * @returns {void}
 */
function log() {
    if (_debuggingEnabled) {
        var args = [].slice.call(arguments);
        var params = ['[stower] '].concat(args);
        console.log.apply(console, params);
    }
}

/**
 * Get a safe writable cache directory for a module
 * @param {string} moduleName - Module name
 * @returns {string} - Absolute path to the cache directory for the given module
 */
function getCachePath(moduleName) {
    var base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(base, moduleName);
}

/**
 * Block the event loop for ms milliseconds — used for sync lock retry back-off.
 * Node.js has no synchronous sleep; this busy-wait is intentional and bounded.
 * @param {number} ms - Milliseconds to wait
 * @returns {void}
 */
function sleepSync(ms) {
    var until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
}

/* ─────────────────────────────────────────────
   Public API
   These are the functions callers use day-to-day.
   Each one is intentionally short and focused.
───────────────────────────────────────────── */

/**
 * Store a value. Optionally set a TTL in seconds after which the value is invisible.
 * Re-setting a key without a TTL clears any existing expiry.
 * @param {string} name - Key name
 * @param {*} value - Value to store
 * @param {number} [expiresInSeconds] - Optional TTL in seconds
 * @returns {void}
 */
function set(name, value, expiresInSeconds) {
    if (!name || value === undefined || value === null) return;

    var normalizedKey = normalizeKey(name);

    // __expires__ is reserved for internal TTL storage — block it as a user key
    if (normalizedKey === '__expires__') return;

    _store[normalizedKey] = value;
    _dirty[normalizedKey] = true; // mark as changed so write() merges this key to disk

    if (typeof expiresInSeconds === 'number' && expiresInSeconds > 0) {
        _expires[normalizedKey] = Date.now() + expiresInSeconds * 1000;
    }
    else {
        // re-setting without a TTL clears any existing expiry
        delete _expires[normalizedKey];
    }

    save();
}

/**
 * Retrieve a value. Returns null if the key doesn't exist or has expired.
 * Always reads fresh from disk in case another process updated the file.
 * @param {string} name - Key name
 * @returns {*|null} - The stored value, or null if the key is missing or expired
 */
function get(name) {
    load();
    var normalizedKey = normalizeKey(name);
    if (isExpired(normalizedKey)) return null;
    return Object.prototype.hasOwnProperty.call(_store, normalizedKey) ? _store[normalizedKey] : null;
}

/**
 * Delete a key from the store and schedule a disk update
 * @param {string} name - Key name to remove
 * @returns {void}
 */
function remove(name) {
    var normalizedKey = normalizeKey(name);
    delete _store[normalizedKey];
    delete _expires[normalizedKey];
    _dirty[normalizedKey] = true; // mark as changed so write() removes this key from disk
    save();
}

/**
 * Check if a key exists and optionally if its value matches
 * @param {string} name - Key name
 * @param {*} [expectedValue] - Optional value to match using deep equality
 * @returns {boolean} - True if the key exists and, if expectedValue is provided, deeply equals the stored value
 */
function exists(name, expectedValue) {
    load();
    var normalizedKey = normalizeKey(name);
    if (isExpired(normalizedKey)) return false;
    if (!Object.prototype.hasOwnProperty.call(_store, normalizedKey)) return false;
    if (arguments.length < 2) return true;
    return deepEqual(_store[normalizedKey], expectedValue);
}

/**
 * Return all active (non-expired) keys
 * @returns {string[]} - Array of all non-expired keys
 */
function keys() {
    load();
    return Object.keys(_store).filter(function (storeKey) {
        return !isExpired(storeKey);
    });
}

/**
 * Return all active (non-expired) values
 * @returns {Array<*>} - Array of all non-expired values
 */
function values() {
    load();
    return Object.keys(_store)
        .filter(function (storeKey) { return !isExpired(storeKey); })
        .map(function (storeKey) { return _store[storeKey]; });
}

/**
 * Delete all stored data and schedule a disk update.
 * Note: this clears data across ALL processes sharing this file.
 * @returns {void}
 */
function clear() {
    _store = Object.create(null);
    _expires = Object.create(null);
    _dirty = Object.create(null);
    _clearPending = true; // tell write() to wipe the file rather than merge
    save();
}

/* ─────────────────────────────────────────────
   Disk I/O
   Internal plumbing for reading and writing the
   JSON file safely across multiple processes.
───────────────────────────────────────────── */

/**
 * Load data from disk into _store and _expires during persist().
 * Backs up the file if it contains corrupt JSON.
 * @returns {void}
 */
function loadInitialData() {
    try {
        var json = fs.readFileSync(_FILE, 'utf8');
        var parsed = JSON.parse(json);

        // __expires__ is a reserved key we use to persist TTL data — not a user key
        _expires = parsed.__expires__ || Object.create(null);
        delete parsed.__expires__;
        _store = parsed;

        _lastMtime = fs.statSync(_FILE).mtimeMs;
        log('loaded', Object.keys(_store).length, 'items');
    }
    catch (error) {
        if (error.code === 'EACCES') {
            log('permission denied:', _FILE);
            throw error;
        }

        // back up the corrupt file so we don't permanently lose data
        if (fs.existsSync(_FILE)) {
            try {
                fs.renameSync(_FILE, _BACKUP);
                log('corrupt file backed up:', _BACKUP);
            } catch (renameErr) {
                log('failed to backup corrupt file:', _FILE);
            }
        }

        _store = Object.create(null);
        log('failed to load, backup created');
    }
}

/**
 * Remove orphaned temp files left by processes that crashed mid-write.
 * @param {string} dir - Directory containing the data file
 * @returns {void}
 */
function cleanOrphanedTempFiles(dir) {
    try {
        var dataFileName = path.basename(_FILE);
        var tmpFiles = fs.readdirSync(dir);
        for (var i = 0; i < tmpFiles.length; i++) {
            if (tmpFiles[i].indexOf(dataFileName + '.') === 0 && tmpFiles[i].slice(-4) === '.tmp') {
                try {
                    fs.unlinkSync(path.join(dir, tmpFiles[i]));
                    log('removed orphaned temp file:', tmpFiles[i]);
                } catch (unlinkErr) {
                    log('could not remove orphaned temp file:', tmpFiles[i]);
                }
            }
        }
    } catch (cleanupErr) {
        log('temp file cleanup skipped:', cleanupErr.message);
    }
}

/**
 * Initialize the store: resolve the file path, load any existing data from disk,
 * and clean up orphaned temp files. Call this once at startup.
 *
 * Retries up to 10 times if the directory isn't ready yet (useful for Docker
 * volume mounts that appear slightly after process start).
 *
 * @param {string} [filename] - optional relative or absolute path to json file
 * @returns {void}
 */
function persist(filename) {
    filename = filename || path.join(getCachePath('stower'), 'data.json');

    if (path.extname(filename) !== '.json') filename += '.json';

    _FILE = path.resolve(filename);
    _TEMP = _FILE + '.' + process.pid + '.tmp';
    _BACKUP = _FILE + '.corrupt';

    var dir = path.dirname(_FILE);
    log('persist:', _FILE);

    _store = Object.create(null);
    _expires = Object.create(null);
    _dirty = Object.create(null);
    _clearPending = false;
    _lastMtime = 0;

    for (var attempts = 1; attempts <= 10; attempts++) {
        try {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.accessSync(dir, fs.constants.W_OK);
            break;
        }
        catch (error) {
            if (attempts >= 10) {
                log('failed to create directory:', dir);
                log('error:', error.message);
                throw error;
            }
            log('waiting for path:', dir, '| attempts left:', 10 - attempts);
            sleepSync(300); // blocks the event loop — only reached on Docker volume delays at startup
        }
    }

    loadInitialData();
    cleanOrphanedTempFiles(dir);
}

/**
 * Re-apply dirty keys from this process on top of freshly loaded disk state.
 * Prevents load() from clobbering keys that set() hasn't yet flushed to disk.
 * @param {Object} oldStore - _store snapshot before the disk reload
 * @param {Object} oldExpires - _expires snapshot before the disk reload
 * @returns {void}
 */
function reapplyDirtyKeys(oldStore, oldExpires) {
    var dirtyKeys = Object.keys(_dirty);
    for (var i = 0; i < dirtyKeys.length; i++) {
        var dirtyKey = dirtyKeys[i];
        if (oldStore[dirtyKey] !== undefined) {
            _store[dirtyKey] = oldStore[dirtyKey]; // key was set by this process — keep our version
        }
        else {
            delete _store[dirtyKey]; // key was removed by this process — keep it deleted
        }

        if (oldExpires[dirtyKey] !== undefined) {
            _expires[dirtyKey] = oldExpires[dirtyKey]; // expiry was set by this process — keep our TTL
        }
        else {
            delete _expires[dirtyKey]; // expiry was removed by this process — keep it cleared
        }
    }
}

/**
 * Re-read the file from disk if another process has changed it since we last loaded.
 * Called before every read operation so we always see the latest data.
 *
 * Critically: any keys this process has set but not yet flushed (i.e. dirty keys)
 * are preserved — they are re-applied on top of the freshly loaded disk state so
 * a concurrent write from another process cannot cause pending data to be lost.
 *
 * @returns {void}
 */
function load() {
    if (!_FILE) return;

    try {
        var mtime = fs.statSync(_FILE).mtimeMs;

        // file hasn't changed — nothing to do
        if (mtime === _lastMtime) return;

        // note: there is a small window between statSync and readFileSync where another
        // process could write the file. If the read catches a partial write, JSON.parse
        // will throw and we skip — the next load() call will pick up the correct state.
        var json = fs.readFileSync(_FILE, 'utf8');
        var parsed = JSON.parse(json);

        var oldStore = _store;
        var oldExpires = _expires;

        _expires = parsed.__expires__ || Object.create(null);
        delete parsed.__expires__;
        _store = parsed;

        reapplyDirtyKeys(oldStore, oldExpires);

        _lastMtime = mtime;
        log('reloaded from disk');
    }
    catch (error) {
        // file might not exist yet or is being written — safe to skip
        log('load skipped:', error.message);
    }
}

/**
 * Read and parse the JSON file from disk.
 * Returns an empty object if the file doesn't exist or can't be parsed.
 * @returns {Object} - Parsed store data, or an empty object on failure
 */
function readFromDisk() {
    try {
        var json = fs.readFileSync(_FILE, 'utf8');
        return JSON.parse(json);
    }
    catch (error) {
        return Object.create(null);
    }
}

/**
 * Acquire the file lock, retrying up to 10 times with random back-off.
 * Returns the release function on success, or null if all attempts fail.
 * @returns {Function|null} - Lock release function, or null on failure
 */
function acquireLock() {
    for (var attempts = 1; attempts <= 10; attempts++) {
        try {
            return lockfile.lockSync(_FILE, { stale: 10000 });
        }
        catch (error) {
            if (attempts >= 10) {
                log('could not acquire lock:', error.message);
                return null;
            }
            sleepSync(100 + Math.floor(Math.random() * 100));
        }
    }
    return null;
}

/**
 * Merge this process's dirty changes on top of the current disk state, prune
 * expired entries, and serialise the result to JSON.
 * Pure computation — reads module state but does not mutate it.
 * @returns {{ data: Object, json: string, expires: Object }} - Merged data, its JSON string, and the merged expiry map
 */
function mergeAndSerialize() {
    var data = _clearPending ? Object.create(null) : readFromDisk();

    // apply this process's dirty keys on top of the disk baseline
    var dirtyKeys = Object.keys(_dirty);
    for (var i = 0; i < dirtyKeys.length; i++) {
        var dirtyKey = dirtyKeys[i];
        if (_store[dirtyKey] !== undefined) {
            data[dirtyKey] = _store[dirtyKey]; // key was set — overwrite disk copy
        }
        else {
            delete data[dirtyKey]; // key was removed — delete from disk copy
        }
    }

    // merge expiry timestamps — only touch entries for dirty keys so we
    // don't accidentally overwrite TTLs written by other processes
    var mergedExpires = data.__expires__ || Object.create(null);
    for (var j = 0; j < dirtyKeys.length; j++) {
        var expiryKey = dirtyKeys[j];
        if (_expires[expiryKey] !== undefined) {
            mergedExpires[expiryKey] = _expires[expiryKey];
        }
        else {
            delete mergedExpires[expiryKey];
        }
    }

    // prune expired entries before saving so the file stays clean
    var now = Date.now();
    var expireKeys = Object.keys(mergedExpires);
    for (var m = 0; m < expireKeys.length; m++) {
        if (now > mergedExpires[expireKeys[m]]) {
            delete data[expireKeys[m]];
            delete mergedExpires[expireKeys[m]];
        }
    }

    // inject expiry map as a reserved key (only when there's something to store)
    if (Object.keys(mergedExpires).length > 0) data.__expires__ = mergedExpires;

    return { data: data, json: JSON.stringify(data, null, 2), expires: mergedExpires };
}

/**
 * Atomically write serialised data to disk and sync all in-memory state.
 * This is the single point where module state is updated after a write.
 * @param {Object} data - The merged data object
 * @param {string} json - Serialised form of data (including __expires__ if present)
 * @param {Object} expires - The merged expiry map
 * @returns {void}
 */
function commitToDisk(data, json, expires) {
    // atomic write: write to a temp file then rename over the real file.
    // rename() is atomic on POSIX — readers never see a partial write.
    fs.writeFileSync(_TEMP, json);
    fs.renameSync(_TEMP, _FILE);

    delete data.__expires__;
    _store = data;
    _expires = expires;
    _clearPending = false;
    _lastMtime = fs.statSync(_FILE).mtimeMs;
    _dirty = Object.create(null);

    log('saved', Object.keys(_store).length, 'items');
}

/**
 * Schedule a save — debounced so rapid back-to-back changes only cause one write
 * @returns {void}
 */
function save() {
    clearTimeout(_timer);
    _timer = setTimeout(write, 1000);
}

/**
 * Flush to disk immediately — used on process exit so no data is lost on shutdown
 * @returns {void}
 */
function flush() {
    clearTimeout(_timer);
    write();
}

/**
 * Write to disk safely: acquire lock → merge → commit → release.
 * @returns {void}
 */
function write() {
    if (!_FILE) return;

    // proper-lockfile requires the file to exist before it can lock it
    if (!fs.existsSync(_FILE)) {
        try {
            fs.writeFileSync(_FILE, '{}');
        }
        catch (error) {
            log('could not create file for locking:', error.message);
            return;
        }
    }

    var release = acquireLock();
    if (!release) return;

    try {
        var result = mergeAndSerialize();
        commitToDisk(result.data, result.json, result.expires);
    }
    catch (error) {
        log('write failed:', error.message);
    }

    try {
        release();
    }
    catch (error) {
        log('release failed:', error.message);
    }
}

/* ─────────────────────────────────────────────
   Process Handlers & Export
───────────────────────────────────────────── */

// flush on normal exit
process.on('exit', flush);

// flush and exit on Ctrl-C (SIGINT) and Docker stop (SIGTERM)
process.on('SIGINT', function () { flush(); process.exit(); });
process.on('SIGTERM', function () { flush(); process.exit(); });

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
