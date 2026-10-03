// Tiny IndexedDB wrapper shared by the background, popup and viewer.
const ConsoleDB = (() => {
  const NAME = 'console-capture';
  const STORE = 'entries';
  const SURFACE = 'surface';
  const RUNTIME = 'runtime';
  let dbPromise;

  const open = () => (dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 4);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      // Surface entries are keyed by host+path+arity so a route re-sweep upserts instead of duplicating.
      if (!db.objectStoreNames.contains(SURFACE)) db.createObjectStore(SURFACE, { keyPath: 'key' });
      // Runtime signals (storage/globals/postMessage/network), keyed for dedup, upserted with a count.
      if (!db.objectStoreNames.contains(RUNTIME)) db.createObjectStore(RUNTIME, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

  const result = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function add(entries) {
    const tx = (await open()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const e of entries) store.add(e);
    return done(tx);
  }

  async function count() {
    return result((await open()).transaction(STORE).objectStore(STORE).count());
  }

  async function all() {
    return result((await open()).transaction(STORE).objectStore(STORE).getAll());
  }

  async function clear() {
    const tx = (await open()).transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    return done(tx);
  }

  // Keys are auto-incremented, so the lowest ones are the oldest entries.
  async function prune(max) {
    const excess = (await count()) - max;
    if (excess <= 0) return;
    const tx = (await open()).transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys(null, excess);
    req.onsuccess = () => {
      const keys = req.result;
      if (keys.length) store.delete(IDBKeyRange.bound(keys[0], keys[keys.length - 1]));
    };
    return done(tx);
  }

  // Upsert surface records. Tracks change history (last 5 snapshots) when snippet or params change.
  async function surfacePut(items) {
    const tx = (await open()).transaction(SURFACE, 'readwrite');
    const store = tx.objectStore(SURFACE);
    for (const it of items) {
      const prev = await result(store.get(it.key)).catch(() => null);
      if (prev) {
        const changed = prev.snippet !== it.snippet
                     || JSON.stringify(prev.params) !== JSON.stringify(it.params);
        const history = Array.isArray(prev.history) ? prev.history : [];
        if (changed) {
          history.unshift({ ts: prev.ts, snippet: prev.snippet, params: prev.params, source: prev.source });
          if (history.length > 5) history.length = 5;
        }
        store.put({
          ...prev, ...it,
          source: it.source || prev.source,
          scriptOrigin: it.scriptOrigin || prev.scriptOrigin || '',
          firstSeen: prev.firstSeen || prev.ts || Date.now(),
          history,
        });
      } else {
        store.put({ ...it, history: [], scriptOrigin: it.scriptOrigin || '', firstSeen: it.ts || Date.now() });
      }
    }
    return done(tx);
  }

  async function surfaceAll() {
    return result((await open()).transaction(SURFACE).objectStore(SURFACE).getAll());
  }

  async function surfaceCount() {
    return result((await open()).transaction(SURFACE).objectStore(SURFACE).count());
  }

  async function surfaceClear() {
    const tx = (await open()).transaction(SURFACE, 'readwrite');
    tx.objectStore(SURFACE).clear();
    return done(tx);
  }

  // Upsert runtime signals, bumping a count + lastTs when the same key reappears.
  async function runtimePut(items) {
    const tx = (await open()).transaction(RUNTIME, 'readwrite');
    const store = tx.objectStore(RUNTIME);
    for (const it of items) {
      const prev = await result(store.get(it.key)).catch(() => null);
      if (prev) store.put({ ...prev, ...it, firstTs: prev.firstTs || prev.ts, count: (prev.count || 1) + 1 });
      else store.put({ ...it, firstTs: it.ts, count: 1 });
    }
    return done(tx);
  }

  async function runtimeAll() {
    return result((await open()).transaction(RUNTIME).objectStore(RUNTIME).getAll());
  }

  async function runtimeCount() {
    return result((await open()).transaction(RUNTIME).objectStore(RUNTIME).count());
  }

  async function runtimeClear() {
    const tx = (await open()).transaction(RUNTIME, 'readwrite');
    tx.objectStore(RUNTIME).clear();
    return done(tx);
  }

  return {
    add, count, all, clear, prune,
    surfacePut, surfaceAll, surfaceCount, surfaceClear,
    runtimePut, runtimeAll, runtimeCount, runtimeClear,
  };
})();
