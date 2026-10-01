const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'network'];
const PAGE_SIZE = 500;
const $ = (id) => document.getElementById(id);
const api = globalThis.browser ?? globalThis.chrome;

// The "só segredos" filter, the red highlight and the count are all driven by this regex,
// evaluated at view time so editing it re-filters already-captured data instantly.
const DEFAULT_SECRET_REGEX = 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk_live_[0-9A-Za-z]{16,}|gh[pousr]_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\\s+[A-Za-z0-9._-]{20,}|pat[A-Za-z0-9]{14}\\.[A-Za-z0-9]{17,}|ya29\\.[A-Za-z0-9._-]{20,}|(?:secret|password|passwd|pwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|[_-]?pat|api[_-]?key|apikey|client[_-]?secret|consumer[_-]?secret|connectionstring|credentials?|(?:secret|private|access|api|aws|gpg|rsa|ssh|encryption|signing|master|auth|client|consumer|cloud|admin|deploy|docker|s3|slack|github|stripe|firebase|algolia|cloudflare|datadog|heroku|mapbox|sentry|twilio)[_-]?key)["\']?\\s*[:=]\\s*["\']?[A-Za-z0-9._+/=-]{12,}';
let secretRe = null;
try { secretRe = new RegExp(DEFAULT_SECRET_REGEX, 'i'); } catch {}

function runtimeText(r) {
  return `${r.name}\n${r.url}\n${r.origin}\n${r.value}\n${r.area}`;
}
function isSecret(r) {
  if (!secretRe) return false;
  secretRe.lastIndex = 0;
  return secretRe.test(runtimeText(r));
}

const RT_TYPES = [['storage', 'Storage / cookies'], ['global', 'Estado / config global'], ['postmessage', 'postMessage'], ['netcall', 'Rede (fetch/XHR/WS)']];
const KINDS = [['console', 'Console'], ['runtime', 'Runtime'], ['surface', 'Funções']];

let mode = 'console';
let entries = [];
let surface = [];
let runtime = [];
let all = [];
let filtered = [];
let shown = 0;
let regexOn = false;
const activeLevels = new Set(LEVELS);
const activeRtTypes = new Set(RT_TYPES.map(([k]) => k));
const activeKinds = new Set(KINDS.map(([k]) => k));

const dataset = () => (mode === 'console' ? entries : mode === 'surface' ? surface : mode === 'runtime' ? runtime : all);

// Text of any item for search/filter, chosen by which view it belongs to.
function itemText(it) {
  const v = it._view || mode;
  if (v === 'console') return `${it.message}\n${it.source}\n${it.pageUrl}`;
  if (v === 'surface') return `${it.path}\n${(it.params || []).join(',')}\n${it.source}\n${it.snippet}\n${(it.reasons || []).join(',')}`;
  return `${it.name}\n${it.url}\n${it.origin}\n${it.value}\n${it.area}\n${(it.secret || []).join(',')}`;
}
function renderItem(it) {
  const v = it._view || mode;
  return v === 'console' ? renderEntry(it) : v === 'surface' ? renderFn(it) : renderRt(it);
}

// Search matchers: reTest (filtering, case-insensitive) and reHi (global, for highlighting).
// Substring mode escapes the query; regex mode uses it raw.
let reTest = null;
let reHi = null;
function buildMatcher() {
  const q = $('search').value;
  $('search').classList.remove('invalid');
  if (!q) { reTest = reHi = null; return; }
  const src = regexOn ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    reTest = new RegExp(src, 'i');
    reHi = new RegExp(src, 'gi');
  } catch {
    // invalid regex while typing: don't filter, just flag the box
    reTest = reHi = null;
    $('search').classList.add('invalid');
  }
}

