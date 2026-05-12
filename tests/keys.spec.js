/* eslint-disable import/extensions */
var fs = require('fs');
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: .keys', function () {
    var filepath = utils.storeFile('keys-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('returns normalized keys for non-expired entries', function () {
        stower.set('One', { v: 1 });
        stower.set(' two ', { v: 2 });

        expect(stower.keys().sort()).toEqual(['one', 'two']);
    });

    it('does not return expired keys', async function () {
        stower.set('short', { v: 1 }, 1);
        stower.set('long', { v: 2 }, 60);

        await utils.wait(1500);

        expect(stower.keys()).toEqual(['long']);
    });

    it('refreshes keys after external disk writes', async function () {
        stower.set('mine', { v: 1 });
        await utils.wait(1500);

        fs.writeFileSync(filepath, JSON.stringify({ mine: { v: 1 }, other: { v: 99 } }, null, 2));

        expect(stower.keys().sort()).toEqual(['mine', 'other']);
    });

    it('hides internal __expires__ from public keys', function () {
        fs.writeFileSync(filepath, JSON.stringify({
            alpha: { v: 1 },
            __expires__: { alpha: Date.now() + 10000 }
        }, null, 2));

        stower.persist(filepath);

        expect(stower.keys()).toEqual(['alpha']);
    });

    it('returns an empty array after clear', function () {
        stower.set('a', 1);
        stower.set('b', 2);
        stower.clear();

        expect(stower.keys()).toEqual([]);
    });
});