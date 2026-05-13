# Documentation - stower

A developer-oriented guide to the stower codebase: what it does, how it works internally, and nuances to watch for.

---

## What stower does

stower is a **singleton, disk-backed, in-memory key/value store** for Node.js. It keeps all data in a plain JavaScript object for fast reads, and asynchronously persists changes to a JSON file on disk. It is designed to be shared across multiple processes or Docker containers reading and writing the same file.

**Core capabilities:**

- `set(key, value, expiresInSeconds)` - store a value with optional TTL
- `get(key)` - retrieve a value (returns null if missing or expired)
- `remove(key)` - delete a key
- `exists(key)` - check if a non-expired key exists
- `keys()` / `values()` - list all non-expired keys/values
- `clear()` - wipe all data
- `persist(filename)` - point the store at a JSON file for disk persistence

---

## Architecture overview

```
  Caller
    |
    v
  Public API (api object) - debug-wrapped methods
  set / get / remove / ...
    |
    +--------+--------+
    |                 |
    v                 v
  Reads             Writes
  load()            trackSet() / trackRemove()
    |               save() -> debounce 1s -> write()
    v                                        |
  statSync          write():
  (mtime check)      1. acquireLock()
    |                 2. readDiskSnapshot()
    v                 3. overlayPending()
  readFileSync        4. pruneExpired()
  parseStoreJson      5. writeFileSync(tmp)
  applySnapshot       6. renameSync(-> file)
                      7. finalizeCommit()
                      8. release lock
```

---

## Module state

All state lives in module-level variables (singleton pattern):

| Variable | Purpose |
|---|---|
| _FILE | Absolute path to the JSON data file |
| _TEMP | Per-PID temp file for atomic writes |
| _BACKUP | Path for corrupt file backups |
| _store | In-memory key->value map (Object.create(null)) |
| _expires | In-memory key->expiry timestamp map |
| _pendingOps | Overlay of uncommitted set/remove operations |
| _clearPending | Flag: clear() called but not yet flushed |
| _lastMtime | File mtime when last read - cache invalidation |
| _timer | Handle for the debounced write() timer |
| _debuggingEnabled | Debug logging toggle |

---

## How reads work

Every read method (get, exists, keys, values) calls load() first.

load() logic:

1. If _FILE is not set, return immediately (no persistence configured)
2. statSync(_FILE) to get current mtime
3. If mtime matches _lastMtime, return (file has not changed)
4. Read and parse the file via readDiskSnapshot()
5. Call applyLoadedSnapshot(), which calls overlayPending() to re-apply any uncommitted local changes on top of the fresh disk state, then updates _store, _expires, and _lastMtime

This means reads always see the latest disk state merged with any pending local writes - another process changes are picked up automatically.

---

## How writes work

### The debounce cycle

1. set() / remove() / clear() update _store and _expires in memory immediately
2. The operation is recorded in _pendingOps via trackSet() or trackRemove()
3. save() clears any existing timer and schedules write() after DEBOUNCE_MS (1s)
4. Rapid successive calls reset the timer - only the last one triggers a write

### The write() function

1. Ensure file exists - create {} if missing (proper-lockfile requires an existing file)
2. Acquire lock - proper-lockfile.lockSync() with retry/jitter/stale detection
3. Read current disk state - readDiskSnapshot() (skipped if _clearPending is true)
4. Merge - overlayPending() replays _pendingOps on top of the disk baseline
5. Prune expired - pruneExpired() removes entries whose TTL has passed
6. Atomic write - writeFileSync to a PID-specific temp file, then renameSync over the real file
7. Finalize - finalizeCommit() syncs _store/_expires, clears _pendingOps/_clearPending, updates _lastMtime
8. Release lock

If any step fails, the error is logged and (for non-flush writes) save() is called to retry.

### Process exit

flush() is called on exit, SIGINT, and SIGTERM. It bypasses the debounce timer and calls write(true) synchronously up to FLUSH_RETRY_PASSES (3) times with a higher lock budget (LOCK_ATTEMPTS_FLUSH = 320).

