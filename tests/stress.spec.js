/* eslint-disable import/extensions */
var fs = require('fs');
var os = require('os');
var path = require('path');
var fork = require('child_process').fork;

var workerPath = path.resolve(__dirname, 'helpers/stress-worker.js');
var WORKERS = parseInt(process.env.STOWER_STRESS_WORKERS || '50', 10);
var OPS = parseInt(process.env.STOWER_STRESS_OPS || '40', 10);
var FLUSH_WAIT_MS = 3000;
var WORKER_EXIT_GRACE_MS = 120;
var TTL_STRESS_SECONDS = parseInt(process.env.STOWER_STRESS_TTL_SECONDS || '10', 10);
var TTL_SNAPSHOT_TIMEOUT_MS = 15000;
var TTL_SNAPSHOT_POLL_MS = 100;

var tmpDir = path.join(os.tmpdir(), 'stower-jasmine-stress-' + process.pid);

/**
 * Build file path in stress temp dir.
 * @param {string} name - Scenario name
 * @returns {string} file path
 */
function tmpFile(name) {
    return path.join(tmpDir, name + '.json');
}

/**
 * Ensure directory exists.
 * @param {string} dir - Directory path
 * @returns {void}
 */
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Sleep helper.
 * @param {number} ms - Delay in milliseconds
 * @returns {Promise<void>} resolved after ms
 */
function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Read and parse store file.
 * @param {string} filepath - JSON file path
 * @returns {Object} parsed JSON
 */
