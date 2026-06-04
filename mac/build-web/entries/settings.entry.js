// Standalone settings page — rendered in its own OS window (a native WKWebView
// window on macOS, a second WebviewWindow on Windows). Two-pane: a left nav
// (外观 / 编辑器 / 快捷键) and a right content area. It reads/writes the global
// settings blob via the same settingsGet / settingsSet IPC the viewer uses; the
// host persists it and broadcasts the change to every open project window so
// they update live.

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
const VALID_THEME_IDS = new Set(['system', ...THEMES.map((t) => t.id)]);

const AUTOSAVE = [
  { id: 'off',       label: '手动', hint: '仅 ⌘/Ctrl + S 保存' },
  { id: 'afterEdit', label: '编辑后自动保存', hint: '停止输入约 1 秒后写盘' },
  { id: 'onBlur',    label: '失去焦点时保存', hint: '编辑器失焦即写盘' },
  { id: 'onLeave',   label: '切换/关闭文件时保存', hint: '离开文件时写盘，不弹确认' },
];

const SHORTCUTS = [
  { keys: '⌘/Ctrl + S', desc: '保存当前文件' },
  { keys: '⌘/Ctrl + D', desc: '复制当前行（编辑器内）' },
  { keys: '⌘/Ctrl + I', desc: '打开 / 关闭 AI 面板' },
  { keys: '⌘/Ctrl + J', desc: '打开 / 关闭终端' },
  { keys: '⌘/Ctrl + B', desc: '显示 / 隐藏侧栏' },
  { keys: '⌘/Ctrl + F', desc: '在编辑器内查找' },
  { keys: '⌘/Ctrl + A', desc: '全选（正文或编辑器）' },
  { keys: '⌘/Ctrl + ⇧ + O', desc: '打开文件夹' },
];

const FONT_MIN = 10, FONT_MAX = 28;
const DEFAULTS = { theme: 'dark', fontUI: 13, fontEditor: 13, fontTerminal: 13, fontAI: 13, autoSave: 'off' };
const FONT_ROWS = [
  ['fontUI', '界面 / 文件树'],
  ['fontEditor', '编辑器'],
  ['fontTerminal', '终端'],
  ['fontAI', 'AI 面板'],
];

let S = { ...DEFAULTS };
let activeSection = 'appearance';

const mqDark = window.matchMedia('(prefers-color-scheme: dark)');

function clampFont(v, def) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(FONT_MIN, Math.min(FONT_MAX, n));
}