// Wrap the exact matched substrings of `text` in <mark> nodes (built as DOM, never innerHTML).
function hl(text) {
  const frag = document.createDocumentFragment();
  if (!reHi) { frag.append(document.createTextNode(text)); return frag; }
  let last = 0;
  reHi.lastIndex = 0;
  let m;
  while ((m = reHi.exec(text)) !== null) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    if (m[0].length === 0) { reHi.lastIndex++; continue; } // avoid zero-length loop
    const mark = document.createElement('mark');
    mark.className = 'hit';
    mark.textContent = m[0];
    frag.append(mark);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

// Content comes from arbitrary websites: always build DOM with textContent/nodes, never innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) {
    if (reHi) node.append(hl(String(text)));
    else node.textContent = text;
  }
  return node;
}

// One checkbox row bound to a Set; toggling re-filters and refreshes the badge.
function checkRow(set, key, labelNode) {
  const label = el('label');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = set.has(key);
  box.addEventListener('change', () => {
    box.checked ? set.add(key) : set.delete(key);
    applyFilters();
  });
  label.append(box, labelNode);
  return label;
}

function buildLevelFilters() {
  for (const level of LEVELS) {
    $('levels').append(checkRow(activeLevels, level, el('span', `lvl lvl-${level}`, level === 'network' ? 'rede' : level)));
  }
  $('lvlAll').addEventListener('click', () => setAllLevels(true));
  $('lvlNone').addEventListener('click', () => setAllLevels(false));
}
function setAllLevels(on) {
  activeLevels.clear();
  if (on) LEVELS.forEach((l) => activeLevels.add(l));
  for (const box of $('levels').querySelectorAll('input')) box.checked = on;
  applyFilters();
}

function buildRtTypeFilters() {
  for (const [key, label] of RT_TYPES) $('rtTypes').append(checkRow(activeRtTypes, key, el('span', null, label)));
}
function buildKindFilters() {
  for (const [key, label] of KINDS) $('kinds').append(checkRow(activeKinds, key, el('span', null, label)));
}

