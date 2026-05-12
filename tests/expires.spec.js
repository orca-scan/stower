/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var stower = require('../index.js');

describe('stower: expiresInSeconds', function () {

    var filepath = path.resolve('./cache/mystorage.json');

    beforeEach(function () {
        var dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        stower.persist(filepath); // reset singleton state between tests
    });

    afterEach(function () {
        try {
            // remove the data file
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

            // remove any PID temp files left by write()
            var dir = path.dirname(filepath);
            if (fs.existsSync(dir)) {
                var files = fs.readdirSync(dir);
                for (var i = 0; i < files.length; i++) {
                    if (files[i].indexOf('.tmp') !== -1) {
                        fs.unlinkSync(path.join(dir, files[i]));
                    }
                }
            }

            // remove proper-lockfile's .lock directory if it exists
            var lockDir = filepath + '.lock';
            if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });

            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        }
        catch (e) {
            // ignore cleanup errors
        }
    });

    it('should return value before expiry elapses', function () {

        stower.set('session', { user: 'alice' }, 10); // 10 second TTL

        expect(stower.get('session')).toEqual({ user: 'alice' });
        expect(stower.exists('session')).toBe(true);
        expect(stower.keys()).toContain('session');
        expect(stower.values()).toContain(jasmine.objectContaining({ user: 'alice' }));
    });

    it('should hide value after expiry elapses', async function () {

        stower.set('temp', { data: 1 }, 1); // 1 second TTL

        await wait(1500); // wait for expiry

        expect(stower.get('temp')).toBeNull();
        expect(stower.exists('temp')).toBe(false);
        expect(stower.keys()).not.toContain('temp');
        expect(stower.values()).not.toContain(jasmine.objectContaining({ data: 1 }));
    });

    it('should clean expired items from disk on next save', async function () {

        stower.persist(filepath);
        stower.set('expires', { v: 1 }, 1); // 1 second TTL
        stower.set('permanent', { v: 2 });

        await wait(1500); // wait for initial save and expiry

        stower.set('trigger', { v: 3 }); // trigger a new save after expiry

        await wait(1500); // wait for new save to complete

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.expires).toBeUndefined();
        expect(content.permanent).toBeDefined();
    });

    it('should persist expiry data to disk and restore it on load', async function () {

        stower.persist(filepath);
        stower.set('ttlkey', { x: 1 }, 60); // 60 second TTL

        await wait(1500); // wait for async save

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.__expires__.ttlkey).toBeDefined();

        stower.persist(filepath); // reload from disk
        expect(stower.get('ttlkey')).toEqual({ x: 1 });
    });

    it('should clear expiry when key is removed', function () {

        stower.set('gone', { v: 1 }, 10);
        stower.remove('gone');

        expect(stower.get('gone')).toBeNull();
        expect(stower.exists('gone')).toBe(false);
    });

    it('should clear all expiry data when clear is called', function () {

        stower.set('a', { v: 1 }, 10);
        stower.set('b', { v: 2 }, 10);
        stower.clear();

        expect(stower.keys()).toEqual([]);
        expect(stower.values()).toEqual([]);
    });

    it('should remove expiry when key is re-set without expiresInSeconds', async function () {

        stower.set('renew', { v: 1 }, 1); // 1 second TTL

        await wait(1500); // wait for expiry

        stower.set('renew', { v: 2 }); // re-set without expiry

        expect(stower.get('renew')).toEqual({ v: 2 });
        expect(stower.exists('renew')).toBe(true);
    });

    // --- __expires__ reserved key collision ---

    it('should silently reject __expires__ as a key to protect internal TTL storage', function () {
        stower.set('__expires__', { bad: true });
        expect(stower.get('__expires__')).toBeNull();

        // a real TTL key should still work correctly
        stower.set('realkey', { v: 1 }, 60);
        expect(stower.get('realkey')).toEqual({ v: 1 });
    });

    // --- TTL edge cases ---

    it('should store value without expiry when TTL is 0', function () {
        stower.set('zero-ttl', { v: 1 }, 0);
        expect(stower.get('zero-ttl')).toEqual({ v: 1 });
        expect(stower.exists('zero-ttl')).toBe(true);
    });

    it('should store value without expiry when TTL is negative', function () {
        stower.set('neg-ttl', { v: 1 }, -5);
        expect(stower.get('neg-ttl')).toEqual({ v: 1 });
        expect(stower.exists('neg-ttl')).toBe(true);
    });

    it('should extend expiry when key is re-set with a longer TTL', function () {
        stower.set('extend', { v: 1 }, 5);
        stower.set('extend', { v: 2 }, 60);
        expect(stower.get('extend')).toEqual({ v: 2 });
        expect(stower.exists('extend')).toBe(true);
    });

    it('should return false from exists() with a matching value after expiry', async function () {
        stower.set('expcheck', { user: 'bob' }, 1);

        await wait(1500);

        expect(stower.exists('expcheck', { user: 'bob' })).toBe(false);
    });

    it('should prune expired key from __expires__ map on disk after next save', async function () {
        stower.persist(filepath);
        stower.set('dying', { v: 1 }, 1); // 1 second TTL

        await wait(1500); // wait for save and expiry

        stower.set('trigger', { v: 2 }); // trigger a save after expiry

        await wait(1500); // wait for new save

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        // __expires__ map should either be absent or not contain the expired key
        expect(content.__expires__ && content.__expires__.dying).toBeUndefined();
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
