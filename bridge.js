// Isolated-world relay: receives entries from inject.js (page world) and batches them to the background.
(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const EVENT = 'console-capture:entry';
  const SURFACE = 'console-capture:surface';
  const RUNTIME = 'console-capture:runtime';
  const HELLO = 'console-capture:hello';
  const READY = 'console-capture:ready';
  const CONFIG = 'console-capture:config';
  const FLUSH_MS = 300;
  const MAX_BATCH = 200;

  const dead = () => {}; // extension reloaded/removed: this page's relay is done

  // A batched channel: queues items and flushes them to the background as one message.
  function channel(type, key) {
    let queue = [];
    let timer = null;
    function flush() {
      clearTimeout(timer);
      timer = null;
      if (!queue.length) return;
      const items = queue;
      queue = [];
      try { api.runtime.sendMessage({ type, [key]: items })?.catch?.(dead); } catch { /* dead */ }
    }
    function push(items) {
      for (const it of items) queue.push(it);
      if (queue.length >= MAX_BATCH) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS);
    }
    return { push, flush };
  }

  const entries = channel('console-capture:entries', 'entries');
  const runtime = channel('console-capture:runtime', 'items');

  document.addEventListener(EVENT, (e) => {
    let entry;
    try { entry = JSON.parse(e.detail); } catch { return; }
    if (entry && typeof entry === 'object') entries.push([entry]);
  });

  document.addEventListener(SURFACE, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (!msg || !Array.isArray(msg.items)) return;
    try { api.runtime.sendMessage({ type: 'console-capture:surface', items: msg.items, frameUrl: msg.frameUrl })?.catch?.(dead); } catch { /* dead */ }
  });

  document.addEventListener(RUNTIME, (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (!msg || !Array.isArray(msg.items)) return;
    for (const it of msg.items) it.frameUrl = msg.frameUrl;
    runtime.push(msg.items);
  });

  // Hand the page world its config (captureSurface/captureRuntime) and push later changes.
  const CONFIG_KEYS = { captureSurface: true, captureRuntime: true };
  async function currentConfig() {
    try { return await api.storage.local.get(CONFIG_KEYS); } catch { return CONFIG_KEYS; }
  }
  function pushConfig(config) {
    try { document.dispatchEvent(new CustomEvent(CONFIG, { detail: JSON.stringify(config) })); } catch {}
  }
  api.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && ('captureSurface' in changes || 'captureRuntime' in changes)) currentConfig().then(pushConfig);
  });

  // Handshake works whichever script runs first; READY carries the initial config.
  async function announce() {
    document.dispatchEvent(new CustomEvent(READY, { detail: JSON.stringify(await currentConfig()) }));
  }
  document.addEventListener(HELLO, announce);
  announce();

  addEventListener('pagehide', () => { entries.flush(); runtime.flush(); });
})();
