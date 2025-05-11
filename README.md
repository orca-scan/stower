# stower

[![license](https://img.shields.io/github/license/orca-scan/stower)](https://github.com/orca-scan/stower/blob/master/LICENSE)
[![Tests](https://github.com/orca-scan/stower/actions/workflows/ci.yml/badge.svg)](https://github.com/orca-scan/stower/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/stower)](https://www.npmjs.com/package/stower)

Stower is a simple disk backed key/value store for node.

**Why?** because sometimes you just need to _stow_ a few values, no database, no fuss. `stower` keeps your data in memory and writes it to disk as a readable JSON file in the background. It handles atomic saves, uses file locks to avoid conflicts, recovers from corrupt files, and stores everything in your systems cache folder _(when no path provided)_.

## Install

```bash
npm install stower
```

## Usage

```js
var stower = require('stower');

// persist (optional JSON file path)
stower.persist('./stow.json');

// enable debugging (console logs)
stower.debug = true;

// store some data
stower.set('token', { id: '123', key: 'abc' });

// retrieve it
var token = stower.get('token');

// check it exists
if (stower.exists('token')) {
    console.log('token exists');
}

// remove it
stower.remove('token');

// view all keys
console.log(stower.keys());

// view all values
console.log(stower.values());

// get the JSON file name and path
console.log(stower.filename);

// clear everything
stower.clear();
```

### Properties

Property   | Description
:----------|:---------------------------------------------
`filename` | Returns filename used so store data on disk
`debug`    | Get/set debug status _(enables console logs)_

### Methods

Method              | Description
:-------------------|:-------------------------------------------------------------------------------------
`get(key)`          | Retrieves a value by key, returns `null` if the key doesn't exist
`set(key, value)`   | Stores a value and schedules it to be saved to disk
`remove(key)`       | Deletes a key from the store and schedules the update to disk
`exists(key, val)`  | Checks if a key exists and optionally if it matches a given value using deep equality
`keys()`            | Returns an array of all stored keys
`values()`          | Returns an array of all stored values
`clear()`           | Deletes all stored data and schedules a save to disk
`persist(filename)` | Loads previously saved values from disk and auto saves changes _(optional filename)_

Note: if `persist()` is not called, values only exist in memory.

## Contributing

As always, pull requests are welcomed - but please ensure you provide a test where necesssary.

### Tests

You can run the tests using `npm test`

### Star

If you find this useful please star the repo, it helps us prioritise Open Source work.

## History

For change-log, check [releases](https://github.com/orca-scan/stower/releases).

## License

[MIT License](LICENSE) © Orca Scan - a [barcode app](https://orcascan.com) with simple [barcode tracking APIs](https://orcascan.com/guides?tag=for-developers).

## TODO

* Add more [Jasmine tests](./tests/) _(PRs welcome)_