import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import deflist from 'markdown-it-deflist';
import hljs from 'highlight.js';
import katex from 'katex';
import renderMathInElement from 'katex/contrib/auto-render';
import { iconForFile, iconForFolder } from '../entries/file-icons.js';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(str, lang) {
    if (lang === 'mermaid') {
      // Mark mermaid blocks; we transform them after render.
      return `<pre class="mermaid-placeholder" data-src="${escapeAttr(str)}"></pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${lang}">${
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        }</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

md.use(taskLists, { enabled: true, label: true });
md.use(deflist);

function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let mermaidLoaded = false;
async function ensureMermaid() {
  if (mermaidLoaded) return;
  // mermaid.bundle.js is shipped alongside; expose itself as window.MDMermaid.
  const script = document.createElement('script');
  script.src = 'vendor/mermaid.bundle.js';
  await new Promise((res, rej) => {
    script.onload = res;
    script.onerror = rej;
    document.head.appendChild(script);
  });
  window.MDMermaid.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.dataset.base === 'dark' ? 'dark' : 'default',
  });
  mermaidLoaded = true;
}

async function renderMermaidBlocks(root) {
  const placeholders = root.querySelectorAll('pre.mermaid-placeholder');
  if (!placeholders.length) return;
  await ensureMermaid();
  const mermaid = window.MDMermaid.default;
  let i = 0;
  for (const el of placeholders) {
    const src = decodeHtml(el.getAttribute('data-src') || '');
    const id = `mmd-${Date.now()}-${i++}`;
    try {
      const { svg } = await mermaid.render(id, src);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid';
      wrap.innerHTML = svg;
      el.replaceWith(wrap);
    } catch (err) {
      const errEl = document.createElement('pre');
      errEl.className = 'mermaid-error';
      errEl.textContent = `Mermaid render error: ${err?.message || err}`;
      el.replaceWith(errEl);
    }
  }
}

function decodeHtml(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function renderMath(root) {
  renderMathInElement(root, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
    ],
    throwOnError: false,
  });
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'section';
}

function assignHeadingIds(root) {
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const used = new Map();
  const outline = [];
  for (const h of headings) {
    const text = (h.textContent || '').trim();
    const base = slugify(text);
    const count = used.get(base) || 0;
    const id = count === 0 ? base : `${base}-${count}`;
    used.set(base, count + 1);
    h.id = id;
    outline.push({ id, level: Number(h.tagName[1]), text });
  }
  return outline;
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre > code.hljs')) {
    const wrapper = pre.parentElement;
    if (wrapper.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      } catch {
        btn.textContent = 'Failed';
      }
    });
    wrapper.classList.add('code-wrap');
    wrapper.appendChild(btn);
  }
}

function updateEmptyState() {
  const empty = document.getElementById('empty-state');
  const root = document.getElementById('root');
  if (!empty || !root) return;
  // Hide the "Open a file" placeholder while a load is in flight, so the
  // dots aren't fighting with the empty-state glyph in the same space.
  const loading = document.getElementById('main')?.classList.contains('is-loading');
  empty.hidden = loading || root.children.length > 0;
}

// Loading indicator — shown after a short delay so fast reads don't flicker
// a spinner on screen. Cancelled the moment `render()` runs or `setLoading(false)`
// is called explicitly by the host. A safety timeout auto-clears the indicator
// if the host never reports back (e.g. native dedupes the load).
let loadingShowTimer = null;
let loadingSafetyTimer = null;
function setLoading(visible) {
  const main = document.getElementById('main');
  const node = document.getElementById('loading-state');
  if (!main || !node) return;
  if (loadingShowTimer) {
    clearTimeout(loadingShowTimer);
    loadingShowTimer = null;
  }
  if (loadingSafetyTimer) {
    clearTimeout(loadingSafetyTimer);
    loadingSafetyTimer = null;
  }
  if (visible) {
    // 80ms grace — anything that resolves faster won't trigger the indicator.
    loadingShowTimer = setTimeout(() => {
      loadingShowTimer = null;
      main.classList.add('is-loading');
      node.hidden = false;
      // Force layout so the opacity transition runs on the next frame.
      void node.offsetWidth;
      node.classList.add('is-visible');
      updateEmptyState();
    }, 80);
    // If no render() arrives within 8s, give up rather than stranding the UI.
    loadingSafetyTimer = setTimeout(() => {
      loadingSafetyTimer = null;
      setLoading(false);
    }, 8000);
  } else {
    main.classList.remove('is-loading');
    node.classList.remove('is-visible');
    // Wait out the fade-out before hiding so the dots don't pop.
    setTimeout(() => {
      if (!main.classList.contains('is-loading')) node.hidden = true;
    }, 220);
    updateEmptyState();
  }
}

// The most recently rendered markdown source + its base dir — handed to the AI
// panel as the "current file" context and used to re-render after an edit.
let lastRenderedText = '';
let lastBaseDir = '';

async function render(text, baseDir) {
  lastRenderedText = text || '';
  if (baseDir) lastBaseDir = baseDir;
  const root = document.getElementById('root');
  // Rewrite relative image paths to file:// URLs so WKWebView's
  // file-URL access whitelist (granted in Swift) can fetch them.
  if (baseDir) {
    md.normalizeLink = (url) => {
      if (/^[a-z][a-z0-9+\-.]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) {
        return url;
      }
      try {
        return new URL(url, baseDir).toString();
      } catch {
        return url;
      }
    };
    md.validateLink = () => true;
  }
  try { FindBar.close(); } catch {}
  const html = md.render(text || '');
  root.innerHTML = html;
  const outline = assignHeadingIds(root);
  addCopyButtons(root);
  renderMath(root);
  await renderMermaidBlocks(root);
  // Reset scroll for new document.
  const main = document.getElementById('main') || document.scrollingElement;
  if (main) main.scrollTop = 0;
  Sidebar.setOutline(outline);
  setLoading(false);
  updateEmptyState();
  try { DocView.onMarkdownRendered(); } catch {}
  try {
    window.webkit?.messageHandlers?.didRender?.postMessage({ length: text.length });
  } catch {}
}

function scrollToAnchor(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

// ===================================================================
// Theme + global UI settings. Themes are named; each has a light/dark
// `base` that drives the highlight.js stylesheet, mermaid, terminal and editor
// palettes. The native shell still resolves the OS appearance for the
// `system` choice and pushes it via setTheme({name, pref}); a named theme is
// applied entirely in the front-end (it carries its own base), so it ignores
// that push. Font sizes are CSS custom properties on :root so every surface
// scales from one place. The settings blob persists natively (uiSettings).
// ===================================================================

// `sw` = [background, accent, foreground] preview swatch colors (must mirror
// the [data-theme='id'] CSS var sets in viewer.css).
const THEMES = [
  { id: 'dark',           label: 'Dark（默认）', base: 'dark',  sw: ['#0d1117', '#4493f8', '#e6edf3'] },
  { id: 'light',          label: 'Light',       base: 'light', sw: ['#ffffff', '#0969da', '#1f2328'] },
  { id: 'cursor-dark',    label: 'Cursor Dark', base: 'dark',  sw: ['#111318', '#7c8cff', '#d7dde8'] },
  { id: 'webstorm-dark',  label: 'WebStorm',    base: 'dark',  sw: ['#2b2d30', '#6c95eb', '#dfe1e5'] },
  { id: 'claude-dark',    label: 'Claude',      base: 'dark',  sw: ['#171412', '#d97757', '#f0e7dc'] },
  { id: 'cursor-light',   label: 'Cursor Light',base: 'light', sw: ['#f8fafc', '#315ee8', '#20242b'] },
  { id: 'webstorm-light', label: 'WebStorm',    base: 'light', sw: ['#ffffff', '#0875e1', '#1f2328'] },
  { id: 'codex-light',    label: 'GPT / Codex', base: 'light', sw: ['#fbfbf8', '#10a37f', '#202124'] },
];
const THEME_BY_ID = Object.fromEntries(THEMES.map((t) => [t.id, t]));

const SETTINGS_DEFAULTS = {
  theme: 'dark',       // 'system' | 'light' | 'dark' | <named theme id>
  fontUI: 13,          // sidebar / tree / outline (px)
  fontEditor: 13,      // CodeMirror + code preview (px)
  fontTerminal: 13,    // xterm (px)
  fontAI: 13,          // AI panel (px)
  autoSave: 'off',     // 'off' | 'afterEdit' | 'onBlur' | 'onLeave'
};
const FONT_MIN = 10;
const FONT_MAX = 28;
const AUTOSAVE_MODES = ['off', 'afterEdit', 'onBlur', 'onLeave'];
const VALID_THEME_IDS = new Set(['system', ...THEMES.map((t) => t.id)]);
const SETTINGS_LS_KEY = 'mdgem.ui.settings';
let uiSettings = { ...SETTINGS_DEFAULTS };
// OS-resolved base ('light'|'dark') pushed by native — used only when the
// chosen theme is 'system'.
let nativeBase = 'dark';

function clampFont(v, def) {
  const n = Math.round(Number(v));   // integer sizes only (no .5)
  if (!Number.isFinite(n)) return def;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, n));
}

function normalizeSettings(s) {
  const out = { ...SETTINGS_DEFAULTS };
  if (s && typeof s === 'object') {
    if (typeof s.theme === 'string' && VALID_THEME_IDS.has(s.theme)) out.theme = s.theme;
    out.fontUI = clampFont(s.fontUI, SETTINGS_DEFAULTS.fontUI);
    out.fontEditor = clampFont(s.fontEditor, SETTINGS_DEFAULTS.fontEditor);
    out.fontTerminal = clampFont(s.fontTerminal, SETTINGS_DEFAULTS.fontTerminal);
    out.fontAI = clampFont(s.fontAI, SETTINGS_DEFAULTS.fontAI);
    if (AUTOSAVE_MODES.includes(s.autoSave)) out.autoSave = s.autoSave;
  }
  return out;
}

// The theme id + base actually applied right now, resolving 'system' against
// the OS appearance the native shell reported.
function resolvedTheme() {
  const pick = uiSettings.theme;
  if (pick === 'system') {
    const base = nativeBase === 'dark' ? 'dark' : 'light';
    return { id: base, base };
  }
  const t = THEME_BY_ID[pick];
  if (t) return { id: t.id, base: t.base };
  // Unknown id — fall back to the app default.
  return { id: 'dark', base: 'dark' };
}

function applyTheme() {
  const { id, base } = resolvedTheme();
  const docEl = document.documentElement;
  docEl.dataset.theme = id;
  docEl.dataset.base = base;
  if (mermaidLoaded && window.MDMermaid) {
    window.MDMermaid.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: base === 'dark' ? 'dark' : 'default',
    });
  }
  try { TerminalPanel.applyTheme(); } catch {}
  try { DocView.applyTheme(); } catch {}
}

function applyFontSizes() {
  const s = document.documentElement.style;
  s.setProperty('--ui-font-size', `${uiSettings.fontUI}px`);
  s.setProperty('--editor-font-size', `${uiSettings.fontEditor}px`);
  s.setProperty('--ai-font-size', `${uiSettings.fontAI}px`);
  try { TerminalPanel.applyFontSize(uiSettings.fontTerminal); } catch {}
}

function applyAllSettings() {
  applyFontSizes();
  applyTheme();
}

// Native theme push: tracks the OS-resolved base for the 'system' choice and
// reapplies if (and only if) the user is on 'system'. A named theme ignores it.
function setTheme(arg) {
  let name;
  if (typeof arg === 'string') name = arg;
  else if (arg && typeof arg === 'object') name = arg.name;
  if (name === 'dark' || name === 'light') nativeBase = name;
  applyTheme();
}

// reqId → resolver, for native settings round-trips (shares the AI pending map).
function requestSettingsGet() {
  return new Promise((resolve) => {
    const reqId = `set-get-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    try {
      if (window.webkit?.messageHandlers?.settingsGet) {
        window.webkit.messageHandlers.settingsGet.postMessage({ reqId });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:settings-get', { reqId }); return; }
    } catch {}
    pendingAi.delete(reqId);
    resolve(null);
  });
}

function requestSettingsSet(settings) {
  try {
    if (window.webkit?.messageHandlers?.settingsSet) {
      window.webkit.messageHandlers.settingsSet.postMessage({ settings });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:settings-set', { settings });
  } catch {}
}

// Ask the host to open the standalone settings window, optionally jumping to a
// section ('appearance' | 'editor' | 'shortcuts' | 'ai').
function requestOpenSettings(section) {
  const payload = section ? { section } : {};
  try {
    if (window.webkit?.messageHandlers?.openSettings) {
      window.webkit.messageHandlers.openSettings.postMessage(payload);
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:open-settings', payload);
  } catch {}
}

// Live-apply a settings blob pushed from the settings window (broadcast by the
// host after a change), so every open project window updates immediately.
function applySettingsBlob(blob) {
  uiSettings = normalizeSettings(blob);
  try { localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(uiSettings)); } catch {}
  applyAllSettings();
}

// Persist the current settings blob (native + a localStorage cache so the next
// cold boot can paint the right theme/fonts before settingsGet resolves).
function persistSettings() {
  try { localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(uiSettings)); } catch {}
  requestSettingsSet(uiSettings);
}

// Per-workspace memory IPC (keyed by workspace root path). Shares the AI
// pending map for the get round-trip.
function requestMemoryGet(key) {
  return new Promise((resolve) => {
    const reqId = `mem-get-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    try {
      if (window.webkit?.messageHandlers?.memoryGet) {
        window.webkit.messageHandlers.memoryGet.postMessage({ reqId, key });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:memory-get', { reqId, key }); return; }
    } catch {}
    pendingAi.delete(reqId);
    resolve(null);
  });
}

function requestMemorySet(key, memory) {
  try {
    if (window.webkit?.messageHandlers?.memorySet) {
      window.webkit.messageHandlers.memorySet.postMessage({ key, memory });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:memory-set', { key, memory });
  } catch {}
}

// History IPC. `scope` is 'chat' or 'term'. Each conversation / terminal
// session is one native JSON file under MDGEM/<scope>/<id>.json, with an
// index.json listing record metadata. Four verbs — list/read/write/delete —
// all round-trip through the AI pending map and resolve on onHistoryLoaded.
// The record's `workspace` field scopes it; the front-end filters by workspace.
function requestHistory(verb, payload) {
  const handler = `history${verb[0].toUpperCase()}${verb.slice(1)}`; // historyList, …
  return new Promise((resolve) => {
    const reqId = `hist-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    const msg = { reqId, ...payload };
    try {
      if (window.webkit?.messageHandlers?.[handler]) {
        window.webkit.messageHandlers[handler].postMessage(msg);
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit(`mdreader:history-${verb}`, msg); return; }
    } catch {}
    pendingAi.delete(reqId);
    resolve(null);
  });
}

const requestHistoryList = (scope) => requestHistory('list', { scope });
const requestHistoryRead = (scope, id) => requestHistory('read', { scope, id });
const requestHistoryWrite = (scope, id, record) => requestHistory('write', { scope, id, record });
const requestHistoryDelete = (scope, id) => requestHistory('delete', { scope, id });

