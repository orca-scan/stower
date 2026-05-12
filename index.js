/* eslint-disable no-console */
/* eslint-disable prefer-rest-params */

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
 * @param {string} str - Raw key
 * @returns {string} - Normalised key
 */
function key(str) {
    return String(str || '').trim().toLowerCase();
}

/**
 * Deep compare 2 values
 * @param {*} a - first value
 * @param {*} b - second value
 * @returns {boolean} - true if deeply equal
 */
function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;

    var aKeys = Object.keys(a);
    var bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;

    for (var i = 0; i < aKeys.length; i++) {
        var k = aKeys[i];
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!deepEqual(a[k], b[k])) return false;
    }

    return true;
}

/**
 * Check if a key has passed its expiry time
 * @param {string} k - Normalised key
 * @returns {boolean} - True if the key has a TTL that has passed
 */
function isExpired(k) {
    return _expires[k] !== undefined && Date.now() > _expires[k];
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

    var k = key(name);

    // __expires__ is reserved for internal TTL storage — block it as a user key
    if (k === '__expires__') return;

    _store[k] = value;
    _dirty[k] = true; // mark as changed so write() merges this key to disk

    if (typeof expiresInSeconds === 'number' && expiresInSeconds > 0) {
        _expires[k] = Date.now() + expiresInSeconds * 1000;
    }
    else {
        // re-setting without a TTL clears any existing expiry
        delete _expires[k];
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
    var k = key(name);
    if (isExpired(k)) return null;
    return Object.prototype.hasOwnProperty.call(_store, k) ? _store[k] : null;
}

/**
 * Delete a key from the store and schedule a disk update
 * @param {string} name - Key name to remove
 * @returns {void}
 */
function remove(name) {
    var k = key(name);
    delete _store[k];
    delete _expires[k];
    _dirty[k] = true; // mark as changed so write() removes this key from disk
    save();
}

/**
 * Check if a key exists and optionally if its value matches
 * @param {string} name - Key name
 * @param {*} [obj] - Optional value to match using deep equality
 * @returns {boolean} - True if the key exists and, if obj is provided, deeply equals the stored value
 */
function exists(name, obj) {
    load();
    var k = key(name);
    if (isExpired(k)) return false;
    if (!Object.prototype.hasOwnProperty.call(_store, k)) return false;
    if (arguments.length < 2) return true;
    return deepEqual(_store[k], obj);
}

/**
 * Return all active (non-expired) keys
 * @returns {string[]} - Array of all non-expired keys
 */
function keys() {
    load();
    return Object.keys(_store).filter(function (k) {
        return !isExpired(k);
    });
}

/**
 * Return all active (non-expired) values
 * @returns {Array<*>} - Array of all non-expired values
 */
function values() {
    load();
    var out = [];
    var keysInStore = Object.keys(_store);
    for (var i = 0; i < keysInStore.length; i++) {
        if (!isExpired(keysInStore[i])) {
            out.push(_store[keysInStore[i]]);
        }
    }
    return out;
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
    // use OS temp path if no filename provided
    filename = filename || path.join(getCachePath('stower'), 'data.json');

    // ensure .json extension
    if (path.extname(filename) !== '.json') filename += '.json';

    // always resolve to absolute path
    _FILE = path.resolve(filename);

    // use a per-process temp file to avoid collisions between concurrent writers
    _TEMP = _FILE + '.' + process.pid + '.tmp';
    _BACKUP = _FILE + '.corrupt';

    var dir = path.dirname(_FILE);
    log('persist:', _FILE);

    // reset state in case persist() is called more than once
    _store = Object.create(null);
    _expires = Object.create(null);
    _dirty = Object.create(null);
    _clearPending = false;
    _lastMtime = 0;

    // retry loop if directory isn't ready (e.g. Docker volume not yet mounted)
    var attempts = 0;
    var maxAttempts = 10;

    function tryInit() {
        attempts++;

        try {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.accessSync(dir, fs.constants.W_OK);
        }
        catch (e) {
            if (attempts < maxAttempts) {
                log('waiting for path:', dir, '| attempts left:', maxAttempts - attempts);
                return setTimeout(tryInit, 300);
            }
            log('failed to create directory:', dir);
            log('error:', e.message);
            throw e;
        }

        // load existing data from disk
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
        catch (e) {
            if (e.code === 'EACCES') {
                log('permission denied:', _FILE);
                throw e;
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

        // clean up any orphaned temp files from processes that crashed mid-write
        try {
            var base = path.basename(_FILE);
            var tmpFiles = fs.readdirSync(dir);
            for (var ti = 0; ti < tmpFiles.length; ti++) {
                if (tmpFiles[ti].indexOf(base + '.') === 0 && tmpFiles[ti].slice(-4) === '.tmp') {
                    try {
                        fs.unlinkSync(path.join(dir, tmpFiles[ti]));
                        log('removed orphaned temp file:', tmpFiles[ti]);
                    } catch (unlinkErr) {
                        log('could not remove orphaned temp file:', tmpFiles[ti]);
                    }
                }
            }
        } catch (cleanupErr) {
            log('temp file cleanup skipped:', cleanupErr.message);
        }
    }

    tryInit();
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

        // save this process's pending (dirty) state before we overwrite _store/_expires
        var oldStore = _store;
        var oldExpires = _expires;

        // replace in-memory state with what's on disk
        _expires = parsed.__expires__ || Object.create(null);
        delete parsed.__expires__;
        _store = parsed;

        // re-apply dirty keys so pending writes from this process are not lost.
        // without this, a get() triggered by another process's write would cause
        // load() to clobber keys that set() hasn't yet flushed to disk.
        var dirtyKeys = Object.keys(_dirty);
        for (var i = 0; i < dirtyKeys.length; i++) {
            var k = dirtyKeys[i];
            if (oldStore[k] !== undefined) {
                // key was set by this process — keep our version
                _store[k] = oldStore[k];
            }
            else {
                // key was removed by this process — keep it deleted
                delete _store[k];
            }

            if (oldExpires[k] !== undefined) {
                // expiry was set by this process — keep our TTL
                _expires[k] = oldExpires[k];
            }
            else {
                // expiry was removed by this process — keep it cleared
                delete _expires[k];
            }
        }

        _lastMtime = mtime;
        log('reloaded from disk');
    } catch (e) {
        // file might not exist yet or is being written — safe to skip
        log('load skipped:', e.message);
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
    catch (e) {
        return Object.create(null);
    }
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
 * Write to disk safely.
 *
 * Steps:
 *   1. Acquire a file lock so only one process writes at a time
 *   2. Read the latest disk state
 *   3. Merge this process's dirty keys on top (set overwrites, remove deletes)
 *   4. Merge expiry timestamps for dirty keys
 *   5. Prune any expired entries
 *   6. Write to a temp file then atomically rename it over the real file
 *   7. Release the lock
 *
 * @param {Function} [done] - optional callback after write completes
 * @returns {void}
 */
function write(done) {
    if (!_FILE) return;

    // proper-lockfile requires the file to exist before it can lock it
    if (!fs.existsSync(_FILE)) {
        try {
            fs.writeFileSync(_FILE, '{}');
        }
        catch (e) {
            log('could not create file for locking:', e.message);
            if (done) done();
            return;
        }
    }

    // acquire lock — retry up to 10 times with a short random back-off.
    // write() must be synchronous because flush() is called on process exit
    // where async callbacks won't run. The 1s debounce means contention is rare.
    var release;
    try {
        var attempts = 0;
        while (attempts < 10) {
            try {
                release = lockfile.lockSync(_FILE, { stale: 10000 });
                break;
            }
            catch (lockErr) {
                attempts++;
                if (attempts >= 10) throw lockErr;
                var until = Date.now() + 100 + Math.floor(Math.random() * 100);
                while (Date.now() < until) { /* spin */ }
            }
        }
    }
    catch (e) {
        log('could not acquire lock:', e.message);
        if (done) done();
        return;
    }

    try {
        var data;

        if (_clearPending) {
            // clear() was called — start from an empty slate rather than merging
            data = Object.create(null);
            _clearPending = false;
        }
        else {
            // read latest disk state so we can merge into it without losing
            // keys written by other processes since we last read
            data = readFromDisk();
        }

        // apply this process's dirty keys on top of the disk baseline
        var dirtyKeys = Object.keys(_dirty);
        for (var i = 0; i < dirtyKeys.length; i++) {
            var k = dirtyKeys[i];
            if (_store[k] !== undefined) {
                data[k] = _store[k]; // key was set — overwrite disk copy
            }
            else {
                delete data[k]; // key was removed — delete from disk copy
            }
        }

        // merge expiry timestamps — only touch entries for dirty keys so we
        // don't accidentally overwrite TTLs written by other processes
        var diskExpires = data.__expires__ || Object.create(null);
        for (var j = 0; j < dirtyKeys.length; j++) {
            var ek = dirtyKeys[j];
            if (_expires[ek] !== undefined) {
                diskExpires[ek] = _expires[ek];
            }
            else {
                delete diskExpires[ek];
            }
        }
        _expires = diskExpires;

        // prune expired entries before saving so the file stays clean
        var now = Date.now();
        var expireKeys = Object.keys(_expires);
        for (var m = 0; m < expireKeys.length; m++) {
            if (now > _expires[expireKeys[m]]) {
                delete data[expireKeys[m]];
                delete _expires[expireKeys[m]];
            }
        }

        // inject expiry map as a reserved key (only when there's something to store)
        if (Object.keys(_expires).length > 0) data.__expires__ = _expires;

        // atomic write: write to a temp file then rename over the real file.
        // rename() is atomic on POSIX — readers never see a partial write.
        var json = JSON.stringify(data, null, 2);
        fs.writeFileSync(_TEMP, json);
        fs.renameSync(_TEMP, _FILE);

        // sync in-memory state with what we just wrote
        delete data.__expires__;
        _store = data;
        _lastMtime = fs.statSync(_FILE).mtimeMs;
        _dirty = Object.create(null);

        log('saved', Object.keys(_store).length, 'items');
    }
    catch (e) {
        log('write failed:', e.message);
    }

    try {
        release();
    }
    catch (e) {
        log('release failed:', e.message);
    }

    if (done) done();
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
    get: function () { return _debuggingEnabled; },
    set: function (value) { _debuggingEnabled = (value === true); },
    enumerable: true,
    configurable: true
});

Object.defineProperty(api, 'filename', {
    get: function () { return _FILE; },
    enumerable: true,
    configurable: true
});

module.exports = api;
