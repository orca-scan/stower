# Code Analysis — stower

A thorough review of `index.js` (v3.2.1) covering bugs, race conditions,
edge-cases, design trade-offs and minor style issues.

---

## 1. Confirmed Bugs

### 1.1 ES6 spread in `log()` breaks the ES5 contract

```js
console.log('[stower]', ...args);
```

The rest of the codebase deliberately avoids ES6+ constructs (`var`
everywhere, `function` expressions, manual `Array.prototype.slice`).
The spread operator here will crash on any Node version below v5 and
violates the project's own coding conventions. It should be:

```js
console.log.apply(console, ['[stower]'].concat(args));
```

### 1.2 `readDiskSnapshot()` has a TOCTOU (Time-of-check to time-of-use) window on mtime

```js
var raw = fs.readFileSync(_FILE, 'utf8');
var parsed = parseStoreJson(raw);
return { store: parsed.store, expires: parsed.expires, mtime: fs.statSync(_FILE).mtimeMs };
```

`statSync` runs *after* `readFileSync`. If another process writes the file
between the two calls, the returned `mtime` belongs to the **newer** file
while `store`/`expires` belong to the **older** content. On the next
`load()`, the mtime check (`mtime === _lastMtime`) will be satisfied, so
the newer content is silently skipped. Fix: call `statSync` **before**
`readFileSync`, or accept the tiny inconsistency and document it.

---

## 2. Race Conditions & Concurrency Risks

### 2.1 `write()` lock-then-read is not truly atomic

The write path is:

1. Acquire lock
2. `readDiskSnapshot()` — read file + parse
3. Overlay pending ops
4. Write temp file → rename

Between steps 2 and 4, another process that has *already* acquired and
released the lock can commit a newer version. The current process then
overwrites it. This is mitigated by the fact that `proper-lockfile` holds
the lock across the entire read-merge-write span, so a true interleave
requires a stale-lock takeover (which is bounded by `LOCK_STALE_MS`).

**Risk:** Low in practice, but under extreme contention with long GC pauses
exceeding `LOCK_STALE_MS` (15 s), data from another process can be lost.

### 2.2 `flush()` retry loop may not converge

```js
for (var pass = 0; pass < FLUSH_RETRY_PASSES; pass++) {
    if (!hasPendingChanges()) return;
    write(true);
}
```

If `write(true)` consistently fails (e.g. lock acquisition fails after
320 attempts), pending changes survive all 3 passes and are silently
dropped when the process exits. There is no warning or fallback.

### 2.3 `clear()` + concurrent `set()` within debounce window

```
Process A: set('x', 1)   // trackSet('x'), save() schedules timer
Process A: clear()        // _pendingOps = {}, _clearPending = true, new timer
Process A: set('y', 2)   // trackSet('y'), reschedules timer
```

When the timer fires, `overlayPending` starts from an empty baseline
(`_clearPending` is true) and applies only `{ y: set }`. Key `x` is
correctly lost. This is the **intended** behaviour, but it may surprise
callers who expected `set → clear → set` to retain *only* the post-clear
set. It does — this is fine, just worth documenting.

---

## 3. Edge-Cases & Gotchas

### 3.1 Falsy-but-valid values

```js
if (name === undefined || name === null || value === undefined || value === null) return;
```

This correctly allows `0`, `false`, and `''` as values. However, `normalizeKey('')` returns `''`,
and the next guard `if (!key || ...)` catches it. This is correct but
relies on a two-step guard that could be fragile if refactored.

### 3.2 `__expires__` is a reserved key with a silent reject

`set('__expires__', ...)` silently returns. There is no error or warning.
This is documented in the module header comment but could surprise users
who choose that key name unknowingly.

### 3.3 Singleton module state

The module exports a single global instance. Two calls to `persist()` with
different filenames will switch the backing file, but `_store`, `_expires`,
and `_pendingOps` are all reset — any unflushed data from the previous
file is **lost**. This is a foot-gun for libraries that try to use stower for multiple files.

### 3.4 `sleepSync` blocks the event loop

`sleepSync` is used during `persist()` startup retries and lock acquisition
retries. During lock contention:

```
max wait = LOCK_ATTEMPTS_NORMAL × (LOCK_RETRY_BASE_MS + LOCK_RETRY_JITTER_MS)
         = 100 × (80 + 160) = 24,000 ms (worst case)
```

This is a 24-second synchronous block of the event loop. For the flush
path (`LOCK_ATTEMPTS_FLUSH = 320`), worst case is ~76 seconds. This is
acceptable *only* on process exit; in normal write paths it could stall
an HTTP server.

**Mitigation:** Normal write path failures schedule a retry via `save()` rather than blocking further.

### 3.5 `load()` trusts file mtime for cache invalidation

Filesystem mtime resolution varies:
- HFS+ (macOS): 1 second
- ext4 (Linux): 1 nanosecond (but can be 1 second with `relatime`)
- NFS/CIFS: varies wildly

