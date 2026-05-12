/* eslint-disable import/extensions */
var stower = require('../index.js');

describe('stower: interface', function() {

    it('exposes expected public properties', function () {
        expect(typeof stower.debug).toEqual('boolean');
        expect(typeof stower.filename).toEqual('string');
    });

    it('exposes expected public methods', function () {
        expect(typeof stower.get).toEqual('function');
        expect(typeof stower.set).toEqual('function');
        expect(typeof stower.remove).toEqual('function');
        expect(typeof stower.exists).toEqual('function');
        expect(typeof stower.persist).toEqual('function');
        expect(typeof stower.keys).toEqual('function');
        expect(typeof stower.values).toEqual('function');
        expect(typeof stower.clear).toEqual('function');
    });

    it('logs wrapped method calls when debug is enabled', function () {
        var originalDebug = stower.debug;
        var logSpy = spyOn(console, 'log');

        stower.debug = true;
        stower.get('token');

        expect(logSpy).toHaveBeenCalledWith('[stower]', 'get', ['token']);

        stower.debug = originalDebug;
    });
});
