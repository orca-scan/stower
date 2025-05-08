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
 * Persist to disk
 * @param {string} [filename] - optional path to json file
 * @returns {void}
 */
function persist(filename) {

    // use OS temp path if no filename provided
    filename = filename || path.join(getCachePath('stow'), 'stow.json');

    if (path.extname(filename) !== '.json') filename += '.json';

    _FILE = path.resolve(filename);
    _TEMP = _FILE + '.tmp';
    _LOCK = _FILE + '.lock';
    _BACKUP = _FILE + '.corrupt';

    try {
        _store = JSON.parse(fs.readFileSync(_FILE, 'utf8'));
        log('loaded', Object.keys(_store).length, 'items');
    }
    catch (e) {
        if (fs.existsSync(_FILE)) fs.renameSync(_FILE, _BACKUP);
        _store = Object.create(null);
        log('failed to load, backup created');
    }
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
 * @param {Function} cb - cllback on lock
 * @param {number} attempt - retry count
 * @returns {void} - qcquires file lock or retries
 */
function lock(cb, attempt) {
    attempt = attempt || 0;
    try {
        var fd = fs.openSync(_LOCK, 'wx');
        fs.closeSync(fd);
        cb();
    }
    catch (e) {
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
 * @returns {void} - deletes lock file if present
 */
function unlock() {
    try {
        fs.unlinkSync(_LOCK);
    }
    catch (e) {
        log('unlock failed', e);
    }
}

/**
 * Write to disk with lock
 * @param {Function} done - callback after write
 * @returns {void} - saves current store to disk
 */
function write(done) {
    if (!_FILE) return;
    lock(function () {
        try {
            var json = JSON.stringify(_store, null, 2);
            fs.writeFileSync(_TEMP, json);
            fs.renameSync(_TEMP, _FILE);
            log('saved', Object.keys(_store).length, 'items');
        }
        catch (e) {
            log('write failed', e);
        }
        unlock();
        if (done) done();
    });
}

/**
 * Schedule save
 * @returns {void} - defers disk write by timeout
 */
function save() {
    clearTimeout(_timer);
    _timer = setTimeout(write, 1000);
}

/**
 * Flush to disk immediately
 * @returns {void} - writes store to disk right away
 */
function flush() {
    clearTimeout(_timer);
    write();
}

/**
 * Set item
 * @param {string} name - Key name
 * @param {Object} value - Value to store
 * @returns {void} - Stores key and schedules save
 */
function set(name, value) {
    if (!name || !value) return;
    _store[key(name)] = value;
    save();
}

/**
 * Get item
 * @param {string} name - Key name
 * @returns {Object|null} - Stored value or null
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
 * @returns {boolean} - True if key exists or matches
 */
function exists(name, obj) {
    var val = _store[key(name)];
    if (!val) return false;
    if (!obj) return true;
    return deepEqual(val, obj);
}

/**
 * Return all values
 * @returns {Array} - Array of all stored values
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
 * @returns {Array} - Array of all stored keys
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
        var params = ['[stow] '].concat(args);
        console.log.apply(console, params);
    }
}

/**
 * Get a safe writable cache directory for a module
 * @param {string} moduleName - Name of the module to use as the cache folder
 * @returns {string} - Absolute path to the cache directory
 */
function getCachePath(moduleName) {
    var base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
    var dir = path.join(base, moduleName);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
    return dir;
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