// Record id / filename: YYYY_MMDD_HHMM_xx (xx = 2 random base36 chars), e.g.
// 2026_0530_1406_rz. Native sanitizes to [A-Za-z0-9_], so keep it ASCII-safe.
function fmtId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const rand = Math.random().toString(36).slice(2, 4).padEnd(2, '0');
  return `${d.getFullYear()}_${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `_${p(d.getHours())}${p(d.getMinutes())}_${rand}`;
}

// Settings modal — gear button in the sidebar footer opens it. Theme picker +
// per-surface font sizes. Changes apply live; the blob persists globally.
const Settings = (() => {
  let built = false;

  // Cold boot: paint from the localStorage cache instantly, then reconcile
  // with the native store (source of truth) once it answers.
  function init() {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(SETTINGS_LS_KEY) || 'null'); } catch {}
    if (cached) uiSettings = normalizeSettings(cached);
    applyAllSettings();
    requestSettingsGet().then((s) => {
      if (s && typeof s === 'object') {
        uiSettings = normalizeSettings(s);
        try { localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(uiSettings)); } catch {}
        applyAllSettings();
        if (built) syncControls();
      }
    });
  }

  function themeCard(t) {
    return `
      <button class="set-theme-card" data-theme-id="${t.id}" type="button" title="${escapeHtml(t.label)}">
        <span class="set-theme-sw" style="background:${t.sw[0]}">
          <span class="set-theme-dot" style="background:${t.sw[1]}"></span>
          <span class="set-theme-bar" style="background:${t.sw[2]}"></span>
        </span>
        <span class="set-theme-name">${escapeHtml(t.label)}</span>
      </button>`;
  }

  function themeSystemCard() {
    return `
      <button class="set-theme-card set-theme-system" data-theme-id="system" type="button" title="跟随系统">
        <span class="set-theme-sw set-theme-sw-auto"><span class="set-theme-dot"></span></span>
        <span class="set-theme-name">跟随系统</span>
      </button>`;
  }

  function build() {
    const host = document.getElementById('settings-modal');
    if (!host) return;
    const themeRows = [
      [themeSystemCard(), themeCard(THEME_BY_ID.dark), themeCard(THEME_BY_ID.light)],
      [themeCard(THEME_BY_ID['cursor-dark']), themeCard(THEME_BY_ID['webstorm-dark']), themeCard(THEME_BY_ID['claude-dark'])],
      [themeCard(THEME_BY_ID['cursor-light']), themeCard(THEME_BY_ID['webstorm-light']), themeCard(THEME_BY_ID['codex-light'])],
    ].map((row) => `<div class="set-theme-row">${row.join('')}</div>`).join('');
    const fontRow = (key, label) => `
      <div class="set-font-row" data-font="${key}">
        <span class="set-font-label">${escapeHtml(label)}</span>
        <button class="set-step" data-step="-1" type="button" aria-label="减小">−</button>
        <input class="set-range" type="range" min="${FONT_MIN}" max="${FONT_MAX}" step="1">
        <button class="set-step" data-step="1" type="button" aria-label="增大">+</button>
        <span class="set-font-val"></span>
      </div>`;
    host.innerHTML = `
      <div class="set-backdrop"></div>
      <div class="set-box" role="dialog" aria-label="设置">
        <header class="set-head">
          <span class="set-title">设置</span>
          <button class="set-close" type="button" aria-label="关闭">×</button>
        </header>
        <div class="set-body">
          <section class="set-section">
            <h3 class="set-h">主题</h3>
            <div class="set-theme-rows">${themeRows}</div>
          </section>
          <section class="set-section">
            <h3 class="set-h">字号</h3>
            ${fontRow('fontUI', '界面 / 文件树')}
            ${fontRow('fontEditor', '编辑器')}
            ${fontRow('fontTerminal', '终端')}
            ${fontRow('fontAI', 'AI 面板')}
          </section>
        </div>
      </div>`;

    host.querySelector('.set-backdrop').addEventListener('click', close);
    host.querySelector('.set-close').addEventListener('click', close);
    host.querySelectorAll('.set-theme-card').forEach((card) => {
      card.addEventListener('click', () => pickTheme(card.dataset.themeId));
    });
    host.querySelectorAll('.set-font-row').forEach((row) => {
      const key = row.dataset.font;
      const range = row.querySelector('.set-range');
      range.addEventListener('input', () => setFont(key, parseFloat(range.value)));
      row.querySelectorAll('.set-step').forEach((b) => {
        b.addEventListener('click', () => setFont(key, uiSettings[key] + Number(b.dataset.step)));
      });
    });
    built = true;
  }

  function pickTheme(id) {
    uiSettings.theme = id;
    applyTheme();
    persistSettings();
    syncControls();
  }

  function setFont(key, value) {
    uiSettings[key] = clampFont(value, SETTINGS_DEFAULTS[key]);
    applyFontSizes();
    persistSettings();
    syncControls();
  }

  // Reflect uiSettings into the controls (selected theme card + slider values).
  function syncControls() {
    const host = document.getElementById('settings-modal');
    if (!host || !built) return;
    host.querySelectorAll('.set-theme-card').forEach((c) => {
      c.classList.toggle('is-active', c.dataset.themeId === uiSettings.theme);
    });
    host.querySelectorAll('.set-font-row').forEach((row) => {
      const key = row.dataset.font;
      const v = uiSettings[key];
      row.querySelector('.set-range').value = String(v);
      row.querySelector('.set-font-val').textContent = `${v}px`;
    });
  }

  function open() {
    if (!built) build();
    syncControls();
    const host = document.getElementById('settings-modal');
    if (host) host.hidden = false;
    document.addEventListener('keydown', onKey);
  }

  function close() {
    const host = document.getElementById('settings-modal');
    if (host) host.hidden = true;
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  return { init, open, close };
})();

// Home page — the empty-state turned into a welcome screen (shown whenever no
// document is on screen). Open-file / open-folder buttons ask the host for its
// native dialog; the recents list reopens past workspaces. On Windows this is
// the launch screen; on macOS the launch screen is a native welcome window and
// this also covers empty document windows (e.g. a folder with no markdown).
const Home = (() => {
  let recents = [];

  function init() {
    const ver = document.getElementById('home-version');
    if (ver) {
      const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
      ver.textContent = v ? `v${v}` : '';
    }
    document.getElementById('home-open-folder')?.addEventListener('click', () => requestOpenFolderDialog());
    document.getElementById('home-open-file')?.addEventListener('click', () => requestOpenFileDialog());
    renderRecents();
  }

  function setRecents(list) {
    recents = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
    renderRecents();
  }

  function renderRecents() {
    const wrap = document.getElementById('home-recents');
    const title = document.getElementById('home-recents-title');
    if (!wrap) return;
    const items = recents.slice(0, 8);
    if (title) title.hidden = items.length === 0;
    wrap.innerHTML = '';
    for (const p of items) {
      const row = document.createElement('div');
      row.className = 'home-recent';
      row.title = p;
      const name = document.createElement('span');
      name.className = 'home-recent-name';
      name.textContent = p.split(/[\\/]/).pop() || p;
      const dir = document.createElement('span');
      dir.className = 'home-recent-dir';
      dir.textContent = p;
      row.appendChild(name);
      row.appendChild(dir);
      row.addEventListener('click', () => requestOpenRecent(p));
      wrap.appendChild(row);
    }
  }

  return { init, setRecents };
})();

// ===================================================================
// Sidebar (Files + Outline) — lives entirely in the front-end so both
// the macOS WKWebView host and the Windows Tauri host get the same UI.
// Native shells push the file tree via MDViewerAPI.setFileTree(payload).
// File clicks go back to the host via requestOpenFile(path).
// ===================================================================

function requestOpenFile(path) {
  setLoading(true);
  try {
    if (window.webkit?.messageHandlers?.openFile) {
      window.webkit.messageHandlers.openFile.postMessage({ path });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev && typeof ev.emit === 'function') {
      ev.emit('mdreader:open-file', path);
    }
  } catch {}
}

// ===================================================================
// File preview — the sidebar lists every file (not just markdown). Clicking
// a non-md file previews it in #root: images/video/html point straight at the
// file URL; text/code are fetched through the host (readFileText IPC); markdown
// goes through the normal host open path. Anything else shows a placeholder.
// ===================================================================

const PREVIEW_EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'ogg'],
  html: ['html', 'htm'],
};
const MD_EXT = ['md', 'markdown', 'mdown', 'mkd', 'mkdn'];
// Generous text/code allowlist. Anything not listed here (and not a known
// binary media type above) falls back to "preview not supported".
const TEXT_EXT = [
  'txt', 'text', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'csv', 'tsv', 'xml', 'env', 'properties', 'gitignore', 'editorconfig',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less',
  'rs', 'swift', 'py', 'rb', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cxx', 'm', 'mm', 'cs', 'php', 'pl', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'sql', 'r', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'vue', 'svelte',
  'gradle', 'dockerfile', 'makefile', 'cmake', 'gemfile', 'rakefile', 'tex', 'bib',
];

function fileExt(path) {
  const base = (path || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    // Dotless names like Makefile / Dockerfile are still text.
    return base.toLowerCase();
  }
  return base.slice(dot + 1).toLowerCase();
}

function previewKind(path) {
  const ext = fileExt(path);
  if (MD_EXT.includes(ext)) return 'md';
  if (PREVIEW_EXT.image.includes(ext)) return 'image';
  if (PREVIEW_EXT.video.includes(ext)) return 'video';
  if (PREVIEW_EXT.html.includes(ext)) return 'html';
  if (TEXT_EXT.includes(ext)) return 'text';
  return 'unsupported';
}

// Turn an OS path into a URL the webview can load. Windows (Tauri) needs the
// asset:// conversion exposed by bridge.js; macOS (WKWebView) uses file:// under
// the read-access grant.
function fileURLFor(path) {
  const conv = window.__mdr && window.__mdr.convertFileSrc;
  if (typeof conv === 'function') {
    try { return conv(path); } catch {}
  }
  const enc = String(path).split(/[\\/]/).map(encodeURIComponent).join('/');
  return 'file://' + (enc.startsWith('/') ? enc : '/' + enc);
}

// Pending text reads — reqId → {resolve, reject}.
const pendingReads = new Map();
let readSeq = 0;
function requestReadFile(path) {
  return new Promise((resolve) => {
    const reqId = `rf-${Date.now().toString(36)}-${(++readSeq).toString(36)}`;
    pendingReads.set(reqId, resolve);
    try {
      if (window.webkit?.messageHandlers?.readFileText) {
        window.webkit.messageHandlers.readFileText.postMessage({ path, reqId });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:read-file-text', { path, reqId }); return; }
    } catch {}
    pendingReads.delete(reqId);
    resolve({ path, ok: false, error: 'No host bridge available' });
  });
}

function onReadFileResult(reqId, payload) {
  const resolve = pendingReads.get(reqId);
  if (!resolve) return;
  pendingReads.delete(reqId);
  resolve(payload || { ok: false, error: 'Empty result' });
}

// Ask the host to hand the file to an external app. HTML opens in a browser
// (host prefers Chrome, falls back to the default browser); everything else
// goes to the OS default app for its type.
function requestOpenExternal(path) {
  const browser = previewKind(path) === 'html';
  try {
    if (window.webkit?.messageHandlers?.openExternal) {
      window.webkit.messageHandlers.openExternal.postMessage({ path, browser });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:open-external', { url: fileURLFor(path), browser });
  } catch {}
}

// Home-page actions — ask the host to present its native open dialog (a
// directory is a valid target), or re-open a recent. Fire-and-forget; the
// host opens the chosen target as a new workspace.
function requestOpenFileDialog() {
  try {
    if (window.webkit?.messageHandlers?.openFileDialog) {
      window.webkit.messageHandlers.openFileDialog.postMessage({});
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:open-file-dialog', {});
  } catch {}
}

function requestOpenFolderDialog() {
  try {
    if (window.webkit?.messageHandlers?.openFolderDialog) {
      window.webkit.messageHandlers.openFolderDialog.postMessage({});
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:open-folder-dialog', {});
  } catch {}
}

function requestOpenRecent(path) {
  try {
    if (window.webkit?.messageHandlers?.openRecent) {
      window.webkit.messageHandlers.openRecent.postMessage({ path });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:open-recent', path);
  } catch {}
}

// Finalize a non-md preview: drop loader, clear the outline, mark the row, and
// scroll the pane to the top. `inner` is the HTML to place in #root.
function showPreview(node, inner) {
  const root = document.getElementById('root');
  if (!root) return;
  try { FindBar.close(); } catch {}
  root.innerHTML = inner;
  Sidebar.setOutline([]);
  Sidebar.setActivePreview(node.path);
  const main = document.getElementById('main');
  if (main) main.scrollTop = 0;
  setLoading(false);
  updateEmptyState();
  try { Tabs.note(node.path, previewKind(node.path)); } catch {}
}

// The sandboxed iframe markup used to render an .html file's live preview.
function htmlFrameHTML(path) {
  return `<iframe class="preview-frame" sandbox="allow-same-origin" src="${escapeHtml(fileURLFor(path))}"></iframe>`;
}

function escapeHtml(s) {
  return md.utils.escapeHtml(String(s == null ? '' : s));
}

async function previewFile(node) {
  const kind = previewKind(node.path);
  try { Tabs.captureScroll(); } catch {}
  // Switching away from a dirty editor: auto-save (or confirm discard) first.
  if (DocView.isDirty() && DocView.path() !== node.path) {
    const ok = await DocView.prepareLeave();
    if (!ok) return;
  }
  if (kind === 'md') {
    // This md file is already the loaded document, but a non-md preview is
    // currently on screen. The mac host de-dupes the re-open (same fileURL +
    // same text → no re-render fires), which would strand the preview. Restore
    // the cached markdown locally instead of round-tripping to native.
    if (node.path === Sidebar.currentFilePath() && Sidebar.activePreview()) {
      Sidebar.setActivePreview(null);
      render(lastRenderedText, lastBaseDir);
      return;
    }
    requestOpenFile(node.path);
    return;
  }
  // Re-clicking the file already on screen is a no-op.
  if (Sidebar.activePreview() === node.path) return;

  const name = node.name || node.path;
  if (kind === 'image') {
    DocView.openMedia(node, `<div class="preview-host"><img class="preview-media" alt="${escapeHtml(name)}" src="${escapeHtml(fileURLFor(node.path))}"></div>`);
    return;
  }
  if (kind === 'video') {
    DocView.openMedia(node, `<div class="preview-host"><video class="preview-media" controls src="${escapeHtml(fileURLFor(node.path))}"></video></div>`);
    return;
  }
  if (kind === 'html') {
    // HTML opens as a live preview but is editable (toggle to edit the source).
    DocView.openHtml(node);
    return;
  }
  if (kind === 'text') {
    // Code / text files open in the editor by default (toggle to preview).
    await DocView.openText(node);
    return;
  }
  DocView.toReadonly();
  showPreview(node, previewUnsupportedHTML(node));
}

// Render a text/code file into #root with highlight.js (by extension).
function renderTextPreview(node, text) {
  const ext = fileExt(node.path);
  let body;
  try {
    if (ext && hljs.getLanguage(ext)) {
      body = hljs.highlight(text, { language: ext, ignoreIllegals: true }).value;
    } else {
      body = escapeHtml(text);
    }
  } catch {
    body = escapeHtml(text);
  }
  showPreview(node, `<pre class="preview-code"><code class="hljs">${body}</code></pre>`);
}

function previewUnsupportedHTML(node, reason) {
  const ext = fileExt(node.path);
  const label = ext ? `.${escapeHtml(ext)}` : escapeHtml(node.name || 'this file');
  const why = reason ? `<div class="preview-unsupported-why">${escapeHtml(reason)}</div>` : '';
  return `<div class="preview-unsupported">
    <div class="preview-unsupported-glyph">⊘</div>
    <div class="preview-unsupported-title">Can't preview ${label}</div>
    ${why}
    <button class="preview-open-ext" type="button">Open in default app</button>
  </div>`;
}

// Delegate the "Open in default app" button (re-created on each preview).
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.preview-open-ext');
  if (!btn) return;
  const p = Sidebar.activePreview();
  if (p) requestOpenExternal(p);
});

// Pending lazy-folder scans — reqId → path, plus the set of folder paths
// currently waiting on a host response (drives the inline spinner).
const pendingScans = new Map();
const loadingDirs = new Set();
let scanSeq = 0;

function requestScanDir(path) {
  const reqId = `sd-${Date.now().toString(36)}-${(++scanSeq).toString(36)}`;
  pendingScans.set(reqId, path);
  loadingDirs.add(path);
  try {
    if (window.webkit?.messageHandlers?.scanDir) {
      window.webkit.messageHandlers.scanDir.postMessage({ path, reqId });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev && typeof ev.emit === 'function') {
      ev.emit('mdreader:scan-dir', { path, reqId });
      return;
    }
  } catch {}
  // No host bridge available — drop the spinner so the UI doesn't hang.
  pendingScans.delete(reqId);
  loadingDirs.delete(path);
}

const Sidebar = (() => {
  let currentTree = null;        // { root, current }
  let currentOutline = [];
  const expanded = new Set();    // paths of expanded dirs
  let lastTreeKey = '';          // memoize tree shape so re-renders are cheap
  // Lazy folders (node_modules, dist, …) come back from the host as stubs
  // every time the tree is re-pushed. Once the user has expanded one, cache
  // its children here so subsequent setFileTree() calls can re-hydrate the
  // stub — otherwise opening an md inside such a folder would collapse it.
  const scannedDirs = new Map();
  let currentRootPath = '';
  // Native hosts still push recents via MDViewerAPI.setRecents — held here in
  // case a UI is reintroduced; nothing renders them today.
  let currentRecents = [];
  // Path of a non-markdown file currently shown in the preview pane. Markdown
  // opens go through the host (which sets currentTree.current); non-md previews
  // are JS-only, so we track the highlighted row here.
  let previewPath = null;

  function el(id) { return document.getElementById(id); }

  function init() {
    const sb = el('sidebar');
    if (!sb) return;

    const w = parseInt(localStorage.getItem('mdgem.sb.width') || '260', 10);
    if (Number.isFinite(w) && w >= 160 && w <= 480) sb.style.width = `${w}px`;

    setCollapsed(localStorage.getItem('mdgem.sb.collapsed') === '1');
    setTab(localStorage.getItem('mdgem.sb.tab') || 'files');

    document.querySelectorAll('.sb-tab').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    el('sb-collapse')?.addEventListener('click', () => setCollapsed(true));
    el('sb-expand')?.addEventListener('click', () => setCollapsed(false));
    el('sb-settings-btn')?.addEventListener('click', () => requestOpenSettings());
    document.querySelectorAll('.sb-fortune-item').forEach((it) => {
      it.addEventListener('click', () => {
        const kind = it.dataset.kind;
        showFortune(kind || 'coin');
      });
    });

    // Stamp the bundle's package version into the sidebar footer. The literal
    // is injected by esbuild's `define` (see build.mjs); falls back gracefully
    // if someone runs the source outside the bundle.
    const ver = el('sb-version');
    if (ver) {
      const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
      ver.textContent = v ? `v${v}` : '';
    }

    initResize();
    updateEmptyState();
  }

  function setTab(name) {
    if (name !== 'files' && name !== 'outline') name = 'files';
    document.querySelectorAll('.sb-tab').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.dataset.tab === name ? 'true' : 'false');
    });
    const filesPane = el('sb-pane-files');
    const outlinePane = el('sb-pane-outline');
    if (filesPane) filesPane.hidden = name !== 'files';
    if (outlinePane) outlinePane.hidden = name !== 'outline';
    const sb = el('sidebar');
    if (sb) sb.dataset.tab = name;
    localStorage.setItem('mdgem.sb.tab', name);
    try { Memory.scheduleSave(); } catch {}
  }

  function setCollapsed(collapsed) {
    const sb = el('sidebar');
    const exp = el('sb-expand');
    if (sb) sb.hidden = !!collapsed;
    if (exp) exp.hidden = !collapsed;
    localStorage.setItem('mdgem.sb.collapsed', collapsed ? '1' : '0');
    try { Memory.scheduleSave(); } catch {}
  }

  function toggleCollapsed() {
    const sb = el('sidebar');
    setCollapsed(!(sb && sb.hidden));
  }

  function initResize() {
    const handle = el('sb-resize');
    const sb = el('sidebar');
    if (!handle || !sb) return;
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(160, Math.min(480, e.clientX));
      sb.style.width = `${w}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('mdgem.sb.width', String(sb.offsetWidth));
      try { Memory.scheduleSave(); } catch {}
    });
  }

  function setActivePreview(path) {
    previewPath = path || null;
    renderFiles();
  }

  function activePreview() {
    return previewPath;
  }

  function currentFilePath() {
    return (currentTree && currentTree.current) || null;
  }

  function workspaceRoot() {
    return (currentTree && currentTree.root && currentTree.root.path) || null;
  }

  function setFileTree(payload) {
    const prevCurrent = (currentTree && currentTree.current) || null;
    currentTree = payload && payload.root ? payload : null;
    const newCurrent = (currentTree && currentTree.current) || null;
    // Only treat this as a fresh markdown render when `current` actually
    // changed. A tree-only re-push — e.g. the FS watcher firing `bumpTree()`
    // after we saved an unrelated code/text file — carries the same stale
    // `current` and must NOT tear down the active editor/preview.
    const currentChanged = !!newCurrent && newCurrent !== prevCurrent;
    // A real markdown open (host sets `current`) supersedes any non-md preview.
    if (currentChanged) previewPath = null;
    if (currentTree?.root) {
      // If the workspace root changed, the cached lazy-dir contents from the
      // previous workspace are stale.
      if (currentTree.root.path !== currentRootPath) {
        scannedDirs.clear();
        currentRootPath = currentTree.root.path;
        // New workspace entry — load & restore its remembered UI state.
        try { Memory.onWorkspace(currentRootPath); } catch {}
        // Drop tabs that belonged to the previous workspace.
        try { Tabs.pruneToRoot(currentRootPath); } catch {}
      }
      // Re-hydrate any lazy nodes whose children we previously scanned, so
      // the host's "lazy stub" doesn't collapse a folder the user expanded.
      walk(currentTree.root, (node) => {
        if (node.type === 'dir' && node.lazy && scannedDirs.has(node.path)) {
          node.children = scannedDirs.get(node.path);
          node.lazy = false;
        }
      });
    }
    autoExpand();
    renderFiles();
    // The host pushes the tree right *after* rendering a markdown doc (render
    // runs before setFileTree), so `current` only becomes authoritative here.
    // Re-sync the doc/tab state now that we know the real path — but only when
    // `current` changed, so a bare tree refresh doesn't reset the active editor.
    if (currentChanged) {
      try { DocView.onMarkdownRendered(); } catch {}
    }
  }

  function onScanDirResult(reqId, payload) {
    const path = pendingScans.get(reqId);
    if (!path) return;
    pendingScans.delete(reqId);
    loadingDirs.delete(path);
    if (!currentTree?.root || !payload) {
      renderFiles();
      return;
    }
    const targetPath = payload.path || path;
    const children = Array.isArray(payload.children) ? payload.children : [];
    walk(currentTree.root, (node) => {
      if (node.type === 'dir' && node.path === targetPath) {
        node.children = children;
        node.lazy = false;
      }
    });
    scannedDirs.set(targetPath, children);
    // Keep memo in sync so a later auto-expand doesn't wipe what we just
    // loaded.
    lastTreeKey = treeKey(currentTree.root);
    renderFiles();
  }

  function setOutline(items) {
    currentOutline = Array.isArray(items) ? items : [];
    renderOutline();
  }

  // No-op holder. The visible Recent files menu was removed; the native
  // side still tracks recents and pushes them here, so reintroducing a UI
  // later (right-click, command palette, …) just needs to read this list.
  function setRecents(list) {
    currentRecents = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  }

  function autoExpand() {
    if (!currentTree?.root) return;
    const key = treeKey(currentTree.root);
    if (key !== lastTreeKey) {
      expanded.clear();
      lastTreeKey = key;
    }
    expanded.add(currentTree.root.path);
    const target = currentTree.current;
    if (!target) return;
    walk(currentTree.root, (node, parents) => {
      if (node.path === target) {
        for (const p of parents) expanded.add(p.path);
      }
    });
  }

  function treeKey(node) {
    // A coarse fingerprint: path + children count, recursive. Cheap and
    // good enough to detect "different folder opened" vs "same folder".
    if (!node) return '';
    if (node.type === 'file') return `f:${node.path}`;
    const kids = (node.children || []).map(treeKey).join('|');
    return `d:${node.path}(${kids})`;
  }

  function walk(node, fn, parents = []) {
    fn(node, parents);
    if (node.children) {
      const next = parents.concat(node);
      for (const c of node.children) walk(c, fn, next);
    }
  }

  function renderFiles() {
    const pane = el('sb-pane-files');
    if (!pane) return;
    if (!currentTree?.root) {
      pane.innerHTML = '<div class="sb-empty">No folder open</div>';
      return;
    }
    pane.innerHTML = '';
    pane.appendChild(buildNode(currentTree.root, previewPath || currentTree.current));
  }

  function buildNode(node, current) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-item';
    row.title = node.path;
    if (node.path === current) row.classList.add('is-current');

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name || node.path;

    if (node.type === 'dir') {
      const isLazy = !!node.lazy;
      const isLoading = loadingDirs.has(node.path);
      const open = expanded.has(node.path);
      if (isLoading) {
        toggle.textContent = '';
        toggle.classList.add('tree-spinner');
      } else {
        toggle.textContent = open ? '▾' : '▸';
      }
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.innerHTML = iconForFolder(open && !isLazy);
      row.appendChild(toggle);
      row.appendChild(icon);
      row.appendChild(label);
      if (isLazy && !isLoading) {
        const hint = document.createElement('span');
        hint.className = 'tree-lazy-hint';
        hint.textContent = '…';
        hint.title = 'Click to load';
        row.appendChild(hint);
      }
      row.addEventListener('click', () => {
        if (isLoading) return;
        if (isLazy) {
          // Treat first click as "load + open" — show spinner immediately
          // and mark expanded so the result drops in already open.
          expanded.add(node.path);
          requestScanDir(node.path);
          renderFiles();
          try { Memory.scheduleSave(); } catch {}
          return;
        }
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        renderFiles();
        try { Memory.scheduleSave(); } catch {}
      });
      wrap.appendChild(row);
      if (open && !isLazy && node.children?.length) {
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        for (const c of node.children) kids.appendChild(buildNode(c, current));
        wrap.appendChild(kids);
      }
    } else {
      toggle.textContent = '';
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.innerHTML = iconForFile(fileExt(node.path));
      row.appendChild(toggle);
      row.appendChild(icon);
      row.appendChild(label);
      row.addEventListener('click', () => {
        // Re-clicking the active file: native shells de-dupe the load (no
        // re-render fires), which would strand the loader. Just scroll the
        // doc to the top, mirroring what most editors do for the same case.
        if (node.path === current) {
          const main = document.getElementById('main');
          if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        previewFile(node);
      });
      wrap.appendChild(row);
    }
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, node);
    });
    return wrap;
  }

  function openContextMenu(x, y, node) {
    if (node.type === 'dir') {
      showContextMenu(x, y, [
        { label: '添加到 AI', action: () => AIPanel.attachFile(node.path, true) },
        'separator',
        { label: '新建文件…',   action: () => promptCreate(node, 'file') },
        { label: '新建文件夹…', action: () => promptCreate(node, 'folder') },
        'separator',
        { label: revealLabel(), action: () => fsOp({ op: 'reveal', path: node.path }) },
        { label: '复制路径', action: () => copyPath(node.path) },
      ]);
    } else {
      showContextMenu(x, y, [
        { label: '添加到 AI', action: () => AIPanel.attachFile(node.path, false) },
        'separator',
        { label: '打开', action: () => previewFile(node) },
        { label: '用系统打开', action: () => requestOpenExternal(node.path) },
        { label: revealLabel(), action: () => fsOp({ op: 'reveal', path: node.path }) },
        { label: '复制路径', action: () => copyPath(node.path) },
        'separator',
        { label: '重命名…', action: () => promptRename(node) },
        { label: trashLabel(), danger: true, action: () => confirmDelete(node) },
      ]);
    }
  }

  function renderOutline() {
    const pane = el('sb-pane-outline');
    if (!pane) return;
    if (!currentOutline.length) {
      pane.innerHTML = '<div class="sb-empty">No headings</div>';
      return;
    }
    const minLevel = currentOutline.reduce((m, i) => Math.min(m, i.level), 6);
    pane.innerHTML = '';
    for (const item of currentOutline) {
      const row = document.createElement('div');
      row.className = `outline-item lvl-${item.level}`;
      row.style.paddingLeft = `${(item.level - minLevel) * 12 + 12}px`;
      row.textContent = item.text;
      row.title = item.text;
      row.addEventListener('click', () => {
        document.querySelectorAll('.outline-item').forEach((e) => e.classList.remove('is-current'));
        row.classList.add('is-current');
        scrollToAnchor(item.id);
      });
      pane.appendChild(row);
    }
  }

  // ── Per-workspace memory: capture / restore sidebar layout + expansions. ──
  function collectLayout() {
    const sb = el('sidebar');
    const dirs = [];
    if (currentTree?.root) {
      walk(currentTree.root, (node) => {
        if (node.type === 'dir' && expanded.has(node.path)
            && node.path !== currentTree.root.path) {
          dirs.push(node.path);
        }
      });
    }
    // Sidebar width is global (localStorage), not per-workspace — only the
    // collapsed/tab state and expansions are remembered per project.
    return {
      sb: {
        collapsed: !!(sb && sb.hidden),
        tab: (sb && sb.dataset.tab) || 'files',
      },
      expandedFolders: dirs,
    };
  }

  function restoreLayout(blob) {
    if (!blob) return;
    const s = blob.sb || {};
    if (typeof s.collapsed === 'boolean') setCollapsed(s.collapsed);
    if (s.tab) setTab(s.tab);
    if (Array.isArray(blob.expandedFolders) && currentTree?.root) {
      for (const p of blob.expandedFolders) expanded.add(p);
      renderFiles();
    }
  }

  function fileExists(path) {
    if (!currentTree?.root || !path) return false;
    let found = false;
    walk(currentTree.root, (node) => { if (node.path === path) found = true; });
    return found;
  }

  return {
    init,
    setFileTree,
    setOutline,
    toggleCollapsed,
    onScanDirResult,
    setRecents,
    setActivePreview,
    activePreview,
    currentFilePath,
    workspaceRoot,
    collectLayout,
    restoreLayout,
    fileExists,
  };
})();

// ===================================================================
// Panels — right-side AI panel + bottom terminal panel. The scaffolding
// (toggle buttons, show/hide, drag-to-resize) lives here; the panels' own
// contents are wired up by their modules via PanelHooks.
// ===================================================================

// Lazily populated by the AI / terminal modules so this controller doesn't
// hard-depend on them (keeps each build self-contained).
const PanelHooks = {
  ai: null,            // called once when the AI panel first opens
  terminal: null,      // called once when the terminal panel first opens
  terminalResized: null, // called after the terminal panel is resized/shown
};

const Panels = (() => {
  function el(id) { return document.getElementById(id); }

  function init() {
    el('sb-ai-btn')?.addEventListener('click', () => toggleAi());
    el('sb-term-btn')?.addEventListener('click', () => toggleTerminal());

    const aiW = parseInt(localStorage.getItem('mdgem.ai.width') || '360', 10);
    if (Number.isFinite(aiW)) {
      const p = el('ai-panel');
      if (p) p.style.width = `${Math.max(240, Math.min(720, aiW))}px`;
    }
    const termH = parseInt(localStorage.getItem('mdgem.term.height') || '260', 10);
    if (Number.isFinite(termH)) {
      const p = el('terminal-panel');
      if (p) p.style.height = `${Math.max(120, Math.min(600, termH))}px`;
    }

    initAiResize();
    initTermResize();
  }

  function aiOpen() { return !!(el('ai-panel') && !el('ai-panel').hidden); }
  function terminalOpen() { return !!(el('terminal-panel') && !el('terminal-panel').hidden); }

  function setAi(open) {
    const panel = el('ai-panel');
    const handle = el('ai-resize');
    const btn = el('sb-ai-btn');
    if (!panel) return;
    panel.hidden = !open;
    if (handle) handle.hidden = !open;
    if (btn) btn.classList.toggle('is-active', open);
    if (open && PanelHooks.ai) PanelHooks.ai();
    try { Memory.scheduleSave(); } catch {}
  }

  function setTerminal(open) {
    const panel = el('terminal-panel');
    const handle = el('term-resize');
    const btn = el('sb-term-btn');
    if (!panel) return;
    panel.hidden = !open;
    if (handle) handle.hidden = !open;
    if (btn) btn.classList.toggle('is-active', open);
    if (open) {
      if (PanelHooks.terminal) PanelHooks.terminal();
      if (PanelHooks.terminalResized) PanelHooks.terminalResized();
    }
    try { Memory.scheduleSave(); } catch {}
  }

  function toggleAi() { setAi(!aiOpen()); }
  function toggleTerminal() { setTerminal(!terminalOpen()); }

  function initAiResize() {
    const handle = el('ai-resize');
    const row = el('content-row');
    const panel = el('ai-panel');
    if (!handle || !row || !panel) return;
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = row.getBoundingClientRect();
      const w = Math.max(240, Math.min(720, rect.right - e.clientX));
      panel.style.width = `${w}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('mdgem.ai.width', String(panel.offsetWidth));
      try { Memory.scheduleSave(); } catch {}
    });
  }

  function initTermResize() {
    const handle = el('term-resize');
    const ws = el('workspace');
    const panel = el('terminal-panel');
    if (!handle || !ws || !panel) return;
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = ws.getBoundingClientRect();
      const h = Math.max(120, Math.min(600, rect.bottom - e.clientY));
      panel.style.height = `${h}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('mdgem.term.height', String(panel.offsetHeight));
      if (PanelHooks.terminalResized) PanelHooks.terminalResized();
      try { Memory.scheduleSave(); } catch {}
    });
  }

  // ── Per-workspace memory: capture / restore panel open-state only. Panel
  // sizes (AI width / terminal height) are global via localStorage, so they
  // are deliberately not stored per workspace. ──
  function collectLayout() {
    return {
      ai: { open: aiOpen() },
      term: { open: terminalOpen() },
    };
  }

  function restoreLayout(blob) {
    const p = blob && blob.panels;
    if (!p) return;
    if (p.ai && p.ai.open) setAi(true);
    if (p.term && p.term.open) setTerminal(true);
  }

  return { init, toggleAi, toggleTerminal, aiOpen, terminalOpen, collectLayout, restoreLayout };
})();

// ===================================================================
// AI assistant — config form + chat, with "apply edit" to the current file.
// HTTP runs natively (see AIService.swift / lib.rs ai_chat_blocking); the panel
// only builds messages and renders responses. Edits the model proposes inside a
// ```md:apply fenced block become an "Apply" button gated by a confirm dialog.
// ===================================================================

const AI_PRESETS = {
  qwen:     { label: '通义千问 (DashScope)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus' },
  zhipu:    { label: '智谱 GLM',             baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',       model: 'glm-5.1' },
  deepseek: { label: 'DeepSeek',             baseURL: 'https://api.deepseek.com/v1',                       model: 'deepseek-v4-pro' },
  custom:   { label: '自定义 (OpenAI 兼容)',  baseURL: '',                                                  model: '' },
};

const AI_SYSTEM_PROMPT =
  "You are MDGEM's built-in agent — one assistant for both office/writing work (Markdown, " +
  'notes, docs) and coding. You operate inside the user\'s current workspace and have tools to ' +
  'read, search, edit and create files, so you can actually finish a task instead of only ' +
  'describing it.\n\n' +
  'How to work:\n' +
  '- Prefer acting over asking. Gather context yourself with read_file / list_dir / search.\n' +
  '- For small, localized changes use edit_file (exact old→new). For new files or full rewrites ' +
  'use write_file. Always send the file\'s real content, never a placeholder.\n' +
  '- Match the existing language, tone and formatting of whatever you edit.\n' +
  '- Keep going across as many tool calls as needed until the task is genuinely done, then end ' +
  'with a short summary of what you did.\n' +
  '- For any task with 3+ steps, call todo_write first to lay out a checklist, then update it ' +
  '(mark items in_progress / completed) as you go so the user can follow your progress.\n' +
  '- Use absolute paths. The workspace root and the currently open file are given below.\n' +
  '- Reply in the user\'s language. Be concise; no filler.';

// OpenAI function-tool schemas. File tools always available; command + web are
// gated behind AI_CAPS and only advertised when their native backends exist.
const AI_CAPS = { command: true, web: true };

const FILE_TOOL_SPECS = [
  { type: 'function', function: {
    name: 'read_file',
    description: 'Read a UTF-8 text file and return its full contents. Use an absolute path.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute file path' },
    }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'list_dir',
    description: 'List the files and folders directly inside a directory (one level). Absolute path.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', description: 'Absolute directory path' },
    }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'search',
    description: 'Case-insensitive substring search across text files in the workspace. ' +
      'Returns "relative/path:line: text" matches.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Text to find' },
      path: { type: 'string', description: 'Directory to search; defaults to the workspace root' },
    }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'edit_file',
    description: 'Replace occurrences of `old` with `new` in a text file. `old` should be unique; ' +
      'copy it from the file (whitespace differences are tolerated, but include enough context to ' +
      'be unambiguous). By default replaces one occurrence and errors if `old` is not unique — set ' +
      'replace_all to change every occurrence. Prefer this over write_file for small edits.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      old: { type: 'string', description: 'Text to find (unique unless replace_all)' },
      new: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    }, required: ['path', 'old', 'new'] },
  } },
  { type: 'function', function: {
    name: 'write_file',
    description: 'Create a file or overwrite it entirely with `content`. Use for new files or ' +
      'full rewrites. Always include the complete intended content.',
    parameters: { type: 'object', properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    }, required: ['path', 'content'] },
  } },
];

const CMD_TOOL_SPEC = { type: 'function', function: {
  name: 'run_command',
  description: 'Run a non-interactive shell command in the workspace and return its stdout/stderr. ' +
    'The user must approve each command. Use for build/test/git/grep and similar one-shot tasks. ' +
    'Do not start long-running servers or interactive programs.',
  parameters: { type: 'object', properties: {
    command: { type: 'string', description: 'The full command line to run' },
    cwd: { type: 'string', description: 'Working directory; defaults to the workspace root' },
  }, required: ['command'] },
} };

const WEB_TOOL_SPEC = { type: 'function', function: {
  name: 'web_search',
  description: 'Search the public web and return a list of result titles, URLs and snippets. ' +
    'Use to look up facts, docs or current information you do not already know.',
  parameters: { type: 'object', properties: {
    query: { type: 'string', description: 'Search query' },
  }, required: ['query'] },
} };

