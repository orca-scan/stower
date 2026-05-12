/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var stower = require('../index.js');

describe('stower: .exists', function () {

    var filepath = path.resolve('./cache/exists-test.json');

    beforeEach(function () {
        var dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        stower.persist(filepath);
    });

    afterEach(function () {
        try {
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

            var dir = path.dirname(filepath);
            if (fs.existsSync(dir)) {
                var files = fs.readdirSync(dir);
                for (var i = 0; i < files.length; i++) {
                    if (files[i].indexOf('.tmp') !== -1) {
                        fs.unlinkSync(path.join(dir, files[i]));
                    }
                }
            }

            var lockDir = filepath + '.lock';
            if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });

            var corruptPath = filepath + '.corrupt';
            if (fs.existsSync(corruptPath)) fs.unlinkSync(corruptPath);

            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        }
        catch (e) {
            // ignore cleanup errors
        }
    });

    // --- basic presence / absence ---

    it('returns false for a key that was never set', function () {
        expect(stower.exists('ghost')).toBe(false);
    });

    it('returns true for a key that was set', function () {
        stower.set('name', 'alice');
        expect(stower.exists('name')).toBe(true);
    });

    // --- value types ---

    it('returns true for a string value', function () {
        stower.set('str', 'hello');
        expect(stower.exists('str')).toBe(true);
    });

    it('returns true for a numeric value', function () {
        stower.set('num', 42);
        expect(stower.exists('num')).toBe(true);
    });

    it('returns true for a boolean false value', function () {
        // false is not null/undefined so set() stores it
        stower.set('flag', false);
        expect(stower.exists('flag')).toBe(true);
    });

    it('returns true for an array value', function () {
        stower.set('arr', [1, 2, 3]);
        expect(stower.exists('arr')).toBe(true);
    });

    it('returns true for an object value', function () {
        stower.set('obj', { x: 1 });
        expect(stower.exists('obj')).toBe(true);
    });

    // --- key normalisation ---

    it('is case-insensitive for uppercase lookups', function () {
        stower.set('token', 'abc');
        expect(stower.exists('TOKEN')).toBe(true);
    });

    it('is case-insensitive for lowercase lookups', function () {
        stower.set('TOKEN', 'abc');
        expect(stower.exists('token')).toBe(true);
    });

    it('trims whitespace from lookup keys', function () {
        stower.set('padded', 1);
        expect(stower.exists('  padded  ')).toBe(true);
    });

    it('trims whitespace from set keys before storing', function () {
        stower.set('  spaced  ', 1);
        expect(stower.exists('spaced')).toBe(true);
    });

    // --- invalid / falsy inputs ---

    it('returns false for an empty string key', function () {
        expect(stower.exists('')).toBe(false);
    });

    it('returns false for a null key', function () {
        expect(stower.exists(null)).toBe(false);
    });

    it('returns false for an undefined key', function () {
        expect(stower.exists(undefined)).toBe(false);
    });

    it('returns false for a whitespace-only key', function () {
        expect(stower.exists('   ')).toBe(false);
    });

    // --- silently ignored set() values ---

    it('returns false when set() receives a null value', function () {
        stower.set('nullval', null);
        expect(stower.exists('nullval')).toBe(false);
    });

    it('returns false when set() receives an undefined value', function () {
        stower.set('undefval', undefined);
        expect(stower.exists('undefval')).toBe(false);
    });

    // --- reserved key ---

    it('returns false for the reserved __expires__ key', function () {
        stower.set('__expires__', { hacked: true });
        expect(stower.exists('__expires__')).toBe(false);
    });

    // --- mutation ---

    it('returns false after a key is removed', function () {
        stower.set('gone', { v: 1 });
        expect(stower.exists('gone')).toBe(true);

        stower.remove('gone');
        expect(stower.exists('gone')).toBe(false);
    });

    it('returns false for all keys after clear()', function () {
        stower.set('a', 1);
        stower.set('b', 2);
        stower.set('c', 3);
        stower.clear();

        expect(stower.exists('a')).toBe(false);
        expect(stower.exists('b')).toBe(false);
        expect(stower.exists('c')).toBe(false);
    });

    it('keeps other keys when one key is removed', function () {
        stower.set('keep', 1);
        stower.set('drop', 2);
        stower.remove('drop');

        expect(stower.exists('keep')).toBe(true);
        expect(stower.exists('drop')).toBe(false);
    });

    // --- TTL ---

    it('returns true for a key with an active TTL', function () {
        stower.set('live', { v: 1 }, 60);
        expect(stower.exists('live')).toBe(true);
    });

    it('returns false after a key TTL has elapsed', async function () {
        stower.set('brief', { v: 1 }, 1);
        await wait(1500);
        expect(stower.exists('brief')).toBe(false);
    });

    it('returns true when TTL is extended before expiry', async function () {
        stower.set('renew', { v: 1 }, 1);
        stower.set('renew', { v: 2 }, 60); // push TTL to 60 s before the 1 s elapses
        await wait(1500);
        expect(stower.exists('renew')).toBe(true);
    });

    it('returns true after resetting a key without TTL', async function () {
        stower.set('notimer', { v: 1 }, 1);
        stower.set('notimer', { v: 2 }); // no TTL — clears expiry
        await wait(1500);
        expect(stower.exists('notimer')).toBe(true);
    });

    it('returns true for a key set with zero TTL (no expiry)', function () {
        stower.set('zero-ttl', { v: 1 }, 0);
        expect(stower.exists('zero-ttl')).toBe(true);
    });

    it('returns true for a key set with negative TTL (no expiry)', function () {
        stower.set('neg-ttl', { v: 1 }, -5);
        expect(stower.exists('neg-ttl')).toBe(true);
    });

    // --- persistence ---

    it('returns true for a key reloaded from disk after persist() runs again', async function () {
        stower.set('disk', { v: 1 });

        await wait(1500); // wait for the debounced write to flush

        stower.persist(filepath); // re-initialise from the same file

        expect(stower.exists('disk')).toBe(true);
    });

    it('detects keys written by another process after file timestamp changes', async function () {
        stower.set('mine', { v: 1 });
        await wait(1500);

        fs.writeFileSync(filepath, JSON.stringify({ mine: { v: 1 }, external: { v: 2 } }, null, 2));

        expect(stower.exists('external')).toBe(true);
    });

    it('returns false for a key removed before file reload', async function () {
        stower.set('transient', { v: 1 });
        stower.remove('transient');

        await wait(1500); // wait for the debounced write to flush

        stower.persist(filepath); // re-initialise from the same file

        expect(stower.exists('transient')).toBe(false);
    });

    it('returns false for a key whose TTL expired before file reload', async function () {
        stower.set('expiring', { v: 1 }, 1);

        await wait(2000); // wait for TTL to elapse and write to flush

        stower.persist(filepath); // re-initialise — expired keys are pruned on write

        expect(stower.exists('expiring')).toBe(false);
    });
});

/**
 * Wait helper
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}
