/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var stower = require('../index.js');

describe('stower: ttl', function () {

    var filepath = path.resolve('./cache/ttlstorage.json');

    beforeEach(function () {
        var dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        stower.persist(filepath);
        stower.clear();
    });

    afterEach(function () {
        stower.clear();
        try {
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            if (fs.existsSync(filepath + '.tmp')) fs.unlinkSync(filepath + '.tmp');
            if (fs.existsSync(filepath + '.lock')) fs.unlinkSync(filepath + '.lock');
            var dir = path.dirname(filepath);
            if (fs.existsSync(dir)) fs.rmdirSync(dir);
        }
        catch (e) {
            // ignore cleanup errors
        }
    });

    it('should return value before TTL expires', function () {
        stower.set('temp', { status: 'active' }, 500);

        var result = stower.get('temp');
        expect(result).not.toBeNull();
        expect(result.status).toBe('active');
    });

    it('should return null after TTL expires', async function () {
        stower.set('temp', { status: 'active' }, 100);

        await wait(200);

        var result = stower.get('temp');
        expect(result).toBeNull();
    });

    it('should return false from exists() after TTL expires', async function () {
        stower.set('temp', { status: 'active' }, 100);

        expect(stower.exists('temp')).toBe(true);

        await wait(200);

        expect(stower.exists('temp')).toBe(false);
    });

    it('should exclude expired keys from keys()', async function () {
        stower.set('short', { a: 1 }, 100);
        stower.set('long', { b: 2 }, 5000);

        await wait(200);

        var result = stower.keys();
        expect(result).not.toContain('short');
        expect(result).toContain('long');
    });

    it('should exclude expired values from values()', async function () {
        stower.set('short', { a: 1 }, 100);
        stower.set('long', { b: 2 }, 5000);

        await wait(200);

        var result = stower.values();
        expect(result).not.toContain(jasmine.objectContaining({ a: 1 }));
        expect(result).toContain(jasmine.objectContaining({ b: 2 }));
    });

    it('should not expire a key set without TTL', async function () {
        stower.set('permanent', { keep: true });

        await wait(200);

        var result = stower.get('permanent');
        expect(result).not.toBeNull();
        expect(result.keep).toBe(true);
    });

    it('should clear previous TTL when key is re-set without one', async function () {
        stower.set('temp', { v: 1 }, 100);

        // re-set the same key without a TTL
        stower.set('temp', { v: 2 });

        await wait(200);

        // value should still be accessible because TTL was cleared
        var result = stower.get('temp');
        expect(result).not.toBeNull();
        expect(result.v).toBe(2);
    });

    it('should persist TTL to disk so other processes see expiry', async function () {
        stower.set('shared', { data: 'hello' }, 100);

        // flush to disk immediately
        stower.clear = stower.clear; // no-op, just for clarity
        // force write to disk
        await wait(1500);

        // verify TTL was written to the file
        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content['__expiry__']).toBeDefined();
        expect(content['__expiry__']['shared']).toBeDefined();

        // re-load from disk (simulates another container reading the file)
        stower.persist(filepath);

        await wait(200);

        // key should now be expired even after reload
        var result = stower.get('shared');
        expect(result).toBeNull();
    });
});

/**
 * Wait helper
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>} resolves when timer met
 */
function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}
