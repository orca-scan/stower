/* eslint-disable import/extensions */
var fs = require('fs');
var path = require('path');
var fork = require('child_process').fork;

var workerPath = path.resolve('./tests/helpers/worker.js');
var filepath = path.resolve('./cache/multiprocess.json');

/**
 * Fork a worker, send it one message, and resolve with its reply.
 * @param {Object} msg - IPC message to send
 * @returns {Promise<Object>}
 */
function runWorker(msg) {
    return new Promise(function (resolve, reject) {
        var child = fork(workerPath, [], { silent: true });
        var result = null;

        child.on('message', function (res) {
            result = res;
        });

        child.on('exit', function (code) {
            if (result) return resolve(result);
            reject(new Error('worker exited with code ' + code + ' and no result'));
        });

        child.on('error', reject);

        child.send(msg);
    });
}

describe('stower: multiprocess', function () {

    afterEach(function () {
        try {
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

            var dir = path.dirname(filepath);
            if (fs.existsSync(dir)) {
                var files = fs.readdirSync(dir);
                for (var i = 0; i < files.length; i++) {
                    if (files[i].indexOf('.tmp') !== -1 || files[i].indexOf('.lock') !== -1) {
                        var full = path.join(dir, files[i]);
                        try {
                            var stat = fs.statSync(full);
                            if (stat.isDirectory()) fs.rmdirSync(full, { recursive: true });
                            else fs.unlinkSync(full);
                        } catch (e) { /* ignore */ }
                    }
                }
            }
        } catch (e) {
            // ignore cleanup errors
        }
    });

    it('should preserve keys from both processes when two processes write different keys concurrently', async function () {
        var keysA = [];
        var keysB = [];
        for (var i = 0; i < 5; i++) {
            keysA.push({ key: 'a' + i, value: { src: 'A', i: i } });
            keysB.push({ key: 'b' + i, value: { src: 'B', i: i } });
        }

        // run both workers in parallel
        var results = await Promise.all([
            runWorker({ cmd: 'setMany', file: filepath, entries: keysA }),
            runWorker({ cmd: 'setMany', file: filepath, entries: keysB })
        ]);

        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(true);

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));

        for (var j = 0; j < 5; j++) {
            expect(content['a' + j]).toBeDefined();
            expect(content['b' + j]).toBeDefined();
        }
    });

    it('should not produce corrupt JSON under lock contention with 4 concurrent writers', async function () {
        var workers = [];
        for (var i = 0; i < 4; i++) {
            var entries = [];
            for (var j = 0; j < 10; j++) {
                entries.push({ key: 'p' + i + '_k' + j, value: { proc: i, key: j } });
            }
            workers.push(runWorker({ cmd: 'setMany', file: filepath, entries: entries }));
        }

        var results = await Promise.all(workers);

        for (var r = 0; r < results.length; r++) {
            expect(results[r].ok).toBe(true);
        }

        // file must be valid JSON and contain all 40 keys
        var raw = fs.readFileSync(filepath, 'utf8');
        var content = JSON.parse(raw); // throws if corrupt

        var allKeys = Object.keys(content).filter(function (k) { return k !== '__expires__'; });
        expect(allKeys.length).toBe(40);
    });

    it('should result in an empty file when one process clears while another writes', async function () {
        // writer sets 5 keys, clearer calls clear() — run simultaneously
        var entries = [];
        for (var i = 0; i < 5; i++) {
            entries.push({ key: 'todelete' + i, value: { v: i } });
        }

        await Promise.all([
            runWorker({ cmd: 'setMany', file: filepath, entries: entries }),
            runWorker({ cmd: 'clear', file: filepath })
        ]);

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        var dataKeys = Object.keys(content).filter(function (k) { return k !== '__expires__'; });
        expect(dataKeys.length).toBe(0);
    });

    it('should produce consistent (non-corrupt) JSON when one process removes a key another is setting', async function () {
        // pre-create the file with the key present
        fs.writeFileSync(filepath, JSON.stringify({ contested: { v: 0 } }, null, 2));

        await Promise.all([
            runWorker({ cmd: 'set',    file: filepath, key: 'contested', value: { v: 1 } }),
            runWorker({ cmd: 'remove', file: filepath, key: 'contested' })
        ]);

        // file must be valid JSON regardless of which operation won
        var raw = fs.readFileSync(filepath, 'utf8');
        expect(function () { JSON.parse(raw); }).not.toThrow();
    });
});
