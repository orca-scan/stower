# stow

[![Tests](https://github.com/orca-scan/stow/actions/workflows/ci.yml/badge.svg)](https://github.com/orca-scan/stow/actions/workflows/ci.yml)

Simple disk based key/value store for Node.js.

Sometimes you just want to **stow** a few values away for safekeeping—without spinning up a database or pulling in a giant dependency. `stow` is a dead-simple, reliable way to persist structured data across sessions using a readable JSON file. It’s an in-memory key/JSON store with disk persistence, atomic writes using temporary files and locks, optional deep equality checks on `exists`, automatic recovery from corrupt JSON files, and safe default storage in the OS-specific cache folder. It also flushes automatically on `SIGINT` and `process.exit`, making it ideal for storing tokens, preferences, or scanned barcode data.

## Install

```bash
npm i git+ssh://git@github.com/orca-scan/stow.git
```

## Usage

```js
var stow = require('stow');

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

// clear everything
stow.clear();
```

### Methods

Method                | Description
:---------------------|:-----------------------------------------------------------------------------------------------
`persist([filename])` | Loads previously saved values from disk, or creates a new empty store if the file doesn't exist
`set(key, value)`     | Stores a value under a given key and schedules it to be saved to disk
`get(key)`            | Retrieves a value by key, returns `null` if the key doesn't exist
`exists(key, [val])`  | Checks if a key exists, or optionally if it matches a given value using deep equality
`remove(key)`         | Deletes a key from the store and schedules the update to disk
`all()`               | Returns an array of all stored values
`clear()`             | Deletes all stored data and schedules a save to disk

## Contributing

Pull requests are welcomed:

1. Fork it!
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -m 'Add some feature'`
4. Push to the branch: `git push origin my-new-feature`
5. Submit a pull request

## Star the repo

If you find this useful ⭐ the repo, it helps me prioritise which bugs to work on.

## History

For change-log, check [releases](https://github.com/orca-scan/stow/releases).

## License

[MIT License](LICENSE) © Orca Scan - a [barcode app](https://orcascan.com) with simple [barcode tracking APIs](https://orcascan.com/guides?tag=for-developers).