/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var stower = require('../index.js');

describe('stower: clear', function () {

    var filepath = path.resolve('./cache/clearstorage.json');

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
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        }
        catch (e) {
            // ignore cleanup errors
        }
    });

    it('should stay empty when a file change occurs before the clear flush', async function () {
        stower.set('foo', { bar: 'baz' });
        stower.set('hello', { world: true });

        // wait for debounced write to persist data to disk
        await wait(1500);

        // confirm data is on disk
        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.foo).toBeDefined();

        // clear the in-memory store (debounced write scheduled for 1s later)
        stower.clear();

        // simulate another process writing to the file BEFORE clear's write flushes
        // this changes the file's mtime so load() will re-read from disk
        var externalData = { external: { from: 'other-process' } };
        fs.writeFileSync(filepath, JSON.stringify(externalData));

        // get() calls load(), which sees the mtime changed and re-reads the file.
        // BUG: load() does not check _clearPending, so it repopulates _store from disk.
        var foo = stower.get('foo');
        var hello = stower.get('hello');
        var external = stower.get('external');

        // after clear(), ALL keys should be null — even ones written externally
        expect(foo).toBeNull();
        expect(hello).toBeNull();
        expect(external).toBeNull();
        expect(stower.keys().length).toBe(0);
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
