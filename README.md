# stow-it

[![Tests](https://github.com/orca-scan/stow-it/actions/workflows/ci.yml/badge.svg)](https://github.com/orca-scan/stow-it/actions/workflows/ci.yml)

Stow is a simple disk backed key/value store for node.

**Why?** because sometimes you just need to `stow-it` a few values, no database, no fuss. `stow-it` keeps your data in memory and writes it to disk as a readable JSON file. It handles atomic saves, uses file locks to avoid conflicts, recovers from corrupt files, and stores everything in your system’s cache folder _(if no path provided)_.

## Install

```bash
npm i stow-it
```

## Usage

```js
var stow = require('stow-it');

// persist to default location
stow.persist();

// enable debugging
stow.debug = true;

// store some data
stow.set('token', { id: '123', key: 'abc' });

// retrieve it
var token = stow.get('token');

// check it exists
if (stow.exists('token')) {
    console.log('token exists');
}

// remove it
stow.remove('token');

// view all
console.log(stow.all());

// get the JSON file name and path
console.log(stow.filename);

// clear everything
stow.clear();
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

## Contributing

Pull requests are welcomed:

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -m 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a PR

### How to run tests

```bash
npm i
npm test
```

## Star the repo

If you find this useful ⭐ the repo, it helps us prioritise Open Source issues.

## History

For change-log, check [releases](https://github.com/orca-scan/stow-it/releases).

## License

[MIT License](LICENSE) © Orca Scan - a [barcode app](https://orcascan.com) with simple [barcode tracking APIs](https://orcascan.com/guides?tag=for-developers).

## TODO

* Add more [Jasmine tests](./tests/) _(PRs welcome)_
* Ensure `husky` prevents `fit`, `fdescribe` comits