const TODO_TOOL_SPEC = { type: 'function', function: {
  name: 'todo_write',
  description: 'Create or update a visible TODO checklist for a multi-step task. Call it at the ' +
    'start of any task with 3+ steps, then call it again whenever progress changes to mark items ' +
    'in_progress / completed. Always send the FULL list (the latest call replaces the displayed ' +
    'list). Keep exactly one item in_progress at a time. This is for tracking only — it does not ' +
    'execute anything.',
  parameters: { type: 'object', properties: {
    todos: { type: 'array', description: 'The full ordered checklist', items: {
      type: 'object', properties: {
        content: { type: 'string', description: 'Short imperative description of the step' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      }, required: ['content', 'status'],
    } },
  }, required: ['todos'] },
} };

function aiToolSpecs() {
  const specs = FILE_TOOL_SPECS.slice();
  specs.push(TODO_TOOL_SPEC);
  if (AI_CAPS.command) specs.push(CMD_TOOL_SPEC);
  if (AI_CAPS.web) specs.push(WEB_TOOL_SPEC);
  return specs;
}

// reqId → resolver, for native chat round-trips.
const pendingAi = new Map();
// reqId → onDelta(text), for live streaming of a chat turn.
const aiDeltaHandlers = new Map();
let aiSeq = 0;

function requestAiGetConfig() {
  return new Promise((resolve) => {
    const reqId = `ai-cfg-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    try {
      if (window.webkit?.messageHandlers?.aiGetConfig) {
        window.webkit.messageHandlers.aiGetConfig.postMessage({ reqId });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:ai-get-config', { reqId }); return; }
    } catch {}
    pendingAi.delete(reqId);
    resolve(null);
  });
}

function requestAiSetConfig(config) {
  try {
    if (window.webkit?.messageHandlers?.aiSetConfig) {
      window.webkit.messageHandlers.aiSetConfig.postMessage({ config });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:ai-set-config', { config });
  } catch {}
}

// ── AI config model ──
// {
//   providers: [{ id, name, baseURL, apiKey, models: string[] }],
//   defaultModel: { providerId, model } | null,   // resolves the "Auto" entry
//   prefs: { approvalPolicy, temperatureEnabled, temperature, systemPrompt, maxSteps }
// }
// approvalPolicy: 'ask' (confirm every write/command) | 'allowEdits' (auto-apply
// file edits/writes, still confirm run_command) | 'allowAll' (no confirms).
const AI_PREFS_DEFAULTS = {
  approvalPolicy: 'ask',
  temperatureEnabled: false,
  temperature: 0.7,
  systemPrompt: '',
  maxSteps: 50,
};

function aiGenId() {
  return `p-${(Date.now() % 1e7).toString(36)}-${Math.floor(performance.now()).toString(36)}-${(++aiSeq).toString(36)}`;
}

function normalizeAiConfig(c) {
  const out = { providers: [], defaultModel: null, prefs: { ...AI_PREFS_DEFAULTS } };
  if (!c || typeof c !== 'object') return out;
  if (Array.isArray(c.providers)) {
    out.providers = c.providers
      .filter((p) => p && typeof p === 'object')
      .map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id : aiGenId(),
        name: String(p.name || '').trim() || '未命名',
        baseURL: String(p.baseURL || '').trim(),
        apiKey: String(p.apiKey || '').trim(),
        models: Array.isArray(p.models)
          ? [...new Set(p.models.map((m) => String(m || '').trim()).filter(Boolean))]
          : [],
      }));
  } else if (c.apiKey || c.baseURL || c.model) {
    // Migrate the old single-provider config.
    out.providers = [{
      id: aiGenId(),
      name: String(c.provider || '默认'),
      baseURL: String(c.baseURL || '').trim(),
      apiKey: String(c.apiKey || '').trim(),
      models: c.model ? [String(c.model).trim()] : [],
    }];
  }
  if (c.prefs && typeof c.prefs === 'object') {
    const p = c.prefs;
    out.prefs.approvalPolicy = ['ask', 'allowEdits', 'allowAll'].includes(p.approvalPolicy)
      ? p.approvalPolicy
      : (p.autoApprove ? 'allowAll' : 'ask');   // migrate the old boolean
    out.prefs.temperatureEnabled = !!p.temperatureEnabled;
    const t = Number(p.temperature);
    out.prefs.temperature = Number.isFinite(t) ? Math.max(0, Math.min(2, t)) : 0.7;
    out.prefs.systemPrompt = typeof p.systemPrompt === 'string' ? p.systemPrompt : '';
    const ms = parseInt(p.maxSteps, 10);
    out.prefs.maxSteps = Number.isFinite(ms) ? Math.max(1, Math.min(500, ms)) : 50;
  }
  // Validate defaultModel against available models; else fall back to the first.
  const all = aiAllModels(out);
  if (c.defaultModel && all.some((x) => x.providerId === c.defaultModel.providerId && x.model === c.defaultModel.model)) {
    out.defaultModel = { providerId: c.defaultModel.providerId, model: c.defaultModel.model };
  } else if (all.length) {
    out.defaultModel = { providerId: all[0].providerId, model: all[0].model };
  }
  return out;
}

// Flatten every (provider, model) pair available for the chat dropdown.
function aiAllModels(cfg) {
  if (!cfg || !Array.isArray(cfg.providers)) return [];
  const out = [];
  for (const p of cfg.providers) {
    for (const m of (p.models || [])) out.push({ providerId: p.id, provider: p.name, model: m });
  }
  return out;
}

// Ordered candidates for "Auto": the top (first-listed) model of every usable
// key, in config order — each key's highest-tier model by convention. A key is
// usable only if it has a base URL, an API key, and at least one model. The
// agent probes this list in order and locks onto the first that connects; if
// every key's first model fails it errors out (no lower-tier fallback).
function aiAutoCandidates(cfg) {
  const provs = (cfg && Array.isArray(cfg.providers) ? cfg.providers : [])
    .filter((p) => p && p.baseURL && p.apiKey && Array.isArray(p.models) && p.models.length);
  // Only each key's first model — no lower-tier fallback (user's choice).
  return provs.map((p) => ({ providerId: p.id, model: p.models[0] }));
}

// Resolve a dropdown selection to the credentials a chat request needs.
//   sel: { providerId, model } | { auto: true } | null
function aiResolveCreds(cfg, sel) {
  const all = aiAllModels(cfg);
  if (!all.length) return null;
  let pick;
  if (!sel || sel.auto) {
    pick = (cfg.defaultModel && all.find((x) => x.providerId === cfg.defaultModel.providerId && x.model === cfg.defaultModel.model)) || all[0];
  } else {
    pick = all.find((x) => x.providerId === sel.providerId && x.model === sel.model) || all[0];
  }
  const provider = cfg.providers.find((p) => p.id === pick.providerId);
  if (!provider || !provider.baseURL || !provider.apiKey) return null;
  const creds = { baseURL: provider.baseURL, apiKey: provider.apiKey, model: pick.model };
  const prefs = cfg.prefs || {};
  if (prefs.temperatureEnabled && Number.isFinite(prefs.temperature)) creds.temperature = prefs.temperature;
  return creds;
}

// One streaming chat turn. Resolves to {full, toolCalls} on success (toolCalls
// is the native flattened [{id,name,arguments}] or null) or {error}. `onDelta`
// receives streamed text chunks as they arrive.
// `creds` carries the per-request {baseURL, apiKey, model, temperature?} chosen
// from the model dropdown, so the host uses the right key+model (instead of a
// single stored config).
function requestAiChat(messages, tools, onDelta, creds) {
  return new Promise((resolve) => {
    const reqId = `ai-chat-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    if (onDelta) aiDeltaHandlers.set(reqId, onDelta);
    try {
      if (window.webkit?.messageHandlers?.aiChat) {
        window.webkit.messageHandlers.aiChat.postMessage({ reqId, messages, tools, creds });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:ai-chat', { reqId, messages, tools, creds }); return; }
    } catch {}
    pendingAi.delete(reqId);
    aiDeltaHandlers.delete(reqId);
    resolve({ error: 'No host bridge available' });
  });
}

// Run a native-backed agent tool (search / list_dir / run_command / web_search).
// Resolves to {ok, result}.
function requestAiTool(name, args) {
  return new Promise((resolve) => {
    const reqId = `ai-tool-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    try {
      if (window.webkit?.messageHandlers?.aiTool) {
        window.webkit.messageHandlers.aiTool.postMessage({ reqId, name, args });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:ai-tool', { reqId, name, args }); return; }
    } catch {}
    pendingAi.delete(reqId);
    resolve({ ok: false, result: 'No host bridge available' });
  });
}

// Streamed text chunk for an in-flight chat turn.
function onAiDelta(reqId, payload) {
  const h = aiDeltaHandlers.get(reqId);
  if (h && payload && typeof payload.text === 'string') h(payload.text);
}

function requestWriteFile(path, content) {
  return new Promise((resolve) => {
    const reqId = `wf-${(++aiSeq).toString(36)}`;
    pendingAi.set(reqId, resolve);
    try {
      if (window.webkit?.messageHandlers?.writeFile) {
        window.webkit.messageHandlers.writeFile.postMessage({ reqId, path, content });
        return;
      }
    } catch {}
    try {
      const ev = window.__TAURI__?.event;
      if (ev?.emit) { ev.emit('mdreader:write-file', { reqId, path, content }); return; }
    } catch {}
    pendingAi.delete(reqId);
    resolve({ ok: false, error: 'No host bridge available' });
  });
}

function resolveAi(reqId, value) {
  aiDeltaHandlers.delete(reqId);
  const r = pendingAi.get(reqId);
  if (!r) return;
  pendingAi.delete(reqId);
  r(value);
}

// ===================================================================
// Diff + robust edit application (shared by the AI agent's edit/write tools).
// ===================================================================

// LCS line diff → [{type:'ctx'|'add'|'del', text}]. Guards against O(n*m) blow-up
// on very large files by falling back to a plain replace summary.
function diffLines(oldText, newText) {
  const a = String(oldText == null ? '' : oldText).split('\n');
  const b = String(newText == null ? '' : newText).split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4_000_000) {
    return [{ type: 'note', text: `（文件较大，省略逐行对比：${n} 行 → ${m} 行）` }];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

// Collapse long unchanged runs to ±pad lines around each change.
function collapseDiff(rows, pad = 3) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'ctx') {
      for (let k = Math.max(0, i - pad); k <= Math.min(rows.length - 1, i + pad); k++) keep[k] = true;
    }
  }
  const out = [];
  let hidden = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === 'note') { out.push(rows[i]); continue; }
    if (keep[i]) {
      if (hidden) { out.push({ type: 'gap', text: `⋯ ${hidden} 行未改动` }); hidden = 0; }
      out.push(rows[i]);
    } else { hidden++; }
  }
  if (hidden) out.push({ type: 'gap', text: `⋯ ${hidden} 行未改动` });
  return out;
}

function buildDiffNode(oldText, newText) {
  const node = document.createElement('div');
  node.className = 'ai-diff';
  const rows = collapseDiff(diffLines(oldText, newText));
  const changed = rows.some((r) => r.type === 'add' || r.type === 'del');
  if (!changed) { node.textContent = '（无变化）'; return node; }
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = `ai-diff-line ai-diff-${r.type}`;
    const sign = r.type === 'add' ? '+ ' : r.type === 'del' ? '- ' : (r.type === 'ctx' ? '  ' : '');
    line.textContent = sign + r.text;
    node.appendChild(line);
  }
  return node;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
}

// Apply an old→new edit robustly. Tries an exact match first; on miss, falls
// back to a whitespace-tolerant line match (handles indentation / trailing-space
// / CRLF drift — the usual reasons exact edits fail). Returns
// {ok, text?, count?, error?}.
function applyEditMatch(source, oldStr, newStr, replaceAll) {
  if (oldStr == null || oldStr === '') return { ok: false, error: '`old` is empty' };
  const text = String(source).replace(/\r\n/g, '\n');
  const old = String(oldStr).replace(/\r\n/g, '\n');
  const rep = String(newStr == null ? '' : newStr).replace(/\r\n/g, '\n');

  const exact = countOccurrences(text, old);
  if (exact > 0) {
    if (!replaceAll && exact > 1) {
      return { ok: false, error: `\`old\` appears ${exact} times; add more surrounding context to make it unique, or set replace_all=true.` };
    }
    // Replace literally — a function replacer avoids `$`-pattern interpretation.
    const next = replaceAll ? text.split(old).join(rep) : text.replace(old, () => rep);
    return { ok: true, text: next, count: replaceAll ? exact : 1 };
  }

  // Lenient: match a contiguous block of lines ignoring per-line surrounding ws.
  const lines = text.split('\n');
  const oldLines = old.replace(/\n$/, '').split('\n');
  const norm = (s) => s.trim();
  const oldNorm = oldLines.map(norm);
  const starts = [];
  for (let i = 0; i + oldNorm.length <= lines.length; i++) {
    let hit = true;
    for (let k = 0; k < oldNorm.length; k++) {
      if (norm(lines[i + k]) !== oldNorm[k]) { hit = false; break; }
    }
    if (hit) { starts.push(i); if (!replaceAll) break; }
  }
  if (starts.length === 0) {
    return { ok: false, error: '`old` text not found (even ignoring whitespace). Re-read the file and copy the exact text.' };
  }
  if (!replaceAll && starts.length > 1) {
    return { ok: false, error: `\`old\` matches ${starts.length} blocks; add more context or set replace_all=true.` };
  }
  const repLines = rep.split('\n');
  let result = lines.slice();
  for (let s = starts.length - 1; s >= 0; s--) {
    result.splice(starts[s], oldNorm.length, ...repLines);
  }
  return { ok: true, text: result.join('\n'), count: starts.length, lenient: true };
}

const AIPanel = (() => {
  let built = false;
  let config = normalizeAiConfig(null);   // new multi-provider shape
  let activeSel = { auto: true };          // dropdown selection for this session
  let autoLocked = null;      // when Auto probes a working model, it's locked here {providerId,model} for the rest of the session
  let convo = [];             // full OpenAI message array (source of truth)
  let busy = false;
  let aborted = false;        // set by the ⏹ stop button — unwinds runAgent at the next checkpoint
  let capPending = false;     // true when the loop hit maxSteps with the task unfinished → offer 继续
  let activity = '';          // human-readable "what the agent is doing now" for the working indicator
  // Inline approval (instead of a blocking modal): a mutating tool that needs
  // confirmation parks itself in the chat as a tool-step chip with the diff /
  // command + 允许 / 拒绝 buttons. `approvalCtxId` is the tool-call id currently
  // executing; `pendingApprovals` holds the unresolved confirm promises;
  // `stepPreview` keeps each step's diff / command so the chip can show it as a
  // preview both before and after writing.
  let approvalCtxId = null;
  const pendingApprovals = new Map();  // tcId -> resolve(boolean)
  const stepPreview = new Map();       // tcId -> {kind:'diff',path,oldText,newText,verb} | {kind:'cmd',text}
  let approvalPolicy = 'ask'; // base policy from config (ask/allowEdits/allowAll)
  let autoApprove = false;    // per-session "全部自动执行" override (toolbar toggle)
  let streamText = '';        // live text of the turn currently streaming (or null)
  let streaming = false;
  let undoStack = [];         // [{path, prev}] — restore points for AI writes this session
  let sessions = [];          // index metadata of this workspace's conversations (no messages)
  let currentSessionId = null;// id of the conversation in `convo` (null until first send)
  let historyKey = null;      // workspace key `sessions` was loaded for
  let attachments = [];       // pending "@文件" references for the next send: [{path,name,dir}]
  let currentTitle = null;    // AI-generated or user-set title for the current session (overrides deriveTitle)
  let titleBusy = false;      // a title-generation request is in flight
  let histOutsideHandler = null; // document listener that dismisses the history dropdown
  let histQuery = '';         // live filter text for the history dropdown's search box

  // Unified line-style clock icon for the history button (replaces the 🕘 emoji).
  const HISTORY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l2.5 2.5"/></svg>';
  // Small chat-bubble glyph that leads each history row (Cursor-style).
  const HIST_ROW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  function panelEl() { return document.getElementById('ai-panel'); }

  function wsKey() { return Sidebar.workspaceRoot() || 'default'; }

  // Workspace pinning: when the open workspace changes, drop the in-memory
  // conversation and reload that workspace's history. Sync part is immediate;
  // the session list fills in asynchronously (only the 🕘 overlay needs it).
  function syncWorkspace() {
    const k = wsKey();
    if (k === historyKey) return;
    historyKey = k;
    convo = []; currentSessionId = null; currentTitle = null; undoStack = []; updateUndoBtn();
    sessions = [];
    loadHistory();
  }

  async function loadHistory() {
    const k = historyKey || wsKey();
    let idx = null;
    try { idx = await requestHistoryList('chat'); } catch {}
    if (k !== historyKey) return; // workspace switched mid-load
    sessions = (Array.isArray(idx) ? idx : []).filter((s) => s && s.workspace === k && !s.deleted);
  }

  function deriveTitle() {
    const u = convo.find((m) => m.role === 'user');
    const t = ((u && String(u.content)) || '').trim().replace(/\s+/g, ' ');
    if (!t) return '新对话';
    return t.length > 48 ? t.slice(0, 48) + '…' : t;
  }

  // Write the current conversation to its own file and refresh the in-memory
  // index entry. No-op until the user has sent at least one message (nothing
  // worth keeping otherwise). `sessions` holds metadata only; the messages live
  // in the per-id record file fetched lazily by loadSession.
  function snapshotCurrent() {
    if (!convo.some((m) => m.role === 'user')) return;
    if (!currentSessionId) currentSessionId = fmtId();
    const now = Date.now();
    const i = sessions.findIndex((s) => s.id === currentSessionId);
    const meta = {
      id: currentSessionId,
      workspace: historyKey || wsKey(),
      title: currentTitle || deriveTitle(),
      createdAt: i >= 0 ? sessions[i].createdAt : now,
      updatedAt: now,
    };
    if (i >= 0) sessions[i] = meta; else sessions.unshift(meta);
    try { requestHistoryWrite('chat', currentSessionId, { ...meta, messages: convo.slice() }); } catch {}
  }

  function ensure() {
    if (!built) { build(); built = true; }
    syncWorkspace();
    requestAiGetConfig().then((cfg) => {
      config = normalizeAiConfig(cfg);
      approvalPolicy = config.prefs.approvalPolicy;
      autoApprove = approvalPolicy === 'allowAll';
      renderView();
    });
  }

  // Live refresh when the settings window changes the AI config.
  function onConfigChanged(cfg) {
    config = normalizeAiConfig(cfg);
    if (!busy) {
      approvalPolicy = config.prefs.approvalPolicy;
      autoApprove = approvalPolicy === 'allowAll';
      autoLocked = null;          // providers/keys changed — re-probe Auto next send
      // Keep the current selection if its model still exists; else Auto.
      const all = aiAllModels(config);
      if (activeSel && !activeSel.auto &&
          !all.some((x) => x.providerId === activeSel.providerId && x.model === activeSel.model)) {
        activeSel = { auto: true };
      }
      if (built) renderView();
    }
  }

  function build() {
    const p = panelEl();
    if (!p) return;
    // No header banner: settings/history/etc. live in the chat toolbar; the
    // panel is opened/closed from the sidebar AI button.
    p.innerHTML = '<div class="ai-body"></div>';
  }

  function body() { return panelEl()?.querySelector('.ai-body'); }

  function hasModels() { return aiAllModels(config).length > 0; }

  function renderView() {
    closeHistory();
    if (!hasModels()) renderEmpty();
    else renderChat();
  }

  // No key/model configured yet → guide the user to settings.
  function renderEmpty() {
    const b = body();
    if (!b) return;
    b.innerHTML = `
      <div class="ai-empty-setup">
        <div class="ai-empty-glyph"><span class="ai-empty-orb">✦</span></div>
        <div class="ai-empty-title">还没有配置 AI</div>
        <div class="ai-empty-text">在「设置 → AI」里添加一个密钥和模型即可开始使用。密钥仅保存在本机。</div>
        <button class="ai-btn primary" data-act="open-ai-settings" type="button">前往设置 → AI</button>
      </div>`;
    b.querySelector('[data-act=open-ai-settings]').addEventListener('click', () => requestOpenSettings('ai'));
  }

  function renderChat() {
    const b = body();
    if (!b) return;
    b.innerHTML = `
      <div class="ai-toolbar">
        <span class="ai-head-actions">
          <button type="button" class="ai-icon-btn" data-act="history" title="历史对话" aria-label="历史对话">${HISTORY_ICON}</button>
          <button type="button" class="ai-icon-btn" data-act="undo" title="撤销上次写入"${undoStack.length ? '' : ' disabled'}>↩</button>
          <button type="button" class="ai-icon-btn" data-act="newchat" title="新对话（当前对话存入历史）">✚</button>
          <button type="button" class="ai-icon-btn" data-act="settings" title="AI 设置" aria-label="设置">⚙</button>
        </span>
      </div>
      <div class="ai-messages"></div>
      <form class="ai-compose">
        <div class="ai-compose-field">
          <div class="ai-attach" hidden></div>
          <textarea class="ai-input" rows="3" placeholder="交给我做点什么…（回车发送，Shift+回车换行）"></textarea>
          <div class="ai-compose-bar">
            <label class="ai-auto" title="勾选后本次会话内的写入 / 命令全部不再确认（覆盖设置里的执行权限）">
              <input type="checkbox" class="ai-auto-cb"${autoApprove ? ' checked' : ''}> 自动执行
            </label>
            <select class="ai-model-select" title="选择模型">${modelOptionsHTML()}</select>
            <button type="submit" class="ai-send-btn" title="发送（回车）" aria-label="发送">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .65.65 1.1 1.39.91z"/></svg>
            </button>
          </div>
        </div>
      </form>`;
    renderMessages();
    const form = b.querySelector('.ai-compose');
    const input = b.querySelector('.ai-input');
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input); });
    // While busy the button becomes ⏹ (type=button) → click stops the agent.
    b.querySelector('.ai-send-btn').addEventListener('click', (e) => {
      if (busy) { e.preventDefault(); abortAgent(); }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
    });
    b.querySelector('.ai-model-select').addEventListener('change', (e) => {
      const v = e.target.value;
      activeSel = v === '__auto__' ? { auto: true } : (() => {
        const i = v.indexOf(':');
        return { providerId: v.slice(0, i), model: v.slice(i + 1) };
      })();
      autoLocked = null;            // a manual change re-arms Auto's probe next time
      refreshAutoLabel();
    });
    b.querySelector('.ai-auto-cb').addEventListener('change', (e) => { autoApprove = e.target.checked; });
    b.querySelector('[data-act=undo]').addEventListener('click', () => undoLast());
    b.querySelector('[data-act=newchat]').addEventListener('click', () => {
      if (busy) return;
      snapshotCurrent();                       // keep what's there before clearing
      convo = []; currentSessionId = null; currentTitle = null; undoStack = []; updateUndoBtn();
      autoLocked = null;                       // fresh chat re-picks an Auto model
      capPending = false;
      pendingApprovals.clear(); stepPreview.clear();
      closeHistory();
      renderMessages();
    });
    b.querySelector('[data-act=history]').addEventListener('click', () => {
      if (busy) return;
      toggleHistory();
    });
    b.querySelector('[data-act=settings]').addEventListener('click', () => requestOpenSettings('ai'));
    renderAttachments();
    input.focus();
  }

  // ── "@文件": right-click → 添加到 AI. Files/dirs queued here are folded into
  // the next user turn's API content (file bodies inlined, capped) while the
  // visible bubble just shows compact 📎 chips. ──
  function attachFile(path, isDir) {
    if (!path) return;
    const name = baseName(path);
    if (!attachments.some((a) => a.path === path)) {
      attachments.push({ path, name, dir: !!isDir });
    }
    const wasOpen = Panels.aiOpen();
    if (!wasOpen) {
      Panels.toggleAi();          // opens → PanelHooks.ai → ensure() → renderChat → renderAttachments
    } else if (!built) {
      ensure();
    } else {
      renderAttachments();
    }
    body()?.querySelector('.ai-input')?.focus();
  }

  function renderAttachments() {
    const wrap = body()?.querySelector('.ai-attach');
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.hidden = attachments.length === 0;
    attachments.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'ai-attach-chip';
      chip.title = a.path;
      const label = document.createElement('span');
      label.className = 'ai-attach-name';
      label.textContent = (a.dir ? '📁 ' : '📎 ') + a.name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'ai-attach-x';
      x.setAttribute('aria-label', '移除');
      x.textContent = '×';
      x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
      chip.appendChild(label);
      chip.appendChild(x);
      wrap.appendChild(chip);
    });
  }

  // Read each queued file and fold it into the message text sent to the model
  // (capped per file). Directories are referenced by path for the agent to
  // browse with list_dir / search rather than inlined.
  async function buildAttachedContent(text, atts) {
    const parts = [];
    for (const a of atts) {
      if (a.dir) {
        parts.push(`目录：${a.path}（请用 list_dir / search 浏览其中内容）`);
        continue;
      }
      const r = await requestReadFile(a.path);
      if (r && r.ok) {
        parts.push(`文件：${a.path}\n\`\`\`\n${clip(r.text, 16000)}\n\`\`\``);
      } else {
        parts.push(`文件：${a.path}（读取失败，请用 read_file 自行读取）`);
      }
    }
    const header = `用户附加了以下内容作为上下文：\n\n${parts.join('\n\n')}`;
    return text ? `${header}\n\n---\n\n${text}` : header;
  }

  function baseName(p) { return String(p || '').split(/[\\/]/).pop() || String(p || ''); }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '\n… (truncated)' : s; }

  // <option>s for the chat model dropdown: Auto (= default model) + every
  // configured (provider · model), with the current session selection marked.
  // Auto option's label: always just "Auto" — no "优先/已用 xxx" hint.
  function autoOptionLabel() {
    return 'Auto';
  }

  // Patch the live dropdown's Auto label without re-rendering (keeps streaming intact).
  function refreshAutoLabel() {
    const sel = body()?.querySelector('.ai-model-select');
    if (sel && sel.options.length) sel.options[0].textContent = autoOptionLabel();
  }

  function modelOptionsHTML() {
    const all = aiAllModels(config);
    const autoLabel = autoOptionLabel();
    const isAuto = !activeSel || activeSel.auto;
    let html = `<option value="__auto__"${isAuto ? ' selected' : ''}>${escapeHtml(autoLabel)}</option>`;
    for (const m of all) {
      const val = `${m.providerId}:${m.model}`;
      const on = !isAuto && activeSel.providerId === m.providerId && activeSel.model === m.model;
      html += `<option value="${escapeHtml(val)}"${on ? ' selected' : ''}>${escapeHtml(m.provider)} · ${escapeHtml(m.model)}</option>`;
    }
    return html;
  }

  // Short, human-readable label for a tool step chip.
  function toolStepLabel(name, argStr) {
    let a = {};
    try { a = JSON.parse(argStr || '{}'); } catch {}
    switch (name) {
      case 'read_file':   return `读取 ${baseName(a.path)}`;
      case 'list_dir':    return `列目录 ${baseName(a.path) || '/'}`;
      case 'search':      return `搜索 “${a.query || ''}”`;
      case 'edit_file':   return `编辑 ${baseName(a.path)}`;
      case 'write_file':  return `写入 ${baseName(a.path)}`;
      case 'run_command': return `运行 ${String(a.command || '').slice(0, 60)}`;
      case 'web_search':  return `联网搜索 “${a.query || ''}”`;
      case 'todo_write':  return '更新任务清单';
      default:            return name;
    }
  }

  function bubbleRow(role, text) {
    const row = document.createElement('div');
    row.className = `ai-msg ai-msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    return row;
  }

  // SVG glyphs for the send button's two states (paper plane / stop square).
  const SEND_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.993.993 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .65.65 1.1 1.39.91z"/></svg>';
  const STOP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>';

  // Keep the composer button in sync with `busy`: send (submit) ⇄ stop (abort).
  function updateSendBtn() {
    const btn = body()?.querySelector('.ai-send-btn');
    if (!btn) return;
    if (busy) {
      btn.classList.add('is-stop');
      btn.type = 'button';
      btn.title = '停止';
      btn.setAttribute('aria-label', '停止');
      btn.innerHTML = STOP_SVG;
    } else {
      btn.classList.remove('is-stop');
      btn.type = 'submit';
      btn.title = '发送（回车）';
      btn.setAttribute('aria-label', '发送');
      btn.innerHTML = SEND_SVG;
    }
  }

  // A checklist card rendered from a todo_write tool call's arguments.
  function todoRow(tc) {
    let todos = [];
    try { todos = (JSON.parse(tc.function?.arguments || '{}').todos) || []; } catch {}
    const row = document.createElement('div');
    row.className = 'ai-msg ai-msg-tool';
    const card = document.createElement('div');
    card.className = 'ai-todo';
    const head = document.createElement('div');
    head.className = 'ai-todo-head';
    const done = todos.filter((t) => t && t.status === 'completed').length;
    head.textContent = `任务清单 · ${done}/${todos.length}`;
    card.appendChild(head);
    for (const t of todos) {
      const st = (t && t.status) || 'pending';
      const item = document.createElement('div');
      item.className = `ai-todo-item is-${st}`;
      const box = document.createElement('span');
      box.className = 'ai-todo-box';
      box.textContent = st === 'completed' ? '✓' : (st === 'in_progress' ? '▸' : '');
      const txt = document.createElement('span');
      txt.className = 'ai-todo-text';
      txt.textContent = (t && t.content) || '';
      item.appendChild(box); item.appendChild(txt);
      card.appendChild(item);
    }
    row.appendChild(card);
    return row;
  }

  // The 📎 chips shown under a sent user turn that carried "@文件" attachments.
  function sentAttachRow(atts) {
    const row = document.createElement('div');
    row.className = 'ai-msg ai-msg-user ai-msg-attach';
    for (const a of atts) {
      const chip = document.createElement('span');
      chip.className = 'ai-attach-chip is-sent';
      chip.title = a.path;
      chip.textContent = (a.dir ? '📁 ' : '📎 ') + a.name;
      row.appendChild(chip);
    }
    return row;
  }

  // Resolve a parked inline approval and re-render so the chip updates.
  function resolveApproval(tcId, ok) {
    const resolve = pendingApprovals.get(tcId);
    if (!resolve) return;
    pendingApprovals.delete(tcId);
    resolve(ok);
    renderMessages();
  }

  // A collapsible tool-step chip. Shows the diff / command as a preview (before
  // and after writing); while a mutating step awaits confirmation it renders an
  // inline 允许 / 拒绝 bar instead of a blocking modal.
  function stepRow(tc, result) {
    const tcId = tc.id;
    const pending = pendingApprovals.has(tcId);
    const prev = stepPreview.get(tcId);
    const done = result != null;
    const row = document.createElement('div');
    row.className = 'ai-msg ai-msg-tool';
    const det = document.createElement('details');
    det.className = 'ai-step' + (pending ? ' pending' : '');
    const sum = document.createElement('summary');
    sum.className = 'ai-step-sum';
    const mark = pending ? '⚠︎ 待确认' : (done ? '✓' : '⋯');
    sum.textContent = `${mark} ${toolStepLabel(tc.function?.name, tc.function?.arguments)}`;
    det.appendChild(sum);

    // Body — prefer the diff / command preview when we have one.
    if (prev && prev.kind === 'diff') {
      const wrap = document.createElement('div');
      wrap.className = 'ai-step-diff';
      wrap.appendChild(buildDiffNode(prev.oldText, prev.newText));
      det.appendChild(wrap);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'ai-step-body';
      const argStr = tc.function?.arguments || '';
      pre.textContent = (prev && prev.kind === 'cmd')
        ? prev.text
        : (argStr ? `args: ${argStr}\n\n` : '') + (done ? String(result) : '运行中…');
      det.appendChild(pre);
    }

    if (pending) {
      det.open = true;
      const isCmd = prev && prev.kind === 'cmd';
      const bar = document.createElement('div');
      bar.className = 'ai-approve-bar';
      const tip = document.createElement('span');
      tip.className = 'ai-approve-tip';
      tip.textContent = isCmd ? '允许运行此命令？' : '允许写入此改动？';
      const no = document.createElement('button');
      no.type = 'button'; no.className = 'ai-btn ai-approve-no'; no.textContent = '拒绝';
      const ok = document.createElement('button');
      ok.type = 'button'; ok.className = 'ai-btn primary'; ok.textContent = isCmd ? '执行' : '允许写入';
      no.addEventListener('click', (e) => { e.preventDefault(); resolveApproval(tcId, false); });
      ok.addEventListener('click', (e) => { e.preventDefault(); resolveApproval(tcId, true); });
      bar.appendChild(tip); bar.appendChild(no); bar.appendChild(ok);
      det.appendChild(bar);
    } else if (done && prev) {
      // After applying / declining, keep the preview and add a one-line result.
      const note = document.createElement('div');
      note.className = 'ai-step-note';
      note.textContent = String(result);
      det.appendChild(note);
    }

    row.appendChild(det);
    return row;
  }

  function renderMessages() {
    const list = body()?.querySelector('.ai-messages');
    if (!list) return;
    list.innerHTML = '';
    const hasUser = convo.some((m) => m.role === 'user');
    if (!hasUser && !streaming) {
      list.innerHTML = `
        <div class="ai-empty">
          <div class="ai-empty-orb">✦</div>
          <div class="ai-empty-h">让我帮你处理整个工作区</div>
          <div class="ai-empty-sub">读 · 搜 · 改 · 写 · 跑命令 · 查资料，都行。</div>
          <div class="ai-empty-chips">
            <button type="button" class="ai-chip" data-fill="把 README 翻译成英文并写回">把 README 翻译成英文并写回</button>
            <button type="button" class="ai-chip" data-fill="在 src 里找用到 foo 的地方并修掉">在 src 里找用到 foo 的地方并修掉</button>
          </div>
        </div>`;
      list.querySelectorAll('.ai-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const input = body()?.querySelector('.ai-input');
          if (!input) return;
          input.value = chip.dataset.fill || '';
          input.focus();
        });
      });
    }
    const results = {};
    for (const m of convo) if (m.role === 'tool') results[m.tool_call_id] = m.content;
    for (const m of convo) {
      if (m.role === 'user') {
        if (m.content) list.appendChild(bubbleRow('user', m.content));
        if (m._attach && m._attach.length) list.appendChild(sentAttachRow(m._attach));
      } else if (m.role === 'assistant') {
        if (m.content) list.appendChild(bubbleRow('assistant', m.content));
        if (m.tool_calls) for (const tc of m.tool_calls) {
          list.appendChild(tc.function?.name === 'todo_write' ? todoRow(tc) : stepRow(tc, results[tc.id]));
        }
      }
    }
    if (streaming) {
      const row = document.createElement('div');
      row.className = 'ai-msg ai-msg-assistant';
      const bubble = document.createElement('div');
      bubble.className = 'ai-bubble';
      bubble.id = 'ai-live-bubble';
      if (streamText) bubble.textContent = streamText;
      else bubble.innerHTML = '<span class="ai-typing"><span></span><span></span><span></span></span>';
      row.appendChild(bubble);
      list.appendChild(row);
    } else if (busy) {
      // Between turns / while a tool runs there's no live bubble — show what the
      // agent is doing plus the dot animation so the panel never looks frozen.
      const row = document.createElement('div');
      row.className = 'ai-working';
      row.innerHTML = '<span class="ai-typing"><span></span><span></span><span></span></span>'
        + `<span class="ai-working-label"></span>`;
      row.querySelector('.ai-working-label').textContent = activity || '工作中…';
      list.appendChild(row);
    }
    if (capPending && !busy) {
      const row = document.createElement('div');
      row.className = 'ai-cap';
      const txt = document.createElement('span');
      txt.className = 'ai-cap-text';
      txt.textContent = `已达到 ${(config.prefs && config.prefs.maxSteps) || 50} 步上限，任务可能还没完成。`;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'ai-btn primary'; btn.textContent = '继续';
      btn.addEventListener('click', () => continueAgent());
      row.appendChild(txt); row.appendChild(btn);
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
    updateSendBtn();
  }

  async function send(input) {
    const text = (input.value || '').trim();
    const atts = attachments.slice();
    if ((!text && !atts.length) || busy) return;
    if (!hasModels()) { renderEmpty(); return; }
    input.value = '';
    attachments = [];
    renderAttachments();
    const msg = { role: 'user', content: text };
    if (atts.length) {
      msg._attach = atts.map((a) => ({ path: a.path, name: a.name, dir: a.dir }));
      msg._apiContent = await buildAttachedContent(text, atts);
    }
    convo.push(msg);
    await runAgent();
  }

  // The agent loop: stream a turn, append it, run any requested tools, repeat
  // until the model stops calling tools (or we hit the step cap).
  // Whether the session is in Auto mode (no explicit model picked).
  function isAutoMode() { return !activeSel || !!activeSel.auto; }

  // One streamed chat turn. In Auto mode with nothing locked yet, probe the
  // candidate models in order and lock onto the first that connects; afterwards
  // (and for an explicit pick) just use the resolved creds. Returns the chat
  // result, or {error} if nothing worked.
  async function chatTurn(onDelta) {
    if (!isAutoMode() || autoLocked) {
      const creds = aiResolveCreds(config, autoLocked || activeSel);
      if (!creds) return { error: '当前选择的模型缺少地址或密钥，请在 设置 → AI 检查。' };
      return requestAiChat(buildApiMessages(), aiToolSpecs(), onDelta, creds);
    }
    const cands = aiAutoCandidates(config);
    if (!cands.length) return { error: '未配置可用的模型（需要 地址 + 密钥 + 至少一个模型）。' };
    let lastErr = '请求失败';
    for (let i = 0; i < cands.length; i++) {
      const creds = aiResolveCreds(config, cands[i]);
      if (!creds) continue;
      // Discard any partial text a previous failed attempt streamed.
      streamText = '';
      const live = document.getElementById('ai-live-bubble'); if (live) live.textContent = '';
      const res = await requestAiChat(buildApiMessages(), aiToolSpecs(), onDelta, creds);
      if (res && !res.error) {
        autoLocked = { providerId: cands[i].providerId, model: cands[i].model };
        try { refreshAutoLabel(); } catch {}
        return res;
      }
      lastErr = (res && res.error) || lastErr;
    }
    return { error: `自动选择失败：配置的 ${cands.length} 个模型都没能调通（最后错误：${lastErr}）。` };
  }

  async function runAgent() {
    busy = true; aborted = false; capPending = false;
    const maxSteps = (config.prefs && config.prefs.maxSteps) || 50;
    let step = 0;
    try {
      for (; step < maxSteps; step++) {
        streaming = true; streamText = ''; activity = '思考中…';
        renderMessages();
        const res = await chatTurn((t) => {
          streamText += t;
          const el = document.getElementById('ai-live-bubble');
          if (el) el.textContent = streamText;
          const list = body()?.querySelector('.ai-messages');
          if (list) list.scrollTop = list.scrollHeight;
        });
        streaming = false;
        if (aborted || (res && res.aborted)) { step = -1; break; }   // step<0 → stopped, no cap prompt
        if (!res || res.error) {
          convo.push({ role: 'assistant', content: `⚠️ ${(res && res.error) || '请求失败'}` });
          step = -1; break;
        }
        const tcs = Array.isArray(res.toolCalls) ? res.toolCalls : null;
        const asst = { role: 'assistant', content: res.full || '' };
        if (tcs && tcs.length) {
          asst.tool_calls = tcs.map((tc) => ({
            id: tc.id, type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        convo.push(asst);
        renderMessages();
        if (!tcs || !tcs.length) { step = -1; break; }   // model answered with no tools → done
        for (const tc of tcs) {
          if (aborted) break;
          let args = {};
          try { args = JSON.parse(tc.arguments || '{}'); } catch {}
          activity = toolStepLabel(tc.name, tc.arguments);
          approvalCtxId = tc.id;                 // so a mutating tool parks its inline approval on this chip
          const result = await executeAiTool(tc.name, args);
          approvalCtxId = null;
          convo.push({ role: 'tool', tool_call_id: tc.id, content: clip(result, 16000) });
          renderMessages();
        }
        if (aborted) { step = -1; break; }
      }
      // step >= maxSteps here means we exhausted the budget while tools were still
      // being requested — surface a 继续 affordance instead of silently truncating.
      if (step >= maxSteps) capPending = true;
      else if (aborted) convo.push({ role: 'assistant', content: '⏹ 已停止。' });
    } finally {
      busy = false; streaming = false; activity = '';
      // Resolve any approval still parked on a chip (user hit stop mid-confirm).
      for (const [, resolve] of pendingApprovals) resolve(false);
      pendingApprovals.clear();
      renderMessages();
      try { snapshotCurrent(); } catch {}
      try { maybeGenerateTitle(); } catch {}
    }
  }

  // ⏹ Stop: flag the loop and immediately resolve the in-flight chat turn / tool
  // round-trip so runAgent unwinds at its next checkpoint without waiting for the
  // native request to finish. (The native stream is abandoned, not hard-cancelled.)
  function abortAgent() {
    if (!busy) return;
    aborted = true;
    activity = '正在停止…';
    for (const [reqId, resolve] of [...pendingAi]) {
      if (reqId.startsWith('ai-chat-')) {
        pendingAi.delete(reqId); aiDeltaHandlers.delete(reqId); resolve({ aborted: true });
      } else if (reqId.startsWith('ai-tool-')) {
        pendingAi.delete(reqId); resolve({ ok: false, result: 'Aborted by user.' });
      }
    }
    for (const [, resolve] of pendingApprovals) resolve(false);
    pendingApprovals.clear();
    updateSendBtn();
  }

  // Resume after a soft cap: the convo already ends with tool results, so a fresh
  // runAgent picks up exactly where the budget ran out.
  function continueAgent() {
    if (busy) return;
    capPending = false;
    renderMessages();
    runAgent();
  }

  function buildApiMessages() {
    const msgs = [{ role: 'system', content: AI_SYSTEM_PROMPT }];
    const extra = (config.prefs && config.prefs.systemPrompt || '').trim();
    if (extra) msgs.push({ role: 'system', content: extra });
    const root = Sidebar.workspaceRoot();
    const f = aiActiveFile();
    let note = '';
    if (root) note += `Workspace root: ${root}\n`;
    if (f.path) note += `Currently open file: ${f.path}${f.editable ? '' : ' (binary/non-text)'}\n`;
    if (note) msgs.push({ role: 'system', content: note.trim() });
    for (const m of convo) {
      // Strip private "@文件" fields; user turns send the attachment-expanded body.
      const { _attach, _apiContent, ...clean } = m;
      if (m.role === 'user' && _apiContent) clean.content = _apiContent;
      msgs.push(clean);
    }
    return msgs;
  }

  // Park a confirmation request inline on the current tool-step chip and resolve
  // when the user clicks 允许 / 拒绝 there. Falls back to a modal only if there's
  // no chip context (shouldn't happen inside the agent loop).
  function inlineConfirm(modalOpts) {
    const tcId = approvalCtxId;
    if (!tcId) return showModal(modalOpts);
    return new Promise((resolve) => {
      pendingApprovals.set(tcId, resolve);
      renderMessages();
    });
  }

  // run_command et al. — only auto-approved when "allow all" (config or session).
  async function confirmMutation(title, message, danger) {
    if (approvalCtxId) stepPreview.set(approvalCtxId, { kind: 'cmd', text: message });
    if (autoApprove || approvalPolicy === 'allowAll') return true;
    return inlineConfirm({ title, message, confirmLabel: '执行', danger: !!danger });
  }

  // Confirm a file write by showing the actual diff inline. Auto-applied when the
  // policy allows edits (or all), or the session "全部自动执行" toggle is on. The
  // diff is recorded either way so the chip can show it as a preview afterward.
  async function confirmWrite(path, oldText, newText, verb) {
    if (approvalCtxId) stepPreview.set(approvalCtxId, { kind: 'diff', path, oldText, newText, verb });
    if (autoApprove || approvalPolicy === 'allowEdits' || approvalPolicy === 'allowAll') return true;
    return inlineConfirm({
      title: `${verb} ${baseName(path)}`,
      message: path,
      bodyNode: buildDiffNode(oldText, newText),
      confirmLabel: '应用',
      danger: true,
      wide: true,
    });
  }

  // Write + record an undo restore point + refresh the view.
  async function commitWrite(path, newText, oldText, okMsg) {
    const w = await requestWriteFile(path, newText);
    if (!(w && w.ok)) return `Error: write failed: ${(w && w.error) || ''}`;
    undoStack.push({ path, prev: oldText });
    updateUndoBtn();
    refreshViewForPath(path, newText);
    return okMsg;
  }

  async function undoLast() {
    if (busy) return;
    const last = undoStack.pop();
    updateUndoBtn();
    if (!last) { showToast('无可撤销的写入', 'info'); return; }
    const w = await requestWriteFile(last.path, last.prev);
    if (w && w.ok) {
      refreshViewForPath(last.path, last.prev);
      showToast(`已撤销对 ${baseName(last.path)} 的写入`, 'info');
    } else {
      showToast(`撤销失败：${(w && w.error) || ''}`, 'error');
    }
  }

  function updateUndoBtn() {
    const btn = panelEl()?.querySelector('[data-act=undo]');
    if (btn) btn.disabled = undoStack.length === 0;
  }

  // ---- History overlay (past conversations for this workspace) -------------

  function relTime(ts) {
    const m = Math.floor((Date.now() - (ts || 0)) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const days = Math.floor(h / 24);
    if (days < 30) return `${days} 天前`;
    const mo = Math.floor(days / 30);
    return mo < 12 ? `${mo} 个月前` : `${Math.floor(mo / 12)} 年前`;
  }

  function historyEl() { return panelEl()?.querySelector('.ai-history'); }
  function closeHistory() {
    const o = historyEl(); if (o) o.remove();
    if (histOutsideHandler) {
      document.removeEventListener('mousedown', histOutsideHandler, true);
      histOutsideHandler = null;
    }
  }
  function toggleHistory() { if (historyEl()) closeHistory(); else openHistory(); }

  async function openHistory() {
    await loadHistory();              // fetch fresh for the current workspace
    const p = panelEl();
    if (!p) return;
    closeHistory();
    histQuery = '';
    const o = document.createElement('div');
    o.className = 'ai-history';
    p.appendChild(o);
    renderHistory();
    const q = o.querySelector('.ai-history-q');
    if (q) q.focus();
    // Dropdown behaviour: dismiss on any click outside the list (the history
    // button's own handler toggles it shut, so ignore clicks on it).
    histOutsideHandler = (e) => {
      const el = historyEl();
      if (!el || el.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-act=history]')) return;
      closeHistory();
    };
    document.addEventListener('mousedown', histOutsideHandler, true);
  }

  // Coarse recency bucket for a timestamp — drives the dropdown's section labels.
  function histBucket(ts) {
    const days = Math.floor((Date.now() - (ts || 0)) / 86400000);
    if (days < 1) return '今天';
    if (days < 2) return '昨天';
    if (days < 7) return '本周';
    if (days < 30) return '本月';
    return '更早';
  }

  function renderHistory() {
    const o = historyEl();
    if (!o) return;
    const q = histQuery.trim().toLowerCase();
    const list = sessions
      .filter((s) => !q || (s.title || '新对话').toLowerCase().includes(q))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    let body = '';
    if (!sessions.length) {
      body = '<div class="ai-history-empty">还没有历史对话</div>';
    } else if (!list.length) {
      body = '<div class="ai-history-empty">没有匹配的对话</div>';
    } else {
      let lastBucket = null;
      for (const s of list) {
        const b = histBucket(s.updatedAt);
        if (b !== lastBucket) { body += `<div class="ai-history-sec">${b}</div>`; lastBucket = b; }
        const cur = s.id === currentSessionId ? ' current' : '';
        body += `<div class="ai-history-row${cur}" data-id="${escapeHtml(s.id)}">`
          + `<span class="ai-history-ico">${HIST_ROW_ICON}</span>`
          + `<div class="ai-history-title" title="双击重命名">${escapeHtml(s.title || '新对话')}</div>`
          + `<span class="ai-history-time">${escapeHtml(relTime(s.updatedAt))}</span>`
          + `<span class="ai-history-actions">`
          + `<button type="button" class="ai-history-rename" title="重命名" data-id="${escapeHtml(s.id)}">✎</button>`
          + `<button type="button" class="ai-history-del" title="删除" data-id="${escapeHtml(s.id)}">🗑</button>`
          + `</span></div>`;
      }
    }
    o.innerHTML = `
      <div class="ai-history-search">
        <input type="text" class="ai-history-q" placeholder="搜索历史对话…" value="${escapeHtml(histQuery)}" />
      </div>
      <div class="ai-history-list">${body}</div>`;
    const qInput = o.querySelector('.ai-history-q');
    qInput.addEventListener('input', (e) => {
      histQuery = e.target.value;
      renderHistory();                       // cheap re-render; restore focus + caret
      const ni = historyEl()?.querySelector('.ai-history-q');
      if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
    });
    qInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeHistory(); }
    });
    o.querySelectorAll('.ai-history-del').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(btn.dataset.id); });
    });
    o.querySelectorAll('.ai-history-rename').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.ai-history-row');
        beginHistRename(row && row.querySelector('.ai-history-title'), btn.dataset.id);
      });
    });
    o.querySelectorAll('.ai-history-row').forEach((row) => {
      row.addEventListener('click', () => loadSession(row.dataset.id));
      const tEl = row.querySelector('.ai-history-title');
      if (tEl) tEl.addEventListener('dblclick', (e) => { e.stopPropagation(); beginHistRename(tEl, row.dataset.id); });
    });
  }

  // Inline-rename a history row's title. Enter / blur saves, Esc cancels.
  function beginHistRename(titleEl, id) {
    if (!titleEl || titleEl.querySelector('input')) return;
    const old = titleEl.textContent;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'ai-history-edit';
    inp.value = old;
    titleEl.textContent = '';
    titleEl.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) renameSession(id, inp.value);
      else renderHistory();
    };
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('dblclick', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  // Persist a manual title change. For the open session we just set currentTitle
  // (snapshotCurrent writes it); otherwise we rewrite that conversation's record.
  async function renameSession(id, raw) {
    const t = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    const i = sessions.findIndex((x) => x.id === id);
    if (i < 0) { renderHistory(); return; }
    if (!t || t === sessions[i].title) { renderHistory(); return; }
    sessions[i] = { ...sessions[i], title: t };
    if (id === currentSessionId) {
      currentTitle = t;
      try { snapshotCurrent(); } catch {}
    } else {
      let rec = null;
      try { rec = await requestHistoryRead('chat', id); } catch {}
      const messages = rec && Array.isArray(rec.messages) ? rec.messages : [];
      try { requestHistoryWrite('chat', id, { ...sessions[i], messages }); } catch {}
    }
    renderHistory();
  }

  // After the first full Q&A round, ask the model for a short title (once).
  // currentTitle (set here or by a manual rename / loaded session) suppresses
  // re-generation. Fire-and-forget: it re-snapshots + refreshes when it lands.
  async function maybeGenerateTitle() {
    if (titleBusy || currentTitle || !currentSessionId) return;
    const hasUser = convo.some((m) => m.role === 'user');
    const hasAsst = convo.some((m) => m.role === 'assistant' && m.content && !String(m.content).startsWith('⚠️'));
    if (!hasUser || !hasAsst) return;
    const creds = aiResolveCreds(config, autoLocked || activeSel);  // reuse the session's locked Auto model
    if (!creds) return;
    titleBusy = true;
    const parts = [];
    for (const m of convo) {
      if (m.role === 'user') parts.push('用户：' + String(m.content || '').slice(0, 600));
      else if (m.role === 'assistant' && m.content) parts.push('助手：' + String(m.content).slice(0, 600));
      if (parts.length >= 4) break;
    }
    const messages = [
      { role: 'system', content: '你是会话标题生成器。根据对话内容，用一句不超过 16 个汉字（或 6 个英文单词）的简短短语概括主题作为标题。只输出标题本身：不要引号、不要句末标点、不要解释。' },
      { role: 'user', content: parts.join('\n') },
    ];
    let res = null;
    try { res = await requestAiChat(messages, [], null, creds); } catch {}
    titleBusy = false;
    if (!res || res.error) return;
    if (currentTitle || !currentSessionId) return;   // a manual rename / new chat won the race
    let t = String(res.full || '').split('\n')[0].trim();
    t = t.replace(/^["'\u201c\u201d\u300e\u300c\u300f\u300d[(\uff08]+/, '').replace(/["'\u201c\u201d\u300f\u300d\u300e\u300c\])\uff09\u3002.!?\uff01\uff1f]+$/, '').trim().slice(0, 40);
    if (!t) return;
    currentTitle = t;
    const idx = sessions.findIndex((s) => s.id === currentSessionId);
    if (idx >= 0) sessions[idx] = { ...sessions[idx], title: t };
    try { snapshotCurrent(); } catch {}
    renderHistory();
  }

  async function loadSession(id) {
    if (busy) return;
    if (!sessions.some((x) => x.id === id)) return;
    snapshotCurrent();                 // save the open conversation first
    let rec = null;
    try { rec = await requestHistoryRead('chat', id); } catch {}
    if (!rec) return;
    convo = Array.isArray(rec.messages) ? rec.messages.slice() : [];
    currentSessionId = id;
    currentTitle = (rec.title || (sessions.find((x) => x.id === id) || {}).title) || null;
    undoStack = []; updateUndoBtn();
    autoLocked = null;                 // loaded conversation re-arms Auto's probe
    capPending = false;
    pendingApprovals.clear(); stepPreview.clear();
    closeHistory();
    renderMessages();
  }

  async function deleteSession(id) {
    const s = sessions.find((x) => x.id === id);
    const ok = await showModal({
      title: '删除历史对话',
      message: `确定删除「${(s && s.title) || '新对话'}」？删除后将从列表移除。`,
      confirmLabel: '删除', danger: true,
    });
    if (!ok) return;
    sessions = sessions.filter((x) => x.id !== id);
    if (id === currentSessionId) currentSessionId = null;
    // Soft delete: keep the conversation file, flag it `deleted:true` and let
    // native lift that into index.json (META_KEYS) so loadHistory filters it out.
    try {
      let rec = null;
      try { rec = await requestHistoryRead('chat', id); } catch {}
      const base = rec || { id, workspace: (s && s.workspace) || wsKey(), title: (s && s.title) || '' };
      requestHistoryWrite('chat', id, { ...base, id, deleted: true });
    } catch {}
    renderHistory();
  }

  // Tool dispatch. Returns a plain string fed back to the model as the tool
  // result. Read-only tools run silently; mutating tools go through a confirm.
  async function executeAiTool(name, args) {
    try {
      switch (name) {
        case 'read_file': {
          if (!args.path) return 'Error: missing path';
          const r = await requestReadFile(args.path);
          return r && r.ok ? clip(r.text, 60000) : `Error: ${(r && r.error) || 'read failed'}`;
        }
        case 'list_dir': {
          const r = await requestAiTool('list_dir', { path: args.path || Sidebar.workspaceRoot() || '' });
          return r.result;
        }
        case 'search': {
          const r = await requestAiTool('search', {
            query: args.query || '', path: args.path || Sidebar.workspaceRoot() || '',
          });
          return r.result;
        }
        case 'todo_write':  return applyTodoTool(args);
        case 'edit_file':   return applyEditTool(args);
        case 'write_file':  return applyWriteTool(args);
        case 'run_command': return runCommandTool(args);
        case 'web_search': {
          const r = await requestAiTool('web_search', { query: args.query || '' });
          return r.result;
        }
        default: return `Error: unknown tool ${name}`;
      }
    } catch (e) {
      return `Error: ${(e && e.message) || e}`;
    }
  }

  // Pure tracking tool: the checklist is rendered from the tool-call args in
  // renderMessages, so here we just validate and acknowledge.
  function applyTodoTool({ todos }) {
    if (!Array.isArray(todos)) return 'Error: todos must be an array';
    const n = todos.length;
    const done = todos.filter((t) => t && t.status === 'completed').length;
    return `Todo list updated (${done}/${n} done).`;
  }

  async function applyEditTool({ path, old, new: rep, replace_all }) {
    if (!path || old == null) return 'Error: missing path or old';
    const r = await requestReadFile(path);
    if (!r || !r.ok) return `Error: cannot read ${path}: ${(r && r.error) || ''}`;
    const m = applyEditMatch(r.text, old, rep, !!replace_all);
    if (!m.ok) return `Error: ${m.error}`;
    if (m.text === String(r.text).replace(/\r\n/g, '\n')) {
      return 'No change (old and new are identical).';
    }
    if (!(await confirmWrite(path, r.text, m.text, '编辑'))) return 'User declined the edit.';
    const note = `${m.count} replacement${m.count > 1 ? 's' : ''}${m.lenient ? ', whitespace-tolerant' : ''}`;
    return commitWrite(path, m.text, r.text, `Edited ${path} (${note}).`);
  }

  async function applyWriteTool({ path, content }) {
    if (!path) return 'Error: missing path';
    const r = await requestReadFile(path);
    const oldText = r && r.ok ? r.text : '';
    const newText = content || '';
    const verb = r && r.ok ? '覆盖' : '新建';
    if (!(await confirmWrite(path, oldText, newText, verb))) return 'User declined the write.';
    return commitWrite(path, newText, oldText, `Wrote ${path}.`);
  }

  async function runCommandTool({ command, cwd }) {
    if (!command) return 'Error: missing command';
    if (!(await confirmMutation('运行命令', `AI 想运行命令：\n\n${command}`, true))) {
      return 'User declined the command.';
    }
    const r = await requestAiTool('run_command', { command, cwd: cwd || Sidebar.workspaceRoot() || '' });
    return r.result;
  }

  // Reflect a tool's write in the view if it touched the file currently shown.
  function refreshViewForPath(path, content) {
    const f = aiActiveFile();
    if (f.path === path) refreshAfterWrite(f, content);
  }

  return { ensure, onConfigChanged, attachFile };
})();

// The file the AI should read as context and write edits to: the previewed
// non-md file if one is showing, else the open markdown document. Only text-ish
// files are "editable" (md / code-text / html) — images, video, binaries aren't.
function aiActiveFile() {
  const preview = Sidebar.activePreview();
  if (preview) {
    const k = previewKind(preview);
    return { path: preview, kind: k, editable: k === 'text' || k === 'html' };
  }
  const mdPath = Sidebar.currentFilePath();
  if (mdPath) return { path: mdPath, kind: 'md', editable: true };
  return { path: null, kind: null, editable: false };
}

// Immediately reflect an applied edit in the view (don't wait on the FS
// watcher). The native watcher also fires and is deduped.
function refreshAfterWrite(f, content) {
  if (f.kind === 'md') {
    render(content, lastBaseDir);
  } else if (f.kind === 'text') {
    renderTextPreview({ path: f.path, name: f.path.split(/[\\/]/).pop() }, content);
  } else if (f.kind === 'html') {
    const frame = document.querySelector('#root .preview-frame');
    if (frame) frame.src = frame.src; // reload the iframe from disk
  }
}

PanelHooks.ai = () => AIPanel.ensure();

// ===================================================================
// Terminal — real interactive PTY (hterm front, native PTY back). The hterm
// bundle (window.MDTerm = { lib, hterm }) is loaded on demand the first time the
// panel opens. hterm replaced xterm.js because its in-webview IME/composition
// handling is solid under WKWebView, where xterm's keydown path doubled chars /
// dropped IME. Bytes flow as utf8 strings over IPC; the native side spawns/owns
// the pty keyed by id, unchanged by this swap.
// ===================================================================

let termBundleLoaded = false;
async function ensureTermBundle() {
  if (termBundleLoaded) return;
  // hterm bundles its own styles into its iframe — no external CSS needed.
  const script = document.createElement('script');
  script.src = 'vendor/hterm_all.js';
  await new Promise((res, rej) => {
    script.onload = res;
    script.onerror = rej;
    document.head.appendChild(script);
  });
  termBundleLoaded = true;
}

// id → hterm Terminal, so native onTermData/onTermExit can find their target.
const termSessions = new Map();

function termEmit(handler, event, payload) {
  try {
    if (window.webkit?.messageHandlers?.[handler]) {
      window.webkit.messageHandlers[handler].postMessage(payload);
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit(event, payload);
  } catch {}
}
const requestTermCreate = (id, cols, rows, cwd) => termEmit('termCreate', 'mdreader:term-create', { id, cols, rows, cwd });
const requestTermInput  = (id, data)            => termEmit('termInput',  'mdreader:term-input',  { id, data });
const requestTermResize = (id, cols, rows)      => termEmit('termResize', 'mdreader:term-resize', { id, cols, rows });
const requestTermKill   = (id)                  => termEmit('termKill',   'mdreader:term-kill',   { id });

function onTermData(id, data) {
  // TerminalPanel owns the hterm io (and buffers output that arrives before the
  // terminal is ready), then runs raw-capture + app-mode tracking in afterOutput.
  try { TerminalPanel.write(id, data); } catch {}
  try { TerminalPanel.afterOutput(id, data); } catch {}
}
function onTermExit(id, code) {
  try { TerminalPanel.write(id, `\r\n\x1b[90m[process exited${code != null ? ` (${code})` : ''}]\x1b[0m\r\n`); } catch {}
  try { TerminalPanel.markExit(id); } catch {}
}

// Derive the terminal palette from the active theme's CSS variables so the
// terminal tracks any named theme, not just light/dark.
function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (cs.getPropertyValue(name).trim() || fallback);
  const bg = v('--code-bg', '#161b22');
  const fg = v('--fg', '#e6edf3');
  const accent = v('--accent', fg);
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    selection: v('--sidebar-current', 'rgba(128,128,128,0.3)'),
  };
}

// Curated ANSI-16 palettes (GitHub's) so terminal colors stay readable and
// consistent: a dark-bg set and a light-bg set, picked by the theme's bg
// luminance. hterm's own defaults are tuned for dark backgrounds and wash out on
// the light themes, so we always override.
const ANSI_DARK = [
  '#484f58', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#b1bac4',
  '#6e7681', '#ffa198', '#56d364', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6fc',
];
const ANSI_LIGHT = [
  '#24292f', '#cf222e', '#116329', '#7d4e00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
  '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f',
];

// Rough perceived-luminance test on a #rgb / #rrggbb / rgb() color string.
function isLightColor(c) {
  let r = 0, g = 0, b = 0;
  const m = String(c).trim();
  let h = m.replace('#', '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map((x) => x + x).join('');
  if (/^[0-9a-f]{6}$/i.test(h)) {
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const rm = m.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rm) { r = +rm[1]; g = +rm[2]; b = +rm[3]; } else return false;
  }
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150;
}

// Push the theme colors + ANSI palette into one hterm terminal's prefs (hterm's
// equivalent of xterm's options.theme). Safe before or after the terminal is
// ready. Called on create and on every theme switch (applyTheme).
function applyHtermPrefs(term) {
  if (!term || !term.getPrefs) return;
  const t = termTheme();
  try {
    const p = term.getPrefs();
    p.set('background-color', t.background);
    p.set('foreground-color', t.foreground);
    p.set('cursor-color', t.cursor);
    p.set('color-palette-overrides', isLightColor(t.background) ? ANSI_LIGHT : ANSI_DARK);
  } catch {}
}

// Multi-session terminal: a left rail lists sessions (new / rename / delete),
// the right pane shows the active one. The native side already keys PTYs by id,
// so each session is just another id; switching only toggles which host shows.
const TerminalPanel = (() => {
  // id -> { id, name, term (hterm.Terminal), io, host, tab, exited, raw, … }
  const sessions = new Map();
  let activeId = null;
  let seq = 0;
  let built = false;
  let listEl = null;   // .term-tabs container (left rail)
  let mainEl = null;   // .term-main host container (right pane)
  let termCommands = [];      // [{cmd, count, lastUsed}] learned for this workspace
  let termHistoryKey = null;  // workspace key `termCommands` was loaded for
  let termAll = {};           // full { "<workspace>": commands[] } map (one native record)
  // Per-project terminal-output persistence. The live shell can't survive a
  // restart, so we snapshot each terminal's grid+scrollback as clean logical-line
  // text (see serializeSession) and replay it dimmed on reopen, with a fresh shell
  // underneath. One file per terminal: term/<pid>.json, mirroring chat's
  // one-file-per-conversation.
  let snapTimer = null;        // debounce handle for snapshotSessions()
  let initializing = false;    // guards the first restore/create against concurrent ensure() calls
  const DIVIDER_MARK = '上次会话结束';   // identifies a replay divider line in snapshots
  const SESSION_DIVIDER = `\r\n\x1b[90m──────────── ${DIVIDER_MARK} · 新终端 ────────────\x1b[0m\r\n\r\n`;

  function build() {
    const panel = document.getElementById('terminal-panel');
    if (!panel) return false;
    panel.innerHTML = `
      <div class="term-side">
        <div class="term-side-head">
          <span class="term-side-title">终端</span>
          <button class="term-new" title="新建终端" aria-label="新建终端">+</button>
        </div>
        <div class="term-tabs"></div>
      </div>
      <div class="term-side-resize" title="拖动调整宽度"></div>
      <div class="term-main"></div>`;
    listEl = panel.querySelector('.term-tabs');
    mainEl = panel.querySelector('.term-main');
    const sideEl = panel.querySelector('.term-side');
    const savedW = parseInt(localStorage.getItem('mdgem.term.sideWidth') || '', 10);
    if (sideEl && Number.isFinite(savedW)) {
      sideEl.style.flexBasis = `${Math.max(110, Math.min(360, savedW))}px`;
    }
    panel.querySelector('.term-new').addEventListener('click', () => create());
    initSideResize(panel);
    // Best-effort final save on page teardown (the throttled per-output save is
    // the real safety net; this just captures the last ~second of output).
    window.addEventListener('beforeunload', () => { try { snapshotSessions(); } catch {} });
    built = true;
    return true;
  }

  async function ensure() {
    try {
      await ensureTermBundle();
    } catch {
      const p = document.getElementById('terminal-panel');
      if (p) p.innerHTML = '<div class="term-error">无法加载终端组件</div>';
      return;
    }
    if (!window.MDTerm) return;
    if (!built && !build()) return;
    if (sessions.size === 0) {
      if (initializing) return;          // a restore/create is already in flight — don't double-create
      initializing = true;
      try { await restoreOrCreate(); } finally { initializing = false; }
    } else fitAndResize();
  }

  // First open for this workspace: replay the project's saved terminals (output
  // greyed in, fresh shell underneath) if any, else open one blank terminal.
  async function restoreOrCreate() {
    let saved = [];
    try { saved = await loadSavedSessions(); } catch {}
    if (sessions.size > 0) return;            // a manual create() raced us — leave it
    if (Array.isArray(saved) && saved.length) {
      for (const s of saved) create({ pid: s.pid, name: s.name, restore: s.data, createdAt: s.createdAt });
    } else {
      create();
    }
  }

  // List this workspace's saved terminals from the term/ index (one file per
  // terminal, like chat). Skips the fixed-id `commands` record, soft-deleted
  // tombstones, and any stale single `sessions` record from the old layout.
  async function loadSavedSessions() {
    const k = wsKey();
    let idx = [];
    try { idx = await requestHistoryList('term'); } catch {}
    const metas = (Array.isArray(idx) ? idx : [])
      .filter((m) => m && m.workspace === k && !m.deleted && m.id !== 'commands' && m.id !== 'sessions')
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const out = [];
    for (const m of metas) {
      let rec = null;
      try { rec = await requestHistoryRead('term', m.id); } catch {}
      if (rec && !rec.deleted) {
        out.push({ pid: m.id, name: rec.name || m.name || '终端', data: rec.data || '', createdAt: rec.createdAt || m.createdAt || 0 });
      }
    }
    return out;
  }

  function create(opts = {}) {
    if (!built || !window.MDTerm) return;
    const { lib, hterm } = window.MDTerm;
    seq += 1;
    const id = `t-${Date.now().toString(36)}-${seq.toString(36)}-${Math.floor(performance.now()).toString(36)}`;
    // Persistent, filename-safe id for this terminal's own history file
    // (term/<pid>.json). Reused across reopens so snapshots overwrite in place.
    const pid = (opts.pid || `t${Date.now().toString(36)}${seq.toString(36)}${Math.floor(performance.now()).toString(36)}`).replace(/[^A-Za-z0-9_]/g, '');
    // Name new terminals after the current workspace folder (IDE-style) rather
    // than a bare counter; disambiguate duplicates with a numeric suffix. A
    // restored session keeps its saved name as the preferred base.
    const base = opts.name || (Sidebar.workspaceRoot() || '').split(/[\\/]/).filter(Boolean).pop() || '终端';
    let name = base;
    const taken = new Set([...sessions.values()].map((s) => s.name));
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;

    const host = document.createElement('div');
    host.className = 'term-host';
    host.dataset.id = id;
    mainEl.appendChild(host);

    // hterm renders into its own iframe inside `host`. Prefs live in an in-memory
    // store (theme/font are pushed in from our CSS vars, never persisted). Input,
    // IME and paste are all handled by hterm's own textarea path — the reason we
    // moved off xterm.js, whose WKWebView input path doubled chars / dropped IME.
    const term = new hterm.Terminal({ storage: new lib.Storage.Memory() });

    const tab = document.createElement('div');
    tab.className = 'term-tab';
    tab.dataset.id = id;
    tab.innerHTML = '<span class="term-tab-name"></span><button class="term-tab-del" title="关闭终端" aria-label="关闭终端">×</button>';
    const nameEl = tab.querySelector('.term-tab-name');
    nameEl.textContent = name;
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.term-tab-del')) return;
      activate(id);
    });
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(id); });
    tab.querySelector('.term-tab-del').addEventListener('click', (e) => {
      e.stopPropagation();
      remove(id);
    });
    listEl.appendChild(tab);

    const sess = {
      id, pid, name, term, host, tab, exited: false,
      ghostEl: null,                       // created inside the hterm iframe once ready
      createdAt: opts.createdAt || Date.now(), dirty: false,
      ready: false, spawned: false, pendingOut: [],
      track: { line: '', alt: false, disabled: false, suggest: '', modes: new Set() },
    };
    termSessions.set(id, term);
    sessions.set(id, sess);

    // hterm is ready once its init promise resolves and the iframe is decorated.
    // Everything that needs the live io / keyboard / grid size happens here.
    // Prefs MUST be set after decorate — hterm's pref-change observers touch the
    // scrollport DOM, so setting them on a not-yet-decorated terminal throws (and
    // would silently fall back to hterm's default light theme / font).
    term.onTerminalReady = function () {
      try {
        const p = term.getPrefs();
        p.set('font-family', "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace");
        p.set('font-size', Number(uiSettings.fontTerminal) || 13);
        p.set('cursor-blink', true);
        p.set('scrollbar-visible', false);
        p.set('copy-on-select', false);
        p.set('audible-bell-sound', '');     // no bell asset / no beep
        p.set('enable-bold-as-bright', true);
      } catch {}
      applyHtermPrefs(term);                 // theme colors + ANSI palette
      const io = term.io.push();
      sess.io = io;
      // hterm's keymap (control keys → byte sequences) and its textarea/IME path
      // both surface here as the resolved string headed for the PTY — exactly what
      // xterm's onData gave us, so handleTermInput is reused verbatim.
      io.onVTKeystroke = (str) => handleTermInput(id, str);
      io.sendString    = (str) => handleTermInput(id, str);
      io.onTerminalResize = (cols, rows) => {
        if (sess.spawned) requestTermResize(id, Math.max(2, cols || 2), Math.max(2, rows || 2));
      };
      // Shift+Enter → ESC+CR (newline in Claude Code / Codex instead of submit).
      try {
        term.keyboard.bindings.addBinding('Shift+ENTER', function () {
          handleTermInput(id, '\x1b\r');
          return hterm.Keyboard.KeyActions.CANCEL;
        });
      } catch {}
      term.installKeyboard();
      try { term.setCursorVisible(true); } catch {}
      try { installGhost(sess); } catch {}

      // Replay saved output (stored as colored logical-line ANSI — see
      // serializeSession), then a divider, then the fresh shell prints below.
      // Stored lines are joined by \n → convert to \r\n for the terminal.
      // serializeSession drops everything up to the last divider on re-save, so
      // reopening never compounds.
      if (opts.restore) {
        try { io.print(`${String(opts.restore).replace(/\n/g, '\r\n')}\r\n${SESSION_DIVIDER}`); } catch {}
      }
      sess.ready = true;
      if (sess.pendingOut.length) {
        const buf = sess.pendingOut; sess.pendingOut = [];
        for (const d of buf) write(id, d);
      }

      // Spawn the pty now we have a real grid size (hterm auto-fit the iframe).
      // resyncOnData re-reports the size once the pty's first output proves it
      // exists, covering a hidden-at-create terminal whose size settles on show.
      const sz = term.screenSize || {};
      const cols = Math.max(2, sz.width || 80);
      const rows = Math.max(2, sz.height || 24);
      sess.resyncOnData = true;
      sess.spawned = true;
      requestTermCreate(id, cols, rows, Sidebar.workspaceRoot() || '');
    };

    try { term.decorate(host); } catch {}
    ensureTermHistory();
    activate(id);
  }

  // Print pty output into a terminal's hterm io, buffering anything that arrives
  // before the terminal is ready (its io is set up in onTerminalReady).
  function write(id, data) {
    const s = sessions.get(id);
    if (!s) return;
    if (!s.ready || !s.io) { s.pendingOut.push(data); return; }
    try { s.io.print(data); } catch {}
  }

  function activate(id) {
    const s = sessions.get(id);
    if (!s) return;
    activeId = id;
    for (const other of sessions.values()) {
      const on = other.id === id;
      other.host.classList.toggle('active', on);
      other.tab.classList.toggle('active', on);
    }
    fitAndResize();
    try { s.term.focus(); } catch {}
  }

  function remove(id) {
    const s = sessions.get(id);
    if (!s) return;
    // Soft delete: rewrite this terminal's own file flagged `deleted:true` (keep
    // its last output, but restore filters it out so it won't replay on reopen).
    try {
      requestHistoryWrite('term', s.pid, {
        id: s.pid, workspace: wsKey(), name: s.name,
        createdAt: s.createdAt, updatedAt: Date.now(),
        data: serializeSession(s), deleted: true,
      });
    } catch {}
    requestTermKill(id);
    try { s.term.uninstallKeyboard(); } catch {}
    s.host.remove();            // removes hterm's iframe with it
    s.tab.remove();
    sessions.delete(id);
    termSessions.delete(id);
    if (activeId === id) {
      activeId = null;
      const next = sessions.keys().next().value;
      if (next) activate(next);
    }
  }

  function beginRename(id) {
    const s = sessions.get(id);
    if (!s || s.tab.querySelector('.term-tab-edit')) return;
    const nameEl = s.tab.querySelector('.term-tab-name');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'term-tab-edit';
    input.value = s.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (keep) => {
      if (done) return;
      done = true;
      if (keep) {
        const v = input.value.trim();
        if (v && v !== s.name) { s.name = v; s.dirty = true; scheduleSnapshot(); }
      }
      const span = document.createElement('span');
      span.className = 'term-tab-name';
      span.textContent = s.name;
      span.addEventListener('dblclick', (e) => { e.stopPropagation(); beginRename(id); });
      input.replaceWith(span);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  function markExit(id) {
    const s = sessions.get(id);
    if (!s) return;
    s.exited = true;
    s.tab.classList.add('exited');
  }

  function fitAndResize() {
    const s = activeId ? sessions.get(activeId) : null;
    if (!s || !s.term) return;
    // hterm re-measures its own scrollport on size changes and fires
    // io.onTerminalResize; here we just report the current grid size to the pty,
    // covering the hidden→visible activate transition where no resize event fired.
    try {
      const sz = s.term.screenSize;
      if (s.spawned && sz && sz.width >= 2 && sz.height >= 2) {
        requestTermResize(s.id, sz.width, sz.height);
      }
    } catch {}
  }

  function applyTheme() {
    for (const s of sessions.values()) applyHtermPrefs(s.term);
  }

  function applyFontSize(px) {
    const n = Number(px);
    if (!Number.isFinite(n)) return;
    for (const s of sessions.values()) {
      try { s.term.getPrefs().set('font-size', n); } catch {}
    }
    fitAndResize();
  }

  // ---- Command history + learning ------------------------------------------
  // The PTY is a raw byte stream, so we reconstruct the line the user is typing
  // from keystrokes. This is best-effort: any cursor movement / shell
  // completion / full-screen app marks the line "uncertain", which suppresses
  // both the inline suggestion and recording until the next fresh prompt.

  function wsKey() { return Sidebar.workspaceRoot() || 'default'; }

  // Terminal history is a per-workspace "frequent commands" table
  // {cmd,count,lastUsed}, learned as you type and deletable from the 🕘 panel.
  // All workspaces share one native record (term/commands.json), a
  // { "<workspace>": commands[] } map; `termCommands` is the current slice.
  async function ensureTermHistory() {
    const k = wsKey();
    if (k === termHistoryKey) return;
    termHistoryKey = k;
    termCommands = [];
    let rec = null;
    try { rec = await requestHistoryRead('term', 'commands'); } catch {}
    if (k !== termHistoryKey) return;          // workspace switched mid-load
    termAll = (rec && typeof rec.commands === 'object' && rec.commands) ? rec.commands : {};
    // Keep soft-deleted entries in the array so they survive re-persist; they are
    // filtered out at the suggestion point (bestSuggestion) instead.
    termCommands = Array.isArray(termAll[k]) ? termAll[k] : [];
    termAll[k] = termCommands;
  }

  function persistTermHistory() {
    if (!termHistoryKey) termHistoryKey = wsKey();
    termAll[termHistoryKey] = termCommands;
    try { requestHistoryWrite('term', 'commands', { id: 'commands', commands: termAll }); } catch {}
  }

  // hterm has no SerializeAddon. We rebuild ANSI from the rendered row DOM so the
  // replay keeps its COLORS: hterm styles each span inline (style.color /
  // backgroundColor as rgb(), fontWeight bold, fontStyle italic, textDecoration
  // underline, .faint), so rowToAnsi emits truecolor SGR per span. Rows are joined
  // into LOGICAL lines (wrapped rows have a `line-overflow` attr → no newline), so
  // the stored text re-wraps naturally at whatever width the terminal is on reopen
  // instead of a raw byte stream re-wrapping wrong. Then (testing a SGR-stripped
  // copy of each line):
  //  - drop everything up to the LAST replay divider, so a prior reopen's history
  //    + old dividers are never re-saved (no compounding);
  //  - strip zsh's partial-line `%` (PROMPT_SP) marker lines and trailing blanks;
  //  - cap to the last 600 logical lines.
  const MAX_REPLAY_LINES = 600;
  const SGR_RE = /\x1b\[[0-9;]*m/g;

  // hterm colors its spans with CSS vars: `rgb(var(--hterm-color-N))` for the 16
  // ANSI palette entries (and `--hterm-{foreground,background}-color` for the
  // defaults), or a literal `rgb(r,g,b)` for 24-bit truecolor. Map palette entries
  // to a 256-color SGR (the replay terminal has the same palette, so index N
  // renders identically), truecolor to a 24-bit SGR, and defaults to nothing.
  // `base` is 38 (foreground) or 48 (background).
  function colorSgr(str, base) {
    if (!str) return '';
    let m = String(str).match(/--hterm-(?:color-(\d+)|(?:foreground|background)-color)/);
    if (m) return m[1] != null ? `;${base};5;${m[1]}` : '';
    m = String(str).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return `;${base};2;${m[1]};${m[2]};${m[3]}`;
    return '';
  }

  function rowToAnsi(row) {
    let out = '';
    for (const ch of row.childNodes) {
      if (ch.nodeType === 3) { out += `\x1b[0m${ch.textContent}`; continue; }  // plain text node
      const st = ch.style || {};
      let sgr = '0';
      sgr += colorSgr(st.color, 38);
      sgr += colorSgr(st.backgroundColor, 48);
      if (st.fontWeight === 'bold' || parseInt(st.fontWeight, 10) >= 600) sgr += ';1';
      if (ch.faint) sgr += ';2';
      if (st.fontStyle === 'italic') sgr += ';3';
      const td = st.textDecorationLine || st.textDecoration || '';
      if (td.includes('underline')) sgr += ';4';
      if (td.includes('line-through')) sgr += ';9';
      out += `\x1b[${sgr}m${ch.textContent || ''}`;
    }
    return `${out}\x1b[0m`;
  }

  function serializeSession(s) {
    if (!s || !s.term || !s.term.getRowCount) return '';
    let lines = [];
    try {
      const n = s.term.getRowCount();
      let cur = '';
      for (let i = 0; i < n; i++) {
        let node = null;
        try { node = s.term.getRowNode(i); } catch {}
        cur += node ? rowToAnsi(node) : '';
        if (i < n - 1 && !(node && node.getAttribute && node.getAttribute('line-overflow'))) {
          lines.push(cur); cur = '';
        }
      }
      lines.push(cur);
    } catch { return ''; }
    const plain = lines.map((l) => l.replace(SGR_RE, ''));
    let lastDiv = -1;
    for (let i = 0; i < plain.length; i++) if (plain[i].includes(DIVIDER_MARK)) lastDiv = i;
    if (lastDiv >= 0) { lines = lines.slice(lastDiv + 1); plain.splice(0, lastDiv + 1); }
    let rows = lines.map((l, i) => ({ l, p: plain[i] })).filter((x) => !/^%\s*$/.test(x.p));
    while (rows.length && !rows[rows.length - 1].p.trim()) rows.pop();
    if (rows.length > MAX_REPLAY_LINES) rows = rows.slice(rows.length - MAX_REPLAY_LINES);
    return rows.map((x) => x.l).join('\n');
  }

  // Persist each terminal that produced output since the last snapshot to its own
  // file (term/<pid>.json), mirroring chat's one-file-per-conversation layout, so
  // reopening the project replays them.
  function snapshotSessions() {
    const k = wsKey();
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.dirty) continue;
      // While a full-screen app owns the screen (claude / vim / less — alt-buffer
      // or mouse modes active), getRowsText would capture its TUI, not the shell
      // scrollback — replaying that later looks garbled. Keep `dirty` and defer
      // until the app exits and the normal screen is back.
      if (s.track && s.track.modes && s.track.modes.size > 0) continue;
      s.dirty = false;
      try {
        requestHistoryWrite('term', s.pid, {
          id: s.pid, workspace: k, name: s.name,
          createdAt: s.createdAt, updatedAt: now, data: serializeSession(s),
        });
      } catch {}
    }
  }

  // Throttled snapshot: coalesces an output burst into one save ~every 1.5s
  // (captured at fire time, so it reflects the latest screen).
  function scheduleSnapshot() {
    if (snapTimer) return;
    snapTimer = setTimeout(() => { snapTimer = null; try { snapshotSessions(); } catch {} }, 1500);
  }

  // Learn one completed command: bump its count + recency (smart learning — a
  // command typed repeatedly climbs the 常用 list), then persist.
  function recordCommand(cmd) {
    const c = String(cmd || '').trim();
    if (!c || c.length > 200) return;          // skip empty / pasted blobs
    const now = Date.now();
    const e = termCommands.find((x) => x.cmd === c);
    // Re-typing a soft-deleted command revives it (clears the deleted flag).
    if (e) { e.count = (e.count || 0) + 1; e.lastUsed = now; if (e.deleted) delete e.deleted; }
    else termCommands.push({ cmd: c, count: 1, lastUsed: now });
    persistTermHistory();
  }

  // Best match for the inline ghost: most-used wins, recency breaks ties. With
  // an empty prefix (fresh prompt) this returns the single most-used command,
  // so the terminal shows a Warp-style suggestion before you type anything.
  function bestSuggestion(prefix) {
    let best = null;
    for (const e of termCommands) {
      if (!e.cmd || e.deleted) continue;
      if (prefix && (e.cmd.length <= prefix.length || !e.cmd.startsWith(prefix))) continue;
      if (!best
        || (e.count || 0) > (best.count || 0)
        || ((e.count || 0) === (best.count || 0) && (e.lastUsed || 0) > (best.lastUsed || 0))) {
        best = e;
      }
    }
    return best ? best.cmd : '';
  }

  // Update the reconstructed line from one chunk of typed data.
  function trackInput(tr, d) {
    if (tr.alt) return;
    if (d === '\r' || d === '\n') {
      if (!tr.disabled) recordCommand(tr.line);
      tr.line = ''; tr.disabled = false;
      return;
    }
    if (d === '\x03' || d === '\x04') { tr.line = ''; tr.disabled = false; return; } // Ctrl-C / Ctrl-D
    if (d === '\x7f' || d === '\b') { tr.line = tr.line.slice(0, -1); return; }       // backspace
    if (d === '\x15') { tr.line = ''; return; }                                       // Ctrl-U kill line
    if (d === '\t') { tr.disabled = true; return; }                                   // shell completion → unknown
    if (d.charCodeAt(0) === 0x1b) { tr.disabled = true; return; }                     // arrows / esc seq → unknown
    // Plain text (single char or pasted run). Reject if it carries any control.
    if (/[\x00-\x1f\x7f]/.test(d)) { tr.disabled = true; return; }
    tr.line += d;
  }

  // Intercept keystrokes: accept the ghost on Right-arrow at line end, else
  // forward verbatim and update tracking. Input is ALWAYS forwarded unchanged
  // except the accept case, so a tracking bug can never break normal typing.
  function handleTermInput(id, d) {
    const s = sessions.get(id);
    if (!s) { requestTermInput(id, d); return; }
    const tr = s.track;
    // Accept the ghost on Right-arrow OR Tab — but only when a suggestion is
    // actually showing. With no ghost, Tab falls through to the shell's own
    // completion (and Right-arrow just moves the cursor), so nothing is lost.
    const canAccept = tr.suggest && !tr.alt && !tr.disabled
      && tr.suggest.length > tr.line.length && tr.suggest.startsWith(tr.line);
    if ((d === '\x1b[C' || d === '\t') && canAccept) {
      const suffix = tr.suggest.slice(tr.line.length);
      requestTermInput(id, suffix);   // let the shell echo it
      tr.line = tr.suggest;
      hideGhost(s);
      return;                          // swallow the bare Right-arrow / Tab
    }
    requestTermInput(id, d);
    trackInput(tr, d);
    scheduleGhost(id);   // typed line changed — reposition/refresh the ghost
  }

  // DEC private modes that signal an interactive app has taken over the screen
  // and is doing its own input/rendering (and often its own autosuggest): the
  // alt screen (vim, less), and mouse tracking (Claude Code, Codex, htop, …)
  // which inline TUIs enable without switching to the alt screen.
  const APP_MODES = new Set([
    '1049', '47', '1047',                          // alt screen
    '1000', '1001', '1002', '1003', '1005', '1006', '1015', '1016', // mouse
  ]);
  // Ghost refresh, coalesced to one per frame per terminal (replaces xterm's
  // term.onRender hook, which hterm has no equivalent of).
  const ghostRaf = new Map();
  function scheduleGhost(id) {
    if (ghostRaf.has(id)) return;
    ghostRaf.set(id, requestAnimationFrame(() => {
      ghostRaf.delete(id);
      try { refreshGhost(id); } catch {}
    }));
  }

  // Scan PTY output for app enter/leave and toggle the suggestion suppression.
  // While any such mode (or the kitty keyboard protocol) is active we stop
  // tracking and hide the ghost, so it never fights the app's own UI / its own
  // Right-arrow / Tab completion (e.g. Claude Code, Codex).
  function afterOutput(id, data) {
    const s = sessions.get(id);
    if (!s) return;
    // First output proves the pty exists. Re-fit + resize now so zsh's COLUMNS
    // matches the rendered grid even if the size settled (or a resize raced the
    // pty's creation and got dropped) since spawn — the fix for the wrapping /
    // self-overwriting prompt after a restore.
    // Only the active terminal has a real on-screen size to fit against; hidden
    // ones are re-synced by activate() when shown, so just clear the flag there.
    if (s.resyncOnData) {
      s.resyncOnData = false;
      if (s.id === activeId) fitAndResize();
    }
    // Mark dirty so the throttled snapshot re-serializes this terminal's grid.
    s.dirty = true;
    scheduleSnapshot();        // persist this workspace's terminal output (throttled)
    const tr = s.track;
    if (!tr.modes) tr.modes = new Set();
    let changed = false;
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let m;
    while ((m = re.exec(data))) {
      const on = m[2] === 'h';
      for (const num of m[1].split(';')) {
        if (!APP_MODES.has(num)) continue;
        if (on) tr.modes.add(num); else tr.modes.delete(num);
        changed = true;
      }
    }
    // Kitty keyboard protocol: push (CSI > flags u) / pop (CSI < … u). Both
    // Claude Code and Codex use it to read modified keys like Shift+Enter.
    if (/\x1b\[>[0-9;]*u/.test(data)) { tr.modes.add('kitty'); changed = true; }
    if (/\x1b\[<[0-9;]*u/.test(data)) { tr.modes.delete('kitty'); changed = true; }
    scheduleGhost(id);         // cursor likely moved — reposition the ghost
    if (!changed) return;
    const app = tr.modes.size > 0;
    if (app && !tr.alt) { tr.alt = true; tr.line = ''; hideGhost(s); }
    else if (!app && tr.alt) { tr.alt = false; tr.line = ''; tr.disabled = false; }
  }

  // The ghost overlay lives INSIDE hterm's iframe document (so it shares the
  // grid's coordinate system and font), positioned at the cursor node. Purely
  // additive — any failure just hides it; typing is never affected.
  function installGhost(s) {
    try {
      const doc = s.term.getScrollPort().getDocument();
      if (!doc || !doc.body) return;
      const el = doc.createElement('div');
      el.className = 'term-ghost';
      el.style.cssText =
        'position:absolute;pointer-events:none;white-space:pre;opacity:0.42;'
        + 'z-index:5;font:inherit;display:none;';
      doc.body.appendChild(el);
      s.ghostEl = el;
    } catch {}
  }

  function hideGhost(s) {
    s.track.suggest = '';
    if (s.ghostEl) s.ghostEl.style.display = 'none';
  }

  // Position the dim suggestion suffix at the cursor. hterm's cursorNode_ is an
  // absolutely-positioned element in the iframe doc, so its offsetLeft/Top give
  // the exact cell — no manual cols×charsize math needed.
  function refreshGhost(id) {
    const s = sessions.get(id);
    if (!s || !s.ghostEl) return;
    const tr = s.track;
    if (tr.alt || tr.disabled) { hideGhost(s); return; }
    const sug = bestSuggestion(tr.line);
    if (!sug || sug.length <= tr.line.length || !sug.startsWith(tr.line)) { hideGhost(s); return; }
    let cn = null;
    try { cn = s.term.cursorNode_; } catch {}
    if (!cn) { hideGhost(s); return; }
    tr.suggest = sug;
    s.ghostEl.textContent = sug.slice(tr.line.length);
    try {
      s.ghostEl.style.left = `${cn.offsetLeft}px`;
      s.ghostEl.style.top = `${cn.offsetTop}px`;
      s.ghostEl.style.height = `${cn.offsetHeight}px`;
      s.ghostEl.style.lineHeight = `${cn.offsetHeight}px`;
    } catch { hideGhost(s); return; }
    s.ghostEl.style.display = '';
  }

  // ---- Left tab-rail resize -------------------------------------------------
  // Drag the divider between the tab rail and the terminal area to set the
  // rail's width; persisted globally (like the AI panel width / term height).
  // The 常用/最近 command-history list now lives in the Settings window —
  // here we only keep the inline ghost suggestion (driven by `termCommands`).

  function initSideResize(panel) {
    const handle = panel.querySelector('.term-side-resize');
    const side = panel.querySelector('.term-side');
    if (!handle || !side) return;
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      const w = Math.max(110, Math.min(360, e.clientX - rect.left));
      side.style.flexBasis = `${w}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('mdgem.term.sideWidth', String(side.offsetWidth));
      fitAndResize();
    });
  }

  return {
    ensure, write, fitAndResize, applyTheme, applyFontSize, markExit, create, afterOutput,
  };
})();

PanelHooks.terminal = () => TerminalPanel.ensure();
PanelHooks.terminalResized = () => TerminalPanel.fitAndResize();

// ===================================================================
// Document view — owns the main content area's edit/preview state. Code &
// text files open in a CodeMirror editor by default; markdown renders to a
// preview by default. Either toggles via the floating mode bar. Edits save to
// disk (⌘S / Save) through the existing writeFile IPC; the host's FS watcher
// then re-renders any open markdown preview. The editor bundle is loaded on
// demand the first time edit mode is entered (mirrors the terminal bundle).
// ===================================================================

let editorBundleLoaded = false;
async function ensureEditorBundle() {
  if (editorBundleLoaded) return;
  const script = document.createElement('script');
  script.src = 'vendor/editor.bundle.js';
  await new Promise((res, rej) => {
    script.onload = res;
    script.onerror = rej;
    document.head.appendChild(script);
  });
  editorBundleLoaded = true;
}

const DocView = (() => {
  // The document shown in the main area.
  let cur = { path: null, ext: '', kind: null, editable: false, mode: 'preview', dirty: false };
  let handle = null;   // CodeMirror handle from window.MDEditor.createEditor
  let autoSaveTimer = null;

  function el(id) { return document.getElementById(id); }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop() || String(p || ''); }

  function path() { return cur.path; }
  function isDirty() { return !!cur.dirty; }
  function isEditing() { return cur.mode === 'edit'; }

  function markDirty(d) {
    cur.dirty = !!d;
    const dot = el('doc-dirty');
    const save = el('doc-save-btn');
    if (dot) dot.hidden = !cur.dirty;
    if (save) save.hidden = !cur.dirty;
    try { Tabs.refresh(); } catch {}
  }
  function markClean() { markDirty(false); }

  function renderBar() {
    const b = el('doc-modebar');
    if (!b) return;
    if (!cur.path) { b.hidden = true; return; }
    b.hidden = false;
    const nameEl = b.querySelector('.doc-modebar-name');
    if (nameEl) nameEl.textContent = baseName(cur.path);
    const toggle = el('doc-mode-toggle');
    if (toggle) {
      toggle.hidden = !cur.editable;
      if (cur.editable) {
        toggle.textContent = cur.mode === 'edit' ? '预览' : '编辑';
        toggle.title = cur.mode === 'edit' ? '切换到预览' : '切换到编辑';
      }
    }
    // "外部打开" is offered for media (image/video) and html previews; html
    // opens in a browser (Chrome-preferred), media in its default app.
    const openExt = el('doc-open-ext');
    if (openExt) {
      const show = (cur.kind === 'media' || cur.kind === 'html') && cur.mode === 'preview';
      openExt.hidden = !show;
      if (show) openExt.title = cur.kind === 'html' ? '用浏览器打开' : '用系统默认程序打开';
    }
    markDirty(cur.dirty);
  }

  function showMain() {
    const m = el('main'); const h = el('editor-host');
    if (m) m.hidden = false;
    if (h) h.hidden = true;
  }
  function showEditor() {
    const m = el('main'); const h = el('editor-host');
    if (m) m.hidden = true;
    if (h) h.hidden = false;
    try { FindBar.close(); } catch {}   // preview find bar doesn't apply in edit mode
  }
  function destroyEditor() {
    if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
    if (handle) { try { handle.destroy(); } catch {} handle = null; }
    const h = el('editor-host');
    if (h) h.innerHTML = '';
  }

  // Debounced auto-save after edits (only in the 'afterEdit' mode).
  function maybeAutoSaveAfterEdit() {
    if (uiSettings.autoSave !== 'afterEdit') return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      if (cur.dirty) save();
    }, 1000);
  }

  function maybeAutoSaveOnBlur() {
    if (uiSettings.autoSave === 'onBlur' && cur.dirty) save();
  }

  // Reset to a non-editable readonly preview (image / video / html / unsupported).
  function toReadonly() {
    destroyEditor();
    showMain();
    cur = { path: null, ext: '', kind: null, editable: false, mode: 'preview', dirty: false };
    const b = el('doc-modebar');
    if (b) b.hidden = true;
  }

  // Host rendered a markdown document into #root.
  function onMarkdownRendered() {
    const p = Sidebar.currentFilePath();
    if (!p) { const b = el('doc-modebar'); if (b) b.hidden = true; return; }
    // If actively editing this same file, keep the editor up (the re-render
    // just refreshed the hidden #root underneath).
    if (cur.mode === 'edit' && cur.path === p) return;
    destroyEditor();
    showMain();
    cur = { path: p, ext: fileExt(p), kind: 'md', editable: true, mode: 'preview', dirty: false };
    renderBar();
    try { Tabs.note(p, 'md'); } catch {}
    try { Memory.scheduleSave(); } catch {}
  }

  // Open an image/video — a non-editable readonly preview. Keeps a minimal
  // modebar so the "外部打开" button is available (toReadonly would hide it).
  function openMedia(node, inner) {
    const p = node.path;
    destroyEditor();
    showMain();
    cur = { path: p, ext: fileExt(p), kind: 'media', editable: false, mode: 'preview', dirty: false };
    showPreview(node, inner);
    renderBar();
    try { Memory.scheduleSave(); } catch {}
  }

  // Open an .html file — shows the live iframe preview, editable via the toggle.
  function openHtml(node) {
    const p = node.path;
    destroyEditor();
    showMain();
    cur = { path: p, ext: fileExt(p), kind: 'html', editable: true, mode: 'preview', dirty: false };
    showPreview(node, htmlFrameHTML(p));
    renderBar();
    try { Memory.scheduleSave(); } catch {}
  }

  // Open a code/text file — defaults to edit mode.
  async function openText(node) {
    const p = node.path;
    setLoading(true);
    const res = await requestReadFile(p);
    setLoading(false);
    if (!res || !res.ok) {
      toReadonly();
      Sidebar.setActivePreview(p);
      showPreview(node, previewUnsupportedHTML(node, res && res.error));
      return;
    }
    cur = { path: p, ext: fileExt(p), kind: 'text', editable: true, mode: 'edit', dirty: false };
    Sidebar.setActivePreview(p);
    Sidebar.setOutline([]);
    await mountEditor(res.text);
    renderBar();
    try { Tabs.note(p, 'text'); } catch {}
    try { Memory.scheduleSave(); } catch {}
  }

  async function mountEditor(text) {
    try {
      await ensureEditorBundle();
    } catch {
      toReadonly();
      showToast('无法加载编辑器组件', 'error');
      return;
    }
    if (!window.MDEditor) { toReadonly(); showToast('无法加载编辑器组件', 'error'); return; }
    destroyEditor();
    const host = el('editor-host');
    handle = window.MDEditor.createEditor({
      parent: host,
      doc: text || '',
      ext: cur.ext,
      base: resolvedTheme().base,
      onChange: () => { markDirty(true); maybeAutoSaveAfterEdit(); },
      onSave: () => { save(); },
      onBlur: () => { maybeAutoSaveOnBlur(); },
    });
    showEditor();
    requestAnimationFrame(() => { try { handle.focus(); } catch {} });
  }

  async function save() {
    if (!handle || !cur.path) return;
    const content = handle.getDoc();
    const w = await requestWriteFile(cur.path, content);
    if (w && w.ok) {
      markClean();
      showToast('已保存', 'info');
    } else {
      showToast(`保存失败：${(w && w.error) || ''}`, 'error');
    }
  }

  async function toggle() {
    if (!cur.editable) return;
    if (cur.mode === 'edit') {
      // → preview. Auto-save pending edits first so the preview matches disk.
      if (cur.dirty) { await save(); if (cur.dirty) return; }
      const content = handle ? handle.getDoc() : '';
      cur.mode = 'preview';
      destroyEditor();
      showMain();
      if (cur.kind === 'md') {
        requestOpenFile(cur.path);   // host reloads + re-renders
      } else if (cur.kind === 'html') {
        showPreview({ path: cur.path, name: baseName(cur.path) }, htmlFrameHTML(cur.path));
      } else {
        renderTextPreview({ path: cur.path, name: baseName(cur.path) }, content);
      }
      renderBar();
    } else {
      // → edit. Read the raw bytes from disk fresh.
      setLoading(true);
      const res = await requestReadFile(cur.path);
      setLoading(false);
      if (!res || !res.ok) { showToast(`无法读取：${(res && res.error) || ''}`, 'error'); return; }
      cur.mode = 'edit';
      await mountEditor(res.text);
      renderBar();
    }
  }

  function applyTheme() {
    if (handle) { try { handle.setBase(resolvedTheme().base); } catch {} }
  }

  function confirmLeave() {
    return showModal({
      title: '未保存的更改',
      message: `“${baseName(cur.path)}” 有未保存的更改，切换将放弃这些更改。`,
      confirmLabel: '放弃并切换',
      danger: true,
    });
  }

  // Called before navigating away from a dirty editor. Auto-save modes flush
  // to disk and proceed; manual mode asks to discard. Returns true to proceed.
  async function prepareLeave() {
    if (!cur.dirty) return true;
    if (uiSettings.autoSave !== 'off') {
      await save();
      return !cur.dirty;   // proceed only if the save succeeded
    }
    const ok = await confirmLeave();
    if (ok) markClean();
    return ok;
  }

  return {
    onMarkdownRendered, openText, openHtml, openMedia, toReadonly, toggle, save, applyTheme,
    isDirty, isEditing, path, markClean, prepareLeave,
  };
})();

