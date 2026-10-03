// Chrome runs this as a service worker (needs importScripts); Firefox loads db.js via manifest "scripts".
if (typeof importScripts === 'function') importScripts('db.js');

const api = globalThis.browser ?? globalThis.chrome;
// maxEntries 0 = keep everything forever.
const DEFAULTS = { enabled: true, captureNetwork: true, captureSurface: true, captureRuntime: true, captureTaint: true, maxEntries: 0, taintWordlist: ['canxpixo'], enabledSinks: null, taintMaxValues: 0, taintMinLen: 2 };
const LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'network']);
const PRUNE_EVERY = 1000;

let writesSincePrune = 0;

const getSettings = () => api.storage.local.get(DEFAULTS);

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

const str = (v, max = 50000) => (typeof v === 'string' ? v.slice(0, max) : '');

function normalize(e, ctx) {
  return {
    ts: Number.isFinite(e.ts) ? e.ts : Date.now(),
    level: LEVELS.has(e.level) ? e.level : 'log',
    kind: str(e.kind, 30) || 'console',
    message: str(e.message),
    source: str(e.source, 2000),
    stack: str(e.stack, 20000) || undefined,
    frameUrl: str(e.frameUrl, 2000) || ctx.frameUrl || '',
    pageUrl: ctx.pageUrl,
    host: hostOf(ctx.pageUrl),
    tabId: ctx.tabId,
  };
}

async function store(entries) {
  const { enabled, maxEntries } = await getSettings();
  if (!enabled || !entries.length) return;
  await ConsoleDB.add(entries);
  if (!maxEntries) return;
  writesSincePrune += entries.length;
  if (writesSincePrune >= PRUNE_EVERY) {
    writesSincePrune = 0;
    await ConsoleDB.prune(maxEntries);
  }
}

// Not async: in Firefox a returned promise would be treated as a reply.
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'console-capture:entries' || !Array.isArray(msg.entries)) return;
  const ctx = {
    tabId: sender.tab?.id ?? -1,
    pageUrl: sender.tab?.url || sender.url || '',
    frameUrl: sender.url,
  };
  store(msg.entries.map((e) => normalize(e, ctx))).catch((err) => console.error('console-capture:', err));
});

// Inventory of functions the page exposes as globals (recon surface), keyed host+path+arity.
function normalizeSurface(it, ctx) {
  const path = str(it.path, 400);
  const arity = Number.isInteger(it.arity) ? it.arity : 0;
  return {
    key: `${ctx.host}\n${path}\n${arity}`,
    ts: Date.now(),
    path,
    arity,
    name: str(it.name, 120),
    params: Array.isArray(it.params) ? it.params.slice(0, 12).map((p) => str(p, 60)) : [],
    native: !!it.native,
    interesting: !!it.interesting,
    reasons: Array.isArray(it.reasons) ? it.reasons.slice(0, 12).map((r) => str(r, 80)) : [],
    snippet: str(it.snippet, 2500),
    scriptOrigin: str(it.scriptOrigin, 500),
    sweepReason: str(it.sweepReason, 30),
    loadedScripts: Array.isArray(ctx.loadedScripts) ? ctx.loadedScripts.map((u) => str(u, 300)) : [],
    source: '',
    pageUrl: ctx.pageUrl,
    frameUrl: ctx.frameUrl,
    host: ctx.host,
    tabId: ctx.tabId,
  };
}

async function storeSurface(items, ctx) {
  const { enabled, captureSurface } = await getSettings();
  if (!enabled || !captureSurface || !items.length) return;
  const rows = items.map((it) => normalizeSurface(it, ctx));
  await ConsoleDB.surfacePut(rows);
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'console-capture:surface' || !Array.isArray(msg.items)) return;
  const pageUrl = sender.tab?.url || sender.url || '';
  const ctx = {
    tabId: sender.tab?.id ?? -1,
    pageUrl,
    frameUrl: str(msg.frameUrl, 2000) || sender.url || '',
    host: hostOf(pageUrl),
    loadedScripts: Array.isArray(msg.loadedScripts) ? msg.loadedScripts : [],
  };
  storeSurface(msg.items, ctx).catch((err) => console.error('console-capture:', err));
});

// Runtime signals: storage entries, global state/config, postMessage, network calls.
function runtimeKey(it, host) {
  switch (it.type) {
    case 'storage': return `${host}\nstorage\n${it.area}\n${it.name}`;
    case 'global': return `${host}\nglobal\n${it.name}`;
    case 'postmessage': return `${host}\npm\n${it.dir}\n${it.origin}\n${hashStr(it.value)}`;
    case 'netcall': return `${host}\nnet\n${it.method}\n${it.url}`;
    case 'taint': return `${host}\ntaint\n${it.sink || ''}\n${hashStr(it.taintedValue || '')}\n${hashStr(it.source || '')}`;
    default: return `${host}\n?\n${hashStr(it.value || '')}`;
  }
}

