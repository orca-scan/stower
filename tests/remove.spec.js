/* eslint-disable import/extensions */
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: .remove', function () {
    var filepath = utils.storeFile('remove-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('removes an existing key from in-memory reads immediately', function () {
        stower.set('gone', { v: 1 });
        expect(stower.get('gone')).toEqual({ v: 1 });

        stower.remove('gone');
        expect(stower.get('gone')).toBeNull();
        expect(stower.exists('gone')).toBe(false);
    });

    it('uses normalized key handling for removals', function () {
        stower.set('ToDrop', { v: 1 });

        stower.remove('  todrop  ');
        expect(stower.get('todrop')).toBeNull();
    });

    it('ignores invalid or reserved remove keys safely', function () {
        stower.set('keep', { v: 1 });

        expect(function () {
            stower.remove('__expires__');
            stower.remove('');
            stower.remove(null);
            stower.remove(undefined);
        }).not.toThrow();

        expect(stower.get('keep')).toEqual({ v: 1 });
    });

    it('removes persisted key and expiry metadata from disk', async function () {
        stower.set('ttl-key', { v: 1 }, 60);
        stower.set('keep', { v: 2 });
        await utils.wait(1500);

        stower.remove('ttl-key');
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content['ttl-key']).toBeUndefined();
        expect(content.keep).toEqual({ v: 2 });
        expect(content.__expires__ && content.__expires__['ttl-key']).toBeUndefined();
    });

    it('does not persist a key set then removed within one debounce window', async function () {
        stower.set('ghost', { v: 1 });
        stower.remove('ghost');

        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.ghost).toBeUndefined();
    });
});