// <option> can only hold text, so build these directly (never via el(), which may add <mark>).
function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}
function buildHostSelect() {
  const counts = new Map();
  for (const e of dataset()) counts.set(e.host, (counts.get(e.host) || 0) + 1);
  const previous = $('host').value;
  $('host').replaceChildren(option('', `Todos os sites (${counts.size})`));
  for (const [host, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    $('host').append(option(host, `${host || '(sem host)'} — ${n}`));
  }
  $('host').value = counts.has(previous) ? previous : '';
}

function applyFilters() {
  buildMatcher();
  const hit = (text) => !reTest || reTest.test(text);
  const host = $('host').value;
  if (mode === 'console') {
    filtered = entries.filter((e) =>
      activeLevels.has(e.level)
      && (!host || e.host === host)
      && hit(`${e.message}\n${e.source}\n${e.pageUrl}`));
  } else if (mode === 'surface') {
    const hot = $('hotOnly').checked;
    filtered = surface.filter((f) =>
      (!hot || f.interesting)
      && (!host || f.host === host)
      && hit(`${f.path}\n${f.params.join(',')}\n${f.source}\n${f.snippet}\n${f.reasons.join(',')}`));
  } else if (mode === 'runtime') {
    const secretsOnly = $('secretsOnly').checked;
    filtered = runtime.filter((r) =>
      activeRtTypes.has(r.type)
      && (!secretsOnly || isSecret(r))
      && (!host || r.host === host)
      && hit(`${r.name}\n${r.url}\n${r.origin}\n${r.value}\n${r.area}\n${(r.secret || []).join(',')}`));
  } else {
    const secretsOnly = $('secretsOnly').checked;
    const hot = $('hotOnly').checked;
    filtered = all.filter((it) => {
      if (!activeKinds.has(it._view)) return false;
      if (host && it.host !== host) return false;
      if (!hit(itemText(it))) return false;
      if (it._view === 'console') return activeLevels.has(it.level);
      if (it._view === 'runtime') return activeRtTypes.has(it.type) && (!secretsOnly || isSecret(it));
      if (it._view === 'surface') return !hot || it.interesting;
      return true;
    });
  }
  $('allList').replaceChildren();
  $('list').replaceChildren();
  $('surfaceList').replaceChildren();
  $('runtimeList').replaceChildren();
  shown = 0;
  renderMore();
  updateFilterBadge();
}

// Badge = how many filter categories are narrowing the current tab's data.
function updateFilterBadge() {
  let n = 0;
  if (mode === 'console') n = activeLevels.size < LEVELS.length ? 1 : 0;
  else if (mode === 'runtime') n = (activeRtTypes.size < RT_TYPES.length ? 1 : 0) + ($('secretsOnly').checked ? 1 : 0);
  else if (mode === 'surface') n = $('hotOnly').checked ? 1 : 0;
  else {
    if (activeKinds.size < KINDS.length) n++;
    if (activeLevels.size < LEVELS.length) n++;
    if (activeRtTypes.size < RT_TYPES.length) n++;
    if ($('secretsOnly').checked) n++;
    if ($('hotOnly').checked) n++;
  }
  const badge = $('filterBadge');
  badge.textContent = n;
  badge.hidden = n === 0;
}

function renderEntry(e) {
  const d = new Date(e.ts);
  const row = el('div', `entry ${e.level}`);
  const time = el('div', 'time', d.toLocaleTimeString('pt-BR', { hour12: false }) + `.${String(d.getMilliseconds()).padStart(3, '0')}`);
  time.title = d.toLocaleString('pt-BR');
  const msg = el('div', 'msg', e.message);
  msg.addEventListener('click', () => msg.classList.toggle('open'));
  row.append(time, el('div', `lvl lvl-${e.level}`, e.level === 'network' ? 'rede' : e.level), msg);
  const meta = [e.kind !== 'console' ? `[${e.kind}]` : '', e.source, e.pageUrl !== e.frameUrl && e.frameUrl ? `frame: ${e.frameUrl}` : '', e.pageUrl].filter(Boolean);
  row.append(el('div', 'meta', meta.join('  ·  ')));
  if (e.stack) {
    const details = el('details');
    details.append(el('summary', 'muted', 'stack'), el('pre', null, e.stack));
    row.append(details);
  }
  return row;
}

function renderFn(f) {
  const row = el('div', `fn${f.interesting ? ' hot' : ''}`);
  const sig = el('div', 'sig');
  sig.append(el('span', 'path', f.path), el('span', 'args', `(${f.params.join(', ')})`));
  row.append(sig);
  const tags = el('div', 'tags');
  if (f.native) tags.append(el('span', 'tag', 'native'));
  for (const r of f.reasons) tags.append(el('span', 'tag', r));
  row.append(tags);
  const meta = [f.source, f.host, f.frameUrl && f.frameUrl !== f.pageUrl ? `frame: ${f.frameUrl}` : f.pageUrl].filter(Boolean);
  row.append(el('div', 'fnmeta', meta.join('  ·  ')));
  if (f.snippet && f.snippet !== '[native code]') row.append(el('div', 'snip', f.snippet));
  return row;
}

const RT_LABEL = { storage: 'storage', global: 'global', postmessage: 'postMessage', netcall: 'rede' };
function renderRt(r) {
  const sec = isSecret(r);
  const row = el('div', `rt${sec ? ' secret' : ''}`);
  row.append(el('div', `rtype rt-${r.type}`, RT_LABEL[r.type] || r.type));
  const head = el('div', 'rthead');
  if (r.type === 'storage') head.append(el('span', 'rtname', r.name), el('span', 'muted', `  (${r.area})`));
  else if (r.type === 'global') head.append(el('span', 'rtname', r.name));
  else if (r.type === 'postmessage') head.append(el('span', 'rtname', `${r.dir === 'in' ? '⬇ recebida' : '⬆ enviada'}`), el('span', 'muted', `  origin: ${r.origin || '(vazio)'}`));
  else if (r.type === 'netcall') head.append(el('span', 'rtname', `${r.method} `), el('span', null, r.url));
  row.append(head);
  const tags = el('div', 'tags');
  for (const s of r.secret || []) tags.append(el('span', 'tag', s));
  if (sec && !(r.secret && r.secret.length)) tags.append(el('span', 'tag', 'segredo'));
  if (r.count > 1) tags.append(el('span', 'muted', `×${r.count}`));
  row.append(tags);
  if (r.value) {
    const val = el('div', 'rtval', r.value);
    val.addEventListener('click', () => val.classList.toggle('open'));
    row.append(val);
  }
  row.append(el('div', 'rtmeta', [r.source, r.host, r.frameUrl && r.frameUrl !== r.pageUrl ? `frame: ${r.frameUrl}` : r.pageUrl].filter(Boolean).join('  ·  ')));
  return row;
}

function renderMore() {
  const target = mode === 'console' ? $('list') : mode === 'surface' ? $('surfaceList') : mode === 'runtime' ? $('runtimeList') : $('allList');
  const render = mode === 'all' ? renderItem : mode === 'console' ? renderEntry : mode === 'surface' ? renderFn : renderRt;
  const frag = document.createDocumentFragment();
  for (const e of filtered.slice(shown, shown + PAGE_SIZE)) frag.append(render(e));
  target.append(frag);
  shown = Math.min(shown + PAGE_SIZE, filtered.length);
  $('more').style.display = shown < filtered.length ? 'block' : 'none';
  const noun = mode === 'console' ? 'entradas' : mode === 'surface' ? 'funções' : mode === 'runtime' ? 'sinais' : 'itens';
  let extra = '';
  if (mode === 'surface') extra = ` · ${filtered.filter((f) => f.interesting).length.toLocaleString('pt-BR')} interessantes`;
  else if (mode === 'runtime') extra = ` · ${filtered.filter(isSecret).length.toLocaleString('pt-BR')} com segredo`;
  $('summary').textContent = `${filtered.length.toLocaleString('pt-BR')} de ${dataset().length.toLocaleString('pt-BR')} ${noun}`
    + extra
    + (filtered.length > shown ? ` (mostrando ${shown.toLocaleString('pt-BR')})` : '');
}

function switchMode(next) {
  if (next === mode) return;
  mode = next;
  closeMenus();
  for (const t of ['all', 'console', 'surface', 'runtime']) $(`tab${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle('active', mode === t);
  $('newPill').style.display = 'none';
  $('allList').style.display = mode === 'all' ? '' : 'none';
  $('list').style.display = mode === 'console' ? '' : 'none';
  $('surfaceList').style.display = mode === 'surface' ? '' : 'none';
  $('runtimeList').style.display = mode === 'runtime' ? '' : 'none';
  // Show only the active tab's filter panel(s). In "Todos" mode, show all panels at once.
  for (const v of ['all', 'console', 'surface', 'runtime']) $(`flt-${v}`).style.display = (mode === v || mode === 'all') ? '' : 'none';
  // Export options valid for this tab (JSON always; .log console; CSV runtime/funções).
  $('exportText').style.display = mode === 'console' ? '' : 'none';
  $('exportCsv').style.display = (mode === 'runtime' || mode === 'surface') ? '' : 'none';
  $('search').placeholder = mode === 'surface' ? 'Buscar por função, parâmetro, fonte…'
    : mode === 'runtime' ? 'Buscar por chave, URL, origin, valor…'
      : 'Buscar…';
  buildHostSelect();
  applyFilters();
}

let lastConsole = 0;
let lastSurface = 0;
let lastRuntime = 0;

async function load() {
  [entries, surface, runtime] = await Promise.all([
    ConsoleDB.all().then((r) => r.reverse()),
    // Interesting functions first, then by path.
    ConsoleDB.surfaceAll().then((r) => r.sort((a, b) => (b.interesting - a.interesting) || a.host.localeCompare(b.host) || a.path.localeCompare(b.path))),
    // Secrets first, then newest.
    ConsoleDB.runtimeAll().then((r) => r.sort((a, b) => (isSecret(b) - isSecret(a)) || b.ts - a.ts)),
  ]);
  lastConsole = entries.length;
  lastSurface = surface.length;
  lastRuntime = runtime.length;
  // Merged feed for the "Todos" tab, newest first; each item tagged with its view.
  entries.forEach((e) => { e._view = 'console'; });
  runtime.forEach((r) => { r._view = 'runtime'; });
  surface.forEach((f) => { f._view = 'surface'; });
  all = [...entries, ...runtime, ...surface].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  $('newPill').style.display = 'none';
  buildHostSelect();
  applyFilters();
}

// Auto-refresh: poll the counts and pull new data in without a manual click. When the
// user has scrolled down (reading), it holds and shows a pill instead of yanking the view.
async function poll() {
  if (!$('auto').checked || document.hidden) return;
  let c;
  let s;
  let rt;
  try { [c, s, rt] = await Promise.all([ConsoleDB.count(), ConsoleDB.surfaceCount(), ConsoleDB.runtimeCount()]); } catch { return; }
  if (c === lastConsole && s === lastSurface && rt === lastRuntime) return;
  const delta = mode === 'console' ? c - lastConsole
    : mode === 'surface' ? s - lastSurface
      : mode === 'runtime' ? rt - lastRuntime
        : (c - lastConsole) + (s - lastSurface) + (rt - lastRuntime);
  const noun = mode === 'console' ? 'novas entradas' : mode === 'surface' ? 'novas funções' : mode === 'runtime' ? 'novos sinais' : 'novos itens';
  if (delta > 0 && window.scrollY > 60) {
    const pill = $('newPill');
    pill.textContent = `${delta.toLocaleString('pt-BR')} ${noun} — carregar`;
    pill.style.display = 'block';
    lastConsole = c;
    lastSurface = s;
    lastRuntime = rt;
  } else {
    load();
  }
}

$('newPill').addEventListener('click', () => { window.scrollTo({ top: 0 }); load(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
setInterval(poll, 2000);

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
// Console exports follow the current filters, oldest first.
const chronological = () => filtered.slice().reverse();
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

$('exportJson').addEventListener('click', () => {
  closeMenus();
  if (mode === 'console') download(`console-logs-${stamp()}.json`, JSON.stringify(chronological(), null, 2), 'application/json');
  else if (mode === 'surface') download(`js-surface-${stamp()}.json`, JSON.stringify(filtered, null, 2), 'application/json');
  else if (mode === 'runtime') download(`runtime-${stamp()}.json`, JSON.stringify(filtered, null, 2), 'application/json');
  else download(`console-capture-tudo-${stamp()}.json`, JSON.stringify(filtered, null, 2), 'application/json');
});

$('exportText').addEventListener('click', () => {
  closeMenus();
  const lines = chronological().map((e) => {
    let line = `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] [${e.host}] ${e.message}`;
    if (e.source) line += `  (${e.source})`;
    if (e.stack) line += `\n    ${e.stack.replace(/\n/g, '\n    ')}`;
    return line;
  });
  download(`console-logs-${stamp()}.log`, lines.join('\n'), 'text/plain');
});

$('exportCsv').addEventListener('click', () => {
  closeMenus();
  if (mode === 'surface') {
    const head = ['host', 'path', 'arity', 'params', 'interesting', 'reasons', 'source', 'pageUrl', 'snippet'];
    const rows = filtered.map((f) => [f.host, f.path, f.arity, f.params.join('|'), f.interesting, f.reasons.join('|'), f.source, f.pageUrl, f.snippet].map(csvCell).join(','));
    download(`js-surface-${stamp()}.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  } else {
    const head = ['host', 'type', 'area', 'dir', 'origin', 'method', 'url', 'name', 'source', 'secret', 'count', 'value', 'pageUrl'];
    const rows = filtered.map((r) => [r.host, r.type, r.area, r.dir, r.origin, r.method, r.url, r.name, r.source, (r.secret || []).join('|'), r.count, r.value, r.pageUrl].map(csvCell).join(','));
    download(`runtime-${stamp()}.csv`, [head.join(','), ...rows].join('\n'), 'text/csv');
  }
});