document.getElementById('doc-mode-toggle')?.addEventListener('click', () => DocView.toggle());
document.getElementById('doc-save-btn')?.addEventListener('click', () => DocView.save());
document.getElementById('doc-open-ext')?.addEventListener('click', () => {
  const p = DocView.path();
  if (p) requestOpenExternal(p);
});

// ===================================================================
// Editor tabs — IDE-style header strip. Every opened file becomes a tab;
// re-opening a file just re-activates its tab. Switching a tab re-runs the
// normal open flow (`previewFile`) for that path, so there's only ever one
// live editor / rendered doc at a time — tabs hold lightweight bookkeeping
// (path, name, kind, remembered scroll), not heavyweight DOM/editor state.
// ===================================================================
const Tabs = (() => {
  const MAX = 12;                 // soft cap; oldest idle tab is evicted past this
  let list = [];                  // [{ path, name, kind, ext, scrollTop }]
  let active = null;              // path of the visible tab

  function el(id) { return document.getElementById(id); }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop() || String(p || ''); }
  function bar() { return el('tabbar'); }
  function find(p) { return list.find((t) => t.path === p); }
  function mainScrollable() { const h = el('editor-host'); return !h || h.hidden; }

  // Stash the live scroll position onto the active tab before we leave it.
  function captureScroll() {
    if (!mainScrollable()) return;          // editor visible → #main scroll is 0
    const t = find(active);
    const m = el('main');
    if (t && m) t.scrollTop = m.scrollTop;
  }

  // A file just became visible (from any entry point). Ensure it has a tab and
  // make it active. Idempotent — re-rendering the same file just re-selects it.
  function note(path, kind) {
    if (!path) return;
    let t = find(path);
    if (!t) {
      t = { path, name: baseName(path), kind, ext: fileExt(path), scrollTop: 0 };
      list.push(t);
      evict();
    } else if (kind) {
      t.kind = kind;
    }
    active = path;
    render();
    // Restore this tab's remembered scroll (render() / showPreview reset to 0).
    if (mainScrollable() && t.scrollTop) {
      const top = t.scrollTop, m = el('main');
      if (m) requestAnimationFrame(() => { m.scrollTop = top; });
    }
  }

  // Drop the oldest non-active tab while over the cap. Inactive tabs are never
  // dirty (leaving an editor always saves/discards first), so this is safe.
  function evict() {
    while (list.length > MAX) {
      const idx = list.findIndex((t) => t.path !== active);
      if (idx < 0) break;
      list.splice(idx, 1);
    }
  }

  function activate(path) {
    if (path === active) {
      if (mainScrollable()) { const m = el('main'); if (m) m.scrollTo({ top: 0, behavior: 'smooth' }); }
      return;
    }
    const t = find(path);
    if (!t) return;
    captureScroll();
    previewFile({ path: t.path, name: t.name, type: 'file' });
  }

  async function closeTab(path) {
    const t = find(path);
    if (!t) return;
    const wasActive = path === active;
    // The active tab is the only one that can hold a dirty editor.
    if (wasActive && DocView.isDirty()) {
      const ok = await DocView.prepareLeave();
      if (!ok) return;
    }
    const idx = list.indexOf(t);
    list.splice(idx, 1);
    if (!wasActive) { render(); return; }
    const next = list[idx] || list[idx - 1] || null;
    active = null;
    render();                         // redraw the reduced strip immediately
    if (next) activate(next.path);
    else showEmpty();
  }

  // No tabs left — clear the view back to the empty home state.
  function showEmpty() {
    try { DocView.toReadonly(); } catch {}
    const root = el('root'); if (root) root.innerHTML = '';
    try { Sidebar.setOutline([]); } catch {}
    try { Sidebar.setActivePreview(null); } catch {}
    updateEmptyState();
  }

  function underRoot(p, root) {
    if (p === root) return true;
    return p.startsWith(root + '/') || p.startsWith(root + '\\');
  }

  // Workspace changed — drop tabs that don't belong to the new root.
  function pruneToRoot(root) {
    if (!root) { list = []; active = null; render(); return; }
    list = list.filter((t) => underRoot(t.path, root));
    if (!find(active)) active = null;
    render();
  }

  // Drop every tab in `removeSet`. Flushes the active editor first if it's
  // among them and dirty. `fallback` is the path to activate if the active tab
  // got closed (must be a survivor); otherwise we fall back to the last tab.
  async function removeMany(removeSet, fallback) {
    if (removeSet.has(active) && DocView.isDirty()) {
      const ok = await DocView.prepareLeave();
      if (!ok) return;
    }
    const activeRemoved = removeSet.has(active);
    list = list.filter((t) => !removeSet.has(t.path));
    if (!activeRemoved) { render(); return; }
    active = null;
    render();                         // redraw the reduced strip immediately
    if (list.length) activate(fallback && find(fallback) ? fallback : list[list.length - 1].path);
    else showEmpty();
  }

  function closeOthers(keep) {
    removeMany(new Set(list.filter((t) => t.path !== keep).map((t) => t.path)), keep);
  }
  function closeSide(path, side) {
    const i = list.findIndex((t) => t.path === path);
    if (i < 0) return;
    const victims = side === 'left' ? list.slice(0, i) : list.slice(i + 1);
    removeMany(new Set(victims.map((t) => t.path)), path);
  }
  function closeAll() { removeMany(new Set(list.map((t) => t.path)), null); }

  // Right-click a tab → close-family menu (no copy/path items by design).
  function tabMenu(e, t) {
    e.preventDefault();
    e.stopPropagation();
    const i = list.indexOf(t);
    const items = [{ label: '关闭', action: () => closeTab(t.path) }];
    if (list.length > 1) items.push({ label: '关闭其他', action: () => closeOthers(t.path) });
    if (i > 0) items.push({ label: '关闭左侧标签', action: () => closeSide(t.path, 'left') });
    if (i < list.length - 1) items.push({ label: '关闭右侧标签', action: () => closeSide(t.path, 'right') });
    items.push('separator');
    items.push({ label: '全部关闭', danger: true, action: () => closeAll() });
    showContextMenu(e.clientX, e.clientY, items);
  }

  function render() {
    const b = bar();
    if (!b) return;
    if (!list.length) { b.hidden = true; b.innerHTML = ''; return; }
    b.hidden = false;
    b.innerHTML = '';
    const sc = document.createElement('div');
    sc.className = 'tab-scroll';
    const dirtyActive = DocView.isDirty();
    for (const t of list) {
      const isActive = t.path === active;
      const tab = document.createElement('div');
      tab.className = 'tab' + (isActive ? ' is-active' : '');
      tab.title = t.path;
      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.innerHTML = iconForFile(t.ext);
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = t.name;
      const dirty = isActive && dirtyActive;
      const close = document.createElement('span');
      close.className = 'tab-close' + (dirty ? ' is-dirty' : '');
      close.textContent = dirty ? '●' : '×';
      close.title = '关闭';
      if (dirty) {
        close.addEventListener('mouseenter', () => { close.textContent = '×'; });
        close.addEventListener('mouseleave', () => { close.textContent = '●'; });
      }
      close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.path); });
      tab.appendChild(icon);
      tab.appendChild(label);
      tab.appendChild(close);
      tab.addEventListener('click', () => activate(t.path));
      tab.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.path); } });
      tab.addEventListener('contextmenu', (e) => tabMenu(e, t));
      sc.appendChild(tab);
    }
    b.appendChild(sc);

    const act = sc.querySelector('.tab.is-active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  return { note, activate, closeTab, captureScroll, pruneToRoot, refresh: render };
})();

