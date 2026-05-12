/* eslint-disable import/extensions */
var path = require('path');
var fork = require('child_process').fork;
var utils = require('./helpers/spec-utils.js');

var workerPath = path.resolve('./tests/helpers/signal-worker.js');

/**
 * Run one signal scenario against a dedicated child process.
 * @param {string} signalName - Process signal to send
 * @param {string} filepath - Backing file path
 * @returns {Promise<void>}
 */
function runSignalScenario(signalName, filepath) {
    return new Promise(function (resolve, reject) {
        var child = fork(workerPath, [], { silent: true });
        var done = false;

        function finish(error) {
            if (done) return;
            done = true;
            if (error) reject(error);
            else resolve();
        }

        child.on('error', finish);

        child.on('message', function (msg) {
            if (!msg || msg.ok !== true) {
                finish(new Error((msg && msg.error) || 'worker failed before ready'));
                return;
            }

            if (msg.ready === true) {
                child.kill(signalName);
            }
        });

        child.on('exit', function (code) {
            if (code !== 0) {
                finish(new Error('worker exited with code ' + code));
                return;
            }

            finish();
        });

        child.send({
            cmd: 'prepare-and-wait',
            file: filepath,
            key: 'signal-key',
            value: { source: signalName }
        });
    });
}

describe('stower: process signals', function () {
    var filepath;

    afterEach(function () {
        if (filepath) utils.cleanupStoreFile(filepath);
    });

    it('flushes pending writes on SIGINT', async function () {
        filepath = utils.storeFile('signal-sigint-' + process.pid + '-' + Date.now());
        utils.ensureStoreDir(filepath);

        await runSignalScenario('SIGINT', filepath);

        var content = utils.readStore(filepath);
        expect(content['signal-key']).toEqual({ source: 'SIGINT' });
    }, 15000);

    it('flushes pending writes on SIGTERM', async function () {
        filepath = utils.storeFile('signal-sigterm-' + process.pid + '-' + Date.now());
        utils.ensureStoreDir(filepath);

        await runSignalScenario('SIGTERM', filepath);

        var content = utils.readStore(filepath);
        expect(content['signal-key']).toEqual({ source: 'SIGTERM' });
    }, 15000);
});