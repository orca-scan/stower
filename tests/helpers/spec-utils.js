/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');

/**
 * Build a cache-backed test file path.
 * @param {string} name - Logical test name
 * @returns {string} absolute JSON file path
 */
function storeFile(name) {
    return path.resolve('./cache/' + name + '.json');
}

/**
 * Ensure parent directory for a store file exists.
 * @param {string} filepath - Target store path
 * @returns {void}
 */
function ensureStoreDir(filepath) {
    var dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Remove one store file and lock/temp artifacts.
 * @param {string} filepath - Target store path
 * @returns {void}
 */
function cleanupStoreFile(filepath) {
    var dir = path.dirname(filepath);
    var basename = path.basename(filepath);

    try {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    }
    catch (error) {
        /* ignore cleanup failures */
    }

    try {
        if (fs.existsSync(filepath + '.corrupt')) fs.unlinkSync(filepath + '.corrupt');
    }
    catch (error) {
        /* ignore cleanup failures */
    }

    try {
        if (fs.existsSync(filepath + '.lock')) fs.rmSync(filepath + '.lock', { recursive: true, force: true });
    }
    catch (error) {
        /* ignore cleanup failures */
    }

    try {
        if (fs.existsSync(dir)) {
            var files = fs.readdirSync(dir);
            for (var i = 0; i < files.length; i++) {
                if (files[i].indexOf(basename + '.') === 0 && files[i].slice(-4) === '.tmp') {
                    fs.unlinkSync(path.join(dir, files[i]));
                }
            }

            if (fs.readdirSync(dir).length === 0) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    }
    catch (error) {
        /* ignore cleanup failures */
    }
}

/**
 * Delay helper.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

/**
 * Read and parse a store file.
 * @param {string} filepath - Store file path
 * @returns {Object} parsed JSON
 */
function readStore(filepath) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

module.exports = {
    storeFile: storeFile,
    ensureStoreDir: ensureStoreDir,
    cleanupStoreFile: cleanupStoreFile,
    wait: wait,
    readStore: readStore
};