// ===================================================================
// Find-in-page for the markdown / preview pane (the code editor has its own
// CodeMirror search). ⌘/Ctrl+F opens an IDE-style bar at the top-right of the
// content; matches are wrapped in <mark> (compatible with macOS 13 WebKit,
// which lacks the CSS Custom Highlight API) and navigated with ↵ / ⇧↵.
// ===================================================================
const FindBar = (() => {
  let bar = null, input = null, countEl = null;
  let marks = [];      // every <mark.find-hit> currently in the document
  let idx = -1;        // index of the active match

  function root() { return document.getElementById('root'); }
  function host() { return document.getElementById('main-col'); }

  function ensure() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'find-bar';
    bar.hidden = true;
    bar.innerHTML =
      '<input type="text" class="find-input" placeholder="查找" aria-label="查找">' +
      '<span class="find-count">0/0</span>' +
      '<button type="button" class="find-btn find-prev" title="上一个 (⇧↵)">↑</button>' +
      '<button type="button" class="find-btn find-next" title="下一个 (↵)">↓</button>' +
      '<button type="button" class="find-btn find-close" title="关闭 (Esc)">✕</button>';
    host().appendChild(bar);
    input = bar.querySelector('.find-input');
    countEl = bar.querySelector('.find-count');
    input.addEventListener('input', () => run(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prev() : next(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    bar.querySelector('.find-prev').addEventListener('click', () => { prev(); input.focus(); });
    bar.querySelector('.find-next').addEventListener('click', () => { next(); input.focus(); });
    bar.querySelector('.find-close').addEventListener('click', close);
    return bar;
  }

  function open() {
    ensure();
    bar.hidden = false;
    host()?.classList.add('is-finding');
    const sel = String(window.getSelection ? window.getSelection() : '').trim();
    if (sel && sel.length <= 80 && !sel.includes('\n')) input.value = sel;
    input.focus();
    input.select();
    if (input.value) run(input.value);
  }

  function close() {
    if (!bar) return;
    clear();
    bar.hidden = true;
    host()?.classList.remove('is-finding');
  }

  function isOpen() { return !!bar && !bar.hidden; }

  // Unwrap every highlight and stitch the split text back together.
  function clear() {
    const r = root();
    if (r) {
      r.querySelectorAll('mark.find-hit').forEach((m) => {
        m.replaceWith(document.createTextNode(m.textContent));
      });
      r.normalize();
    }
    marks = [];
    idx = -1;
  }

  function run(query) {
    clear();
    const q = query || '';
    const r = root();
    if (!q || !r) { updateCount(); return; }
    const lq = q.toLowerCase();
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(lq)) return NodeFilter.FILTER_REJECT;
        // Skip rendered math (wrapping KaTeX text breaks its layout).
        if (n.parentElement && n.parentElement.closest('.katex, svg')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let from = 0, i = lower.indexOf(lq);
      while (i >= 0) {
        if (i > from) frag.appendChild(document.createTextNode(text.slice(from, i)));
        const m = document.createElement('mark');
        m.className = 'find-hit';
        m.textContent = text.slice(i, i + q.length);
        frag.appendChild(m);
        marks.push(m);
        from = i + q.length;
        i = lower.indexOf(lq, from);
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
    }
    if (marks.length) { idx = 0; activate(); }
    else updateCount();
  }

  function updateCount() {
    if (countEl) countEl.textContent = `${marks.length ? idx + 1 : 0}/${marks.length}`;
  }

  function activate() {
    marks.forEach((m, k) => m.classList.toggle('current', k === idx));
    const m = marks[idx];
    if (m) m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateCount();
  }

  function next() { if (marks.length) { idx = (idx + 1) % marks.length; activate(); } }
  function prev() { if (marks.length) { idx = (idx - 1 + marks.length) % marks.length; activate(); } }

  return { open, close, isOpen };
})();

// ===================================================================
// Per-workspace memory — remembers the last opened file, sidebar/panel state,
// terminal open-state, and expanded folders, keyed by the workspace root path.
// Lives in the global native store (UserDefaults / tauri-store), so nothing is
// written into the user's project. Loaded once on workspace entry (after the
// host pushes the file tree) and re-saved, debounced, on any layout change.
// ===================================================================

const Memory = (() => {
  let rootKey = null;
  let loaded = false;
  let restoring = false;   // suppress saves while applying a restore cascade
  let timer = null;

  function onWorkspace(root) {
    rootKey = root || null;
    loaded = false;
    if (!rootKey) return;
    requestMemoryGet(rootKey).then((blob) => {
      loaded = true;
      if (blob && typeof blob === 'object') {
        restoring = true;
        try { restore(blob); } finally {
          // Let the restore's own state-change callbacks settle first.
          setTimeout(() => { restoring = false; }, 0);
        }
      }
    });
  }

  function restore(blob) {
    try { Sidebar.restoreLayout(blob); } catch {}
    try { Panels.restoreLayout(blob); } catch {}
    // Restore the last opened file, overriding the host's default auto-open.
    const last = blob.lastFile;
    if (last && last !== Sidebar.currentFilePath() && Sidebar.fileExists(last)) {
      try { previewFile({ path: last, name: last.split(/[\\/]/).pop(), type: 'file' }); } catch {}
    }
  }

  function collect() {
    const blob = {};
    try { Object.assign(blob, Sidebar.collectLayout()); } catch {}
    try { blob.panels = Panels.collectLayout(); } catch {}
    blob.lastFile = Sidebar.activePreview() || Sidebar.currentFilePath() || null;
    return blob;
  }

  function scheduleSave() {
    if (!rootKey || !loaded || restoring) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try { requestMemorySet(rootKey, collect()); } catch {}
    }, 400);
  }

  return { onWorkspace, scheduleSave };
})();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { Sidebar.init(); Panels.init(); Settings.init(); Home.init(); });
} else {
  Sidebar.init();
  Panels.init();
  Settings.init();
  Home.init();
}

