/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var lockfile = require('proper-lockfile');
var stower = require('../index.js');
var utils = require('./helpers/spec-utils.js');

/**
 * Build a dedicated filepath for this spec suite.
 * @param {string} name - Scenario name
 * @returns {string} absolute filepath
 */
function scenarioFile(name) {
    return utils.storeFile('error-paths-' + name);
}

describe('stower: error paths', function () {
    var filesToCleanup;

    beforeEach(function () {
        filesToCleanup = [];
    });

    afterEach(function () {
        for (var i = 0; i < filesToCleanup.length; i++) {
            utils.cleanupStoreFile(filesToCleanup[i]);
        }
    });

    it('retries after file-creation failure when target file is missing', async function () {
        var filepath = scenarioFile('missing-file-create-failure');
        filesToCleanup.push(filepath);
        utils.ensureStoreDir(filepath);

        stower.persist(filepath);
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

        var originalWriteFileSync = fs.writeFileSync;
        var createAttempts = 0;

        spyOn(fs, 'writeFileSync').and.callFake(function (target, data) {
            if (target === filepath && data === '{}') {
                createAttempts += 1;
                if (createAttempts === 1) {
                    throw new Error('simulated create failure');
                }
            }

            return originalWriteFileSync.apply(fs, arguments);
        });

        stower.set('alpha', { ok: true });

        await utils.wait(2600);

        var content = utils.readStore(filepath);
        expect(createAttempts).toBe(2);
        expect(content.alpha).toEqual({ ok: true });
    });

    it('retries after a lock acquisition failure and eventually saves', async function () {
        var filepath = scenarioFile('lock-release-null');
        filesToCleanup.push(filepath);
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);

        var originalLockSync = lockfile.lockSync;
        var attempts = 0;

        spyOn(lockfile, 'lockSync').and.callFake(function (target, options) {
            attempts += 1;
            if (attempts === 1) return null;
            return originalLockSync.call(lockfile, target, options);
        });

        stower.set('beta', { v: 2 });

        await utils.wait(2600);

        var content = utils.readStore(filepath);
        expect(attempts).toBeGreaterThan(1);
        expect(content.beta).toEqual({ v: 2 });
    });

    it('retries after write failures inside the locked commit section', async function () {
        var filepath = scenarioFile('rename-failure');
        filesToCleanup.push(filepath);
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);

        var originalRenameSync = fs.renameSync;
        var failed = false;

        spyOn(fs, 'renameSync').and.callFake(function (from, to) {
            if (!failed && to === filepath) {
                failed = true;
                throw new Error('simulated rename failure');
            }

            return originalRenameSync.call(fs, from, to);
        });

        stower.set('gamma', { v: 3 });

        await utils.wait(2600);

        var content = utils.readStore(filepath);
        expect(failed).toBe(true);
        expect(content.gamma).toEqual({ v: 3 });
    });

    it('continues safely when lock release callback throws', async function () {
        var filepath = scenarioFile('release-throws');
        filesToCleanup.push(filepath);
        utils.ensureStoreDir(filepath);
        stower.persist(filepath);

        var originalLockSync = lockfile.lockSync;
        spyOn(lockfile, 'lockSync').and.callFake(function (target, options) {
            var release = originalLockSync.call(lockfile, target, options);
            return function () {
                release();
                throw new Error('simulated release failure');
            };
        });

        stower.set('delta', { v: 4 });

        await utils.wait(1500);

        var content = utils.readStore(filepath);
        expect(content.delta).toEqual({ v: 4 });
    });

    it('throws when startup read fails with EACCES', function () {
        var filepath = scenarioFile('startup-eacces');
        filesToCleanup.push(filepath);
        utils.ensureStoreDir(filepath);
        fs.writeFileSync(filepath, '{}');

        var originalReadFileSync = fs.readFileSync;
        spyOn(fs, 'readFileSync').and.callFake(function (target) {
            if (target === filepath) {
                var error = new Error('permission denied');
                error.code = 'EACCES';
                throw error;
            }

            return originalReadFileSync.apply(fs, arguments);
        });

        expect(function () {
            stower.persist(filepath);
        }).toThrow();
    });

    it('throws when writable-dir checks keep failing after retries', function () {
        var filepath = scenarioFile('startup-retries-exhausted');
        filesToCleanup.push(filepath);

        var originalDateNow = Date.now;
        var now = originalDateNow();
        spyOn(Date, 'now').and.callFake(function () {
            now += 1000;
            return now;
        });

        spyOn(fs, 'accessSync').and.throwError('still not writable');

        expect(function () {
            stower.persist(filepath);
        }).toThrow();

        expect(fs.accessSync.calls.count()).toBeGreaterThan(1);
    });
});