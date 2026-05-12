/**
 * Child process worker for multi-process stower tests.
 *
 * Receives a command over IPC, executes it against stower, then sends back
 * a result object: { ok: true } on success or { ok: false, error: string } on failure.
 *
 * Commands:
 *   { cmd: 'set',    file, key, value, [ttl] }
 *   { cmd: 'remove', file, key }
 *   { cmd: 'clear',  file }
 *   { cmd: 'get',    file, key }
 *   { cmd: 'keys',   file }
 *   { cmd: 'setMany', file, entries: [{ key, value }] }
 */

/* eslint-disable import/extensions */
var stower = require('../../index.js');

process.on('message', function (msg) {
    try {
        stower.persist(msg.file);

        if (msg.cmd === 'set') {
            stower.set(msg.key, msg.value, msg.ttl);

        } else if (msg.cmd === 'setMany') {
            for (var i = 0; i < msg.entries.length; i++) {
                stower.set(msg.entries[i].key, msg.entries[i].value);
            }

        } else if (msg.cmd === 'remove') {
            stower.remove(msg.key);

        } else if (msg.cmd === 'clear') {
            stower.clear();

        } else if (msg.cmd === 'get') {
            process.send({ ok: true, value: stower.get(msg.key) });
            return;

        } else if (msg.cmd === 'keys') {
            process.send({ ok: true, value: stower.keys() });
            return;
        }

        // flush to disk before reporting done so the parent can read the final state
        setTimeout(function () {
            process.send({ ok: true });
            process.exit(0);
        }, 1500);

    } catch (e) {
        process.send({ ok: false, error: e.message });
        process.exit(1);
    }
});