// Suppress the host webview's default context menu (Reload / Inspect / etc.)
// everywhere except where we attached our own handler that called
// preventDefault first — that's what `defaultPrevented` checks.
document.addEventListener('contextmenu', (e) => {
  if (!e.defaultPrevented) e.preventDefault();
});

// Cmd/Ctrl+A in the viewer should only select the *document* (#root) text,
// not the sidebar tree / outline. Native menu Select All goes through the
// same JS via window.MDViewerAPI.selectAllContent (called from the Win shell
// and via this keydown handler on macOS).
function selectAllContent() {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    document.execCommand('selectAll');
    return;
  }
  const target = document.getElementById('root');
  if (!target) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && (e.key === 'a' || e.key === 'A')) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    // Don't hijack select-all inside the code editor (CodeMirror handles it).
    if (document.activeElement?.closest?.('#editor-host')) return;
    e.preventDefault();
    selectAllContent();
  }
  // Save the open editor. When the editor is focused CodeMirror's own Mod-s
  // keymap handles it; this covers ⌘S while focus is elsewhere.
  if (meta && (e.key === 's' || e.key === 'S') && DocView.isEditing()) {
    if (document.activeElement?.closest?.('#editor-host')) return;
    e.preventDefault();
    DocView.save();
  }
  // ⌘/Ctrl+F → find in the markdown/preview pane (the code editor owns its own
  // CodeMirror search in edit mode).
  if (meta && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
    if (DocView.isEditing()) return;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') && !ae.closest('.find-bar')) return;
    e.preventDefault();
    FindBar.open();
  }
  // ⌘/Ctrl+I → toggle AI panel; ⌘/Ctrl+J → toggle terminal.
  if (meta && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
    e.preventDefault();
    Panels.toggleAi();
  }
  if (meta && !e.shiftKey && !e.altKey && (e.key === 'j' || e.key === 'J')) {
    e.preventDefault();
    Panels.toggleTerminal();
  }
});

