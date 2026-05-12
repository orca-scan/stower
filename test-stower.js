#!/usr/bin/env node

/*
 * Backwards-compatible launcher for the stress test.
 * The stress scenarios now live in Jasmine at tests/stress.spec.js.
 */

var Jasmine = require('jasmine');
var path = require('path');

var jasmine = new Jasmine();

jasmine.loadConfig({
    spec_dir: path.resolve(__dirname, 'tests'),
    spec_files: ['stress.spec.js'],
    helpers: ['jasmine/reporter.js'],
    stopSpecOnExpectationFailure: true,
    random: false,
    failFast: true
});

jasmine.execute();