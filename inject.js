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

  // captureSurface/captureRuntime can be toggled from the popup; bridge relays the values.
  let config = { captureSurface: true, captureRuntime: true };
  const onConfig = (e) => {
    try { config = { ...config, ...JSON.parse(e.detail) }; } catch {}
    if (config.captureSurface || config.captureRuntime) scheduleSweep();
  };
  listen.call(document, CONFIG, onConfig);

  listen.call(document, READY, (e) => {
    if (e.detail) onConfig(e);
    if (bridgeReady) return;
    bridgeReady = true;
    early.splice(0).forEach(send);
    surfaceQueue.splice(0).forEach(sendSurface);
    runtimeQueue.splice(0).forEach(sendRuntime);
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

  // Params/keywords that make a function worth a closer look for SSRF / redirect / DOM XSS.
  const HINT = /^(url|uri|href|endpoint|api|path|method|verb|redirect|redir|return|returnurl|next|callback|cb|src|source|target|dest|destination|host|domain|link|location|loc|proxy|webhook|hook|html|dom|markup|template|tpl|action|route|address|addr|remote|fetch|request|req|payload)$/i;
  const BODY_SINK = /(fetch\s*\(|XMLHttpRequest|\.open\s*\(|\baxios\b|\.ajax\s*\(|WebSocket|EventSource|sendBeacon|innerHTML|outerHTML|insertAdjacentHTML|document\.write|dangerouslySetInnerHTML|\.href\s*=|location\s*=|location\.(?:href|assign|replace)|window\.open|\beval\s*\(|new Function|import\s*\()/;

  // A hidden about:blank iframe gives the pristine list of browser built-ins, so anything on
  // this page's window that isn't in it was added by page scripts.
  function getBaseline() {
    if (baseline) return baseline;
    baseline = new Set(['constructor', 'prototype', '__proto__', 'caches', 'trustedTypes']);
    try {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      f.setAttribute('sandbox', 'allow-same-origin');
      (document.body || document.documentElement).appendChild(f);
      for (const n of Object.getOwnPropertyNames(f.contentWindow)) baseline.add(n);
      f.remove();
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

  function recordFn(path, fn, out) {
    const { params, native, body } = signatureOf(fn);
    const key = `${path}/${fn.length}`;
    if (sentKeys.has(key)) return;
    sentKeys.add(key);
    const reasons = [];
    for (const p of params) if (HINT.test(p)) reasons.push(`param:${p}`);
    const sink = !native && body.match(BODY_SINK);
    if (sink) reasons.push(`body:${sink[0].replace(/[\s(=]+$/, '')}`);
    out.push({
      path,
      arity: fn.length,
      name: fn.name || '',
      params,
      native,
      interesting: reasons.length > 0,
      reasons,
      snippet: native ? '[native code]' : body.slice(0, 300).replace(/\s+/g, ' ').trim(),
    });
  }

  function sweep() {
    const skip = getBaseline();
    const out = [];
    const seen = new WeakSet();
    const visit = (path, v, depth) => {
      if (out.length >= 800) return;
      const t = typeof v;
      if (t === 'function') { try { recordFn(path, v, out); } catch {} return; }
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
    if (out.length) sendSurface(out);
  }

  function sendSurface(items) {
    if (!bridgeReady) { if (surfaceQueue.length < 50) surfaceQueue.push(items); return; }
    try { dispatch.call(document, new CustomEvt(SURFACE, { detail: stringify({ items, frameUrl: location.href }) })); } catch {}
  }

  function scheduleSweep() {
    if (!config.captureSurface && !config.captureRuntime) return;
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => {
      if (config.captureSurface) { try { sweep(); } catch {} }
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
        history[m] = function (...a) { const r = orig.apply(this, a); scheduleSweep(); return r; };
      } catch {}
    }
  }
  listen.call(window, 'popstate', scheduleSweep);
  listen.call(window, 'hashchange', scheduleSweep);
  listen.call(window, 'load', scheduleSweep);
  scheduleSweep();
  setTimeout(scheduleSweep, 3000); // catch globals added during late boot / lazy chunks

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

  function recordNet(method, url, body) {
    if (!config.captureRuntime) return;
    const u = String(url);
    if (once(`n:${method}:${u}`)) {
      const b = typeof body === 'string' ? body.slice(0, VALUE_CAP) : '';
      sendRuntime([{ type: 'netcall', method: String(method || 'GET').toUpperCase(), url: u.slice(0, 2000), value: b, source: callerSource(), secret: scanSecrets(`${u} ${b}`) }]);
    }
  }

  function recordPM(dir, origin, data) {
    if (!config.captureRuntime) return;
    const value = (typeof data === 'string' ? data : safeStringify(data)).slice(0, VALUE_CAP);
    const o = String(origin || '');
    // Only outbound has a meaningful stack (we're in the page's call path); inbound fires async.
    if (once(`p:${dir}:${o}:${hash(value)}`)) sendRuntime([{ type: 'postmessage', dir, origin: o, value, source: dir === 'out' ? callerSource() : '', secret: scanSecrets(value) }]);
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
      return xs.apply(this, arguments);
    };
  } catch {}

  // WebSocket
  try {
    const OW = window.WebSocket;
    if (typeof OW === 'function') {
      const NW = function (...args) { try { recordNet('WS', args[0], ''); } catch {} return new OW(...args); };
      NW.prototype = OW.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) { try { NW[k] = OW[k]; } catch {} }
      window.WebSocket = NW;
    }
  } catch {}

  // EventSource
  try {
    const OE = window.EventSource;
    if (typeof OE === 'function') {
      const NE = function (...args) { try { recordNet('SSE', args[0], ''); } catch {} return new OE(...args); };
      NE.prototype = OE.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSED']) { try { NE[k] = OE[k]; } catch {} }
      window.EventSource = NE;
    }
  } catch {}
})();
