/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var stower = require('../index.js');

describe('stower: methods', function () {

    var filepath = path.resolve('./cache/mystorage.json');

    beforeEach(function () {
        var dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
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

    it('should create use provided storage on disk and persist data', async function () {

        stower.persist(filepath); // use dev provided storage folder
        stower.set('foo', { bar: 'baz' });

        await wait(1500); // wait for async save

        var exists = fs.existsSync(filepath);
        expect(exists).toBe(true);

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.foo.bar).toBe('baz');
    });

    it('should create os based storage on disk and persist data', async function () {

        stower.persist(); // uses OS based temp storage folder
        stower.set('foo', { bar: 'baz' });

        await wait(1500); // wait for async save

        var exists = fs.existsSync(stower.filename);
        expect(exists).toBe(true);

        var content = JSON.parse(fs.readFileSync(stower.filename, 'utf8'));
        expect(content.foo.bar).toBe('baz');
    });

    it('should pick up changes another process wrote to the file', async function () {

        stower.persist(filepath);
        stower.set('mine', { v: 1 });

        await wait(1500); // wait for initial save

        // simulate another process writing directly to the file
        var external = { mine: { v: 1 }, other: { v: 99 } };
        fs.writeFileSync(filepath, JSON.stringify(external, null, 2));

        // get() calls load() which checks mtime and reloads the file
        expect(stower.get('other')).toEqual({ v: 99 });
    });

    it('should merge its own keys without overwriting keys from other processes', async function () {

        stower.persist(filepath);

        // simulate a key already on disk from another process
        var diskData = { diskkey: { v: 1 } };
        fs.writeFileSync(filepath, JSON.stringify(diskData, null, 2));

        stower.set('mykey', { v: 2 });

        await wait(1500); // wait for save

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.diskkey).toBeDefined();  // other process's key preserved
        expect(content.mykey).toBeDefined();    // this process's key written
    });

    it('should remove a key from disk when remove() is called', async function () {

        stower.persist(filepath);
        stower.set('gone', { v: 1 });

        await wait(1500); // wait for save

        stower.remove('gone');

        await wait(1500); // wait for save

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.gone).toBeUndefined();
    });

    // --- merge / dirty-key edge cases ---

    it('should not write a key that was set then removed within the debounce window', async function () {
        stower.persist(filepath);
        stower.set('ghost', { v: 1 });
        stower.remove('ghost');

        await wait(1500); // wait for save

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.ghost).toBeUndefined();
    });

    it('should only persist the last value when the same key is set multiple times rapidly', async function () {
        stower.persist(filepath);
        stower.set('rapid', { v: 1 });
        stower.set('rapid', { v: 2 });
        stower.set('rapid', { v: 3 });

        await wait(1500); // wait for save

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.rapid).toEqual({ v: 3 });
    });

    it('should fully reset state when persist() is called twice on the same file', async function () {
        stower.persist(filepath);
        stower.set('first', { v: 1 });

        await wait(1500); // wait for save

        stower.persist(filepath); // reload — should see the saved key, nothing extra

        expect(stower.get('first')).toEqual({ v: 1 });
        expect(stower.keys().length).toBe(1);
    });

    // --- resilience ---

    it('should back up a corrupt file and start fresh', function () {
        var backupPath = filepath + '.corrupt';

        // write garbage to the file
        var dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filepath, 'NOT VALID JSON }{');

        stower.persist(filepath);

        expect(fs.existsSync(backupPath)).toBe(true);
        expect(stower.keys()).toEqual([]);

        // cleanup backup
        try { fs.unlinkSync(backupPath); } catch (e) { /* ignore */ }
    });

    it('should create a new file when the file is deleted after persist()', async function () {
        stower.persist(filepath);

        // delete the file after persist
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

        stower.set('newfile', { v: 1 });

        await wait(1500); // wait for save

        expect(fs.existsSync(filepath)).toBe(true);
        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        expect(content.newfile).toEqual({ v: 1 });
    });

    // --- dirty-window: pending writes must survive a load() triggered by an external write ---
    // Regression tests for the bug where load() replaced _store wholesale, causing dirty
    // keys (set but not yet flushed) to be treated as deletes when write() eventually ran.

    it('should preserve a dirty key after load() is triggered by an external file change', async function () {
        stower.persist(filepath);

        // set a key — it is now dirty (in memory, not yet on disk)
        stower.set('myset', { v: 1 });

        // simulate another container writing to the file, changing its mtime
        var external = { other: { v: 99 } };
        fs.writeFileSync(filepath, JSON.stringify(external, null, 2));

        // get() triggers load() which detects the mtime change and reloads from disk
        stower.get('probe');

        // wait for the debounced write to flush
        await wait(1500);

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));

        // our dirty key must survive — load() must not wipe it
        expect(content.myset).toEqual({ v: 1 });

        // the other container's key must also be present — merge must work both ways
        expect(content.other).toEqual({ v: 99 });
    });

    it('should preserve a dirty TTL after load() is triggered by an external file change', async function () {
        stower.persist(filepath);

        // set a key with a 60s TTL — dirty and not yet flushed
        stower.set('ttlkey', { v: 1 }, 60);

        // simulate another container writing to the file
        var external = { other: { v: 99 } };
        fs.writeFileSync(filepath, JSON.stringify(external, null, 2));

        // trigger load() via get()
        stower.get('probe');

        // wait for debounced write
        await wait(1500);

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));

        // the TTL must survive the reload — without the fix, load() clears _expires
        // and write() persists __expires__ without ttlkey, losing the expiry forever
        expect(content.__expires__).toBeDefined();
        expect(content.__expires__.ttlkey).toBeDefined();
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
