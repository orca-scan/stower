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

    it('should produce consistent (non-corrupt) JSON when one process clears while another writes', async function () {
        // writer sets 5 keys, clearer calls clear() — run simultaneously
        var entries = [];
        for (var i = 0; i < 5; i++) {
            entries.push({ key: 'todelete' + i, value: { v: i } });
        }

        await Promise.all([
            runWorker({ cmd: 'setMany', file: filepath, entries: entries }),
            runWorker({ cmd: 'clear', file: filepath })
        ]);

        // outcome is nondeterministic (last-writer-wins): clear wins (0 keys) or setMany wins (5 keys)
        // the important invariant is that the file is valid JSON with a consistent state
        var content = JSON.parse(fs.readFileSync(filepath, 'utf8')); // throws if corrupt
        var dataKeys = Object.keys(content).filter(function (k) { return k !== '__expires__'; });
        expect(dataKeys.length === 0 || dataKeys.length === 5).toBe(true);
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

    it('should preserve TTL entries from both processes when two processes write with TTLs concurrently', async function () {
        var entriesA = [
            { key: 'ttl_a0', value: { src: 'A' }, ttl: 60 },
            { key: 'ttl_a1', value: { src: 'A' }, ttl: 60 },
            { key: 'ttl_a2', value: { src: 'A' }, ttl: 60 }
        ];
        var entriesB = [
            { key: 'ttl_b0', value: { src: 'B' }, ttl: 60 },
            { key: 'ttl_b1', value: { src: 'B' }, ttl: 60 },
            { key: 'ttl_b2', value: { src: 'B' }, ttl: 60 }
        ];

        var results = await Promise.all([
            runWorker({ cmd: 'setMany', file: filepath, entries: entriesA }),
            runWorker({ cmd: 'setMany', file: filepath, entries: entriesB })
        ]);

        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(true);

        var content = JSON.parse(fs.readFileSync(filepath, 'utf8'));

        // all 6 keys must exist
        for (var i = 0; i < 3; i++) {
            expect(content['ttl_a' + i]).toBeDefined();
            expect(content['ttl_b' + i]).toBeDefined();
        }

        // all 6 TTL entries must be in __expires__
        expect(content.__expires__).toBeDefined();
        for (var j = 0; j < 3; j++) {
            expect(content.__expires__['ttl_a' + j]).toBeDefined();
            expect(content.__expires__['ttl_b' + j]).toBeDefined();
        }
    });

    it('should preserve all 100 keys when 10 processes write concurrently', async function () {
        var workers = [];
        for (var i = 0; i < 10; i++) {
            var entries = [];
            for (var j = 0; j < 10; j++) {
                entries.push({ key: 'w' + i + '_k' + j, value: { worker: i, key: j } });
            }
            workers.push(runWorker({ cmd: 'setMany', file: filepath, entries: entries }));
        }

        var results = await Promise.all(workers);

        for (var r = 0; r < results.length; r++) {
            expect(results[r].ok).toBe(true);
        }

        var raw = fs.readFileSync(filepath, 'utf8');
        var content = JSON.parse(raw); // throws if corrupt

        var allKeys = Object.keys(content).filter(function (k) { return k !== '__expires__'; });
        expect(allKeys.length).toBe(100);
    });

    // Regression test: with 8+ processes flushing to disk simultaneously (rolling deploys,
    // container restarts) the lock retry budget (~1.5 s) was exhausted and write() returned
    // without saving — silently dropping ~50 keys per failed process.
    it('should preserve all 400 keys when 8 processes flush to disk concurrently', async function () {
        var workers = [];
        for (var i = 0; i < 8; i++) {
            var entries = [];
            for (var j = 0; j < 50; j++) {
                entries.push({ key: 'w' + i + '_k' + j, value: { worker: i, key: j } });
            }
            workers.push(runWorker({ cmd: 'setMany', file: filepath, entries: entries }));
        }

        var results = await Promise.all(workers);

        for (var r = 0; r < results.length; r++) {
            expect(results[r].ok).toBe(true);
        }

        var raw = fs.readFileSync(filepath, 'utf8');
        var content = JSON.parse(raw); // throws if corrupt

        var allKeys = Object.keys(content).filter(function (k) { return k !== '__expires__'; });
        expect(allKeys.length).toBe(400);
    }, 60000); // generous timeout: up to 8 processes queuing for the lock
});