---

## How TTL / expiry works

### Setting a TTL

```js
stower.set('session', { user: 'alice' }, 60); // expires in 60 seconds
```

- The expiry timestamp (Date.now() + expiresInSeconds * 1000) is stored in _expires[key]
- It is recorded in the pending op via trackSet()
- On disk, expiry data is stored under the reserved __expires__ key

### Reading expired keys

- isExpired(key) checks if _expires[key] exists and Date.now() > _expires[key]
- get(), exists(), keys(), and values() all filter out expired keys
- Expired keys are NOT actively removed from _store on read - they are simply hidden
- They are pruned from disk on the next write via pruneExpired()

### Clearing a TTL

Re-setting a key without expiresInSeconds deletes its entry from _expires:

```js
stower.set('session', { user: 'alice' });  // no TTL clears any existing expiry
```

---

## How multi-process safety works

### Locking

proper-lockfile provides cross-process mutual exclusion via a .lock directory next to the data file. Stale timeout is LOCK_STALE_MS (15000 ms) - if a process crashes while holding the lock, another process can take over after 15 seconds.

### Merge-on-write strategy

Each process tracks its own pending operations in _pendingOps. On write:

1. The latest disk state is read (may include writes from other processes)
2. This process pending ops are replayed on top
3. The merged result is committed atomically

Writes from different processes are merged, not overwritten. Each process only touches its own dirty keys.

### The _clearPending flag

When clear() is called, the merge baseline is an empty object instead of the disk state. This ensures a clear truly wipes all data, including keys written by other processes.

---

## Key normalisation

```js
function normalizeKey(rawKey) {
    return String(rawKey || '').trim().toLowerCase();
}
```

- 'FOO', 'foo', ' foo ' all map to the same key 'foo'
- Empty strings, null, undefined normalise to '' which is rejected by the if-not-key guard
- __expires__ is a reserved key - set('__expires__', ...) silently does nothing

---

## Constants reference

| Constant | Value | Purpose |
|---|---|---|
| DEBOUNCE_MS | 1000 | Delay before writing to disk |
| STARTUP_RETRIES | 10 | Max retries for directory creation during persist() |
| STARTUP_RETRY_MS | 300 | Delay between startup retries |
| LOCK_STALE_MS | 15000 | Lock considered stale after this many ms |
| LOCK_RETRY_BASE_MS | 80 | Base delay between lock acquisition retries |
| LOCK_RETRY_JITTER_MS | 160 | Random jitter added to lock retry delay |
| LOCK_ATTEMPTS_NORMAL | 100 | Max lock retries for normal writes |
| LOCK_ATTEMPTS_FLUSH | 320 | Max lock retries for process-exit flush |
| FLUSH_RETRY_PASSES | 3 | Number of write attempts during flush |

---

## Nuances for new developers

1. **Singleton** - one store instance per process. Calling persist() with a different filename resets everything; unflushed data from the previous file is lost.

2. **Reads trigger disk I/O** - every get/exists/keys/values call runs statSync(). Fast when unchanged but still a synchronous syscall per read.

3. **Writes are eventual** - set() returns immediately but data is not on disk until the debounce timer fires (~1s later). SIGKILL loses unflushed data.

4. **sleepSync blocks the event loop** - lock acquisition and startup retries use a busy-wait. Can block for seconds under contention.

5. **Shallow references** - get() returns a direct reference, not a copy. Mutating it mutates _store directly.

6. **exists() signature** - current version only checks key presence (one argument). The 2-arg deep-equality form was removed.

7. **Case-insensitive keys** - 'API_KEY' and 'api_key' are the same key.

8. **File format** - human-readable JSON with 2-space indent. __expires__ is reserved metadata. Old files without it load fine.

9. **Test helpers** - tests/helpers/spec-utils.js for utilities, worker.js for multiprocess, signal-worker.js for signal tests, stress-worker.js for stress tests.

10. **Debug mode** - stower.debug = true logs all method calls via createDebugWrappedMethod() wrappers.
