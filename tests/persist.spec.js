/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

describe('stower: persist', function () {
    var filepath = utils.storeFile('persist-test');

    beforeEach(function () {
        utils.ensureStoreDir(filepath);
    });

    afterEach(function () {
        utils.cleanupStoreFile(filepath);
    });

    it('appends .json when persist path has no extension', function () {
        var noExt = filepath.slice(0, -5);
        stower.persist(noExt);

        expect(stower.filename.slice(-5)).toBe('.json');
    });

    it('uses XDG_CACHE_HOME when no filename is provided', function () {
        var originalXdg = process.env.XDG_CACHE_HOME;
        var xdgRoot = path.resolve('./cache/xdg-home');

        try {
            process.env.XDG_CACHE_HOME = xdgRoot;
            stower.persist();

            expect(stower.filename).toBe(path.join(xdgRoot, 'stower', 'data.json'));
        }
        finally {
            if (originalXdg === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = originalXdg;

            utils.cleanupStoreFile(path.join(xdgRoot, 'stower', 'data.json'));
        }
    });

    it('loads existing values from disk on startup', function () {
        fs.writeFileSync(filepath, JSON.stringify({ existing: { v: 7 } }, null, 2));

        stower.persist(filepath);

        expect(stower.get('existing')).toEqual({ v: 7 });
    });

    it('backs up corrupt JSON files and starts fresh', function () {
        var backupPath = filepath + '.corrupt';
        fs.writeFileSync(filepath, 'NOT VALID JSON }{');

        stower.persist(filepath);

        expect(fs.existsSync(backupPath)).toBe(true);
        expect(stower.keys()).toEqual([]);
    });

    it('creates and writes to the store file', async function () {
        stower.persist(filepath);
        stower.set('foo', { bar: 'baz' });

        await utils.wait(1500);

        expect(fs.existsSync(filepath)).toBe(true);

        var content = utils.readStore(filepath);
        expect(content.foo).toEqual({ bar: 'baz' });
    });

    it('preserves keys from external writers when persisting its own changes', async function () {
        stower.persist(filepath);
        fs.writeFileSync(filepath, JSON.stringify({ diskkey: { v: 1 } }, null, 2));

        stower.set('mykey', { v: 2 });

        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.diskkey).toEqual({ v: 1 });
        expect(content.mykey).toEqual({ v: 2 });
    });

    // Regression: load() must not drop pending sets when mtime changes before flush.
    it('keeps pending set values when external writes trigger a reload before flush', async function () {
        stower.persist(filepath);
        stower.set('myset', { v: 1 });

        fs.writeFileSync(filepath, JSON.stringify({ other: { v: 99 } }, null, 2));

        stower.get('probe');
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.myset).toEqual({ v: 1 });
        expect(content.other).toEqual({ v: 99 });
    });

    // Regression: reload path must preserve pending TTL metadata.
    it('keeps pending TTL metadata when external writes trigger a reload before flush', async function () {
        stower.persist(filepath);
        stower.set('ttlkey', { v: 1 }, 60);

        fs.writeFileSync(filepath, JSON.stringify({ other: { v: 99 } }, null, 2));

        stower.get('probe');
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.__expires__).toBeDefined();
        expect(content.__expires__.ttlkey).toBeDefined();
    });

    it('creates a fresh file if it is deleted after persist is initialized', async function () {
        stower.persist(filepath);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

        stower.set('newfile', { v: 1 });
        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.newfile).toEqual({ v: 1 });
    });
});