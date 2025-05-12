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
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            var dir = path.dirname(filepath);
            if (fs.existsSync(dir)) fs.rmdirSync(dir);
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
