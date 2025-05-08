/* eslint-disable import/extensions */
var stow = require('../index.js');

describe('stow: interface', function() {

    it('should expose correct interface', function () {
        expect(typeof stow.get).toEqual('function');
        expect(typeof stow.set).toEqual('function');
        expect(typeof stow.remove).toEqual('function');
        expect(typeof stow.exists).toEqual('function');
        expect(typeof stow.persist).toEqual('function');
        expect(typeof stow.all).toEqual('function');
        expect(typeof stow.clear).toEqual('function');
        expect(typeof stow.debug).toEqual('boolean');
        expect(typeof stow.filename).toEqual('string');
    });

    it('should expose correct methods', function () {
        expect(stow.get).toBeDefined();
        expect(stow.set).toBeDefined();
        expect(stow.remove).toBeDefined();
        expect(stow.exists).toBeDefined();
        expect(stow.persist).toBeDefined();
        expect(stow.all).toBeDefined();
        expect(stow.clear).toBeDefined();
    });
});