function readStore(filepath) {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

/**
 * Return data keys excluding internal metadata key.
 * @param {Object} content - Parsed store object
 * @returns {string[]} public keys
 */
function dataKeys(content) {
    return Object.keys(content).filter(function (key) { return key !== '__expires__'; });
}

/**
 * Remove one scenario file and related artifacts.
 * @param {string} filepath - Data file path
 * @returns {void}
 */
function cleanupFileArtifacts(filepath) {
    var dir = path.dirname(filepath);
    var basename = path.basename(filepath);

    try {
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (error) { /* ignore cleanup failures */ }

    try {
        if (fs.existsSync(filepath + '.corrupt')) fs.unlinkSync(filepath + '.corrupt');
    } catch (error) { /* ignore cleanup failures */ }

    try {
        if (fs.existsSync(filepath + '.lock')) fs.rmSync(filepath + '.lock', { recursive: true, force: true });
    } catch (error) { /* ignore cleanup failures */ }

    try {
        if (fs.existsSync(dir)) {
            var files = fs.readdirSync(dir);
            for (var i = 0; i < files.length; i++) {
                if (files[i].indexOf(basename + '.') === 0 && files[i].slice(-4) === '.tmp') {
                    fs.unlinkSync(path.join(dir, files[i]));
                }
            }
        }
    } catch (error) { /* ignore cleanup failures */ }
}

/**
 * Spawn one stress worker and return its result.
 * @param {Object} msg - Worker command payload
 * @returns {Promise<Object>} worker result
 */
function runWorker(msg) {
    return new Promise(function (resolve, reject) {
        var child = fork(workerPath, [], { silent: true });
        var result = null;
        var stderr = '';
        var settled = false;
        var exitTimer = null;

        function resolveOnce(value) {
            if (settled) return;
            settled = true;
            if (exitTimer) clearTimeout(exitTimer);
            resolve(value);
        }

        function rejectOnce(error) {
            if (settled) return;
            settled = true;
            if (exitTimer) clearTimeout(exitTimer);
            reject(error);
        }

        child.on('message', function (res) {
            result = res;
            resolveOnce(res);
        });

        child.stderr.on('data', function (chunk) {
            stderr += chunk.toString();
        });

        child.on('error', rejectOnce);

        child.on('exit', function (code) {
            // On busy systems, the exit event can fire before the message event.
            // Give IPC a short grace window before treating this as a worker failure.
            exitTimer = setTimeout(function () {
                if (result) {
                    resolveOnce(result);
                    return;
                }

                rejectOnce(new Error('worker exited with code ' + code + (stderr ? ' (' + stderr.trim() + ')' : '')));
            }, WORKER_EXIT_GRACE_MS);
        });

        child.send(msg);
    });
}

/**
 * Wait for disk state to contain all expected TTL keys and metadata.
 * @param {string} filepath - JSON file path
 * @param {number} expectedCount - Expected number of data keys
 * @returns {Promise<Object|null>} parsed snapshot or null on timeout
 */
async function waitForExpectedTtlSnapshot(filepath, expectedCount) {
    var deadline = Date.now() + TTL_SNAPSHOT_TIMEOUT_MS;

    while (Date.now() < deadline) {
        try {
            var content = readStore(filepath);
            var keys = dataKeys(content);
            var expiresCount = content.__expires__ ? Object.keys(content.__expires__).length : 0;

            if (keys.length === expectedCount && expiresCount === expectedCount) {
                return content;
            }
        }
        catch (error) {
            // File may not exist yet or may be mid-write; keep polling.
        }

        await wait(TTL_SNAPSHOT_POLL_MS);
    }

    return null;
}

describe('stower: stress (shared file, 50 workers)', function () {
    var defaultTimeout;

    beforeAll(function () {
        defaultTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
        jasmine.DEFAULT_TIMEOUT_INTERVAL = 10 * 60 * 1000;
        ensureDir(tmpDir);
    });

    afterAll(function () {
        jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout;
        try {
            if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (error) { /* ignore cleanup failures */ }
    });

    it('preserves all keys with ' + WORKERS + ' concurrent writers sharing one file', async function () {
        var filepath = tmpFile('bulk-writes');
        ensureDir(path.dirname(filepath));

        var workers = [];
        for (var i = 0; i < WORKERS; i++) {
            workers.push(runWorker({
                cmd: 'bulk-set',
                file: filepath,
                prefix: 'w' + i,
                count: OPS
            }));
        }

        var results = await Promise.all(workers);
        var workerErrors = results.filter(function (res) { return !res.ok; });
        expect(workerErrors.length).toBe(0);

        await wait(FLUSH_WAIT_MS);

        var content = readStore(filepath);
        var keys = dataKeys(content);
        expect(keys.length).toBe(WORKERS * OPS);

        var invalid = keys.filter(function (key) {
            var value = content[key];
            return !value || typeof value.worker !== 'string' || typeof value.index !== 'number';
        });
        expect(invalid.length).toBe(0);

        cleanupFileArtifacts(filepath);
    });

    it('keeps JSON valid during clear and write races with ' + WORKERS + ' workers', async function () {
        var filepath = tmpFile('clear-race');
        ensureDir(path.dirname(filepath));

        var rounds = 5;
        var writesPerWorker = Math.min(30, OPS);

        for (var round = 0; round < rounds; round++) {
            var workers = [runWorker({ cmd: 'clear', file: filepath })];

            for (var i = 0; i < WORKERS - 1; i++) {
                workers.push(runWorker({
                    cmd: 'bulk-set',
                    file: filepath,
                    prefix: 'r' + round + '-w' + i,
                    count: writesPerWorker
                }));
            }

            var results = await Promise.all(workers);
            var workerErrors = results.filter(function (res) { return !res.ok; });
            expect(workerErrors.length).toBe(0);

            await wait(FLUSH_WAIT_MS);

            expect(function () {
                readStore(filepath);
            }).not.toThrow();
        }

        cleanupFileArtifacts(filepath);
    });

    it('expires TTL keys correctly with ' + WORKERS + ' workers sharing one file', async function () {
        var filepath = tmpFile('ttl-load');
        ensureDir(path.dirname(filepath));

        // Keep TTL comfortably above high-contention commit windows in CI/coverage runs.
        var ttlSeconds = TTL_STRESS_SECONDS;
        var opsPerWorker = Math.min(20, OPS);
        var expectedCount = WORKERS * opsPerWorker;

        var workers = [];
        for (var i = 0; i < WORKERS; i++) {
            workers.push(runWorker({
                cmd: 'ttl-set',
                file: filepath,
                prefix: 'ttl-w' + i,
                count: opsPerWorker,
                ttl: ttlSeconds
            }));
        }

        var results = await Promise.all(workers);
        var workerErrors = results.filter(function (res) { return !res.ok; });
        expect(workerErrors.length).toBe(0);

        var before = await waitForExpectedTtlSnapshot(filepath, expectedCount);
        expect(before).not.toBeNull();
        if (!before) {
            cleanupFileArtifacts(filepath);
            return;
        }

        expect(dataKeys(before).length).toBe(expectedCount);
        expect(before.__expires__).toBeDefined();
        expect(Object.keys(before.__expires__).length).toBe(expectedCount);

        await wait((ttlSeconds * 1000) + 700);

        var readResult = await runWorker({ cmd: 'keys', file: filepath });
        expect(readResult.ok).toBe(true);
        expect(readResult.value.length).toBe(0);

        cleanupFileArtifacts(filepath);
    });
});