function hashStr(s) {
  let h = 5381;
  s = String(s);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const RUNTIME_TYPES = new Set(['storage', 'global', 'postmessage', 'netcall', 'taint']);

function normalizeRuntime(it, ctx) {
  const type = RUNTIME_TYPES.has(it.type) ? it.type : 'other';
  return {
    key: runtimeKey({ ...it, type }, ctx.host),
    ts: Date.now(),
    type,
    area: str(it.area, 20),
    dir: str(it.dir, 4),
    origin: str(it.origin, 300),
    method: str(it.method, 12),
    url: str(it.url, 2000),
    name: str(it.name, 300),
    source: str(it.source, 2000),
    value: str(it.value, 40000),
    secret: Array.isArray(it.secret) ? it.secret.slice(0, 10).map((s) => str(s, 40)) : [],
    sink: str(it.sink, 100),
    taintedValue: str(it.taintedValue, 200),
    stack: str(it.stack, 20000) || undefined,
    frameUrl: str(it.frameUrl, 2000) || ctx.frameUrl || '',
    pageUrl: ctx.pageUrl,
    host: ctx.host,
    tabId: ctx.tabId,
  };
}

async function storeRuntime(items, ctx) {
  const { enabled, captureRuntime, captureTaint } = await getSettings();
  if (!enabled || !items.length) return;
  const filtered = items.filter((it) => it.type === 'taint' ? captureTaint : captureRuntime);
  if (!filtered.length) return;
  await ConsoleDB.runtimePut(filtered.map((it) => normalizeRuntime(it, ctx)));
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'console-capture:runtime' || !Array.isArray(msg.items)) return;
  // taint-words: update storage with current tracked words, do not store in DB
  const wordItems = msg.items.filter((it) => it.type === 'taint-words');
  if (wordItems.length) {
    try {
      const latest = wordItems[wordItems.length - 1];
      const words = JSON.parse(latest.value || '[]');
      if (Array.isArray(words)) api.storage.local.set({ taintCaptured: words }).catch(() => {});
    } catch {}
  }
  const regularItems = msg.items.filter((it) => it.type !== 'taint-words');
  if (!regularItems.length) return;
  const pageUrl = sender.tab?.url || sender.url || '';
  const ctx = { tabId: sender.tab?.id ?? -1, pageUrl, frameUrl: sender.url || '', host: hostOf(pageUrl) };
  storeRuntime(regularItems, ctx).catch((err) => console.error('console-capture:', err));
});

// Failed requests (404, CORS, DNS...) are logged by the browser itself, not by page JS,
// so the content script can't see them. webRequest is the cross-browser way to get them.
async function recordNetwork(d, message) {
  const { captureNetwork } = await getSettings();
  if (!captureNetwork) return;
  let pageUrl = d.type === 'main_frame' ? d.url : '';
  if (!pageUrl) {
    try { pageUrl = (await api.tabs.get(d.tabId)).url || ''; } catch {}
  }
  pageUrl ||= d.documentUrl || d.initiator || '';
  await store([normalize(
    { ts: d.timeStamp, level: 'network', kind: 'network', message, source: d.type },
    { tabId: d.tabId, pageUrl, frameUrl: d.documentUrl || '' },
  )]);
}

const netFilter = { urls: ['<all_urls>'] };

api.webRequest.onCompleted.addListener((d) => {
  if (d.tabId < 0 || d.statusCode < 400) return;
  recordNetwork(d, `${d.method} ${d.url} ${d.statusCode}`).catch(() => {});
}, netFilter);

api.webRequest.onErrorOccurred.addListener((d) => {
  // Aborted requests (navigation away, cancelled fetch) are noise.
  if (d.tabId < 0 || /ABORTED/.test(d.error)) return;
  recordNetwork(d, `${d.method} ${d.url} ${d.error}`).catch(() => {});
}, netFilter);

// "ON" badge on the toolbar icon while recording.
async function updateBadge() {
  const { enabled } = await getSettings();
  await api.action.setBadgeBackgroundColor({ color: '#16a34a' });
  await api.action.setBadgeTextColor?.({ color: '#ffffff' });
  await api.action.setBadgeText({ text: enabled ? 'ON' : '' });
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'enabled' in changes) updateBadge().catch(() => {});
});
// Badges aren't persisted across browser restarts.
api.runtime.onStartup.addListener(() => updateBadge().catch(() => {}));
api.runtime.onInstalled.addListener(() => updateBadge().catch(() => {}));
updateBadge().catch(() => {});

// Seed default canary words if the list is still empty (covers existing installs).
api.storage.local.get({ taintWordlist: null }).then(({ taintWordlist }) => {
  if (!Array.isArray(taintWordlist) || taintWordlist.length === 0) {
    api.storage.local.set({ taintWordlist: DEFAULTS.taintWordlist }).catch(() => {});
  }
}).catch(() => {});