If two writes occur within the same mtime granularity window, the second
write will not be detected by `load()`. This is a real risk on macOS HFS+ volumes.

### 3.6 `normalizeKey` lowercases — potential collision

`set('API_KEY', x)` and `set('api_key', y)` write to the same slot.
This is intentional but undocumented in the README. Could surprise users
with mixed-case keys.

### 3.7 `process.exit()` in signal handlers

```js
process.on('SIGINT', function () { flush(); process.exit(); });
```

`process.exit()` without an argument defaults to exit code 0. Some
container orchestrators and process managers expect non-zero exit on
signal termination. Consider `process.exit(128 + signalNumber)`.

### 3.8 Temp file collision after PID reuse

`_TEMP = _FILE + '.' + process.pid + '.tmp'` is unique per process, but
if a process crashes without cleaning up its temp file and the OS reuses
the PID, the new process's temp file will collide. This is mitigated by
`cleanOrphanedTempFiles()` during `persist()`, which removes stale `.tmp`
files — so the risk is very low.

---

## 4. Robustness Concerns

### 4.1 No schema versioning in the JSON file

The file format relies on a magic `__expires__` key. If the schema ever
changes (e.g. a future `__version__` or `__meta__` key), there is no
migration path. Old versions of stower reading a new-format file will
silently treat new metadata keys as user data.

### 4.2 No file size or key count limits

A runaway loop calling `set()` with unique keys will grow the JSON file
unboundedly. There is no eviction policy, no max-size guard, and no
warning when the file exceeds a reasonable size. `JSON.stringify` and
`JSON.parse` on very large objects will also cause GC pressure and
event-loop stalls.

### 4.3 `JSON.stringify` can throw on circular references

If a caller passes a circular object to `set()`, it is accepted into
`_store` without error. The crash happens later, asynchronously, inside
`write()` when `JSON.stringify` throws. The error is caught and logged,
but the key remains in `_store` and `_pendingOps`, causing every
subsequent write attempt to fail until `remove()` or `clear()` is called.

### 4.4 Atomic rename is not atomic on Windows

`fs.renameSync` is atomic on POSIX but not guaranteed on Windows (NTFS).
The module header documents this, but there is no Windows-specific
fallback.

---

## 5. Test Coverage Observations

### 5.1 Flaky multiprocess tests

The `should preserve all 400 keys with 8 concurrent flushes` test has been
observed to fail intermittently. Under heavy lock contention, the
`LOCK_ATTEMPTS_NORMAL` budget can be exhausted, causing some workers to
silently drop their writes.

### 5.2 TTL multiprocess test fragility

`should preserve TTL entries from both processes` depends on both workers
finishing their lock-acquire-merge-write cycle. Under CI load, this can
fail if one worker's entire debounce + flush completes before the other
starts.

### 5.3 No test for circular reference in `set()`

There is no test verifying behaviour when a circular object is passed to
`set()`. This is a real-world edge case that causes silent write failures.

---

## 6. Minor Style / Consistency Issues

| Issue | Location | Note |
|---|---|---|
| ES6 spread in `log()` | `index.js:101` | Only ES6 usage in the file — see bug 1.1 |
| `exists()` lost its 2nd argument | Public API | Original API had `exists(key, val)` for deep equality. Current version only checks presence — README still documents the 2-arg form |
| `cloneMap` is a shallow clone | `index.js:57` | Nested objects are shared references. Mutating a value returned by `get()` mutates `_store` directly |
| `createDebugWrappedMethod` adds overhead | `index.js:627` | Every API call goes through an extra function layer even when debug is off |

---

## 7. Security Considerations

### 7.1 JSON file is world-readable by default

The persisted JSON file inherits the process's umask. On systems with a
permissive umask (e.g. `0022`), the file is readable by all users. If
sensitive data (tokens, API keys) is stored, this is a data exposure risk.

### 7.2 No input sanitisation on key names

Key names pass through `normalizeKey` (trim + lowercase) but are otherwise
unconstrained. Keys like `__proto__` are safe because `_store` uses
`Object.create(null)`.

### 7.3 `JSON.parse` of untrusted file content

If the JSON file is writable by another user, a malicious payload could
be crafted. `JSON.parse` itself is safe (no code execution), and
`Object.create(null)` prevents prototype pollution. The `normalizeExpires`
function validates that expiry values are finite numbers. Overall this is
handled well.

---

## Summary

| Severity | Count | Key Items |
|---|---|---|
| Bug | 2 | ES6 spread in `log()`, TOCTOU in `readDiskSnapshot()` |
| Race condition | 3 | Lock-then-read gap, flush retry exhaustion, clear+set ordering |
| Edge-case | 8 | Singleton state, sleepSync blocking, mtime resolution, key collisions |
| Robustness | 4 | No size limits, circular refs crash writes, no schema versioning |
| Style | 4 | Spread inconsistency, shallow clone, debug wrapper overhead |
| Security | 1 | World-readable file by default |