const CLEAR_FN = { console: ConsoleDB.clear, surface: ConsoleDB.surfaceClear, runtime: ConsoleDB.runtimeClear };
const CLEAR_LABEL = { console: 'as entradas de console', surface: 'as funções mapeadas', runtime: 'os sinais de runtime' };
$('clear').addEventListener('click', async () => {
  closeMenus();
  if (mode === 'all') {
    if (!confirm('Apagar TUDO (console, runtime e funções)?')) return;
    await Promise.all([ConsoleDB.clear(), ConsoleDB.surfaceClear(), ConsoleDB.runtimeClear()]);
  } else {
    if (!confirm(`Apagar ${CLEAR_LABEL[mode]}? (os outros conjuntos são mantidos)`)) return;
    await CLEAR_FN[mode]();
  }
  load();
});

// Dropdown menus: close any open one on outside-click or Escape.
function closeMenus() {
  for (const d of document.querySelectorAll('details.menu[open]')) d.removeAttribute('open');
}
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.removeAttribute('open');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

$('tabAll').addEventListener('click', () => switchMode('all'));
$('tabConsole').addEventListener('click', () => switchMode('console'));
$('tabSurface').addEventListener('click', () => switchMode('surface'));
$('tabRuntime').addEventListener('click', () => switchMode('runtime'));
$('hotOnly').addEventListener('change', applyFilters);
$('secretsOnly').addEventListener('change', applyFilters);
$('regex').addEventListener('click', () => {
  regexOn = !regexOn;
  $('regex').setAttribute('aria-pressed', String(regexOn));
  applyFilters();
});
$('reload').addEventListener('click', () => { closeMenus(); load(); });
$('more').addEventListener('click', renderMore);
$('host').addEventListener('change', applyFilters);
let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 200);
});

