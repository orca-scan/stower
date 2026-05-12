/* eslint-disable import/extensions */
var stower = require('../../index.js');

process.on('message', function (msg) {
    try {
        if (!msg || msg.cmd !== 'prepare-and-wait') return;

        stower.persist(msg.file);
        stower.set(msg.key, msg.value);

        if (typeof process.send === 'function') {
            process.send({ ok: true, ready: true });
        }

        setInterval(function () {
            // keep child alive until parent sends a signal
        }, 1000);
    }
    catch (error) {
        if (typeof process.send === 'function') {
            process.send({ ok: false, error: error.message });
        }
        process.exit(1);
    }
});