function normalize(s) {
  const out = { ...DEFAULTS };
  if (s && typeof s === 'object') {
    if (typeof s.theme === 'string' && VALID_THEME_IDS.has(s.theme)) out.theme = s.theme;
    out.fontUI = clampFont(s.fontUI, DEFAULTS.fontUI);
    out.fontEditor = clampFont(s.fontEditor, DEFAULTS.fontEditor);
    out.fontTerminal = clampFont(s.fontTerminal, DEFAULTS.fontTerminal);
    out.fontAI = clampFont(s.fontAI, DEFAULTS.fontAI);
    if (AUTOSAVE.some((m) => m.id === s.autoSave)) out.autoSave = s.autoSave;
  }
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- theme applied to THIS window's chrome ----
function resolveBase(themeId) {
  if (themeId === 'system') return mqDark.matches ? 'dark' : 'light';
  const t = THEME_BY_ID[themeId];
  return t ? t.base : 'dark';
}
function applyTheme() {
  const base = resolveBase(S.theme);
  const id = S.theme === 'system' ? base : S.theme;
  document.documentElement.dataset.theme = id;
  document.documentElement.dataset.base = base;
}
mqDark.addEventListener('change', () => { if (S.theme === 'system') applyTheme(); });

// ---- IPC ----
const pending = new Map();
let seq = 0;
function requestSettingsGet() {
  return new Promise((resolve) => {
    const reqId = `set-get-${(++seq).toString(36)}`;
    pending.set(reqId, resolve);
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
    pending.delete(reqId);
    resolve(null);   // no host (e.g. browser preview) — keep defaults
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

// The host calls these back on this window.
window.MDViewerAPI = {
  onSettings: (reqId, settings) => {
    const r = pending.get(reqId);
    if (r) { pending.delete(reqId); r(settings); }
  },
  // If another window changed settings while this one is open, reflect it.
  onSettingsChanged: (settings) => {
    S = normalize(settings);
    applyTheme();
    syncControls();
  },
  onAiConfig: (reqId, cfg) => {
    const r = pending.get(reqId);
    if (r) { pending.delete(reqId); r(cfg); }
  },
  onAiConfigChanged: (cfg) => { A = normalizeAi(cfg); renderAiSection(); },
  // History IPC reply — list/read/write/delete all resolve here by reqId.
  onHistoryLoaded: (reqId, value) => {
    const r = pending.get(reqId);
    if (r) { pending.delete(reqId); r(value); }
  },
};

// ---- AI config ----
const AI_PREFS_DEFAULTS = { approvalPolicy: 'ask', temperatureEnabled: false, temperature: 0.7, systemPrompt: '', maxSteps: 50 };

// Execution-permission levels for the agent (maps to viewer gating).
const AI_APPROVAL = [
  { id: 'ask',        label: '每次询问',                 hint: '所有文件写入 / 运行命令都逐条确认' },
  { id: 'allowEdits', label: '允许编辑文件，危险操作询问', hint: '自动应用文件编辑 / 写入；运行命令仍需确认' },
  { id: 'allowAll',   label: '允许一切',                 hint: '写入 / 命令都不再确认（请谨慎）' },
];

// Provider presets — picking one auto-fills the接口地址 and default models. All
// use the OpenAI-compatible endpoint ({baseURL}/chat/completions). The GLM
// Coding Plan key works against its OpenAI-compatible coding endpoint.
const AI_PRESETS = [
  { id: 'zhipu',        name: '智谱 GLM',            baseURL: 'https://open.bigmodel.cn/api/paas/v4',        models: ['glm-5.1', 'glm-5-turbo'] },
  { id: 'zhipu-coding', name: '智谱 GLM Coding Plan', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', models: ['glm-5.1', 'glm-5-turbo'] },
  { id: 'deepseek',     name: 'DeepSeek',           baseURL: 'https://api.deepseek.com',                    models: ['deepseek-v4-pro', 'deepseek-v4-flash'] },
  { id: 'qwen',         name: '通义千问',            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
  { id: 'custom',       name: '',                   baseURL: '',                                            models: [] },
];
function presetByBaseURL(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return AI_PRESETS.find((p) => p.id !== 'custom' && p.baseURL.replace(/\/+$/, '') === u) || null;
}

let A = normalizeAi(null);
let aiSaveTimer = null;
let aiExpanded = null;   // id of the provider whose editor is open (accordion)

function aiGenId() {
  return `p-${(seq + 1).toString(36)}-${Math.floor(Math.abs(Math.sin(++seq)) * 1e6).toString(36)}`;
}
function normalizeAi(c) {
  const out = { providers: [], defaultModel: null, prefs: { ...AI_PREFS_DEFAULTS } };
  if (c && typeof c === 'object') {
    if (Array.isArray(c.providers)) {
      out.providers = c.providers.filter((p) => p && typeof p === 'object').map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id : aiGenId(),
        name: String(p.name || '').trim(),
        baseURL: String(p.baseURL || '').trim(),
        apiKey: String(p.apiKey || '').trim(),
        models: Array.isArray(p.models) ? [...new Set(p.models.map((m) => String(m || '').trim()).filter(Boolean))] : [],
      })).filter((p) => p.name || p.baseURL || p.apiKey || p.models.length);  // drop blank rows
    } else if (c.apiKey || c.baseURL || c.model) {
      out.providers = [{ id: aiGenId(), name: String(c.provider || '默认'), baseURL: String(c.baseURL || '').trim(), apiKey: String(c.apiKey || '').trim(), models: c.model ? [String(c.model).trim()] : [] }];
    }
    if (c.prefs && typeof c.prefs === 'object') {
      out.prefs.approvalPolicy = AI_APPROVAL.some((a) => a.id === c.prefs.approvalPolicy)
        ? c.prefs.approvalPolicy
        : (c.prefs.autoApprove ? 'allowAll' : 'ask');   // migrate the old boolean
      out.prefs.temperatureEnabled = !!c.prefs.temperatureEnabled;
      const t = Number(c.prefs.temperature);
      out.prefs.temperature = Number.isFinite(t) ? Math.max(0, Math.min(2, t)) : 0.7;
      out.prefs.systemPrompt = typeof c.prefs.systemPrompt === 'string' ? c.prefs.systemPrompt : '';
      const ms = parseInt(c.prefs.maxSteps, 10);
      out.prefs.maxSteps = Number.isFinite(ms) ? Math.max(1, Math.min(500, ms)) : 50;
    }
    const all = aiAllModels(out);
    if (c.defaultModel && all.some((x) => x.providerId === c.defaultModel.providerId && x.model === c.defaultModel.model)) {
      out.defaultModel = { providerId: c.defaultModel.providerId, model: c.defaultModel.model };
    } else if (all.length) {
      out.defaultModel = { providerId: all[0].providerId, model: all[0].model };
    }
  }
  return out;
}
function aiAllModels(cfg) {
  const out = [];
  for (const p of (cfg.providers || [])) for (const m of (p.models || [])) { const t = String(m || '').trim(); if (t) out.push({ providerId: p.id, provider: p.name, model: t }); }
  return out;
}
function requestAiGetConfig() {
  return new Promise((resolve) => {
    const reqId = `ai-cfg-${(++seq).toString(36)}`;
    pending.set(reqId, resolve);
    try { if (window.webkit?.messageHandlers?.aiGetConfig) { window.webkit.messageHandlers.aiGetConfig.postMessage({ reqId }); return; } } catch {}
    try { const ev = window.__TAURI__?.event; if (ev?.emit) { ev.emit('mdreader:ai-get-config', { reqId }); return; } } catch {}
    pending.delete(reqId);
    resolve(null);
  });
}
function requestAiSetConfig(cfg) {
  try { if (window.webkit?.messageHandlers?.aiSetConfig) { window.webkit.messageHandlers.aiSetConfig.postMessage({ config: cfg }); return; } } catch {}
  try { const ev = window.__TAURI__?.event; if (ev?.emit) ev.emit('mdreader:ai-set-config', { config: cfg }); } catch {}
}

// ---- History IPC (mirrors viewer.entry.js requestHistory) ----
// `scope` is 'chat' or 'term'. Mac registers historyList/Read/Write/Delete
// script handlers on the settings window; win replies via the global
// mdreader:history-loaded broadcast. Both resolve through onHistoryLoaded.
function requestHistory(verb, payload) {
  const handler = `history${verb[0].toUpperCase()}${verb.slice(1)}`;
  return new Promise((resolve) => {
    const reqId = `hist-${(++seq).toString(36)}`;
    pending.set(reqId, resolve);
    const msg = { reqId, ...payload };
    try { if (window.webkit?.messageHandlers?.[handler]) { window.webkit.messageHandlers[handler].postMessage(msg); return; } } catch {}
    try { const ev = window.__TAURI__?.event; if (ev?.emit) { ev.emit(`mdreader:history-${verb}`, msg); return; } } catch {}
    pending.delete(reqId);
    resolve(null);
  });
}
const requestHistoryList = (scope) => requestHistory('list', { scope });
const requestHistoryRead = (scope, id) => requestHistory('read', { scope, id });
const requestHistoryWrite = (scope, id, record) => requestHistory('write', { scope, id, record });
const requestHistoryDelete = (scope, id) => requestHistory('delete', { scope, id });
function aiSave() {
  // Re-validate the default model against current providers before saving.
  const all = aiAllModels(A);
  if (!all.length) A.defaultModel = null;
  else if (!A.defaultModel || !all.some((x) => x.providerId === A.defaultModel.providerId && x.model === A.defaultModel.model)) {
    A.defaultModel = { providerId: all[0].providerId, model: all[0].model };
  }
  if (aiSaveTimer) clearTimeout(aiSaveTimer);
  aiSaveTimer = setTimeout(() => {
    aiSaveTimer = null;
    // Persist a cleaned copy — drop blank model rows, then drop empty providers.
    const clean = {
      ...A,
      providers: A.providers
        .map((p) => ({ ...p, models: [...new Set(p.models.map((m) => String(m || '').trim()).filter(Boolean))] }))
        .filter((p) => p.name || p.baseURL || p.apiKey || p.models.length),
    };
    requestAiSetConfig(clean);
  }, 300);
}

function persist() {
  applyTheme();
  requestSettingsSet(S);
}

// ---- render ----
function render() {
  const root = document.getElementById('settings-root');
  if (!root) return;
  const themeRows = [
    [themeSystemCard(), themeCard(THEME_BY_ID.dark), themeCard(THEME_BY_ID.light)],
    [themeCard(THEME_BY_ID['cursor-dark']), themeCard(THEME_BY_ID['webstorm-dark']), themeCard(THEME_BY_ID['claude-dark'])],
    [themeCard(THEME_BY_ID['cursor-light']), themeCard(THEME_BY_ID['webstorm-light']), themeCard(THEME_BY_ID['codex-light'])],
  ].map((row) => `<div class="set-theme-row">${row.join('')}</div>`).join('');
  root.innerHTML = `
    <nav class="settings-nav">
      <div class="settings-nav-title">设置</div>
      <button class="settings-nav-item" data-sec="appearance" type="button">外观</button>
      <button class="settings-nav-item" data-sec="ai" type="button">AI模块</button>
      <button class="settings-nav-item" data-sec="editor" type="button">编辑器</button>
      <button class="settings-nav-item" data-sec="terminal" type="button">终端</button>
      <button class="settings-nav-item" data-sec="shortcuts" type="button">快捷键</button>
    </nav>
    <main class="settings-content">
      <section class="settings-sec" data-sec="appearance">
        <h2 class="settings-h2">主题</h2>
        <div class="set-theme-rows">${themeRows}</div>
        <h2 class="settings-h2">字号</h2>
        ${FONT_ROWS.map(([k, label]) => fontRow(k, label)).join('')}
      </section>
      <section class="settings-sec" data-sec="ai" hidden>
        <h2 class="settings-h2">密钥与模型</h2>
        <div id="ai-set-providers"></div>
        <button class="set-add-btn set-add-key-btn" id="ai-add-key" type="button">+ 添加密钥</button>
        <h2 class="settings-h2">默认模型（Auto）</h2>
        <select class="set-select" id="ai-default-model"></select>
        <h2 class="settings-h2">运行执行程度</h2>
        <div class="set-radio-group" id="ai-approval-group">
          ${AI_APPROVAL.map(approvalRow).join('')}
        </div>
        <h2 class="settings-h2">温度</h2>
        <label class="set-check-row">
          <input type="checkbox" id="ai-pref-temp-enabled">
          <span class="set-radio-main">自定义温度</span>
          <span class="set-radio-hint" id="ai-temp-val"></span>
        </label>
        <div class="set-font-row" id="ai-temp-row">
          <span class="set-font-label">temperature</span>
          <input class="set-range" id="ai-pref-temp" type="range" min="0" max="2" step="0.1">
          <span class="set-font-val" id="ai-temp-num"></span>
        </div>
        <h2 class="settings-h2">系统提示词（追加）</h2>
        <textarea class="set-textarea" id="ai-pref-prompt" rows="4" placeholder="留空则用内置提示词；填写则追加到内置之后"></textarea>
        <h2 class="settings-h2">最大工具步数</h2>
        <div class="set-font-row">
          <span class="set-font-label">单次任务最多工具步数（撞上限会询问是否继续）</span>
          <button class="set-step" data-step="-1" id="ai-steps-dec" type="button">−</button>
          <input class="set-range" id="ai-pref-steps" type="range" min="1" max="200" step="1">
          <button class="set-step" data-step="1" id="ai-steps-inc" type="button">+</button>
          <span class="set-font-val" id="ai-steps-num"></span>
        </div>
      </section>
      <section class="settings-sec" data-sec="editor" hidden>
        <h2 class="settings-h2">自动保存</h2>
        <div class="set-radio-group">
          ${AUTOSAVE.map(autoRow).join('')}
        </div>
      </section>
      <section class="settings-sec" data-sec="terminal" hidden>
        <h2 class="settings-h2">命令历史</h2>
        <p class="settings-note">终端会记录各工作区输入过的命令，用于输入时的灰色补全提示。可在此查看或删除。</p>
        <div id="term-hist"></div>
      </section>
      <section class="settings-sec" data-sec="shortcuts" hidden>
        <h2 class="settings-h2">快捷键</h2>
        <div class="set-shortcuts">
          ${SHORTCUTS.map((s) => `
            <div class="set-shortcut">
              <span class="set-shortcut-desc">${escapeHtml(s.desc)}</span>
              <kbd class="set-shortcut-keys">${escapeHtml(s.keys)}</kbd>
            </div>`).join('')}
        </div>
        <p class="settings-note">快捷键暂为内置，后续版本支持自定义。</p>
      </section>
    </main>`;

  root.querySelectorAll('.settings-nav-item').forEach((b) => {
    b.addEventListener('click', () => setSection(b.dataset.sec));
  });
  root.querySelectorAll('.set-theme-card').forEach((c) => {
    c.addEventListener('click', () => { S.theme = c.dataset.themeId; persist(); syncControls(); });
  });
  root.querySelectorAll('.set-font-row').forEach((row) => {
    const key = row.dataset.font;
    const range = row.querySelector('.set-range');
    range.addEventListener('input', () => { S[key] = clampFont(range.value, DEFAULTS[key]); persist(); syncControls(); });
    row.querySelectorAll('.set-step').forEach((b) => {
      b.addEventListener('click', () => { S[key] = clampFont(S[key] + Number(b.dataset.step), DEFAULTS[key]); persist(); syncControls(); });
    });
  });
  root.querySelectorAll('.set-radio').forEach((r) => {
    r.addEventListener('change', () => { if (r.checked) { S.autoSave = r.value; persist(); } });
  });

  wireAiStatic();
  renderAiSection();
  setSection(activeSection);
  syncControls();
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
function fontRow(key, label) {
  return `
    <div class="set-font-row" data-font="${key}">
      <span class="set-font-label">${escapeHtml(label)}</span>
      <button class="set-step" data-step="-1" type="button" aria-label="减小">−</button>
      <input class="set-range" type="range" min="${FONT_MIN}" max="${FONT_MAX}" step="1">
      <button class="set-step" data-step="1" type="button" aria-label="增大">+</button>
      <span class="set-font-val"></span>
    </div>`;
}
function autoRow(m) {
  return `
    <label class="set-radio-row">
      <input class="set-radio" type="radio" name="autosave" value="${m.id}">
      <span class="set-radio-main">${escapeHtml(m.label)}</span>
      <span class="set-radio-hint">${escapeHtml(m.hint)}</span>
    </label>`;
}

function approvalRow(m) {
  return `
    <label class="set-radio-row">
      <input class="set-radio-approval" type="radio" name="aiapproval" value="${m.id}">
      <span class="set-radio-main">${escapeHtml(m.label)}</span>
      <span class="set-radio-hint">${escapeHtml(m.hint)}</span>
    </label>`;
}

function maskKey(k) {
  const s = String(k || '');
  if (!s) return '未填密钥';
  return s.length <= 8 ? '••••' : `••••${s.slice(-4)}`;
}

// Collapsed one-line summary of a saved provider (click to expand & edit).
function providerSummary(p) {
  const label = p.name || presetByBaseURL(p.baseURL)?.name || '未命名';
  const models = p.models.length ? `${p.models.length} 个模型` : '无模型';
  return `
    <button type="button" class="ai-set-sum">
      <span class="ai-set-sum-caret">▸</span>
      <span class="ai-set-sum-name">${escapeHtml(label)}</span>
      <span class="ai-set-sum-meta">${escapeHtml(maskKey(p.apiKey))} · ${escapeHtml(models)}</span>
    </button>`;
}

// Expanded inline editor: provider preset → auto-fills url+models; key w/ eye;
// one input row per model with a +/− button (first row adds, others remove).
function providerEditor(p) {
  if (!p.models.length) p.models.push('');   // always show at least one model row
  const presetVal = presetByBaseURL(p.baseURL)?.id || 'custom';
  const options = AI_PRESETS.map((pr) =>
    `<option value="${pr.id}"${pr.id === presetVal ? ' selected' : ''}>${escapeHtml(pr.id === 'custom' ? '自定义' : pr.name)}</option>`).join('');
  const modelRows = p.models.map((m, i) => `
          <div class="ai-model-row">
            <input class="ai-model-inp set-input" placeholder="模型名，如 gpt-4o" value="${escapeHtml(m)}">
            <button type="button" class="set-step ai-model-btn" data-act="${i === 0 ? 'add' : 'del'}" data-idx="${i}" aria-label="${i === 0 ? '添加一行' : '删除此行'}">${i === 0 ? '+' : '−'}</button>
          </div>`).join('');
  return `
    <div class="ai-set-edit">
      <label class="ai-f-row"><span class="ai-f-lab">服务商</span>
        <select class="ai-f-preset set-select">${options}</select></label>
      <label class="ai-f-row"><span class="ai-f-lab">名称</span>
        <input class="ai-f-name set-input" placeholder="如 DashScope / 我的密钥" value="${escapeHtml(p.name)}"></label>
      <label class="ai-f-row"><span class="ai-f-lab">接口地址</span>
        <input class="ai-f-base set-input" placeholder="https://…/v1" value="${escapeHtml(p.baseURL)}"></label>
      <label class="ai-f-row"><span class="ai-f-lab">API Key</span>
        <span class="ai-f-key-wrap">
          <input class="ai-f-key set-input" type="password" placeholder="sk-…" value="${escapeHtml(p.apiKey)}">
          <button type="button" class="ai-f-eye" title="显示 / 隐藏" aria-label="显示 / 隐藏">👁</button>
        </span></label>
      <div class="ai-f-row ai-f-row-top"><span class="ai-f-lab">模型</span>
        <div class="ai-model-box">${modelRows}</div></div>
      <div class="ai-set-actions"><button class="ai-del-key set-del-btn" type="button">删除此密钥</button></div>
    </div>`;
}

function providerCard(p) {
  const open = aiExpanded === p.id;
  return `
    <div class="ai-set-provider${open ? ' is-open' : ''}" data-id="${escapeHtml(p.id)}">
      ${providerSummary(p)}
      ${open ? providerEditor(p) : ''}
    </div>`;
}

function renderAiSection() {
  const host = document.getElementById('ai-set-providers');
  if (!host) return;
  // Empty state: show an add form by default (a blank, expanded provider). The
  // blank row is filtered out of what gets persisted until the user fills it.
  if (!A.providers.length) {
    const np = { id: aiGenId(), name: '', baseURL: '', apiKey: '', models: [] };
    A.providers.push(np);
    aiExpanded = np.id;
  }
  host.innerHTML = A.providers.map(providerCard).join('');
  host.querySelectorAll('.ai-set-provider').forEach((card) => {
    const p = A.providers.find((x) => x.id === card.dataset.id);
    if (p) wireProviderCard(card, p);
  });
  refreshDefaultModel();
  syncAiPrefs();
}

function wireProviderCard(card, p) {
  card.querySelector('.ai-set-sum')?.addEventListener('click', () => {
    aiExpanded = aiExpanded === p.id ? null : p.id;
    renderAiSection();
  });
  if (aiExpanded !== p.id) return;   // collapsed — only the summary is present

  card.querySelector('.ai-f-preset')?.addEventListener('change', (e) => {
    const pr = AI_PRESETS.find((x) => x.id === e.target.value);
    if (pr) {
      // Switching provider = a fresh provider: replace name/url/models with the
      // preset's (custom → blank), and clear the now-mismatched key.
      p.name = pr.name;
      p.baseURL = pr.baseURL;
      p.models = [...pr.models];
      p.apiKey = '';
    }
    renderAiSection();
    aiSave();
  });
  card.querySelector('.ai-f-name')?.addEventListener('input', (e) => { p.name = e.target.value; aiSave(); });
  card.querySelector('.ai-f-base')?.addEventListener('input', (e) => { p.baseURL = e.target.value.trim(); aiSave(); });
  card.querySelector('.ai-f-key')?.addEventListener('input', (e) => { p.apiKey = e.target.value.trim(); aiSave(); });
  card.querySelector('.ai-f-eye')?.addEventListener('click', () => {
    const k = card.querySelector('.ai-f-key');
    const eye = card.querySelector('.ai-f-eye');
    if (!k) return;
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    eye.classList.toggle('is-on', show);
  });
  card.querySelectorAll('.ai-model-inp').forEach((inp, i) => {
    inp.addEventListener('input', () => { p.models[i] = inp.value; refreshDefaultModel(); aiSave(); });
  });
  card.querySelectorAll('.ai-model-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'add') p.models.push('');
      else p.models.splice(Number(btn.dataset.idx), 1);
      if (!p.models.length) p.models.push('');
      renderAiSection();
      aiSave();
    });
  });
  card.querySelector('.ai-del-key')?.addEventListener('click', () => {
    A.providers = A.providers.filter((x) => x.id !== p.id);
    if (aiExpanded === p.id) aiExpanded = null;
    renderAiSection();
    aiSave();
  });
}

function refreshDefaultModel() {
  const sel = document.getElementById('ai-default-model');
  if (!sel) return;
  const all = aiAllModels(A);
  if (!all.length) { sel.innerHTML = '<option value="">（无可用模型）</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const cur = A.defaultModel ? `${A.defaultModel.providerId}:${A.defaultModel.model}` : '';
  sel.innerHTML = all.map((m) => {
    const v = `${m.providerId}:${m.model}`;
    return `<option value="${escapeHtml(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(m.provider || '?')} · ${escapeHtml(m.model)}</option>`;
  }).join('');
}

function syncAiPrefs() {
  const p = A.prefs;
  const at = (id) => document.getElementById(id);
  document.querySelectorAll('.set-radio-approval').forEach((r) => { r.checked = r.value === p.approvalPolicy; });
  if (at('ai-pref-temp-enabled')) at('ai-pref-temp-enabled').checked = p.temperatureEnabled;
  if (at('ai-pref-temp')) at('ai-pref-temp').value = String(p.temperature);
  if (at('ai-temp-num')) at('ai-temp-num').textContent = p.temperature.toFixed(1);
  if (at('ai-temp-row')) at('ai-temp-row').style.opacity = p.temperatureEnabled ? '1' : '0.4';
  if (at('ai-pref-prompt')) at('ai-pref-prompt').value = p.systemPrompt;
  if (at('ai-pref-steps')) at('ai-pref-steps').value = String(p.maxSteps);
  if (at('ai-steps-num')) at('ai-steps-num').textContent = String(p.maxSteps);
}

function wireAiStatic() {
  document.getElementById('ai-add-key')?.addEventListener('click', () => {
    const np = { id: aiGenId(), name: '', baseURL: '', apiKey: '', models: [] };
    A.providers.push(np);
    aiExpanded = np.id;
    renderAiSection();
    document.querySelector(`.ai-set-provider[data-id="${np.id}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  document.getElementById('ai-default-model')?.addEventListener('change', (e) => {
    const v = e.target.value, i = v.indexOf(':');
    if (i > 0) { A.defaultModel = { providerId: v.slice(0, i), model: v.slice(i + 1) }; aiSave(); }
  });
  document.getElementById('ai-approval-group')?.addEventListener('change', (e) => {
    if (e.target.classList.contains('set-radio-approval') && e.target.checked) {
      A.prefs.approvalPolicy = e.target.value;
      aiSave();
    }
  });
  document.getElementById('ai-pref-temp-enabled')?.addEventListener('change', (e) => { A.prefs.temperatureEnabled = e.target.checked; syncAiPrefs(); aiSave(); });
  document.getElementById('ai-pref-temp')?.addEventListener('input', (e) => {
    A.prefs.temperature = Math.max(0, Math.min(2, parseFloat(e.target.value) || 0));
    const n = document.getElementById('ai-temp-num'); if (n) n.textContent = A.prefs.temperature.toFixed(1);
    aiSave();
  });
  document.getElementById('ai-pref-prompt')?.addEventListener('input', (e) => { A.prefs.systemPrompt = e.target.value; aiSave(); });
  const setSteps = (n) => { A.prefs.maxSteps = Math.max(1, Math.min(200, n)); syncAiPrefs(); aiSave(); };
  document.getElementById('ai-pref-steps')?.addEventListener('input', (e) => setSteps(parseInt(e.target.value, 10) || 24));
  document.getElementById('ai-steps-dec')?.addEventListener('click', () => setSteps(A.prefs.maxSteps - 1));
  document.getElementById('ai-steps-inc')?.addEventListener('click', () => setSteps(A.prefs.maxSteps + 1));
}

function setSection(sec) {
  activeSection = sec;
  document.querySelectorAll('.settings-nav-item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.sec === sec);
  });
  document.querySelectorAll('.settings-sec').forEach((s) => {
    s.hidden = s.dataset.sec !== sec;
  });
  if (sec === 'terminal') loadTermHistory().then(renderTermSection);
}

// ---- Terminal command history (scope 'term') ----
// Terminal history is a single native record (term/commands.json), a
// { "<workspace>": [{cmd,count,lastUsed}] } map maintained by the terminal as
// you type. The settings window is global, so it merges every workspace's
// frequent commands into one 常用 list. Deleting a command drops it from every
// workspace; "清空全部" empties the whole table.
let termAll = {};    // the raw { "<workspace>": commands[] } map
let termCmds = [];   // merged [{cmd, count, lastUsed}] across all workspaces

async function loadTermHistory() {
  let rec = null;
  try { rec = await requestHistoryRead('term', 'commands'); } catch {}
  termAll = (rec && typeof rec.commands === 'object' && rec.commands) ? rec.commands : {};
  const stats = new Map();
  for (const list of Object.values(termAll)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || !e.cmd || e.deleted) continue;
      const cur = stats.get(e.cmd);
      const count = (e.count || 0), lastUsed = (e.lastUsed || 0);
      if (cur) { cur.count += count; if (lastUsed > cur.lastUsed) cur.lastUsed = lastUsed; }
      else stats.set(e.cmd, { cmd: e.cmd, count, lastUsed });
    }
  }
  termCmds = Array.from(stats.values());
}

function persistTermAll() {
  try { requestHistoryWrite('term', 'commands', { id: 'commands', commands: termAll }); } catch {}
}

function termRow(e) {
  return `<div class="set-term-row" data-cmd="${escapeHtml(e.cmd)}">`
    + `<span class="set-term-cmd">${escapeHtml(e.cmd)}</span>`
    + (e.count > 1 ? `<span class="set-term-count">×${e.count}</span>` : '')
    + `<button class="set-term-del" type="button" title="删除" aria-label="删除">×</button>`
    + `</div>`;
}

function renderTermSection() {
  const host = document.getElementById('term-hist');
  if (!host) return;
  if (!termCmds.length) {
    host.innerHTML = '<div class="set-term-empty">暂无常用命令</div>';
    return;
  }
  // 常用 only: most-used first, recency breaks ties.
  const frequent = termCmds.slice().sort((a, b) =>
    (b.count || 0) - (a.count || 0) || (b.lastUsed || 0) - (a.lastUsed || 0));
  host.innerHTML = `
    <div class="set-term-actions"><button class="set-del-btn" id="term-hist-clear" type="button">清空全部</button></div>
    <div class="set-term-sec-title">常用</div>
    <div class="set-term-list">${frequent.map(termRow).join('')}</div>`;
  document.getElementById('term-hist-clear')?.addEventListener('click', clearTermHistory);
  host.querySelectorAll('.set-term-row').forEach((row) => {
    row.querySelector('.set-term-del')?.addEventListener('click', () => deleteTermCommand(row.dataset.cmd));
  });
}

async function deleteTermCommand(cmd) {
  if (!cmd) return;
  // Soft delete: flag matching entries `deleted:true` instead of removing them,
  // so the json data is kept (no recovery UI). The viewer filters them out.
  let changed = false;
  for (const k of Object.keys(termAll)) {
    if (!Array.isArray(termAll[k])) continue;
    for (const e of termAll[k]) {
      if (e && e.cmd === cmd && !e.deleted) { e.deleted = true; changed = true; }
    }
  }
  if (changed) persistTermAll();
  await loadTermHistory();
  renderTermSection();
}

async function clearTermHistory() {
  // Soft delete everything: flag every entry across all workspaces, keep the record.
  let changed = false;
  for (const k of Object.keys(termAll)) {
    if (!Array.isArray(termAll[k])) continue;
    for (const e of termAll[k]) {
      if (e && !e.deleted) { e.deleted = true; changed = true; }
    }
  }
  if (changed) persistTermAll();
  termCmds = [];
  renderTermSection();
}

function syncControls() {
  document.querySelectorAll('.set-theme-card').forEach((c) => {
    c.classList.toggle('is-active', c.dataset.themeId === S.theme);
  });
  document.querySelectorAll('.set-font-row').forEach((row) => {
    const key = row.dataset.font;
    row.querySelector('.set-range').value = String(S[key]);
    row.querySelector('.set-font-val').textContent = `${S[key]}px`;
  });
  document.querySelectorAll('.set-radio').forEach((r) => { r.checked = r.value === S.autoSave; });
}

const VALID_SECTIONS = ['appearance', 'ai', 'editor', 'terminal', 'shortcuts'];
function init() {
  const hash = (location.hash || '').replace('#', '');
  if (VALID_SECTIONS.includes(hash)) activeSection = hash;
  applyTheme();
  render();
  requestSettingsGet().then((s) => {
    if (s && typeof s === 'object') S = normalize(s);
    applyTheme();
    syncControls();
  });
  requestAiGetConfig().then((cfg) => {
    A = normalizeAi(cfg);
    renderAiSection();
  });
}
window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace('#', '');
  if (VALID_SECTIONS.includes(h)) setSection(h);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
