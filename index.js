/* eslint-disable no-console */
/* eslint-disable prefer-rest-params */

var fs = require('fs');
var path = require('path');
var os = require('os');

var _FILE = '';
var _TEMP = null;
var _LOCK = null;
var _BACKUP = null;
var _store = Object.create(null);
var _timer = null;
var _debuggingEnabled = false;

/**
 * Persist to disk with retry if path is not yet writable
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
    _TEMP = _FILE + '.tmp';
    _LOCK = _FILE + '.lock';
    _BACKUP = _FILE + '.corrupt';

    var dir = path.dirname(_FILE);
    log('persist:', _FILE);

    // retry loop if directory isn't ready
    var attempts = 0;
    var maxAttempts = 10;

    function tryInit() {
        attempts++;

        try {
            // ensure directory exists
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // test write permission
            fs.accessSync(dir, fs.constants.W_OK);
        } catch (e) {
            if (attempts < maxAttempts) {
                log('waiting for path:', dir, '| attempts left:', maxAttempts - attempts);
                return setTimeout(tryInit, 300);
            }

            log('failed to create directory:', dir);
            log('error:', e.message);
            throw e;
        }

        // remove stale lock file if older than 10s
        if (fs.existsSync(_LOCK)) {
            try {
                var stat = fs.statSync(_LOCK);
                var age = Date.now() - new Date(stat.mtime).getTime();
                if (age > 10000) {
                    fs.unlinkSync(_LOCK);
                    log('removed stale lock file');
                }
            } catch (e) {
                log('failed to check/remove stale lock:', e.message);
            }
        }

        // try loading existing data
        try {
            var json = fs.readFileSync(_FILE, 'utf8');
            _store = JSON.parse(json);
            log('loaded', Object.keys(_store).length, 'items');
        } catch (e) {
            if (e.code === 'EACCES') {
                log('permission denied:', _FILE);
                throw e;
            }

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

    tryInit();
}

/**
 * Normalize key
 * @param {string} str - Raw key
 * @returns {string} - Trimmed lowercase key
 */
function key(str) {
    return String(str || '').trim().toLowerCase();
}

/**
 * Deep compare 2 values
 * @param {Object} a - first value
 * @param {Object} b - second value
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
 * Create lock with retry
 * @param {Function} cb - callback on lock
 * @param {number} attempt - retry count
 * @returns {void}
 */
function lock(cb, attempt) {
    attempt = attempt || 0;

    try {
        var fd = fs.openSync(_LOCK, 'wx');
        fs.closeSync(fd);
        cb();
    }
    catch (e) {
        if (e.code === 'EEXIST') {
            try {
                var stat = fs.statSync(_LOCK);
                var ageMs = Date.now() - new Date(stat.mtime).getTime();

                if (ageMs > 10000) {
                    fs.unlinkSync(_LOCK);
                    log('stale lock removed');
                    return lock(cb, attempt + 1);
                }
            }
            catch (statErr) {
                log('lock stat failed:', statErr.message);
            }
        }

        if (attempt > 10) {
            log('lock failed');
            return;
        }

        setTimeout(function () {
            lock(cb, attempt + 1);
        }, 100 + Math.random() * 100);
    }
}

/**
 * Remove lock file
 * @returns {void}
 */
function unlock() {
    try {
        fs.unlinkSync(_LOCK);
    } catch (e) {
        log('unlock failed', e.message);
    }
}

/**
 * Write to disk with lock
 * @param {Function} done - callback after write
 * @returns {void}
 */
function write(done) {
    if (!_FILE) return;
    lock(function () {
        try {
            var json = JSON.stringify(_store, null, 2);
            fs.writeFileSync(_TEMP, json);
            fs.renameSync(_TEMP, _FILE);
            log('saved', Object.keys(_store).length, 'items');
        } catch (e) {
            log('write failed', e.message);
        }
        unlock();
        if (done) done();
    });
}

/**
 * Schedule save
 * @returns {void}
 */
function save() {
    clearTimeout(_timer);
    _timer = setTimeout(write, 1000);
}

/**
 * Flush to disk immediately
 * @returns {void}
 */
function flush() {
    clearTimeout(_timer);
    write();
}

/**
 * Set item
 * @param {string} name - Key name
 * @param {Object} value - Value to store
 * @returns {void}
 */
function set(name, value) {
    if (!name || !value) return;
    _store[key(name)] = value;
    save();
}

/**
 * Get item
 * @param {string} name - Key name
 * @returns {Object|null}
 */
function get(name) {
    return _store[key(name)] || null;
}

/**
 * Remove item
 * @param {string} name - Key name to remove
 * @returns {void}
 */
function remove(name) {
    delete _store[key(name)];
    save();
}

/**
 * Check If Key Exists Or Matches Value
 * @param {string} name - Key name
 * @param {Object} [obj] - Optional value to match
 * @returns {boolean}
 */
function exists(name, obj) {
    var val = _store[key(name)];
    if (!val) return false;
    if (!obj) return true;
    return deepEqual(val, obj);
}

/**
 * Return all values
 * @returns {Array}
 */
function values() {
    var out = [];
    var keysInStore = Object.keys(_store);
    for (var i = 0; i < keysInStore.length; i++) {
        out.push(_store[keysInStore[i]]);
    }
    return out;
}

/**
 * Return all keys
 * @returns {Array}
 */
function keys() {
    return Object.keys(_store);
}

/**
 * Remove all items
 * @returns {void}
 */
function clear() {
    _store = Object.create(null);
    save();
}

/**
 * console.log helper
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
 * @returns {string}
 */
function getCachePath(moduleName) {
    var base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    return path.join(base, moduleName);
}

process.on('exit', flush);
process.on('SIGINT', function () {
    flush();
    process.exit();
});

/* --- public methods --- */

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

/* --- public properties --- */

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
