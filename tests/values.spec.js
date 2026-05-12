/* eslint-disable import/extensions */
var fs = require('fs');
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: values', function () {
    var filepath = utils.storeFile('values-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('returns all active values', function () {
        stower.set('one', { v: 1 });
        stower.set('two', { v: 2 });

        var vals = stower.values();
        expect(vals).toContain(jasmine.objectContaining({ v: 1 }));
        expect(vals).toContain(jasmine.objectContaining({ v: 2 }));
        expect(vals.length).toBe(2);
    });

    it('keeps falsy values that are valid payloads', function () {
        stower.set('bool-false', false);
        stower.set('zero', 0);
        stower.set('empty-string', '');

        var vals = stower.values();
        expect(vals).toContain(false);
        expect(vals).toContain(0);
        expect(vals).toContain('');
    });

    it('omits values for expired keys', async function () {
        stower.set('short', { v: 1 }, 1);
        stower.set('long', { v: 2 }, 60);

        await utils.wait(1500);

        var vals = stower.values();
        expect(vals).toContain(jasmine.objectContaining({ v: 2 }));
        expect(vals).not.toContain(jasmine.objectContaining({ v: 1 }));
        expect(vals.length).toBe(1);
    });

    it('updates after remove and clear operations', function () {
        stower.set('drop', { v: 1 });
        stower.set('keep', { v: 2 });

        stower.remove('drop');
        expect(stower.values()).toEqual([{ v: 2 }]);

        stower.clear();
        expect(stower.values()).toEqual([]);
    });

    it('refreshes values after external disk writes', async function () {
        stower.set('mine', { src: 'me' });
        await utils.wait(1500);

        fs.writeFileSync(filepath, JSON.stringify({ mine: { src: 'me' }, other: { src: 'disk' } }, null, 2));

        var vals = stower.values();
        expect(vals).toContain(jasmine.objectContaining({ src: 'disk' }));
    });
});
