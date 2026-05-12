/**
 * Stress-test worker for stower.
 *
 * Spawned by test-stower.js via fork(). Receives a single IPC message
 * describing the work to perform, executes it, reports back, and exits.
 *
 * Commands:
 *   { cmd: 'bulk-set',     file, prefix, count, [ttl] }
 *   { cmd: 'read-verify',  file, prefix, count, expectedValue }
 *   { cmd: 'ttl-set',      file, prefix, count, ttl }
 *   { cmd: 'churn',        file, prefix, count }
 *   { cmd: 'clear',        file }
 *   { cmd: 'keys',         file }
 */

/* eslint-disable import/extensions */
var stower = require('../../index.js');

process.on('message', function (msg) {
    try {
        stower.persist(msg.file);

        if (msg.cmd === 'bulk-set') {
            for (var i = 0; i < msg.count; i++) {
                var key = msg.prefix + '-' + i;
                var value = { worker: msg.prefix, index: i, ts: Date.now() };
                stower.set(key, value, msg.ttl);
            }

        } else if (msg.cmd === 'read-verify') {
            var mismatches = [];
            for (var r = 0; r < msg.count; r++) {
                var rKey = msg.prefix + '-' + r;
                var val = stower.get(rKey);
                if (val === null) {
                    mismatches.push({ key: rKey, expected: 'exists', got: null });
                }
            }
            process.send({ ok: true, mismatches: mismatches });
            process.exit(0);
            return;

        } else if (msg.cmd === 'ttl-set') {
            for (var t = 0; t < msg.count; t++) {
                var tKey = msg.prefix + '-' + t;
                var tVal = { worker: msg.prefix, index: t, ttl: msg.ttl };
                stower.set(tKey, tVal, msg.ttl);
            }

        } else if (msg.cmd === 'churn') {
            for (var c = 0; c < msg.count; c++) {
                var cKey = msg.prefix + '-' + c;
                stower.set(cKey, { churn: true, index: c });
                stower.remove(cKey);
            }

        } else if (msg.cmd === 'clear') {
            stower.clear();

        } else if (msg.cmd === 'keys') {
            process.send({ ok: true, value: stower.keys() });
            process.exit(0);
            return;
        }

        process.send({ ok: true });
        process.exit(0);

    } catch (e) {
        process.send({ ok: false, error: e.message });
        process.exit(1);
    }
});
