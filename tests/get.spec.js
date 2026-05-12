/* eslint-disable import/extensions */
var fs = require('fs');
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: get', function () {
    var filepath = utils.storeFile('get-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('returns null for a key that does not exist', function () {
        expect(stower.get('ghost')).toBeNull();
    });

    it('returns stored values with case-insensitive and trimmed key lookup', function () {
        stower.set('  SessionToken  ', { user: 'alice' });

        expect(stower.get('sessiontoken')).toEqual({ user: 'alice' });
        expect(stower.get('SESSIONTOKEN')).toEqual({ user: 'alice' });
    });

    it('returns null for invalid keys', function () {
        expect(stower.get('')).toBeNull();
        expect(stower.get('   ')).toBeNull();
        expect(stower.get(null)).toBeNull();
        expect(stower.get(undefined)).toBeNull();
    });

    it('returns null after TTL expires', async function () {
        stower.set('brief', { v: 1 }, 1);

        await utils.wait(1500);

        expect(stower.get('brief')).toBeNull();
    });

    it('loads fresh values when another process changes the file', async function () {
        stower.set('mine', { v: 1 });
        await utils.wait(1500);

        var external = {
            mine: { v: 1 },
            other: { v: 99 }
        };

        fs.writeFileSync(filepath, JSON.stringify(external, null, 2));

        expect(stower.get('other')).toEqual({ v: 99 });
    });
});