// ===================================================================
// File-system ops (right-click → Reveal / Copy Path / Rename / Delete)
// ===================================================================

function isWindowsHost() {
  // Tauri only loads on Windows for this project; WebKit host is Mac.
  return !!window.__TAURI__;
}
function revealLabel() { return isWindowsHost() ? '在资源管理器中显示' : '在访达中显示'; }
function trashLabel()  { return isWindowsHost() ? '移到回收站' : '移到废纸篓'; }

function fsOp(payload) {
  try {
    if (window.webkit?.messageHandlers?.fsOp) {
      window.webkit.messageHandlers.fsOp.postMessage(payload);
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:fs-op', payload);
  } catch {}
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    showToast('路径已复制');
  } catch {
    // Clipboard API can be blocked outside user-gesture or in some webviews;
    // ask native to copy via the platform clipboard instead.
    fsOp({ op: 'copyPath', path });
  }
}

async function promptRename(node) {
  const dot = node.name.lastIndexOf('.');
  const stemEnd = dot > 0 ? dot : node.name.length;
  const v = await showModal({
    title: '重命名',
    input: { value: node.name, selectRange: [0, stemEnd] },
    confirmLabel: '重命名',
  });
  if (typeof v !== 'string') return;
  const newName = v.trim();
  if (!newName || newName === node.name) return;
  if (/[\\/]/.test(newName)) {
    showToast('名称不能包含 / 或 \\', 'error');
    return;
  }
  fsOp({ op: 'rename', path: node.path, newName });
}

async function promptCreate(parentDir, kind) {
  const placeholder = kind === 'file' ? 'untitled.md' : 'new-folder';
  const stemEnd = kind === 'file' && placeholder.lastIndexOf('.') > 0
    ? placeholder.lastIndexOf('.')
    : placeholder.length;
  const v = await showModal({
    title: kind === 'file' ? '新建文件' : '新建文件夹',
    input: { value: placeholder, selectRange: [0, stemEnd] },
    confirmLabel: '创建',
  });
  if (typeof v !== 'string') return;
  const name = v.trim();
  if (!name) return;
  if (/[\\/]/.test(name)) {
    showToast('名称不能包含 / 或 \\', 'error');
    return;
  }
  fsOp({
    op: kind === 'file' ? 'newFile' : 'newFolder',
    path: parentDir.path,
    newName: name,
  });
}

async function confirmDelete(node) {
  const ok = await showModal({
    title: trashLabel() + '？',
    message: `“${node.name}” 将被${trashLabel()}，你可以从那里恢复。`,
    confirmLabel: trashLabel(),
    danger: true,
  });
  if (!ok) return;
  fsOp({ op: 'delete', path: node.path });
}