// --- Editable secret regex (persisted in extension storage) ---
function applySecretRegex(source) {
  try { secretRe = new RegExp(source, 'i'); return true; } catch { return false; }
}
async function loadSecretRegex() {
  try {
    const { secretRegex } = await api.storage.local.get({ secretRegex: DEFAULT_SECRET_REGEX });
    if (secretRegex && applySecretRegex(secretRegex)) return;
  } catch {}
  applySecretRegex(DEFAULT_SECRET_REGEX);
}

function showRegexMsg(text, cls) {
  const box = $('secretRegexErr');
  box.textContent = text;
  box.className = cls || '';
}

$('editSecret').addEventListener('click', async () => {
  closeMenus();
  let current = DEFAULT_SECRET_REGEX;
  try { current = (await api.storage.local.get({ secretRegex: DEFAULT_SECRET_REGEX })).secretRegex || DEFAULT_SECRET_REGEX; } catch {}
  $('secretRegexInput').value = current;
  $('secretRegexInput').classList.remove('invalid');
  showRegexMsg('', '');
  $('secretDlg').showModal();
});

$('secretRegexInput').addEventListener('input', () => {
  const v = $('secretRegexInput').value;
  try { new RegExp(v, 'i'); $('secretRegexInput').classList.remove('invalid'); showRegexMsg('regex válido', 'okmsg'); }
  catch (e) { $('secretRegexInput').classList.add('invalid'); showRegexMsg(`regex inválido: ${e.message}`, 'err'); }
});

$('secretRevert').addEventListener('click', () => {
  $('secretRegexInput').value = DEFAULT_SECRET_REGEX;
  $('secretRegexInput').classList.remove('invalid');
  showRegexMsg('voltou ao original — clique em Salvar para aplicar', 'okmsg');
});

$('secretCancel').addEventListener('click', () => $('secretDlg').close());

$('secretSave').addEventListener('click', async () => {
  const v = $('secretRegexInput').value.trim();
  if (!v || !applySecretRegex(v)) {
    $('secretRegexInput').classList.add('invalid');
    showRegexMsg('regex inválido — corrija antes de salvar', 'err');
    return;
  }
  try { await api.storage.local.set({ secretRegex: v }); } catch {}
  $('secretDlg').close();
  applyFilters();
});

buildLevelFilters();
buildRtTypeFilters();
buildKindFilters();
// Default tab is console: show its filter panel, hide the others, set export options.
for (const v of ['all', 'console', 'surface', 'runtime']) $(`flt-${v}`).style.display = v === 'console' ? '' : 'none';
$('exportCsv').style.display = 'none';
loadSecretRegex().then(load);
