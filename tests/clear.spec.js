/* eslint-disable import/extensions */
var fs = require('fs');
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: clear', function () {
    var filepath = utils.storeFile('clear-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('clears all in-memory data immediately', function () {
        stower.set('a', { v: 1 });
        stower.set('b', { v: 2 }, 60);

        stower.clear();

        expect(stower.keys()).toEqual([]);
        expect(stower.values()).toEqual([]);
        expect(stower.get('a')).toBeNull();
        expect(stower.exists('b')).toBe(false);
    });

    it('persists empty state and removes expiry metadata from disk', async function () {
        stower.set('a', { v: 1 }, 60);
        stower.set('b', { v: 2 });
        await utils.wait(1500);

        stower.clear();
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content).toEqual({});
        expect(content.__expires__).toBeUndefined();
    });

    it('clears keys that were already present on disk', async function () {
        fs.writeFileSync(filepath, JSON.stringify({ diskkey: { v: 1 } }, null, 2));

        stower.persist(filepath);
        expect(stower.get('diskkey')).toEqual({ v: 1 });

        stower.clear();
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content).toEqual({});
    });

    it('writes only new keys after clear then set within the debounce window', async function () {
        stower.set('old', { v: 1 });
        stower.clear();
        stower.set('new', { v: 2 });

        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.old).toBeUndefined();
        expect(content.new).toEqual({ v: 2 });
    });
});