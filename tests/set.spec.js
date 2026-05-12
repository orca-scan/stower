/* eslint-disable import/extensions */
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: set', function () {
    var filepath = utils.storeFile('set-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('stores values and normalizes keys to lowercase + trimmed form', function () {
        stower.set('  MyKey  ', { v: 1 });

        expect(stower.get('mykey')).toEqual({ v: 1 });
        expect(stower.get('MYKEY')).toEqual({ v: 1 });
    });

    it('ignores writes with missing key or missing value', function () {
        stower.set(null, { v: 1 });
        stower.set('missing-value', undefined);
        stower.set('', { v: 2 });

        expect(stower.keys()).toEqual([]);
    });

    it('rejects the reserved __expires__ key', function () {
        stower.set('__expires__', { hacked: true });
        expect(stower.get('__expires__')).toBeNull();
        expect(stower.keys()).toEqual([]);
    });

    it('persists only the last value when key is set repeatedly before flush', async function () {
        stower.set('rapid', { v: 1 });
        stower.set('rapid', { v: 2 });
        stower.set('rapid', { v: 3 });

        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.rapid).toEqual({ v: 3 });
    });

    it('stores and persists TTL metadata when expiresInSeconds is positive', async function () {
        stower.set('ttl-key', { v: 1 }, 60);

        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content['ttl-key']).toEqual({ v: 1 });
        expect(content.__expires__).toBeDefined();
        expect(content.__expires__['ttl-key']).toBeDefined();
    });

    it('clears existing TTL metadata when key is set again without TTL', async function () {
        stower.set('renew', { v: 1 }, 60);
        await utils.wait(1500);

        stower.set('renew', { v: 2 });
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.renew).toEqual({ v: 2 });
        expect(content.__expires__ && content.__expires__.renew).toBeUndefined();
    });
});