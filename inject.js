// Runs in the page's own JS context (world: MAIN) so it sees the page's console calls.
// It has no extension APIs; entries are handed to bridge.js through DOM events.
(() => {
  const FLAG = Symbol.for('console-capture.installed');
  if (window[FLAG]) return;
  window[FLAG] = true;

  const EVENT = 'console-capture:entry';
  const SURFACE = 'console-capture:surface';
  const RUNTIME = 'console-capture:runtime';
  const HELLO = 'console-capture:hello';
  const READY = 'console-capture:ready';
  const CONFIG = 'console-capture:config';
  const TAINT_STATE = 'console-capture:taint-state';
  const MAX_TEXT = 20000;
  const MAX_DEPTH = 4;
  const MAX_KEYS = 50;
  const LEVELS = {
    log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug',
    trace: 'trace', assert: 'error', table: 'log', dir: 'log',
  };

  // Keep private references so a page that patches these globals can't break us.
  const stringify = JSON.stringify;
  const CustomEvt = CustomEvent;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;

  let busy = false;
  let bridgeReady = false;
  const early = [];

  function send(entry) {
    entry.frameUrl = location.href;
    if (!bridgeReady) {
      if (early.length < 1000) early.push(entry);
      return;
    }
    try {
      dispatch.call(document, new CustomEvt(EVENT, { detail: stringify(entry) }));
    } catch {}
  }

  // captureSurface/captureRuntime/captureTaint can be toggled from the popup; bridge relays the values.
  let config = { captureSurface: true, captureRuntime: true, captureTaint: true, taintWordlist: [], enabledSinks: null };
  const onConfig = (e) => {
    try { config = { ...config, ...JSON.parse(e.detail) }; } catch {}
    if (config.captureSurface || config.captureRuntime) scheduleSweep();
    customWords.clear();
    if (Array.isArray(config.taintWordlist)) {
      for (const w of config.taintWordlist) { const s = String(w || '').trim(); if (s.length >= (config.taintMinLen ?? TAINT_DEFAULTS.taintMinLen)) customWords.add(s); }
    }
  };
  listen.call(document, CONFIG, onConfig);
  listen.call(document, 'console-capture:request-taint-state', () => emitTaintState());

  listen.call(document, READY, (e) => {
    if (e.detail) onConfig(e);
    if (bridgeReady) return;
    bridgeReady = true;
    // Restore values captured on a previous page so cross-navigation sinks are still detected.
    // Only runs once per inject.js lifetime (bridgeReady gate above). Skipped for SPA reuse
    // since popstate/hashchange already cleared taintValues and READY doesn't re-fire.
    // Restore using updateTaint() so subsumption runs — the pre-fill scan may have already
    // added truncated/reflected values from the new page; longer restored values will
    // correctly subsume those shorter ones. No size===0 guard needed.
    if (Array.isArray(config.taintState?.values) && config.taintState.values.length > 0) {
      for (const item of config.taintState.values) {
        const v = typeof item === 'object' ? item.v : String(item);
        if (v) updateTaint(v);
      }
    }
    early.splice(0).forEach(send);
    surfaceQueue.splice(0).forEach(([items, ls]) => sendSurface(items, ls));
    runtimeQueue.splice(0).forEach(sendRuntime);
    emitTaintState();
  });
  dispatch.call(document, new CustomEvt(HELLO));

  const truncate = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… [+${s.length - MAX_TEXT} chars]` : s);

  function describeElement(el) {
    let s = `<${el.tagName.toLowerCase()}`;
    if (el.id) s += ` id="${el.id}"`;
    if (typeof el.className === 'string' && el.className) s += ` class="${el.className}"`;
    return `${s}>`;
  }

  function describe(v, depth = 0, seen = new WeakSet()) {
    const t = typeof v;
    if (v === null) return 'null';
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return depth ? stringify(v) : v;
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return `${v}n`;
    if (t === 'symbol') return v.toString();
    if (t === 'function') return `ƒ ${v.name || 'anonymous'}()`;
    try {
      if (v instanceof Error) return `${v.name}: ${v.message}${depth === 0 && v.stack ? `\n${v.stack}` : ''}`;
      if (v instanceof Element) return describeElement(v);
      if (v instanceof Node) return v.nodeName.toLowerCase();
      if (v === window) return '[Window]';
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
    } catch {}
    if (seen.has(v)) return '[Circular]';
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? `Array(${v.length})` : '{…}';
    seen.add(v);
    try {
      const more = (n) => (n > MAX_KEYS ? [`…+${n - MAX_KEYS}`] : []);
      if (Array.isArray(v)) {
        const items = v.slice(0, MAX_KEYS).map((x) => describe(x, depth + 1, seen));
        return `[${items.concat(more(v.length)).join(', ')}]`;
      }
      if (v instanceof Map) {
        const items = [...v].slice(0, MAX_KEYS).map(([k, x]) => `${describe(k, depth + 1, seen)} => ${describe(x, depth + 1, seen)}`);
        return `Map(${v.size}) {${items.concat(more(v.size)).join(', ')}}`;
      }
      if (v instanceof Set) {
        const items = [...v].slice(0, MAX_KEYS).map((x) => describe(x, depth + 1, seen));
        return `Set(${v.size}) {${items.concat(more(v.size)).join(', ')}}`;
      }
      const keys = Object.keys(v);
      const name = v.constructor?.name;
      const items = keys.slice(0, MAX_KEYS).map((k) => {
        let val;
        try { val = describe(v[k], depth + 1, seen); } catch { val = '[getter threw]'; }
        return `${k}: ${val}`;
      });
      return `${name && name !== 'Object' ? `${name} ` : ''}{${items.concat(more(keys.length)).join(', ')}}`;
    } catch {
      return '[unserializable]';
    } finally {
      seen.delete(v);
    }
  }

  // Applies console format specifiers (%s %d %o %c ...) like DevTools does.
  function format(args) {
    const parts = [];
    let next = 0;
    if (typeof args[0] === 'string' && args[0].includes('%')) {
      next = 1;
      parts.push(args[0].replace(/%[sdifoOc%]/g, (m) => {
        if (m === '%%') return '%';
        if (next >= args.length) return m;
        const a = args[next++];
        switch (m) {
          case '%c': return '';
          case '%d': case '%i': return String(parseInt(a, 10));
          case '%f': return String(parseFloat(a));
          case '%s': return typeof a === 'string' ? a : describe(a, 1);
          default: return describe(a);
        }
      }));
    }
    for (let i = next; i < args.length; i++) parts.push(describe(args[i]));
    return truncate(parts.join(' '));
  }

  const stackLines = () => (new Error().stack || '').split('\n').map((l) => l.trim()).filter((l) => l && l !== 'Error');
  // Where this script lives, as stack traces name it: chrome-extension://…/inject.js in Chrome,
  // "<anonymous code>" in Firefox.
  const SELF = (stackLines()[0] || '').replace(/^at /, '').replace(/^[^(@]*[(@]/, '').replace(/(:\d+)+\)?$/, '');

  // Stack frames minus our own wrapper frames.
  function pageFrames() {
    return stackLines().filter((l) => !(SELF && l.includes(SELF)) && !l.includes('extension://'));
  }

  function record(level, args, withStack) {
    const frames = pageFrames();
    send({
      ts: Date.now(),
      level,
      kind: 'console',
      message: format(args),
      source: (frames[0] || '').replace(/^at /, ''),
      stack: withStack ? frames.join('\n') : undefined,
    });
  }

  for (const method of Object.keys(LEVELS)) {
    const original = console[method];
    if (typeof original !== 'function') continue;
    console[method] = function (...args) {
      if (!busy) {
        busy = true;
        try {
          if (method !== 'assert') record(LEVELS[method], args, method === 'trace');
          else if (!args[0]) record('error', ['Assertion failed:', ...args.slice(1)], true);
        } catch {} finally {
          busy = false;
        }
      }
      return original.apply(this, args);
    };
  }

  listen.call(window, 'error', (e) => {
    try {
      send({
        ts: Date.now(),
        level: 'error',
        kind: 'exception',
        message: `Uncaught ${e.error ? describe(e.error, 1) : e.message}`,
        source: e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
        stack: e.error?.stack,
      });
    } catch {}
  });

  listen.call(window, 'unhandledrejection', (e) => {
    try {
      const r = e.reason;
      send({
        ts: Date.now(),
        level: 'error',
        kind: 'exception',
        message: `Uncaught (in promise) ${describe(r, 1)}`,
        source: '',
        stack: r instanceof Error ? r.stack : undefined,
      });
    } catch {}
  });

  listen.call(document, 'securitypolicyviolation', (e) => {
    send({
      ts: Date.now(),
      level: 'error',
      kind: 'csp',
      message: `CSP bloqueou ${e.blockedURI || '(inline)'} — diretiva "${e.violatedDirective}"`,
      source: e.sourceFile ? `${e.sourceFile}:${e.lineNumber}:${e.columnNumber}` : '',
    });
  });

  // --- Exposed-globals surface mapping ---
  // Walks the page's own global objects (things the app added on top of the browser's
  // built-ins) and catalogs every reachable function, so callable recon surface — e.g. an
  // app.api.fetch(url) that a route change unlocks — is inventoried per host. It never calls
  // any function it finds; it only reads signatures. Re-runs on SPA route changes.
  const surfaceQueue = [];
  const sentKeys = new Set();
  let sweepTimer = null;
  let baseline = null;
  let pendingSweepReason = 'init';

  // Params/keywords that make a function worth a closer look for SSRF / redirect / DOM XSS.
  const HINT = /^(url|uri|href|endpoint|api|path|method|verb|redirect|redir|return|returnurl|next|callback|cb|src|source|target|dest|destination|host|domain|link|location|loc|proxy|webhook|hook|html|dom|markup|template|tpl|action|route|address|addr|remote|fetch|request|req|payload)$/i;
  const BODY_SINK = /(fetch\s*\(|XMLHttpRequest|\.open\s*\(|\baxios\b|\.ajax\s*\(|WebSocket|EventSource|sendBeacon|innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|\.href\s*=|location\s*=|location\.(?:href|assign|replace)|window\.open|\beval\s*\(|new Function|import\s*\()/;

  // A hidden about:blank iframe gives the pristine list of browser built-ins, so anything on
  // this page's window that isn't in it was added by page scripts.
  function getBaseline() {
    if (baseline) return baseline;
    baseline = new Set(['constructor', 'prototype', '__proto__', 'caches', 'trustedTypes']);
    try {
      // If we're inside a sandboxed frame that doesn't allow scripts, creating a child iframe
      // triggers a browser-level console warning we can't silence. Detect and bail early.
      // Same-origin parent: frameElement is accessible.
      const fe = window.frameElement;
      if (fe !== null) {
        const sb = fe.getAttribute('sandbox');
        if (sb !== null && !sb.includes('allow-scripts')) return baseline;
      }
      // Sandboxed frame without allow-same-origin: origin is the string "null".
      if (window.origin === 'null') return baseline;

      const f = document.createElement('iframe');
      f.style.display = 'none';
      // No sandbox attribute needed: about:blank with no content has pristine globals.
      (document.body || document.documentElement).appendChild(f);
      const cw = f.contentWindow;
      f.remove();
      if (cw) for (const n of Object.getOwnPropertyNames(cw)) baseline.add(n);
    } catch {}
    return baseline;
  }

  function signatureOf(fn) {
    let src = '';
    try { src = Function.prototype.toString.call(fn); } catch { return { params: [], native: true, body: '' }; }
    if (src.includes('[native code]')) return { params: [], native: true, body: '' };
    let params = [];
    const open = src.indexOf('(');
    if (open !== -1 && (src.lastIndexOf('=>') === -1 || open < src.indexOf('=>'))) {
      const close = src.indexOf(')', open);
      if (close !== -1) {
        params = src.slice(open + 1, close).split(',')
          .map((p) => p.trim().split('=')[0].trim().replace(/^\.{3}/, ''))
          .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p)).slice(0, 12);
      }
    } else {
      const arrow = src.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
      if (arrow) params = [arrow[1]];
    }
    return { params, native: false, body: src.slice(0, 4000) };
  }

  function recordFn(path, fn, out, sweepReason) {
    const { params, native, body } = signatureOf(fn);
    const key = `${path}/${fn.length}`;
    if (sentKeys.has(key)) return;
    sentKeys.add(key);
    const reasons = [];
    for (const p of params) if (HINT.test(p)) reasons.push(`param:${p}`);
    const sink = !native && body.match(BODY_SINK);
    if (sink) reasons.push(`body:${sink[0].replace(/[\s(=]+$/, '')}`);
    const srcMatch = body.match(/\/\/[#@]\s*sourceURL=\s*(\S+)/);
    const mapMatch = !srcMatch && body.match(/\/\/[#@]\s*sourceMappingURL=\s*(\S+)/);
    const scriptOrigin = srcMatch ? srcMatch[1].trim()
      : mapMatch ? mapMatch[1].trim().replace(/\.map$/, '')
      : '';
    out.push({
      path,
      arity: fn.length,
      name: fn.name || '',
      params,
      native,
      interesting: reasons.length > 0,
      reasons,
      snippet: native ? '[native code]' : body.slice(0, 2000).replace(/\s+/g, ' ').trim(),
      ts: Date.now(),
      sweepReason: sweepReason || 'init',
      scriptOrigin,
    });
  }

  // Live set of <script src> URLs — populated at init and kept current by MutationObserver.
  const loadedScriptSet = new Set();
  try {
    for (const s of document.querySelectorAll('script[src]')) { if (s.src) loadedScriptSet.add(s.src); }
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeName === 'SCRIPT' && n.src) loadedScriptSet.add(n.src);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {}

  function sweep(sweepReason) {
    const skip = getBaseline();
    const out = [];
    const seen = new WeakSet();
    const visit = (path, v, depth) => {
      if (out.length >= 2000) return;
      const t = typeof v;
      if (t === 'function') { try { recordFn(path, v, out, sweepReason); } catch {} return; }
      if (t !== 'object' || v === null || depth >= 3 || seen.has(v)) return;
      try { if (v === window || v.nodeType || v instanceof Node || v instanceof Element) return; } catch { return; }
      seen.add(v);
      let keys;
      try { keys = Object.getOwnPropertyNames(v); } catch { return; }
      if (keys.length > 250) return; // sprawling library object; skip to avoid noise and cost
      for (const k of keys) {
        if (k === 'constructor' || k === 'prototype' || k === '__proto__') continue;
        let cv;
        try {
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || d.get) continue; // never trigger getters — they can have side effects
          cv = d.value;
        } catch { continue; }
        visit(`${path}.${k}`, cv, depth + 1);
      }
    };
    let roots;
    try { roots = Object.getOwnPropertyNames(window); } catch { return; }
    for (const k of roots) {
      if (skip.has(k) || /^(webkit|moz|chrome)/i.test(k)) continue;
      let v;
      try {
        const d = Object.getOwnPropertyDescriptor(window, k);
        if (!d || d.get) continue;
        v = d.value;
      } catch { continue; }
      visit(k, v, 0);
    }
    const loadedScripts = Array.from(loadedScriptSet);
    if (out.length) sendSurface(out, loadedScripts);
  }

  function sendSurface(items, loadedScripts) {
    if (!bridgeReady) { if (surfaceQueue.length < 50) surfaceQueue.push([items, loadedScripts]); return; }
    try { dispatch.call(document, new CustomEvt(SURFACE, { detail: stringify({ items, frameUrl: location.href, loadedScripts: loadedScripts || [] }) })); } catch {}
  }

  function scheduleSweep(reason) {
    if (!config.captureSurface && !config.captureRuntime) return;
    pendingSweepReason = reason || 'init';
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      const sweepReason = pendingSweepReason;
      if (config.captureSurface) { try { sweep(sweepReason); } catch {} }
      if (config.captureRuntime) {
        try { snapshotStorage(); } catch {}
        try { snapshotGlobals(); } catch {}
      }
    }, 500);
  }

  // Re-sweep whenever an SPA changes route (new lazy chunks can expose new globals).
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    if (typeof orig === 'function') {
      try {
        history[m] = function (...a) {
          try { const url = a[2]; if (url) { const t = isTainted(String(url)); if (t) emitTaint(`history.${m}`, t, String(url)); } } catch {}
          const r = orig.apply(this, a); scheduleSweep(m); return r;
        };
      } catch {}
    }
  }
  listen.call(window, 'popstate', () => scheduleSweep('popstate'));
  listen.call(window, 'hashchange', () => scheduleSweep('hashchange'));
  listen.call(window, 'load', () => scheduleSweep('load'));
  scheduleSweep('init');
  setTimeout(() => scheduleSweep('3s-after-load'), 3000); // catch globals added during late boot / lazy chunks

  // --- Runtime capture: storage, global state/config, postMessage, network ---
  // Everything the page holds or exchanges at runtime that's gold for recon. All reads are
  // passive; the fetch/XHR/WebSocket/postMessage hooks always call through to the original.
  const VALUE_CAP = 8000;
  const GLOBAL_CAP = 30000;
  const runtimeQueue = [];
  const sentRuntime = new Set();

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function once(key) {
    if (sentRuntime.has(key)) return false;
    if (sentRuntime.size > 8000) sentRuntime.clear();
    sentRuntime.add(key);
    return true;
  }

  function safeStringify(v) {
    const seen = new WeakSet();
    try {
      return stringify(v, (k, val) => {
        if (typeof val === 'function') return 'ƒ';
        if (typeof val === 'bigint') return `${val}n`;
        if (val && typeof val === 'object') {
          if (seen.has(val)) return '[Circular]';
          seen.add(val);
          if (val instanceof Node) return `[${val.nodeName}]`;
        }
        return val;
      }) || '';
    } catch { return ''; }
  }

  // Secret patterns flagged at capture time; the tag travels with the record.
  const SECRET_RX = [
    ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
    ['aws-akia', /\bAKIA[0-9A-Z]{16}\b/],
    ['google-api', /\bAIza[0-9A-Za-z_-]{35}\b/],
    ['stripe', /\bsk_live_[0-9A-Za-z]{16,}\b/],
    ['github', /\bgh[pousr]_[0-9A-Za-z]{20,}\b/],
    ['slack', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
    ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['bearer', /\bBearer\s+[A-Za-z0-9._-]{20,}/i],
    ['airtable-pat', /\bpat[A-Za-z0-9]{14}\.[A-Za-z0-9]{17,}/],
    ['google-oauth', /\bya29\.[A-Za-z0-9._-]{20,}/],
    // key name ending in a secret-ish word (apiKey, csrfToken, airtablePat…) = a longish value
    ['secret-assign', /["']?[\w-]*(?:apikey|api[_-]?key|secret|token|password|passwd|access[_-]?token|[_-]?pat|privatekey|clientsecret)["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i],
  ];
  function scanSecrets(text) {
    if (!text) return [];
    const out = [];
    for (const [name, rx] of SECRET_RX) { try { if (rx.test(text)) out.push(name); } catch {} }
    return out;
  }

  function sendRuntime(items) {
    if (!items.length) return;
    if (!bridgeReady) { if (runtimeQueue.length < 100) runtimeQueue.push(items); return; }
    try { dispatch.call(document, new CustomEvt(RUNTIME, { detail: stringify({ items, frameUrl: location.href }) })); } catch {}
  }

  function snapshotStorage() {
    const out = [];
    for (const [area, store] of [['local', 'localStorage'], ['session', 'sessionStorage']]) {
      let s;
      try { s = window[store]; if (!s) continue; } catch { continue; }
      let n;
      try { n = s.length; } catch { continue; }
      for (let i = 0; i < n; i++) {
        try {
          const key = s.key(i);
          const value = String(s.getItem(key)).slice(0, VALUE_CAP);
          if (once(`s:${area}:${key}:${hash(value)}`)) out.push({ type: 'storage', area, name: key, value, secret: scanSecrets(`${key} ${value}`) });
        } catch {}
      }
    }
    try {
      for (const c of document.cookie.split(';')) {
        const i = c.indexOf('=');
        if (i <= 0) continue;
        const key = c.slice(0, i).trim();
        const value = c.slice(i + 1).trim().slice(0, VALUE_CAP);
        if (once(`s:cookie:${key}:${hash(value)}`)) out.push({ type: 'storage', area: 'cookie', name: key, value, secret: scanSecrets(`${key} ${value}`) });
      }
    } catch {}
    sendRuntime(out);
  }

  const KNOWN_GLOBALS = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', '__remixContext', '__NEXT_REDUX_STORE__', '__STATE__', 'env', 'ENV', 'CONFIG', 'APP_CONFIG', 'firebaseConfig', 'runtimeConfig'];
  const GLOBAL_HINT = /(config|env|setting|state|context|preload|apollo|redux|store|runtime|firebase|amplify|__)/i;
  function snapshotGlobals() {
    const skip = getBaseline();
    const names = new Set(KNOWN_GLOBALS);
    try { for (const k of Object.getOwnPropertyNames(window)) if (!skip.has(k) && GLOBAL_HINT.test(k)) names.add(k); } catch {}
    const out = [];
    for (const name of names) {
      let v;
      try { const d = Object.getOwnPropertyDescriptor(window, name); if (!d || d.get) continue; v = d.value; } catch { continue; }
      if (v == null) continue;
      const t = typeof v;
      if (t === 'function') continue;
      const json = (t === 'object' ? safeStringify(v) : String(v)).slice(0, GLOBAL_CAP);
      if (!json || json === '{}' || json === '[]' || json === '""') continue;
      if (once(`g:${name}:${hash(json)}`)) out.push({ type: 'global', name, value: json, secret: scanSecrets(`${name} ${json}`) });
    }
    sendRuntime(out);
  }

  // First page frame that made the call (skips our own hook + extension frames), as file:line.
  function callerSource() {
    try { return (pageFrames()[0] || '').replace(/^at /, ''); } catch { return ''; }
  }

  // --- Taint tracking: follow user-typed values to dangerous sinks ---
  const taintValues = new Map(); // value → timestamp (cleared on navigation)
  const customWords = new Set(); // persistent words from taintWordlist config (not cleared on navigation)
  // These come from config (taintMaxValues: 0 = unlimited; taintMinLen: 2 = minimum length to track).
  // Defaults are used until bridge delivers the real config.
  const TAINT_DEFAULTS = { taintMaxValues: 0, taintMinLen: 2 };

  function sinkEnabled(name) {
    return !Array.isArray(config.enabledSinks) || config.enabledSinks.includes(name);
  }

  function emitTaintState() {
    if (!bridgeReady) return;
    const values = [...taintValues.entries()].map(([v, ts]) => ({ v, ts }));
    try { dispatch.call(document, new CustomEvt(TAINT_STATE, { detail: stringify({ values }) })); } catch {}
  }

  function updateTaint(val) {
    const s = String(val || '').trim();
    const minLen = config.taintMinLen ?? TAINT_DEFAULTS.taintMinLen;
    if (s.length < minLen) return;
    // Remove partials that are substrings of the new value — they're now subsumed.
    // e.g. "<img src=x" gets dropped when "<img src=x onerror=alert(1)>" arrives.
    for (const [k] of taintValues) { if (s.includes(k)) taintValues.delete(k); }
    const maxVals = config.taintMaxValues ?? TAINT_DEFAULTS.taintMaxValues;
    if (maxVals > 0 && taintValues.size >= maxVals) {
      let oldestKey = null; let oldestTs = Infinity;
      for (const [k, ts] of taintValues) { if (ts < oldestTs) { oldestTs = ts; oldestKey = k; } }
      if (oldestKey !== null) taintValues.delete(oldestKey);
    }
    taintValues.set(s, Date.now());
    emitTaintState();
  }

  function isTainted(str) {
    if (typeof str !== 'string' || !str) return null;
    const s = str.toLowerCase();
    // Return the longest matching value so partial intermediates (typed char-by-char)
    // don't shadow the full captured string.
    let best = null;
    for (const [v] of taintValues) { if (s.includes(v.toLowerCase()) && (!best || v.length > best.length)) best = v; }
    if (best) return best;
    for (const w of customWords) { if (s.includes(w.toLowerCase())) return w; }
    return null;
  }

  function emitTaint(sinkName, taintedVal, fullArg) {
    if (!config.captureTaint) return;
    if (!sinkEnabled(sinkName)) return;
    const frames = pageFrames();
    sendRuntime([{
      type: 'taint',
      sink: String(sinkName),
      taintedValue: String(taintedVal).slice(0, 200),
      value: String(fullArg || '').slice(0, VALUE_CAP),
      name: String(sinkName),
      source: (frames[0] || '').replace(/^at /, ''),
      stack: frames.join('\n'),
      url: '', origin: '', area: '', method: '',
    }]);
  }

  function trackInputs() {
    const SKIP_INPUT_TYPES = new Set(['password', 'hidden', 'submit', 'button', 'reset', 'image', 'file', 'checkbox', 'radio']);
    const isTrackedEl = (t) => (t instanceof HTMLInputElement && !SKIP_INPUT_TYPES.has(t.type))
      || t instanceof HTMLTextAreaElement
      || t instanceof HTMLSelectElement
      || !!t.isContentEditable;

    // Capture values already in the DOM when we initialize (pre-filled fields, autofill).
    try {
      for (const el of document.querySelectorAll('input:not([type=password]):not([type=hidden]), textarea, select, [contenteditable]')) {
        const v = el.value !== undefined ? el.value : (el.textContent || '');
        if (v) updateTaint(v);
      }
    } catch {}

    const debounce = new WeakMap();
    const onInput = (e) => {
      const t = e.target;
      if (!t || !isTrackedEl(t)) return;
      clearTimeout(debounce.get(t));
      debounce.set(t, setTimeout(() => {
        try { updateTaint(t.value !== undefined ? t.value : (t.textContent || '')); } catch {}
      }, 300));
    };
    listen.call(document, 'input', onInput, true);
    listen.call(document, 'change', onInput, true); // catches <select> and programmatic .value changes

    // Capture immediately on Enter/submit — debounce (300ms) would miss values typed
    // right before form submission since the sink fires before the debounce ticks.
    listen.call(document, 'keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (!t || !isTrackedEl(t)) return;
      try { updateTaint(t.value !== undefined ? t.value : (t.textContent || '')); } catch {}
    }, true);

    // Also catch form submits (covers submit buttons, not just Enter).
    listen.call(document, 'submit', (e) => {
      try {
        const form = e.target;
        if (!form) return;
        for (const el of form.elements) {
          if (isTrackedEl(el) && el.value) updateTaint(el.value);
        }
      } catch {}
    }, true);

    listen.call(window, 'popstate', () => { taintValues.clear(); emitTaintState(); });
    listen.call(window, 'hashchange', () => { taintValues.clear(); emitTaintState(); });
  }

  function hookSinks() {
    const chk = (name, val, extra) => {
      try {
        if (!config.captureTaint || !sinkEnabled(name)) return;
        const t = isTainted(String(val ?? ''));
        if (t) emitTaint(name, t, String(extra ?? val ?? '').slice(0, VALUE_CAP));
      } catch {}
    };

    // XSS: innerHTML / outerHTML
    for (const prop of ['innerHTML', 'outerHTML']) {
      try {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, prop);
        if (!desc?.set) continue;
        const orig = desc.set;
        Object.defineProperty(Element.prototype, prop, { ...desc, set(val) { chk(prop, val); return orig.call(this, val); } });
      } catch {}
    }

    // XSS: insertAdjacentHTML
    try {
      const orig = Element.prototype.insertAdjacentHTML;
      if (typeof orig === 'function') Element.prototype.insertAdjacentHTML = function(pos, html) { chk('insertAdjacentHTML', html); return orig.call(this, pos, html); };
    } catch {}

    // XSS: document.write / writeln
    for (const m of ['write', 'writeln']) {
      try {
        const orig = document[m];
        if (typeof orig !== 'function') continue;
        document[m] = function(...args) { for (const a of args) chk(`document.${m}`, a); return orig.apply(this, args); };
      } catch {}
    }

    // RCE: eval
    try {
      const origEval = window.eval;
      if (typeof origEval === 'function') window.eval = function(code) { chk('eval', code); return origEval.call(this, code); };
    } catch {}

    // RCE: new Function(code)
    try {
      window.Function = new Proxy(Function, {
        construct(target, args) {
          try { chk('new Function', args[args.length - 1]); } catch {}
          return Reflect.construct(target, args);
        },
        apply(target, thisArg, args) { return Reflect.apply(target, thisArg, args); },
      });
    } catch {}

    // RCE: setTimeout / setInterval (string arg only)
    for (const fn of ['setTimeout', 'setInterval']) {
      try {
        const orig = window[fn];
        if (typeof orig !== 'function') continue;
        window[fn] = function(handler, delay, ...rest) { if (typeof handler === 'string') chk(fn, handler); return orig.call(this, handler, delay, ...rest); };
      } catch {}
    }

    // Redirect: location.assign / replace
    for (const m of ['assign', 'replace']) {
      try {
        const orig = location[m].bind(location);
        location[m] = function(url) { chk(`location.${m}`, url); return orig(url); };
      } catch {}
    }

    // Redirect: location.href / search / hash / pathname setters (via prototype)
    try {
      const locProto = Object.getPrototypeOf(location);
      for (const prop of ['href', 'search', 'hash', 'pathname']) {
        try {
          const desc = Object.getOwnPropertyDescriptor(locProto, prop);
          if (!desc?.set) continue;
          const orig = desc.set;
          const sinkName = `location.${prop}`;
          Object.defineProperty(locProto, prop, { ...desc, set(val) { chk(sinkName, val); return orig.call(this, val); } });
        } catch {}
      }
    } catch {}

    // Redirect: window.open
    try {
      const orig = window.open;
      if (typeof orig === 'function') window.open = function(url, ...rest) { chk('window.open', url); return orig.apply(this, arguments); };
    } catch {}

    // Cookie injection
    try {
      const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
      if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(Document.prototype, 'cookie', { ...desc, set(val) { chk('document.cookie', val); return orig.call(this, val); } });
      }
    } catch {}

    // Storage injection: localStorage + sessionStorage (one prototype covers both)
    try {
      const orig = Storage.prototype.setItem;
      if (typeof orig === 'function') Storage.prototype.setItem = function(key, val) { chk('storage.setItem', val, `${key}=${val}`); return orig.call(this, key, val); };
    } catch {}

    // SSRF: sendBeacon
    try {
      const orig = navigator.sendBeacon?.bind(navigator);
      if (typeof orig === 'function') navigator.sendBeacon = function(url, data) { chk('sendBeacon', url, `${url} ${data ?? ''}`); return orig.apply(this, arguments); };
    } catch {}

    // XSS: Range.createContextualFragment
    try {
      const orig = Range.prototype.createContextualFragment;
      if (typeof orig === 'function') Range.prototype.createContextualFragment = function(html) { chk('createContextualFragment', html); return orig.call(this, html); };
    } catch {}

    // XSS: DOMParser.parseFromString (HTML type only)
    try {
      const orig = DOMParser.prototype.parseFromString;
      if (typeof orig === 'function') DOMParser.prototype.parseFromString = function(str, type, ...rest) {
        if (type && String(type).includes('html')) chk('DOMParser.parseFromString', str);
        return orig.apply(this, arguments);
      };
    } catch {}

    // XSS: iframe.srcdoc
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'srcdoc');
      if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', { ...desc, set(val) { chk('iframe.srcdoc', val); return orig.call(this, val); } });
      }
    } catch {}

    // XSS/SSRF: script.text and script.src
    for (const prop of ['text', 'src']) {
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, prop);
        if (!desc?.set) continue;
        const orig = desc.set;
        const sinkName = `script.${prop}`;
        Object.defineProperty(HTMLScriptElement.prototype, prop, { ...desc, set(val) { chk(sinkName, val); return orig.call(this, val); } });
      } catch {}
    }

    // SSRF: img.src (pixel tracking / exfil pattern)
    try {
      const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(HTMLImageElement.prototype, 'src', { ...desc, set(val) { chk('img.src', val); return orig.call(this, val); } });
      }
    } catch {}

    // SSRF: URL-bearing IDL property setters — assignment bypasses setAttribute so needs separate hooks.
    const urlPropHooks = [
      [typeof HTMLIFrameElement !== 'undefined' && HTMLIFrameElement.prototype, 'src', 'iframe.src'],
      [typeof HTMLObjectElement !== 'undefined' && HTMLObjectElement.prototype, 'data', 'object.data'],
      [typeof HTMLEmbedElement !== 'undefined' && HTMLEmbedElement.prototype, 'src', 'embed.src'],
      [typeof HTMLLinkElement !== 'undefined' && HTMLLinkElement.prototype, 'href', 'link.href'],
      [typeof HTMLMediaElement !== 'undefined' && HTMLMediaElement.prototype, 'src', 'media.src'],
      [typeof HTMLFormElement !== 'undefined' && HTMLFormElement.prototype, 'action', 'form.action'],
      [typeof HTMLAnchorElement !== 'undefined' && HTMLAnchorElement.prototype, 'href', 'a.href'],
    ];
    for (const [proto, prop, sinkName] of urlPropHooks) {
      try {
        if (!proto) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if (!desc?.set) continue;
        const orig = desc.set;
        Object.defineProperty(proto, prop, { ...desc, set(val) { chk(sinkName, val); return orig.call(this, val); } });
      } catch {}
    }

    // XSS: Element.setAttribute for dangerous attributes
    try {
      const DANGER = new Set(['href', 'src', 'action', 'formaction', 'srcdoc', 'data', 'onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'onblur', 'style']);
      const orig = Element.prototype.setAttribute;
      if (typeof orig === 'function') Element.prototype.setAttribute = function(name, val) {
        if (DANGER.has(String(name).toLowerCase())) chk('setAttribute', val, `${name}=${val}`);
        return orig.call(this, name, val);
      };
    } catch {}

    // XSS: Element.setAttributeNS — namespace-aware variant, used by SVG and modern frameworks
    try {
      const orig = Element.prototype.setAttributeNS;
      const DANGER_NS = new Set(['href', 'src', 'action', 'formaction', 'srcdoc', 'data', 'onclick', 'onerror', 'onload', 'xlink:href']);
      if (typeof orig === 'function') Element.prototype.setAttributeNS = function(ns, name, val) {
        const local = String(name || '').split(':').pop().toLowerCase();
        if (DANGER_NS.has(local) || DANGER_NS.has(String(name).toLowerCase())) chk('setAttributeNS', val, `${name}=${val}`);
        return orig.call(this, ns, name, val);
      };
    } catch {}

    // Exfil: window.name — readable cross-origin, used for data exfiltration
    try {
      const desc = Object.getOwnPropertyDescriptor(window, 'name') || Object.getOwnPropertyDescriptor(Window.prototype, 'name');
      if (desc?.set) {
        const orig = desc.set;
        const target = 'name' in Window.prototype ? Window.prototype : window;
        Object.defineProperty(target, 'name', { ...desc, set(val) { chk('window.name', val); return orig.call(this, val); } });
      }
    } catch {}

    // CSS injection: insertRule
    try {
      const orig = CSSStyleSheet.prototype.insertRule;
      if (typeof orig === 'function') CSSStyleSheet.prototype.insertRule = function(rule, index) { chk('CSSStyleSheet.insertRule', rule); return orig.call(this, rule, index); };
    } catch {}

    // CSS injection: style.cssText
    try {
      const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'cssText');
      if (desc?.set) {
        const orig = desc.set;
        Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', { ...desc, set(val) { chk('style.cssText', val); return orig.call(this, val); } });
      }
    } catch {}

    // Clipboard hijack
    try {
      const origWrite = navigator.clipboard?.writeText?.bind(navigator.clipboard);
      if (typeof origWrite === 'function') navigator.clipboard.writeText = function(text) { chk('clipboard.writeText', text); return origWrite(text); };
    } catch {}

    // Cross-tab messaging: BroadcastChannel
    try {
      const orig = BroadcastChannel.prototype.postMessage;
      if (typeof orig === 'function') BroadcastChannel.prototype.postMessage = function(data) {
        try { chk('BroadcastChannel.postMessage', typeof data === 'string' ? data : stringify(data)); } catch {}
        return orig.call(this, data);
      };
    } catch {}

    // Persistent SSRF: ServiceWorker
    try {
      const swc = navigator.serviceWorker;
      if (swc && typeof swc.register === 'function') {
        const orig = swc.register.bind(swc);
        swc.register = function(url, ...rest) { chk('serviceWorker.register', url); return orig(url, ...rest); };
      }
    } catch {}

    // Script injection: Worker / SharedWorker
    for (const name of ['Worker', 'SharedWorker']) {
      try {
        const Orig = window[name];
        if (typeof Orig !== 'function') continue;
        const W = function(url, ...rest) { chk(name, url); return new Orig(url, ...rest); };
        W.prototype = Orig.prototype;
        window[name] = W;
      } catch {}
    }

    // XSS: document.execCommand (insertHTML command)
    try {
      const orig = document.execCommand;
      if (typeof orig === 'function') document.execCommand = function(cmd, showUI, val) {
        if (cmd === 'insertHTML' || cmd === 'insertText') chk('document.execCommand', val, `${cmd}: ${val}`);
        return orig.call(this, cmd, showUI, val);
      };
    } catch {}
  }

  function recordNet(method, url, body) {
    if (!config.captureRuntime) return;
    const u = String(url);
    if (once(`n:${method}:${u}`)) {
      const b = typeof body === 'string' ? body.slice(0, VALUE_CAP) : '';
      sendRuntime([{ type: 'netcall', method: String(method || 'GET').toUpperCase(), url: u.slice(0, 2000), value: b, source: callerSource(), secret: scanSecrets(`${u} ${b}`) }]);
      try { const t = isTainted(u) || isTainted(b); if (t) emitTaint('fetch', t, `${u} ${b}`.slice(0, 500)); } catch {}
    }
  }

  function recordPM(dir, origin, data) {
    if (!config.captureRuntime) return;
    const value = (typeof data === 'string' ? data : safeStringify(data)).slice(0, VALUE_CAP);
    const o = String(origin || '');
    // Only outbound has a meaningful stack (we're in the page's call path); inbound fires async.
    if (once(`p:${dir}:${o}:${hash(value)}`)) sendRuntime([{ type: 'postmessage', dir, origin: o, value, source: dir === 'out' ? callerSource() : '', secret: scanSecrets(value) }]);
    // Taint: outbound message carrying tracked data = exfiltration sink.
    if (dir === 'out') { try { const t = isTainted(value); if (t) emitTaint('postMessage', t, `→${o} ${value}`.slice(0, VALUE_CAP)); } catch {} }
  }

  // Inbound postMessage: our own capture-phase listener sees every message, even ones the
  // page never validates.
  listen.call(window, 'message', (e) => {
    try { recordPM('in', e.origin, e.data); } catch {}
  }, true);

  // Outbound postMessage.
  try {
    const op = window.postMessage;
    if (typeof op === 'function') {
      window.postMessage = function (message, targetOrigin, ...rest) {
        try { recordPM('out', targetOrigin, message); } catch {}
        return op.apply(this, arguments);
      };
    }
  } catch {}

  // fetch
  try {
    const of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function (input, init) {
        try {
          const url = input && typeof input === 'object' ? input.url : input;
          recordNet((init && init.method) || (input && input.method) || 'GET', url, init && init.body);
        } catch {}
        return of.apply(this, arguments);
      };
    }
  } catch {}

  // XMLHttpRequest
  try {
    const xo = XMLHttpRequest.prototype.open;
    const xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__cc = { method, url }; } catch {}
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try { if (this.__cc) recordNet(this.__cc.method, this.__cc.url, body); } catch {}
      try { const t = isTainted(String(this.__cc && this.__cc.url || '')) || isTainted(typeof body === 'string' ? body : ''); if (t) emitTaint('XHR.send', t, String(body || '')); } catch {}
      return xs.apply(this, arguments);
    };
  } catch {}

  // WebSocket
  try {
    const OW = window.WebSocket;
    if (typeof OW === 'function') {
      const NW = function (...args) {
        try { recordNet('WS', args[0], ''); } catch {}
        try { const t = isTainted(String(args[0] || '')); if (t) emitTaint('WebSocket', t, String(args[0] || '')); } catch {}
        return new OW(...args);
      };
      NW.prototype = OW.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) { try { NW[k] = OW[k]; } catch {} }
      window.WebSocket = NW;
    }
  } catch {}

  // EventSource
  try {
    const OE = window.EventSource;
    if (typeof OE === 'function') {
      const NE = function (...args) {
        try { recordNet('SSE', args[0], ''); } catch {}
        try { const t = isTainted(String(args[0] || '')); if (t) emitTaint('EventSource', t, String(args[0] || '')); } catch {}
        return new OE(...args);
      };
      NE.prototype = OE.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) { try { NE[k] = OE[k]; } catch {} }
      window.EventSource = NE;
    }
  } catch {}

  // Taint tracking: monitor user inputs and dangerous sinks
  try { trackInputs(); } catch {}
  try { hookSinks(); } catch {}
})();
