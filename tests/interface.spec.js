/* eslint-disable import/extensions */
var stower = require('../index.js');

describe('stower: interface', function() {

    it('should expose correct properties', function () {
        expect(typeof stower.debug).toEqual('boolean');
        expect(typeof stower.filename).toEqual('string');
    });

    it('should expose correct methods', function () {
        expect(typeof stower.get).toEqual('function');
        expect(typeof stower.set).toEqual('function');
        expect(typeof stower.remove).toEqual('function');
        expect(typeof stower.exists).toEqual('function');
        expect(typeof stower.persist).toEqual('function');
        expect(typeof stower.keys).toEqual('function');
        expect(typeof stower.values).toEqual('function');
        expect(typeof stower.clear).toEqual('function');
    });
});