// ===================================================================
// Context menu, modal, toast — minimal but theme-aware
// ===================================================================

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  for (const it of items) {
    if (it === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('div');
    btn.className = 'context-menu-item' + (it.danger ? ' danger' : '');
    btn.textContent = it.label;
    btn.addEventListener('click', () => { closeContextMenu(); it.action(); });
    menu.appendChild(btn);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  // Reposition if it overflows the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
    window.addEventListener('blur', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  document.querySelectorAll('.context-menu').forEach((m) => m.remove());
}

function showModal({ title, message, input, danger, confirmLabel, bodyNode, wide }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal-box' + (wide ? ' modal-box-wide' : '');

    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = title || '';
    box.appendChild(titleEl);

    if (message) {
      const msgEl = document.createElement('div');
      msgEl.className = 'modal-message';
      msgEl.textContent = message;
      box.appendChild(msgEl);
    }

    if (bodyNode) box.appendChild(bodyNode);

    let inputEl = null;
    if (input) {
      inputEl = document.createElement('input');
      inputEl.className = 'modal-input';
      inputEl.type = 'text';
      inputEl.value = input.value || '';
      box.appendChild(inputEl);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'modal-btn';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.className = 'modal-btn ' + (danger ? 'danger' : 'primary');
    confirm.textContent = confirmLabel || 'OK';
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    box.appendChild(actions);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    if (inputEl) {
      inputEl.focus();
      if (input.selectRange) {
        inputEl.setSelectionRange(input.selectRange[0], input.selectRange[1]);
      } else {
        inputEl.select();
      }
    } else {
      confirm.focus();
    }

    function close(value) {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(inputEl ? inputEl.value : true); }
    }
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close(inputEl ? inputEl.value : true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

// ===================================================================
// Easter egg — 遇事不决问春风~
// Random coin flip or dice roll, centered card, click anywhere to close.
// ===================================================================

// Dice — 18 sayings per face, themed around the number's symbolism.
const FORTUNE_DICE_SAYINGS = {
  1: [
    '一锤定音', '一往无前', '一鸣惊人', '一气呵成', '一帆风顺',
    '一举两得', '一夫当关', '独占鳌头', '一意孤行也无妨', '一个就够',
    '单枪匹马上', '万事开头难，但你能', '第一步迈出去', '孤注一掷', '一击必中',
    '一念之间', '一切刚刚好', '一切都来得及',
  ],
  2: [
    '好事成双', '双管齐下', '一举两得', '鱼与熊掌兼得', '两全其美',
    '二话不说，干', '进可攻退可守', '左右逢源', '两条路都通', '二人同心其利断金',
    '第二次机会来了', '别犹豫，二选一', '两手都要硬', '双喜临门', '二者必居其一',
    '两个选择，都行', '双倍幸运', '加倍奉还',
  ],
  3: [
    '三思后行', '三阳开泰', '事不过三', '三足鼎立', '三人行必有我师',
    '第三次试试，会成', '三天后再看', '三言两语说不清就行动', '三十六计走为上', '吾日三省吾身',
    '三生有幸', '三分天注定七分靠打拼', '三日不练手生', '一日不见如隔三秋', '三个臭皮匠顶一诸葛',
    '三月春风', '三两好友足矣', '三件事挑最重要的',
  ],
  4: [
    '四平八稳', '四通八达', '四海皆春', '安如磐石', '稳中求进',
    '四方来财', '四季常青', '一年四季都是好时节', '不偏不倚', '稳如老狗',
    '八面玲珑', '安然无恙', '心安四方', '四面来风', '四海为家',
    '站得稳走得远', '守正出奇', '不慌不忙',
  ],
  5: [
    '五福临门', '五星好评', '五彩缤纷', '五湖四海皆春', '五光十色',
    '五行俱足', '五马奔腾', '五体投地的运气', '五味俱全', '五子登科',
    '一举夺魁', '五星上将', '五颗星运势', '中五百万都不为过', '五年内必成',
    '满堂红', '福禄寿喜财', '五谷丰登',
  ],
  6: [
    '六六大顺', '顺风顺水', '一路绿灯', '六畜兴旺', '六合同春',
    '六根清净', '一切如愿', '时来运转', '旗开得胜', '万事顺意',
    '春风得意', '六字真言：随你心意', '一切顺遂', '心想事成', '大道至简',
    '顺势而为', '六亲不认地去做', '六六之运已到',
  ],
};

// Coin sides — 18 each. Heads leans into "go", tails leans into "wait".
const COIN_HEADS_SAYINGS = [
  '该出手时就出手',
  '干就完了',
  '现在就是好时机',
  '别犹豫，做',
  '直接上',
  '风顺，就走',
  '答应它',
  '大胆点',
  '你赢',
  '该 yes 的时候就 yes',
  '趁热打铁',
  '这步对了',
  '心动就行动',
  '这次靠谱',
  '没毛病，开干',
  '你说对的就是对的',
  '春风替你点了头',
  '冲',
];

const COIN_TAILS_SAYINGS = [
  '再想想吧',
  '缓一缓',
  '时机未到',
  '先放一放',
  '等等再说',
  '不急',
  '不必现在决定',
  '拒绝它',
  '再睡一觉看',
  '慢一点',
  '该 no 的时候就 no',
  '没风，别启航',
  '这次别勉强',
  '心里没底就别动',
  '不是时候',
  '让子弹再飞一会儿',
  '算了吧',
  '春风替你摇了头',
];

// Pip layout per face on a 3×3 grid. Standard western dice — opposite faces sum to 7.
const DICE_PIPS = {
  1: ['mc'],
  2: ['tl', 'br'],
  3: ['tl', 'mc', 'br'],
  4: ['tl', 'tr', 'bl', 'br'],
  5: ['tl', 'tr', 'mc', 'bl', 'br'],
  6: ['tl', 'ml', 'bl', 'tr', 'mr', 'br'],
};

// Face N → cube rotation that brings face N to the camera.
// CSS y-axis points down, so .dice-face-3 (rotateX(-90)) is on the bottom and
// .dice-face-4 (rotateX(+90)) is on the top — invert the X angles to bring
// each face's outward normal to +Z. Opposite pairs still sum to 7.
const DICE_FACE_TO_ROT = {
  1: { x: 0,   y: 0   },
  2: { x: 0,   y: -90 },
  3: { x: 90,  y: 0   },
  4: { x: -90, y: 0   },
  5: { x: 0,   y: 90  },
  6: { x: 0,   y: 180 },
};

// Lots — weighted toward the middle, mirroring an actual fortune-stick draw.
// Each tier carries 18 readings; pick one at random once the tier is drawn.
// Weights tuned so 上 > 中 > 下 — the tube tilts good. 上上 / 下下 stay rare.
//   上上=2  上=6  中=4  下=2  下下=1   →  53% 上+上上 / 27% 中 / 20% 下+下下
// Each tier carries an `interps` pool: today's fortune in plain language,
// always with a positive lean — even 下下 reads as "rest now, things will turn".
const FORTUNE_LOTS = [
  {
    tier: '上上签', weight: 2,
    sayings: [
      '万事顺心，今日好风扑面', '心想事成的一天', '桃花、贵人、好运齐到',
      '想做的都会成', '出门见喜', '满分上签',
      '春风得意马蹄疾', '一日看尽长安花', '锦上添花',
      '抬头三尺有神明', '福星高照', '紫气东来',
      '大吉大利', '鸿运当头', '阖家欢乐',
      '心愿成真', '好事自然来', '别怕，今天稳赢',
    ],
    interps: [
      '今日运势：诸事皆顺，做什么都有人接住',
      '今日运势：满分天，财运、桃花、贵人都站你这边',
      '今日运势：心想事成，记得把这份福气收下',
      '今日运势：抬头是阳光，低头是顺风，开干就完事',
      '今日运势：别犹豫，今天的运气配额特别足',
      '今日运势：连堵车都让路，到哪都不会被卡住',
      '今日运势：出门见喜，回家见礼',
      '今日运势：所求皆得，所愿皆成',
    ],
  },
  {
    tier: '上签', weight: 6,
    sayings: [
      '好风正起，沿着想做的事走', '努力会有回报', '该来的都会来',
      '一切都在变好', '顺水推舟', '守得云开见月明',
      '慢慢来都会有的', '你做的对', '拨云见日',
      '心安即是归处', '喜事将至', '春风正暖',
      '心情爽朗，事事顺利', '不急，正在路上', '你已在好转的路上',
      '好运还在路上', '努力会有回声', '该是你的跑不掉',
    ],
    interps: [
      '今日运势：风正起，事顺心，去做想做的事就好',
      '今日运势：付出会被看见，等的人也快到了',
      '今日运势：好事一件接一件，留点期待感',
      '今日运势：心情松了，事情自然就顺了',
      '今日运势：贵人在身边，多说几句没坏处',
      '今日运势：手头的事会有进展，别急',
      '今日运势：今天适合往前走一小步',
      '今日运势：好运在路上，再耐心一点',
    ],
  },
  {
    tier: '中签', weight: 4,
    sayings: [
      '不急不躁，按部就班即可', '平平淡淡才是真', '别问结果，先做事',
      '不好不坏，刚刚好', '守着初心做就行', '维持现状也不错',
      '一切如常', '走得稳一点', '不上不下，刚好',
      '中规中矩', '平安即是福', '别折腾',
      '顺其自然', '稳一点', '守正待时',
      '当下足矣', '该来的会来', '平常心',
    ],
    interps: [
      '今日运势：稳，按部就班来就好',
      '今日运势：无大喜也无大悲，舒服一天',
      '今日运势：把今天平平稳稳过完就是赢',
      '今日运势：维持现状是上策，明天再图变化',
      '今日运势：日子刚刚好，别加戏',
      '今日运势：守得住就有小收获',
      '今日运势：不咸不淡，做完手上的事就够',
      '今日运势：今天适合静下心，不必折腾',
    ],
  },
  {
    tier: '下签', weight: 2,
    sayings: [
      '稳一点，今日不宜冒进', '三思而后行', '谨慎行事',
      '退一步海阔天空', '今日宜守', '不宜出远门',
      '不宜签字', '不宜表白', '凡事多忍让',
      '静观其变', '缓行', '不宜决断',
      '风太大，先归来', '这事儿先放一放', '今天先收一收',
      '量力而行', '别贪', '退也是一种进',
    ],
    interps: [
      '今日运势：风有点大，今天先歇歇，明天会放晴',
      '今日运势：小事别上心，大事缓一缓',
      '今日运势：今天宜静，运气会在明天悄悄回来',
      '今日运势：少说少做，把麻烦攒到明天一起处理',
      '今日运势：今天累的，明天会双倍补给你',
      '今日运势：不顺只是暂时的，下午会好转',
      '今日运势：今日宜守，明日宜攻',
      '今日运势：少决策、多观察，运气在调整方向',
    ],
  },
  {
    tier: '下下签', weight: 1,
    sayings: [
      '今日先歇着，明日再战', '闭门思过', '大凶之兆，不出门为妙',
      '今天宜：什么都不做', '早点睡', '万事不宜',
      '今天的事留给明天', '别签、别买、别答应', '停',
      '退而结网', '来日再来', '春风不渡此关',
      '不动为吉', '大忌：争辩', '大忌：消费',
      '大忌：表态', '听别人的别听自己的', '装睡，最好',
    ],
    interps: [
      '今日运势：今天先歇着，明天就有春风',
      '今日运势：糟心事到此为止，明天重新开始',
      '今日运势：今日宜：装睡。明日宜：重启',
      '今日运势：哪有什么下下签，只是提醒你早点睡',
      '今日运势：今天宇宙在测试你，过了就是大涨',
      '今日运势：歇一歇，运气在路上充电',
      '今日运势：闭门一日，明日开运',
      '今日运势：今天的负能量，睡一觉就清零',
    ],
  },
];

// 1..100 → 一..一百 in plain Chinese numerals (for stick numbers).
// Temple-stick numerals — uses 廿 (20s) and 卅 (30s) like real fortune sticks.
function toChineseNum(n) {
  const d = ['零','一','二','三','四','五','六','七','八','九'];
  if (n <= 0) return d[0];
  if (n < 10) return d[n];
  if (n === 100) return '百';
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (tens === 1) return ones === 0 ? '十' : '十' + d[ones];
  if (tens === 2) return ones === 0 ? '廿' : '廿' + d[ones];
  if (tens === 3) return ones === 0 ? '卅' : '卅' + d[ones];
  if (ones === 0) return d[tens] + '十';
  return d[tens] + '十' + d[ones];
}

// 108 — 暗合佛家烦恼数；分八组写在源码里方便往后补，运行时仍是一只扁平数组。
const FORTUNE_SAYINGS = [
  // —— 原版 12 条 ——
  '今天的风很适合做决定',
  '想做的事就去做，别等春风过境',
  '事缓则圆，急事不要急办',
  '心里没底的事，先睡一觉再想',
  '问就是 yes',
  '问就是 no',
  '别问了，去做',
  '相信第一直觉',
  '坐下喝杯茶再说',
  '今日宜：摸鱼。今日忌：内耗',
  '没人催你，你自己别催自己',
  '差不多就行，别把它做完美',

  // —— 决断 ——
  '想清楚再动，比动了再想清楚省力',
  '你已经知道答案，只是想找个人附和',
  '不知道答案就先不动',
  '直觉错过两次，第三次就听它的',
  '二选一，选当下让你放松的那个',
  '列三条优先级，先做第一条',
  '删掉清单里最不想做的那条',
  '待办太多时，只保留三条',
  '别问值不值得，先做着',
  '把"以后再说"换成"现在做五分钟"',
  '写下来，问题就消了一半',
  '走着走着就清楚了',

  // —— 缓行 ——
  '慢慢来比较快',
  '越急越慢',
  '一次只做一件事',
  '让子弹再飞一会儿',
  '这事先放一放，让它发酵',
  '把它交给明天的自己',
  '三天后再回头看，你会笑',
  '这事儿，明年的你不会记得',
  '顺其自然，但要先尽人事',
  '尽人事，听天命',
  '该来的会来，该走的会走',
  '风会替你做决定，如果你愿意听',

  // —— 宜忌 ——
  '今日宜：发呆。今日忌：开会',
  '今日宜：散步。今日忌：刷手机',
  '今日宜：早睡。今日忌：emo',
  '今日宜：见朋友。今日忌：自我怀疑',
  '今日宜：动手做。今日忌：再等等',
  '今日宜：说"不"。今日忌：硬撑',
  '今日宜：说"是"。今日忌：再想想',
  '今日宜：留白。今日忌：填满',
  '今日宜：写字。今日忌：发消息',
  '今日宜：独处。今日忌：合群',
  '今日宜：复盘。今日忌：自责',
  '今日宜：放空。今日忌：纠结',

  // —— 自处 ——
  '你不是机器，可以休息',
  '你不是石头，可以改变主意',
  '改主意不是失败',
  '不做也是一种选择',
  '拒绝也是一种回答',
  '沉默不是逃避，是缓冲',
  '不必每个人都喜欢你',
  '不必每件事都做对',
  '错了就改，没什么大不了',
  '把自己当朋友劝一句',
  '别让"应该"压过"想要"',
  '也别让"想要"挤掉"必要"',

  // —— 行动 ——
  '行动比想象便宜',
  '完成大于完美',
  '60 分就交卷',
  '先做手上能立刻开始的那一步',
  '不必喜欢它，做完就行',
  '把手边的事先做完',
  '不必证明，做出来给他看',
  '别再开会了，去做吧',
  '出门走十分钟',
  '关掉通知，专心一会儿',
  '把手机扔远一点',
  '今日只做一件正事',

  // —— 时机 ——
  '今天不适合做大决定',
  '今天就是要做大决定的日子',
  '别在凌晨三点做选择',
  '别在周一早上下结论',
  '别在周五下午开新坑',
  '别空着肚子做决定',
  '答应之前，查一下日历',
  '在拒绝之前，再问自己一次',
  '在答应之前，再问自己一次',
  '这个想法值得保留，但不是现在',
  '时机比努力重要',
  '现在不是时候，但快了',

  // —— 生活 ——
  '抬头看看天',
  '听听窗外的风',
  '喝口水，再说',
  '喝口热的',
  '吃点东西再决定',
  '把窗户打开一会儿',
  '该上的班还是要上',
  '该请的假就请',
  '该躺平就躺平',
  '该卷的时候卷一下',
  '你已经做得不错了',
  '你今天已经够努力了',

  // —— 放下 ——
  '这事儿值得你皱眉吗',
  '把"为什么是我"换成"那就我吧"',
  '与其纠结过去，不如计划明天',
  '与其规划明天，不如先把今天过完',
  '道个歉，向前走',
  '已读不回也是一种态度',
  '别问春风，问自己',
  '答案在你心里，不在春风这儿',
  '不必每件事都有答案',
  '今天到此为止',
  '早点睡，明天有春风',
  '遇事不决，问春风',
];

function weightedPick(items) {
  const total = items.reduce((s, it) => s + (it.weight || 1), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= (it.weight || 1);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

const FORTUNE_TITLES = {
  coin:   '抛 · 硬 · 币',
  dice:   '摇 · 骰 · 子',
  lots:   '抽 · 签',
  saying: '春 · 风 · 一 · 句',
};

function showFortune(kind) {
  if (document.querySelector('.fortune-overlay')) return; // already open
  switch (kind) {
    case 'dice':   return stageDiceRoll();
    case 'lots':   return stageLotsDraw();
    case 'saying': return stageSpringSaying();
    case 'coin':
    default:       return stageCoinFlip();
  }
}

// Per-kind overlay shell. The overlay catches background clicks unless a child
// stops propagation. Each stager pushes its WAAPI animations / timers into
// `cancellers` so close() tears them down cleanly.
function buildFortuneOverlay(kind) {
  const overlay = document.createElement('div');
  overlay.className = 'fortune-overlay';
  overlay.setAttribute('data-kind', kind);
  document.body.appendChild(overlay);

  const cancellers = [];
  function close() {
    cancellers.forEach((fn) => { try { fn(); } catch {} });
    overlay.remove();
  }
  return { overlay, close, cancellers };
}

// Render `text` into `el` glyph by glyph — each character fades + un-blurs in,
// like ink reaching the page. Used for lots / saying reveals.
function inkWrite(el, text, opts) {
  const o = opts || {};
  const delayPer = o.delayPer != null ? o.delayPer : 80;
  const startDelay = o.startDelay != null ? o.startDelay : 0;
  const charDur = o.charDur != null ? o.charDur : 240;
  el.textContent = '';
  const chars = Array.from(text);
  const anims = [];
  chars.forEach((c, i) => {
    const s = document.createElement('span');
    s.className = 'ink-char';
    s.textContent = c === ' ' ? ' ' : c;
    s.style.opacity = '0';
    el.appendChild(s);
    const a = s.animate(
      [
        { opacity: 0, transform: 'translateY(5px) scale(1.06)', filter: 'blur(1.5px)' },
        { opacity: 1, transform: 'translateY(0) scale(1)',     filter: 'blur(0)'    },
      ],
      { duration: charDur, delay: startDelay + i * delayPer, easing: 'ease-out', fill: 'forwards' }
    );
    anims.push(a);
  });
  return {
    totalMs: startDelay + chars.length * delayPer + charDur,
    cancel: () => anims.forEach((a) => { try { a.cancel(); } catch {} }),
  };
}

// Reveal the result line + dismiss hint, styled to the kind: coin stamps in,
// dice shakes, lots and saying write stroke by stroke.
function revealFortune(resultEl, hintEl, text, kind) {
  resultEl.classList.add('show');
  if (kind === 'lots' || kind === 'saying') {
    const out = inkWrite(resultEl, text, { delayPer: 80, charDur: 240 });
    setTimeout(() => hintEl.classList.add('show'), Math.max(380, out.totalMs - 240));
    return;
  }
  resultEl.textContent = text;
  if (kind === 'dice') {
    resultEl.animate(
      [
        { opacity: 0, transform: 'translateX(0)' },
        { opacity: 1, transform: 'translateX(-6px)', offset: 0.25 },
        { opacity: 1, transform: 'translateX(5px)',  offset: 0.5  },
        { opacity: 1, transform: 'translateX(-3px)', offset: 0.75 },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 520, easing: 'cubic-bezier(0.45, 0, 0.3, 1)', fill: 'forwards' }
    );
  } else {
    // coin — stamp.
    resultEl.animate(
      [
        { opacity: 0, transform: 'translateY(12px) scale(1.08)', letterSpacing: '0.32em' },
        { opacity: 1, transform: 'translateY(0) scale(1)',       letterSpacing: '0.04em' },
      ],
      { duration: 400, easing: 'cubic-bezier(0.16, 1.2, 0.36, 1)', fill: 'forwards' }
    );
  }
  setTimeout(() => hintEl.classList.add('show'), 380);
}

// === Coin: flies from the sidebar ❀ button into the card stage, lands, ripples. ===
function stageCoinFlip() {
  const { overlay, close, cancellers } = buildFortuneOverlay('coin');

  const card = document.createElement('div');
  card.className = 'fortune-card';
  card.innerHTML =
    '<div class="fortune-title">抛 · 硬 · 币</div>' +
    '<div class="fortune-stage"></div>' +
    '<div class="fortune-result"></div>' +
    '<div class="fortune-hint">再 点 散 场</div>';
  overlay.appendChild(card);

  const stage = card.querySelector('.fortune-stage');
  const resultEl = card.querySelector('.fortune-result');
  const hintEl = card.querySelector('.fortune-hint');

  const heads = Math.random() < 0.5;
  const flips = 5 + Math.floor(Math.random() * 2);
  const endRot = flips * 360 + (heads ? 0 : 180);

  const flyer = document.createElement('div');
  flyer.className = 'coin-flyer';
  flyer.innerHTML =
    '<div class="coin">' +
      '<div class="coin-face coin-front">正</div>' +
      '<div class="coin-face coin-back">反</div>' +
    '</div>' +
    '<div class="coin-ripple"></div>';
  overlay.appendChild(flyer);

  // Layout-dependent coords come after the card has been laid out.
  requestAnimationFrame(() => {
    const btn = document.getElementById('sb-fortune-btn');
    let bx, by;
    if (btn) {
      const r = btn.getBoundingClientRect();
      bx = r.left + r.width / 2;
      by = r.top + r.height / 2;
    }
    if (!bx || !by) {
      bx = window.innerWidth / 2;
      by = window.innerHeight - 80;
    }
    const sr = stage.getBoundingClientRect();
    const tx = sr.left + sr.width / 2;
    const ty = sr.top + sr.height / 2;

    flyer.style.left = bx + 'px';
    flyer.style.top  = by + 'px';

    const dx = tx - bx;
    const dy = ty - by;
    const midX = dx / 2;
    const midY = Math.min(0, dy) - 160; // arc peak

    // Translate + scale animate the flyer (no 3D needed). The rotateX flip
    // must live on .coin (which has transform-style: preserve-3d) so the two
    // faces' backface-visibility actually does its job — otherwise the flyer's
    // rotation flattens .coin to 2D first and you end up seeing an upside-down
    // "正" instead of the "反" you'd expect.
    const flyAnim = flyer.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.45)' },
        { transform: `translate(calc(-50% + ${midX}px), calc(-50% + ${midY}px)) scale(0.85)`,        offset: 0.5  },
        { transform: `translate(calc(-50% + ${dx}px),   calc(-50% + ${dy - 8}px)) scale(1)`,         offset: 0.86 },
        { transform: `translate(calc(-50% + ${dx}px),   calc(-50% + ${dy + 2}px)) scale(1.06, 0.92)`, offset: 0.94 },
        { transform: `translate(calc(-50% + ${dx}px),   calc(-50% + ${dy}px))     scale(1)`           },
      ],
      { duration: 1150, easing: 'cubic-bezier(0.33, 0.06, 0.45, 1.05)', fill: 'forwards' }
    );
    cancellers.push(() => { try { flyAnim.cancel(); } catch {} });

    const coin = flyer.querySelector('.coin');
    const flipAnim = coin.animate(
      [
        { transform: 'rotateX(0deg)' },
        { transform: `rotateX(${endRot * 0.45}deg)`, offset: 0.5  },
        { transform: `rotateX(${endRot}deg)`,        offset: 0.86 },
        { transform: `rotateX(${endRot}deg)`,        offset: 1    },
      ],
      { duration: 1150, easing: 'cubic-bezier(0.33, 0.06, 0.45, 1.05)', fill: 'forwards' }
    );
    cancellers.push(() => { try { flipAnim.cancel(); } catch {} });

    const ripple = flyer.querySelector('.coin-ripple');
    const land = setTimeout(() => {
      const ra = ripple.animate(
        [
          { opacity: 0.65, transform: 'translate(-50%, -50%) scale(0.35)' },
          { opacity: 0,    transform: 'translate(-50%, -50%) scale(2.8)' },
        ],
        { duration: 560, easing: 'ease-out', fill: 'forwards' }
      );
      cancellers.push(() => { try { ra.cancel(); } catch {} });

      const pool = heads ? COIN_HEADS_SAYINGS : COIN_TAILS_SAYINGS;
      const saying = pool[Math.floor(Math.random() * pool.length)];
      revealFortune(resultEl, hintEl, `${heads ? '正面' : '反面'} · ${saying}`, 'coin');
    }, 1100);
    cancellers.push(() => clearTimeout(land));
  });

  overlay.addEventListener('click', close);
}

// Scatter `count` short-lived dust motes radially from the dice's landing
// point. Each mote is absolutely positioned in `stage` and self-removes when
// its animation ends; if the overlay closes early, removing `stage` cancels
// the WAAPI handles automatically.
function spawnDust(stage, count) {
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'dice-dust';
    stage.appendChild(p);
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const dist = 22 + Math.random() * 24;
    const dx = Math.cos(angle) * dist;
    // Bias upward arc so motes don't sink — feels like ground dust kicked up.
    const dy = -Math.abs(Math.sin(angle)) * dist * 0.45 + 3;
    const dur = 420 + Math.random() * 220;
    const a = p.animate(
      [
        { transform: 'translate(-50%, 0)                            scale(1)',    opacity: 0.85 },
        { transform: `translate(calc(-50% + ${dx}px), ${dy}px) scale(0.25)`, opacity: 0    },
      ],
      { duration: dur, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)', fill: 'forwards' }
    );
    a.onfinish = () => p.remove();
  }
}

// === Dice: in-content infinite tumble. Click / Space / Enter to stop; Esc dismisses. ===
function stageDiceRoll() {
  const { overlay, close, cancellers } = buildFortuneOverlay('dice');

  // Stage holds the cube + its ground shadow so the shadow can stay anchored
  // while the cube bobs above it.
  const stage = document.createElement('div');
  stage.className = 'dice-stage';
  overlay.appendChild(stage);

  const cube = document.createElement('div');
  cube.className = 'dice-cube';
  for (let value = 1; value <= 6; value++) {
    const face = document.createElement('div');
    face.className = `dice-face dice-face-${value}`;
    for (const area of DICE_PIPS[value]) {
      const pip = document.createElement('span');
      pip.className = 'dice-pip';
      pip.style.gridArea = area;
      face.appendChild(pip);
    }
    cube.appendChild(face);
  }

  const cubeWrap = document.createElement('div');
  cubeWrap.className = 'dice-wrap dice-wrap-free';
  cubeWrap.appendChild(cube);
  stage.appendChild(cubeWrap);

  const shadow = document.createElement('div');
  shadow.className = 'dice-shadow';
  stage.appendChild(shadow);

  const prompt = document.createElement('div');
  prompt.className = 'dice-prompt';
  prompt.textContent = '点  击  停  止';
  overlay.appendChild(prompt);

  // Entrance: cube drops in from above with a small overshoot. Spin starts
  // immediately on the cube; the wrap-level bob waits for entrance to finish
  // so the two cubeWrap animations don't fight.
  const ENTER_MS = 360;
  const enterAnim = cubeWrap.animate(
    [
      { transform: 'translateY(-42px) scale(0.45)', opacity: 0.4 },
      { transform: 'translateY(2px)   scale(1.06)', opacity: 1,   offset: 0.7 },
      { transform: 'translateY(0px)   scale(1)',    opacity: 1,   offset: 1   },
    ],
    { duration: ENTER_MS, easing: 'cubic-bezier(0.34, 1.3, 0.5, 1)', fill: 'forwards' }
  );
  cancellers.push(() => { try { enterAnim.cancel(); } catch {} });

  // Tumble. Non-commensurate axis ratios + faster cycle so it whirs instead
  // of marching. WAAPI (not CSS keyframes) lets us read the animation's
  // progress at stop time and continue smoothly into the settle anim.
  const CYCLE = 1800;
  const rateX = 1.4, rateY = 1.85, rateZ = 0.83;
  const spinAnim = cube.animate(
    [
      { transform: 'rotateX(0deg) rotateY(0deg) rotateZ(0deg)' },
      { transform: `rotateX(${360 * rateX}deg) rotateY(${360 * rateY}deg) rotateZ(${360 * rateZ}deg)` },
    ],
    { duration: CYCLE, iterations: Infinity, easing: 'linear' }
  );
  cancellers.push(() => { try { spinAnim.cancel(); } catch {} });

  // Gentle bob + faint sway — sells the "tossed in palm" feel. Sway period
  // is intentionally off from bob so the motion never repeats cleanly.
  const bobAnim = cubeWrap.animate(
    [
      { transform: 'translate(0px,  0px)' },
      { transform: 'translate(1.5px, -6px)', offset: 0.5 },
      { transform: 'translate(-1px, 0px)',   offset: 1   },
    ],
    { duration: 1500, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: ENTER_MS }
  );
  cancellers.push(() => { try { bobAnim.cancel(); } catch {} });
  const shadowAnim = shadow.animate(
    [
      { transform: 'translateX(-50%) scale(1, 1)',    opacity: 0.55 },
      { transform: 'translateX(-50%) scale(0.74, 1)', opacity: 0.30 },
      { transform: 'translateX(-50%) scale(1, 1)',    opacity: 0.55 },
    ],
    { duration: 1500, iterations: Infinity, easing: 'ease-in-out', delay: ENTER_MS }
  );
  cancellers.push(() => { try { shadowAnim.cancel(); } catch {} });

  let phase = 'spinning'; // → 'stopping' → 'shown'
  const startedAt = performance.now();
  // Wait until entrance settles so a stop never freezes mid-drop-in. Also
  // shrugs off the trailing mouseup from the menu click that opened us.
  const INPUT_LOCKOUT_MS = ENTER_MS + 40;

  // pickSettle: from `cur` angle, advance to a multiple of 360 plus the face
  // target offset, with at least one extra full rotation for visual settle.
  function pickSettle(cur, targetMod) {
    const t = ((targetMod % 360) + 360) % 360;
    const curMod = ((cur % 360) + 360) % 360;
    let delta = t - curMod;
    if (delta < 0) delta += 360;
    return cur + delta + 360;
  }

  function tryStop() {
    if (phase !== 'spinning') return;
    if (performance.now() - startedAt < INPUT_LOCKOUT_MS) return;
    phase = 'stopping';

    const t = (spinAnim.currentTime || 0) % CYCLE;
    const progress = t / CYCLE;
    const curX = 360 * rateX * progress;
    const curY = 360 * rateY * progress;
    const curZ = 360 * rateZ * progress;
    try { spinAnim.cancel(); } catch {}
    try { bobAnim.cancel(); } catch {}
    try { shadowAnim.cancel(); } catch {}

    const n = 1 + Math.floor(Math.random() * 6);
    const target = DICE_FACE_TO_ROT[n];
    const settleX = pickSettle(curX, target.x);
    const settleY = pickSettle(curY, target.y);
    const settleZ = pickSettle(curZ, 0);

    const STOP_MS = 780;
    const stopAnim = cube.animate(
      [
        { transform: `rotateX(${curX}deg) rotateY(${curY}deg) rotateZ(${curZ}deg)` },
        { transform: `rotateX(${settleX}deg) rotateY(${settleY}deg) rotateZ(${settleZ}deg)` },
      ],
      { duration: STOP_MS, easing: 'cubic-bezier(0.18, 0.6, 0.22, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { stopAnim.cancel(); } catch {} });

    // Drop + impact squash + rebound, baked into a single animation on the wrap
    // so we never have two transforms fighting on the same element.
    const dropAnim = cubeWrap.animate(
      [
        { transform: 'translateY(-5px) scale(1, 1)',       offset: 0    },
        { transform: 'translateY(0px)  scale(1, 1)',       offset: 0.55 },
        { transform: 'translateY(2px)  scale(1.12, 0.84)', offset: 0.68 },
        { transform: 'translateY(0px)  scale(0.96, 1.06)', offset: 0.82 },
        { transform: 'translateY(0px)  scale(1, 1)',       offset: 1    },
      ],
      { duration: STOP_MS, easing: 'cubic-bezier(0.35, 0.05, 0.2, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { dropAnim.cancel(); } catch {} });

    // Shadow sharpens + darkens as the cube lands.
    const shadowSettle = shadow.animate(
      [
        { transform: 'translateX(-50%) scale(0.78, 1)', opacity: 0.32, filter: 'blur(6px)' },
        { transform: 'translateX(-50%) scale(1.12, 1)', opacity: 0.62, filter: 'blur(3px)' },
      ],
      { duration: STOP_MS, easing: 'cubic-bezier(0.35, 0.05, 0.2, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { shadowSettle.cancel(); } catch {} });

    prompt.classList.add('hide');

    // Impact: stage rumble + scattered dust right when squash hits its peak.
    // Squash peaks at offset 0.68 of STOP_MS.
    const impactDelay = Math.round(STOP_MS * 0.68);
    const impact = setTimeout(() => {
      const rumble = stage.animate(
        [
          { transform: 'translate(0, 0)' },
          { transform: 'translate(1.5px, -1px)', offset: 0.18 },
          { transform: 'translate(-1.5px, 1px)', offset: 0.42 },
          { transform: 'translate(0.8px, 0)',    offset: 0.66 },
          { transform: 'translate(-0.6px, 0)',   offset: 0.84 },
          { transform: 'translate(0, 0)',        offset: 1    },
        ],
        { duration: 220, easing: 'linear', fill: 'forwards' }
      );
      cancellers.push(() => { try { rumble.cancel(); } catch {} });
      spawnDust(stage, 8);
    }, impactDelay);
    cancellers.push(() => clearTimeout(impact));

    // After settle, lift the cube up so the result card flows in below. The
    // dice face itself reveals N — no separate numeric badge needed. A small
    // Z-tilt makes the lift feel like the die is being held up for display.
    const reveal = setTimeout(() => {
      const lift = cubeWrap.animate(
        [
          { transform: 'translateY(0)     scale(1)    rotate(0deg)' },
          { transform: 'translateY(-32px) scale(0.68) rotate(-7deg)' },
        ],
        { duration: 380, easing: 'cubic-bezier(0.33, 0, 0.4, 1)', fill: 'forwards' }
      );
      cancellers.push(() => { try { lift.cancel(); } catch {} });

      const shadowFade = shadow.animate(
        [
          { opacity: 0.6 },
          { opacity: 0.12 },
        ],
        { duration: 360, easing: 'ease-out', fill: 'forwards' }
      );
      cancellers.push(() => { try { shadowFade.cancel(); } catch {} });

      const card = document.createElement('div');
      card.className = 'fortune-card dice-card';
      const pool = FORTUNE_DICE_SAYINGS[n] || [];
      const saying = pool[Math.floor(Math.random() * pool.length)] || '';
      card.innerHTML =
        '<div class="fortune-result"></div>' +
        '<div class="fortune-hint">再 点 散 场</div>';
      overlay.appendChild(card);

      const resultEl = card.querySelector('.fortune-result');
      const hintEl = card.querySelector('.fortune-hint');

      // .dice-card has translateX(-50%) baked in via CSS; keep it in every
      // keyframe so the animation doesn't drift it off-center.
      const cardIn = card.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 14px)' },
          { opacity: 1, transform: 'translate(-50%, 0)' },
        ],
        { duration: 320, easing: 'cubic-bezier(0.16, 1.0, 0.36, 1)', fill: 'forwards' }
      );
      cancellers.push(() => { try { cardIn.cancel(); } catch {} });

      revealFortune(resultEl, hintEl, saying, 'dice');
      phase = 'shown';
    }, STOP_MS + 120);
    cancellers.push(() => clearTimeout(reveal));
  }

  function onClick() {
    if (phase === 'spinning') tryStop();
    else if (phase === 'shown') close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
      e.preventDefault();
      if (phase === 'spinning') tryStop();
      else if (phase === 'shown') close();
    }
  }

  overlay.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  cancellers.push(() => document.removeEventListener('keydown', onKey));
}

// === Lots: 7 sticks spread into a fan, user clicks one to pick. ===
function stageLotsDraw() {
  const { overlay, close, cancellers } = buildFortuneOverlay('lots');

  const prompt = document.createElement('div');
  prompt.className = 'lots-prompt';
  prompt.textContent = '点  击  摇  签';
  overlay.appendChild(prompt);

  // Bamboo tube with sticks visible at the top, a wood rim, and a soft shadow.
  const tubeWrap = document.createElement('div');
  tubeWrap.className = 'lots-tube-wrap';

  const tube = document.createElement('div');
  tube.className = 'lots-tube';

  const stickRow = document.createElement('div');
  stickRow.className = 'lots-tube-sticks';
  // Visible stick tops poking out of the tube — varied heights look hand-loaded.
  [38, 52, 44, 60, 48, 40, 56].forEach((h) => {
    const s = document.createElement('span');
    s.style.height = h + '%';
    stickRow.appendChild(s);
  });
  tube.appendChild(stickRow);

  const grain = document.createElement('div');
  grain.className = 'lots-tube-grain';
  tube.appendChild(grain);

  const rim = document.createElement('div');
  rim.className = 'lots-tube-rim';
  tube.appendChild(rim);

  const tubeShadow = document.createElement('div');
  tubeShadow.className = 'lots-tube-shadow';

  tubeWrap.appendChild(tube);
  tubeWrap.appendChild(tubeShadow);
  overlay.appendChild(tubeWrap);

  let phase = 'waiting'; // → 'shaking' → 'shown'

  function shakeAndDraw() {
    prompt.classList.add('hide');
    tube.classList.add('shaking');

    const shakeDur = 720 + Math.floor(Math.random() * 200);
    const stop = setTimeout(() => {
      tube.classList.remove('shaking');
      drawStick();
    }, shakeDur);
    cancellers.push(() => clearTimeout(stop));
  }

  function drawStick() {
    const lot = weightedPick(FORTUNE_LOTS);
    const sayings = lot.sayings || [''];
    const saying = sayings[Math.floor(Math.random() * sayings.length)];
    const interps = lot.interps || [''];
    const interp = interps[Math.floor(Math.random() * interps.length)];
    const number = 1 + Math.floor(Math.random() * 100);
    const numCh = toChineseNum(number);

    // The chosen stick rises out of the tube into a clear plaque above it.
    // Tier on top, stick number below — bold horizontal text so they read at
    // a glance. Final rise offset is small so the plaque stays on-screen.
    const stick = document.createElement('div');
    stick.className = 'lots-rising-stick';
    stick.innerHTML =
      `<div class="lots-rising-tier">${Array.from(lot.tier).join(' ')}</div>` +
      '<div class="lots-rising-divider"></div>' +
      `<div class="lots-rising-num">第 ${numCh} 号</div>`;
    tubeWrap.appendChild(stick);

    const riseAnim = stick.animate(
      [
        { transform: 'translate(-50%, 100%) scale(0.78)', opacity: 0 },
        { transform: 'translate(-50%, 30%)  scale(0.96)', opacity: 1, offset: 0.45 },
        { transform: 'translate(-50%, -18%) scale(1.04)', opacity: 1, offset: 0.78 },
        { transform: 'translate(-50%, -10%) scale(1)',    opacity: 1 },
      ],
      { duration: 780, easing: 'cubic-bezier(0.18, 0.78, 0.22, 1.05)', fill: 'forwards' }
    );
    cancellers.push(() => { try { riseAnim.cancel(); } catch {} });

    // After the stick reaches its resting spot, slide the tube + plaque left
    // and surface the saying on an aged paper bookmark on the right side,
    // plus interp + hint below.
    const reveal = setTimeout(() => {
      overlay.classList.add('revealed');

      const scroll = document.createElement('div');
      scroll.className = 'lots-scroll';
      scroll.innerHTML =
        '<div class="lots-scroll-rod lots-scroll-rod-top"></div>' +
        '<div class="lots-scroll-paper">' +
          '<div class="fortune-result lots-scroll-text"></div>' +
        '</div>' +
        '<div class="lots-scroll-rod lots-scroll-rod-bottom"></div>';
      overlay.appendChild(scroll);

      const interpEl = document.createElement('div');
      interpEl.className = 'fortune-result lots-interp-text';
      const hint = document.createElement('div');
      hint.className = 'fortune-hint';
      hint.textContent = '轻 点 散 场';
      overlay.appendChild(interpEl);
      overlay.appendChild(hint);

      // Scroll slides up + fades in (resting position is right of viewport center).
      const scrollIn = scroll.animate(
        [
          { opacity: 0, transform: 'translate(calc(-50% + 110px), calc(-50% + 22px)) scale(0.94)' },
          { opacity: 1, transform: 'translate(calc(-50% + 110px), -50%) scale(1)' },
        ],
        { duration: 420, easing: 'cubic-bezier(0.18, 0.78, 0.22, 1.05)', fill: 'forwards' }
      );
      cancellers.push(() => { try { scrollIn.cancel(); } catch {} });

      // Brush-write the saying down the paper, then the interp horizontally
      // below, then surface the dismiss hint.
      const sayingEl = scroll.querySelector('.lots-scroll-text');
      const sayStart = setTimeout(() => {
        sayingEl.classList.add('show');
        const sayOut = inkWrite(sayingEl, saying, { delayPer: 105, charDur: 280 });
        cancellers.push(sayOut.cancel);

        const interpStart = setTimeout(() => {
          interpEl.classList.add('show');
          const intOut = inkWrite(interpEl, interp, { delayPer: 55, charDur: 220 });
          cancellers.push(intOut.cancel);
          const hintShow = setTimeout(() => hint.classList.add('show'), intOut.totalMs + 100);
          cancellers.push(() => clearTimeout(hintShow));
        }, sayOut.totalMs + 240);
        cancellers.push(() => clearTimeout(interpStart));
      }, 280);
      cancellers.push(() => clearTimeout(sayStart));

      phase = 'shown';
    }, 760);
    cancellers.push(() => clearTimeout(reveal));
  }

  function onClick() {
    if (phase === 'waiting') {
      phase = 'shaking';
      shakeAndDraw();
    } else if (phase === 'shown') {
      close();
    }
    // 'shaking' phase ignores clicks
  }

  overlay.addEventListener('click', onClick);
}

// === Saying: paper messenger flies in, unfolds into a letter, ink writes. ===
function stageSpringSaying() {
  const { overlay, close, cancellers } = buildFortuneOverlay('saying');

  const crane = document.createElement('div');
  crane.className = 'paper-crane';
  crane.innerHTML =
    '<div class="paper-crane-wing paper-crane-wing-l"></div>' +
    '<div class="paper-crane-wing paper-crane-wing-r"></div>' +
    '<div class="paper-crane-body"></div>';
  overlay.appendChild(crane);

  const PETAL_GLYPHS = ['❀', '✿', '❁', '✾'];
  const PETAL_COLORS = ['#f7a6c1', '#fbc4d3', '#ef9bb6', '#f9c8d6'];
  for (let i = 0; i < 4; i++) {
    const p = document.createElement('span');
    p.className = 'breeze-petal breeze-petal-overlay';
    p.textContent = PETAL_GLYPHS[i % PETAL_GLYPHS.length];
    p.style.color = PETAL_COLORS[i % PETAL_COLORS.length];
    p.style.fontSize = `${14 + Math.random() * 10}px`;
    overlay.appendChild(p);

    const dx = -8 + Math.random() * 16;
    const dy = -4 + Math.random() * 8;
    const dur = 2000 + Math.random() * 700;
    const delay = 220 + i * 140;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 240);

    const a = p.animate(
      [
        { transform: `translate(40vw, -12vh) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${dx}vw, ${dy}vh) rotate(${spin * 0.5}deg)`, opacity: 0.95, offset: 0.55 },
        { transform: `translate(${dx - 28}vw, ${dy + 14}vh) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: dur, delay, easing: 'cubic-bezier(0.4, 0.06, 0.55, 0.95)', fill: 'forwards' }
    );
    cancellers.push(() => { try { a.cancel(); } catch {} });
  }

  // Crane flies in S-curve from off-screen top-right to overlay center.
  const flyAnim = crane.animate(
    [
      { transform: 'translate(-50%, -50%) translate(48vw, -32vh) rotate(38deg) scale(0.65)', opacity: 0 },
      { transform: 'translate(-50%, -50%) translate(22vw, -6vh)  rotate(18deg) scale(0.88)', opacity: 1, offset: 0.4 },
      { transform: 'translate(-50%, -50%) translate(-8vw, 8vh)   rotate(-10deg) scale(0.96)', opacity: 1, offset: 0.74 },
      { transform: 'translate(-50%, -50%) translate(0, 0)         rotate(0deg)  scale(1)',   opacity: 1 },
    ],
    { duration: 1400, easing: 'cubic-bezier(0.36, 0.02, 0.4, 1)', fill: 'forwards' }
  );
  cancellers.push(() => { try { flyAnim.cancel(); } catch {} });

  const saying = FORTUNE_SAYINGS[Math.floor(Math.random() * FORTUNE_SAYINGS.length)];

  const unfold = setTimeout(() => {
    const craneOut = crane.animate(
      [
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)' },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(0.35) rotate(0deg)' },
      ],
      { duration: 280, easing: 'ease-in', fill: 'forwards' }
    );
    cancellers.push(() => { try { craneOut.cancel(); } catch {} });

    const letter = document.createElement('div');
    letter.className = 'paper-letter';
    letter.innerHTML =
      '<div class="paper-letter-rod paper-letter-rod-l"></div>' +
      '<div class="paper-letter-rod paper-letter-rod-r"></div>' +
      '<div class="paper-letter-body">' +
        '<div class="fortune-result paper-letter-line"></div>' +
      '</div>' +
      '<div class="fortune-hint">轻 点 收 起</div>';
    overlay.appendChild(letter);

    const openAnim = letter.animate(
      [
        { clipPath: 'inset(0 50% 0 50%)', opacity: 0 },
        { clipPath: 'inset(0 0 0 0)',     opacity: 1 },
      ],
      { duration: 480, easing: 'cubic-bezier(0.16, 1, 0.36, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { openAnim.cancel(); } catch {} });

    const lineEl = letter.querySelector('.paper-letter-line');
    const hintEl = letter.querySelector('.fortune-hint');

    const writeStart = setTimeout(() => {
      revealFortune(lineEl, hintEl, saying, 'saying');
    }, 460);
    cancellers.push(() => clearTimeout(writeStart));
  }, 1400);
  cancellers.push(() => clearTimeout(unfold));

  overlay.addEventListener('click', close);
}

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, 2200);
}

// Public API exposed to the host (Swift evaluateJavaScript / Tauri events).
window.MDViewerAPI = {
  render,
  setTheme,
  scrollToAnchor,
  setFileTree: (payload) => Sidebar.setFileTree(payload),
  onScanDirResult: (reqId, payload) => Sidebar.onScanDirResult(reqId, payload),
  onReadFileResult: (reqId, payload) => onReadFileResult(reqId, payload),
  onAiConfig: (reqId, config) => resolveAi(reqId, config),
  onSettings: (reqId, settings) => resolveAi(reqId, settings),
  onSettingsChanged: (settings) => applySettingsBlob(settings),
  onMemory: (reqId, memory) => resolveAi(reqId, memory),
  onHistoryLoaded: (reqId, history) => resolveAi(reqId, history),
  onAiDelta: (reqId, payload) => onAiDelta(reqId, payload),
  onAiDone: (reqId, payload) => resolveAi(reqId, payload),
  onAiError: (reqId, payload) => resolveAi(reqId, payload),
  onAiToolResult: (reqId, payload) => resolveAi(reqId, payload),
  onWriteResult: (reqId, payload) => resolveAi(reqId, payload),
  onAiConfigChanged: (config) => { try { AIPanel.onConfigChanged(config); } catch {} },
  onTermData: (id, data) => onTermData(id, data),
  onTermExit: (id, code) => onTermExit(id, code),
  toast: (message, type) => showToast(message, type),
  selectAllContent,
  // ⌘S from the native File menu → save the open code/text editor (no-op when
  // not editing). The native menu owns ⌘S because the read-only document's
  // default Save would otherwise just swallow the shortcut.
  saveActiveEditor: () => { try { if (DocView.isEditing()) DocView.save(); } catch {} },
  toggleSidebar: () => Sidebar.toggleCollapsed(),
  toggleAiPanel: () => Panels.toggleAi(),
  toggleTerminal: () => Panels.toggleTerminal(),
  setLoading,
  setRecents: (list) => { Sidebar.setRecents(list); Home.setRecents(list); },
};
