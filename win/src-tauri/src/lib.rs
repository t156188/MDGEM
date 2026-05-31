use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Listener, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;
use url::Url;

const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn"];
const STORE_FILE: &str = "settings.json";
const STORE_KEY_THEME: &str = "themeOverride"; // "system" | "light" | "dark"
const STORE_KEY_ZOOM: &str = "pageZoom";       // 0.4 ..= 3.0
const STORE_KEY_RECENTS: &str = "recentFiles"; // newest-first list of absolute paths
const STORE_KEY_AI: &str = "aiConfig";         // OpenAI-compatible provider config
const STORE_KEY_SETTINGS: &str = "uiSettings"; // global theme + font-size blob
const STORE_KEY_MEMORY: &str = "workspaceMemory"; // per-workspace-path UI memory map
const RECENTS_MAX: usize = 12;
/// Files larger than this are refused for in-app preview — the text preview is
/// for source/text, not for hauling megabytes across the IPC bridge.
const MAX_PREVIEW_BYTES: u64 = 2 * 1024 * 1024;

/// Directory names we never recurse into eagerly. They still appear in the
/// tree, but the front-end fetches their children on demand (see
/// `mdreader:scan-dir`). Keeps `node_modules`/build output from freezing the
/// UI when opening large workspaces.
const LAZY_DIR_NAMES: &[&str] = &[
    "node_modules", "dist", "build", "out", "target", "vendor",
    "release", "coverage", "Pods", "DerivedData", "__pycache__",
];

#[derive(Default)]
struct OpenState {
    /// Currently displayed .md file.
    current_file: Mutex<Option<PathBuf>>,
    /// Pinned at the first opened file's parent directory. Sidebar clicks do
    /// not change this — only "new document" entry points (initial argv,
    /// drag-drop, File → Open, single-instance forward).
    workspace_root: Mutex<Option<PathBuf>>,
    /// Recursive FS watcher for the current workspace. Dropping it closes
    /// the underlying handle and lets the consumer thread exit.
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
struct RenderPayload {
    text: String,
    base_dir: String,
}

#[derive(Serialize, Clone)]
struct ThemePayload {
    name: String,
    pref: String,
}

#[derive(Serialize, Clone)]
struct FileTreeNode {
    #[serde(rename = "type")]
    kind: String,
    name: String,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileTreeNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    lazy: Option<bool>,
}

#[derive(Serialize, Clone)]
struct ScanDirResult {
    #[serde(rename = "reqId")]
    req_id: String,
    path: String,
    children: Vec<FileTreeNode>,
}

#[derive(Deserialize)]
struct ScanDirRequest {
    path: String,
    #[serde(rename = "reqId")]
    req_id: String,
}

#[derive(Deserialize)]
struct ReadFileRequest {
    path: String,
    #[serde(rename = "reqId")]
    req_id: String,
}

#[derive(Serialize, Clone)]
struct ReadFileResult {
    #[serde(rename = "reqId")]
    req_id: String,
    path: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct ReqIdOnly {
    #[serde(rename = "reqId")]
    req_id: String,
}

#[derive(Deserialize)]
struct AiSetConfig {
    config: serde_json::Value,
}

#[derive(Deserialize)]
struct AiChatRequest {
    #[serde(rename = "reqId")]
    req_id: String,
    messages: serde_json::Value,
    #[serde(default)]
    tools: serde_json::Value,
    /// Per-request {baseURL, apiKey, model, temperature?} from the model dropdown.
    #[serde(default)]
    creds: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct AiConfigPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    config: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
struct AiDeltaPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    text: String,
}

#[derive(Serialize, Clone)]
struct AiDonePayload {
    #[serde(rename = "reqId")]
    req_id: String,
    full: String,
    #[serde(rename = "toolCalls")]
    tool_calls: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct AiErrorPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    error: String,
}

#[derive(Deserialize)]
struct AiToolRequest {
    #[serde(rename = "reqId")]
    req_id: String,
    name: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct AiToolResultPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    ok: bool,
    result: String,
}

#[derive(Deserialize)]
struct WriteFileRequest {
    #[serde(rename = "reqId")]
    req_id: String,
    path: String,
    content: String,
}

#[derive(Serialize, Clone)]
struct WriteResultPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ===== Settings + per-workspace memory =====

#[derive(Serialize, Clone)]
struct SettingsPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    settings: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SettingsSet {
    settings: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct MemoryPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    memory: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct MemoryGet {
    #[serde(rename = "reqId")]
    req_id: String,
    key: String,
}

#[derive(Deserialize)]
struct MemorySet {
    key: String,
    memory: serde_json::Value,
}

#[derive(Serialize, Clone)]
struct HistoryPayload {
    #[serde(rename = "reqId")]
    req_id: String,
    history: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct HistoryList {
    #[serde(rename = "reqId")]
    req_id: String,
    scope: String,
}

#[derive(Deserialize)]
struct HistoryRead {
    #[serde(rename = "reqId")]
    req_id: String,
    scope: String,
    id: String,
}

#[derive(Deserialize)]
struct HistoryWrite {
    #[serde(rename = "reqId")]
    req_id: String,
    scope: String,
    id: String,
    record: serde_json::Value,
}

#[derive(Deserialize)]
struct HistoryDelete {
    #[serde(rename = "reqId")]
    req_id: String,
    scope: String,
    id: String,
}

// ===== Terminal (PTY) =====

/// One live pseudo-terminal: the master (for resize), a writer (for input), and
/// the child (for kill). Output is streamed by a per-terminal reader thread.
struct TermHandle {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct TermState {
    map: Mutex<HashMap<String, TermHandle>>,
}

#[derive(Deserialize)]
struct TermCreate {
    id: String,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct TermInput {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct TermResize {
    id: String,
    #[serde(default)]
    cols: Option<u16>,
    #[serde(default)]
    rows: Option<u16>,
}

#[derive(Deserialize)]
struct TermId {
    id: String,
}

#[derive(Serialize, Clone)]
struct TermDataPayload {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct TermExitPayload {
    id: String,
    code: i32,
}

#[derive(Serialize, Clone)]
struct FileTreePayload {
    root: FileTreeNode,
    current: Option<String>,
}

#[derive(Deserialize)]
struct FsOp {
    op: String,
    path: String,
    #[serde(default, rename = "newName")]
    new_name: Option<String>,
}

#[derive(Copy, Clone)]
enum LoadMode {
    /// New document entry point — reset workspace_root to the file's parent.
    NewWorkspace,
    /// Sidebar click inside the existing workspace — keep workspace_root.
    KeepWorkspace,
}

fn is_markdown_path(p: &Path) -> bool {
    p.extension()
        .and_then(|s| s.to_str())
        .map(|s| MD_EXTS.iter().any(|e| e.eq_ignore_ascii_case(s)))
        .unwrap_or(false)
}

fn absolutize(p: PathBuf) -> PathBuf {
    if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .ok()
            .map(|c| c.join(&p))
            .unwrap_or(p)
    }
}

/// Pick the first argv entry that points to either a markdown file or a
/// directory. Used both for initial argv and for second-instance forwarding
/// (single-instance plugin).
fn pick_target_from_args<I, S>(args: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for (i, a) in args.into_iter().enumerate() {
        if i == 0 {
            continue; // skip exe path
        }
        let s = a.as_ref();
        if s.starts_with('-') {
            continue;
        }
        let p = absolutize(PathBuf::from(s));
        if is_markdown_path(&p) {
            return Some(p);
        }
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

/// Pick a "default" md inside a folder — README.* wins (case-insensitive),
/// otherwise the first .md/.markdown/... in alpha order. Only the immediate
/// children are inspected — opening a giant tree shouldn't recurse here.
fn find_default_md_in_dir(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut files: Vec<PathBuf> = entries
        .filter_map(|r| r.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && is_markdown_path(p))
        .collect();
    files.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
    // README.<md-ext> first, case-insensitive.
    if let Some(p) = files.iter().find(|p| {
        p.file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("README"))
            .unwrap_or(false)
    }) {
        return Some(p.clone());
    }
    files.into_iter().next()
}

fn read_text(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut s = String::from_utf8_lossy(&bytes).into_owned();
    if s.starts_with('\u{feff}') {
        s.remove(0);
    }
    Ok(s)
}

fn read_theme_pref(app: &AppHandle) -> String {
    if let Ok(store) = app.store(settings_path(app)) {
        if let Some(v) = store.get(STORE_KEY_THEME) {
            if let Some(s) = v.as_str() {
                return s.to_string();
            }
        }
    }
    // No stored preference (fresh install) → default to dark.
    "dark".to_string()
}

fn write_theme_pref(app: &AppHandle, value: &str) {
    if let Ok(store) = app.store(settings_path(app)) {
        store.set(STORE_KEY_THEME, serde_json::Value::String(value.to_string()));
        let _ = store.save();
    }
}

fn read_recents(app: &AppHandle) -> Vec<String> {
    if let Ok(store) = app.store(settings_path(app)) {
        if let Some(v) = store.get(STORE_KEY_RECENTS) {
            if let Some(arr) = v.as_array() {
                return arr
                    .iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect();
            }
        }
    }
    Vec::new()
}

fn write_recents(app: &AppHandle, list: &[String]) {
    if let Ok(store) = app.store(settings_path(app)) {
        store.set(STORE_KEY_RECENTS, serde_json::json!(list));
        let _ = store.save();
    }
}

fn add_recent(app: &AppHandle, path: &Path) {
    let p = path.to_string_lossy().to_string();
    if p.is_empty() {
        return;
    }
    let mut list = read_recents(app);
    list.retain(|x| x != &p);
    list.insert(0, p);
    list.truncate(RECENTS_MAX);
    write_recents(app, &list);
    if let Some(w) = app.get_webview_window("main") {
        push_recents(&w, &list);
    }
}

/// Drop entries whose target no longer exists. Cheap to do — we only ever
/// keep RECENTS_MAX paths.
fn prune_recents(app: &AppHandle) {
    let list = read_recents(app);
    let alive: Vec<String> = list
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect();
    write_recents(app, &alive);
}

fn push_recents(window: &WebviewWindow, list: &[String]) {
    let _ = window.emit("mdreader:recents", list);
}

fn read_ai_config(app: &AppHandle) -> Option<serde_json::Value> {
    let store = app.store(settings_path(app)).ok()?;
    store.get(STORE_KEY_AI)
}

fn write_ai_config(app: &AppHandle, value: serde_json::Value) {
    if let Ok(store) = app.store(settings_path(app)) {
        store.set(STORE_KEY_AI, value);
        let _ = store.save();
    }
}

fn read_ui_settings(app: &AppHandle) -> Option<serde_json::Value> {
    let store = app.store(settings_path(app)).ok()?;
    store.get(STORE_KEY_SETTINGS)
}

fn write_ui_settings(app: &AppHandle, value: serde_json::Value) {
    if let Ok(store) = app.store(settings_path(app)) {
        store.set(STORE_KEY_SETTINGS, value);
        let _ = store.save();
    }
}

/// Per-workspace memory is stored as one JSON object keyed by workspace path.
fn read_workspace_memory(app: &AppHandle, key: &str) -> Option<serde_json::Value> {
    let store = app.store(settings_path(app)).ok()?;
    let map = store.get(STORE_KEY_MEMORY)?;
    map.get(key).cloned()
}

fn write_workspace_memory(app: &AppHandle, key: &str, value: serde_json::Value) {
    if let Ok(store) = app.store(settings_path(app)) {
        let mut map = store
            .get(STORE_KEY_MEMORY)
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        map.insert(key.to_string(), value);
        store.set(STORE_KEY_MEMORY, serde_json::Value::Object(map));
        let _ = store.save();
    }
}

/// Self-managed data directory: `%APPDATA%\MDGEM\` (Win), matching the mac
/// shell's `~/Library/Application Support/MDGEM/` so both platforms use the
/// same friendly folder name instead of the bundle id. Unlike `app_data_dir()`
/// (= `data_dir()/com.mdgem.app`), this drops the identifier suffix. NOTE: the
/// `tauri-plugin-window-state` plugin still writes `.window-state.json` under
/// `app_data_dir()` (com.mdgem.app) — it has no dir-override API, so that one
/// file is intentionally left behind there.
fn mdgem_data_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().data_dir().ok()?.join("MDGEM");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// Absolute path to the settings store. Passed to `app.store(...)` so the file
/// lands in `mdgem_data_dir()`; the store plugin resolves a relative path
/// against `app_data_dir()`, but an absolute path replaces that base.
fn settings_path(app: &AppHandle) -> PathBuf {
    mdgem_data_dir(app)
        .map(|d| d.join(STORE_FILE))
        .unwrap_or_else(|| PathBuf::from(STORE_FILE)) // fallback: relative → app_data_dir
}

/// History stores one JSON file per conversation / terminal session under
/// `MDGEM/<scope>/`, plus an `index.json` listing every record's metadata for
/// fast list rendering:
/// ```
/// MDGEM/chat/index.json    [{id,workspace,title,createdAt,updatedAt}, …]
/// MDGEM/chat/<id>.json     {id,workspace,title,createdAt,updatedAt, messages:[…]}
/// MDGEM/term/<id>.json     {id,workspace,createdAt,updatedAt, lines:[{cmd,ts}, …]}
/// ```
/// The front-end owns the record schema; only `META_KEYS` are lifted into the
/// index. `id` comes from the web context and is used as a filename, so it is
/// sanitized to `[A-Za-z0-9_]` to prevent path traversal.
const META_KEYS: &[&str] = &["id", "workspace", "title", "createdAt", "updatedAt"];

fn history_scope_dir(app: &AppHandle, scope: &str) -> Option<PathBuf> {
    let safe = if scope == "chat" || scope == "term" { scope } else { "misc" };
    let dir = mdgem_data_dir(app)?.join(safe);
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

fn sanitized_id(id: &str) -> Option<&str> {
    if !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        Some(id)
    } else {
        None
    }
}

fn record_path(app: &AppHandle, scope: &str, id: &str) -> Option<PathBuf> {
    let dir = history_scope_dir(app, scope)?;
    let safe = sanitized_id(id)?;
    Some(dir.join(format!("{safe}.json")))
}

fn index_path(app: &AppHandle, scope: &str) -> Option<PathBuf> {
    Some(history_scope_dir(app, scope)?.join("index.json"))
}

fn load_index(app: &AppHandle, scope: &str) -> Vec<serde_json::Value> {
    index_path(app, scope)
        .and_then(|p| std::fs::read(&p).ok())
        .and_then(|d| serde_json::from_slice::<Vec<serde_json::Value>>(&d).ok())
        .unwrap_or_default()
}

fn save_index(app: &AppHandle, scope: &str, idx: &[serde_json::Value]) {
    if let (Some(p), Ok(out)) = (index_path(app, scope), serde_json::to_vec(idx)) {
        let _ = std::fs::write(&p, out);
    }
}

/// `index.json` as a JSON array value (always an array, empty if missing).
fn history_list(app: &AppHandle, scope: &str) -> serde_json::Value {
    serde_json::Value::Array(load_index(app, scope))
}

/// One record file (or `null`).
fn history_read(app: &AppHandle, scope: &str, id: &str) -> Option<serde_json::Value> {
    let path = record_path(app, scope, id)?;
    let data = std::fs::read(&path).ok()?;
    serde_json::from_slice(&data).ok()
}

/// Write `<id>.json` and upsert the record's metadata into `index.json`.
fn history_write(app: &AppHandle, scope: &str, id: &str, record: &serde_json::Value) {
    let Some(path) = record_path(app, scope, id) else { return };
    let Ok(out) = serde_json::to_vec(record) else { return };
    let _ = std::fs::write(&path, out);

    let mut meta = serde_json::Map::new();
    if let Some(obj) = record.as_object() {
        for k in META_KEYS {
            if let Some(v) = obj.get(*k) {
                meta.insert((*k).to_string(), v.clone());
            }
        }
    }
    meta.insert("id".into(), serde_json::Value::String(id.to_string())); // authoritative
    let meta = serde_json::Value::Object(meta);

    let mut idx = load_index(app, scope);
    if let Some(slot) = idx
        .iter_mut()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id))
    {
        *slot = meta;
    } else {
        idx.insert(0, meta);
    }
    save_index(app, scope, &idx);
}

/// Delete `<id>.json` and drop its index entry.
fn history_delete(app: &AppHandle, scope: &str, id: &str) {
    if let Some(path) = record_path(app, scope, id) {
        let _ = std::fs::remove_file(&path);
    }
    if sanitized_id(id).is_none() {
        return;
    }
    let mut idx = load_index(app, scope);
    idx.retain(|e| e.get("id").and_then(|v| v.as_str()) != Some(id));
    save_index(app, scope, &idx);
}

/// A tool call assembled across streamed deltas, keyed by `index`.
#[derive(Default)]
struct ToolAcc {
    id: String,
    name: String,
    args: String,
}

/// Streaming OpenAI-compatible chat turn. Sends `stream:true` + `tools`, parses
/// the SSE response, forwards text deltas through `on_delta`, and returns the
/// final `(content, toolCalls)` where toolCalls is a JSON array of
/// `{id, name, arguments}` (or Null). All providers share this `/chat/
/// completions` shape. Runs on a worker thread (never the UI thread).
fn ai_chat_stream(
    config: &serde_json::Value,
    messages: serde_json::Value,
    tools: &serde_json::Value,
    mut on_delta: impl FnMut(&str),
) -> Result<(String, serde_json::Value), String> {
    let base = config
        .get("baseURL")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or("AI is not configured yet")?;
    let model = config
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("AI is not configured yet")?;
    let key = config
        .get("apiKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("AI is not configured yet")?;

    let endpoint = format!("{}/chat/completions", base.trim_end_matches('/'));
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if let Some(t) = config.get("temperature").and_then(|v| v.as_f64()) {
        body["temperature"] = serde_json::json!(t);
    }
    if tools.is_array() && !tools.as_array().map(|a| a.is_empty()).unwrap_or(true) {
        body["tools"] = tools.clone();
        body["tool_choice"] = serde_json::Value::String("auto".into());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&endpoint)
        .bearer_auth(key)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let raw = resp.text().unwrap_or_default();
        let msg = serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|j| {
                j.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(msg);
    }

    let mut content = String::new();
    let mut accs: BTreeMap<i64, ToolAcc> = BTreeMap::new();
    let reader = BufReader::new(resp);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let payload = match line.strip_prefix("data:") {
            Some(p) => p.trim(),
            None => continue,
        };
        if payload.is_empty() {
            continue;
        }
        if payload == "[DONE]" {
            break;
        }
        let obj: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let delta = match obj
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
        {
            Some(d) => d,
            None => continue,
        };
        if let Some(piece) = delta.get("content").and_then(|c| c.as_str()) {
            if !piece.is_empty() {
                content.push_str(piece);
                on_delta(piece);
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
            for call in calls {
                let idx = call.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
                let acc = accs.entry(idx).or_default();
                if let Some(id) = call.get("id").and_then(|i| i.as_str()) {
                    if !id.is_empty() {
                        acc.id = id.to_string();
                    }
                }
                if let Some(func) = call.get("function") {
                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                        if !name.is_empty() {
                            acc.name = name.to_string();
                        }
                    }
                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                        acc.args.push_str(args);
                    }
                }
            }
        }
    }

    let tool_calls: Vec<serde_json::Value> = accs
        .into_values()
        .filter(|a| !a.name.is_empty())
        .map(|a| serde_json::json!({ "id": a.id, "name": a.name, "arguments": a.args }))
        .collect();
    let tool_calls = if tool_calls.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::Value::Array(tool_calls)
    };
    Ok((content, tool_calls))
}

/// Native side of the AI agent's tools (the file read/write tools reuse the
/// existing read-file-text / write-file IPC; these need fs-walk / process /
/// network). Returns `(ok, text)` where text is fed back to the model.
fn run_agent_tool(name: &str, args: &serde_json::Value) -> (bool, String) {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "list_dir" => (true, tool_list_dir(&s("path"))),
        "search" => (true, tool_search(&s("query"), &s("path"))),
        "run_command" => tool_run_command(&s("command"), &s("cwd")),
        "web_search" => tool_web_search(&s("query")),
        other => (false, format!("Unknown tool: {other}")),
    }
}

/// One level of directory entries, folders suffixed with `/`.
fn tool_list_dir(path: &str) -> String {
    if path.is_empty() {
        return "Error: missing path".into();
    }
    let dir = Path::new(path);
    if !dir.is_dir() {
        return format!("Error: not a directory: {path}");
    }
    let mut entries: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if e.path().is_dir() {
                    format!("{name}/")
                } else {
                    name
                }
            })
            .collect(),
        Err(e) => return format!("Error: cannot list {path}: {e}"),
    };
    if entries.is_empty() {
        return "(empty directory)".into();
    }
    entries.sort();
    entries.join("\n")
}

const SEARCH_MAX_MATCHES: usize = 80;
const SEARCH_MAX_FILE_BYTES: u64 = 1_000_000;

/// Case-insensitive substring grep over text files under `root`, skipping hidden
/// entries and the lazy (node_modules/build/…) directories.
fn tool_search(query: &str, root: &str) -> String {
    let needle = query.trim();
    if needle.is_empty() {
        return "Error: empty search query.".into();
    }
    let root_path = if root.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(root)
    };
    let lower = needle.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    search_dir(&root_path, &root_path, &lower, &mut out, &mut truncated);
    if out.is_empty() {
        return format!("No matches for \"{needle}\".");
    }
    let mut result = out.join("\n");
    if truncated {
        result.push_str(&format!("\n… (truncated at {SEARCH_MAX_MATCHES} matches)"));
    }
    result
}

fn search_dir(dir: &Path, root: &Path, lower: &str, out: &mut Vec<String>, truncated: &mut bool) {
    if *truncated {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        if *truncated {
            return;
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if !is_lazy_dir_name(&name) {
                search_dir(&path, root, lower, out, truncated);
            }
            continue;
        }
        let too_big = std::fs::metadata(&path)
            .map(|m| m.len() > SEARCH_MAX_FILE_BYTES)
            .unwrap_or(true);
        if too_big {
            continue;
        }
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue, // not UTF-8 / unreadable
        };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(lower) {
                let snippet: String = line.trim().chars().take(200).collect();
                out.push(format!("{rel}:{}: {snippet}", i + 1));
                if out.len() >= SEARCH_MAX_MATCHES {
                    *truncated = true;
                    return;
                }
            }
        }
    }
}

const CMD_MAX_OUTPUT: usize = 20_000;

/// Run a one-shot shell command and return merged stdout+stderr. The JS layer
/// already obtained user approval. Cross-platform: cmd on Windows, sh elsewhere
/// (dev runs on macOS).
fn tool_run_command(command: &str, cwd: &str) -> (bool, String) {
    let cmd = command.trim();
    if cmd.is_empty() {
        return (false, "Error: empty command".into());
    }
    let mut builder = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", cmd]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-lc", cmd]);
        c
    };
    if !cwd.is_empty() {
        builder.current_dir(cwd);
    }
    match builder.output() {
        Ok(output) => {
            let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
            let err = String::from_utf8_lossy(&output.stderr);
            if !err.is_empty() {
                if !combined.is_empty() {
                    combined.push('\n');
                }
                combined.push_str(&err);
            }
            if combined.len() > CMD_MAX_OUTPUT {
                combined.truncate(CMD_MAX_OUTPUT);
                combined.push_str("\n… (output truncated)");
            }
            let code = output.status.code().unwrap_or(-1);
            let body = if combined.is_empty() { "(no output)".into() } else { combined };
            (output.status.success(), format!("exit code: {code}\n{body}"))
        }
        Err(e) => (false, format!("Error: {e}")),
    }
}

const WEB_MAX_RESULTS: usize = 6;

/// Best-effort public web search by scraping DuckDuckGo's HTML endpoint (no API
/// key). Swap for a keyed provider later if reliability matters.
fn tool_web_search(query: &str) -> (bool, String) {
    let q = query.trim();
    if q.is_empty() {
        return (false, "Error: empty query".into());
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => return (false, format!("Error: {e}")),
    };
    let resp = client
        .get("https://html.duckduckgo.com/html/")
        .query(&[("q", q)])
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        )
        .send();
    let html = match resp.and_then(|r| r.text()) {
        Ok(t) => t,
        Err(e) => return (false, format!("Error: {e}")),
    };
    let parsed = parse_duckduckgo(&html);
    if parsed.is_empty() {
        (true, "No results found.".into())
    } else {
        (true, parsed)
    }
}

/// Pull result links + snippets out of DuckDuckGo HTML without a regex crate.
fn parse_duckduckgo(html: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for (idx, seg) in html.split("result__a").enumerate().skip(1) {
        if idx > WEB_MAX_RESULTS {
            break;
        }
        // href and link text live right after the class marker.
        let href = slice_between(seg, "href=\"", "\"").unwrap_or_default();
        let title_raw = slice_between(seg, ">", "</a>").unwrap_or_default();
        let title = strip_tags(&title_raw);
        if title.is_empty() {
            continue;
        }
        let url = decode_redirect(&href);
        let snippet = seg
            .find("result__snippet")
            .and_then(|p| slice_between(&seg[p..], ">", "</a>"))
            .map(|s| strip_tags(&s))
            .unwrap_or_default();
        let mut entry = format!("{}. {title}\n   {url}", out.len() + 1);
        if !snippet.is_empty() {
            entry.push_str(&format!("\n   {snippet}"));
        }
        out.push(entry);
    }
    out.join("\n\n")
}

fn slice_between(s: &str, start: &str, end: &str) -> Option<String> {
    let a = s.find(start)? + start.len();
    let rest = &s[a..];
    let b = rest.find(end)?;
    Some(rest[..b].to_string())
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

/// DuckDuckGo wraps result URLs as `…/l/?uddg=<percent-encoded real url>`.
fn decode_redirect(href: &str) -> String {
    let full = if let Some(stripped) = href.strip_prefix("//") {
        format!("https:{stripped}")
    } else {
        href.to_string()
    };
    if let Ok(parsed) = Url::parse(&full) {
        if let Some((_, value)) = parsed.query_pairs().find(|(k, _)| k == "uddg") {
            return value.to_string();
        }
    }
    full
}

fn read_zoom_pref(app: &AppHandle) -> f64 {
    if let Ok(store) = app.store(settings_path(app)) {
        if let Some(v) = store.get(STORE_KEY_ZOOM) {
            if let Some(n) = v.as_f64() {
                return n.clamp(0.4, 3.0);
            }
        }
    }
    1.0
}

fn write_zoom_pref(app: &AppHandle, value: f64) {
    if let Ok(store) = app.store(settings_path(app)) {
        store.set(STORE_KEY_ZOOM, serde_json::json!(value));
        let _ = store.save();
    }
}

fn push_zoom(window: &WebviewWindow, value: f64) {
    let js = format!(
        "window.__mdr_zoom = {z}; document.body.style.zoom = {z};",
        z = value
    );
    let _ = window.eval(&js);
}

fn effective_theme_name(app: &AppHandle, window: &WebviewWindow) -> &'static str {
    match read_theme_pref(app).as_str() {
        "light" => "light",
        "dark" => "dark",
        _ => match window.theme().unwrap_or(tauri::Theme::Light) {
            tauri::Theme::Dark => "dark",
            _ => "light",
        },
    }
}

fn push_theme(window: &WebviewWindow, name: &str, pref: &str) {
    let payload = ThemePayload {
        name: name.to_string(),
        pref: pref.to_string(),
    };
    let _ = window.emit("mdreader:theme", payload);
    let theme = if name == "dark" {
        Some(tauri::Theme::Dark)
    } else {
        Some(tauri::Theme::Light)
    };
    let _ = window.set_theme(theme);
}

fn display_name(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.to_string_lossy().to_string())
}

fn is_lazy_dir_name(name: &str) -> bool {
    LAZY_DIR_NAMES.iter().any(|n| *n == name)
}

/// Read + sort the immediate children of `dir`, applying the same hidden-file
/// + lazy-dir rules as the full scan.
fn scan_children(dir: &Path) -> Vec<FileTreeNode> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|r| r.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|s| s.to_str())
                .map(|s| !s.starts_with('.'))
                .unwrap_or(false)
        })
        .collect();
    paths.sort_by(|a, b| {
        let a_dir = a.is_dir();
        let b_dir = b.is_dir();
        if a_dir != b_dir {
            return if a_dir {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });
    let mut out = Vec::new();
    for p in paths {
        if let Some(n) = scan_tree(&p, false) {
            out.push(n);
        }
    }
    out
}

fn scan_tree(url: &Path, is_root: bool) -> Option<FileTreeNode> {
    let metadata = std::fs::metadata(url).ok()?;
    if metadata.is_dir() {
        // Heavy directory → stub with lazy=true. Root is exempt so opening a
        // file directly inside e.g. `node_modules` still shows a populated
        // sidebar.
        let name = display_name(url);
        if !is_root && is_lazy_dir_name(&name) {
            return Some(FileTreeNode {
                kind: "dir".to_string(),
                name,
                path: url.to_string_lossy().to_string(),
                children: None,
                lazy: Some(true),
            });
        }
        let children = scan_children(url);
        if !is_root && children.is_empty() {
            return None;
        }
        Some(FileTreeNode {
            kind: "dir".to_string(),
            name,
            path: url.to_string_lossy().to_string(),
            children: Some(children),
            lazy: None,
        })
    } else {
        // IDE-style tree: emit every regular file, not just markdown. The
        // front-end decides how (or whether) to preview it by extension.
        Some(FileTreeNode {
            kind: "file".to_string(),
            name: display_name(url),
            path: url.to_string_lossy().to_string(),
            children: None,
            lazy: None,
        })
    }
}

fn push_file_tree(window: &WebviewWindow, workspace_root: &Path, current: Option<&Path>) {
    let Some(root) = scan_tree(workspace_root, true) else {
        return;
    };
    let payload = FileTreePayload {
        root,
        current: current.map(|p| p.to_string_lossy().to_string()),
    };
    let _ = window.emit("mdreader:file-tree", payload);
}

/// Spawn a recursive FS watcher rooted at `root` and a consumer thread that
/// coalesces events inside a 300ms window before refreshing the sidebar tree
/// and (when relevant) re-rendering the currently open file.
fn start_watcher(app: AppHandle, root: PathBuf) -> Option<RecommendedWatcher> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(
        move |res: notify::Result<notify::Event>| {
            // If the receiver was dropped (workspace replaced) the send fails
            // and the watcher will be torn down by its owner.
            let _ = tx.send(res);
        },
    )
    .ok()?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .ok()?;

    let app_handle = app;
    std::thread::spawn(move || {
        use std::time::{Duration, Instant};
        let debounce = Duration::from_millis(300);
        loop {
            let first = match rx.recv() {
                Ok(v) => v,
                Err(_) => break, // watcher dropped; thread exits cleanly
            };
            let mut paths: Vec<PathBuf> = Vec::new();
            if let Ok(ev) = first {
                paths.extend(ev.paths);
            }
            // Drain everything that arrives inside the debounce window so a
            // burst of writes (npm install, git checkout…) lands in one
            // refresh instead of N.
            let deadline = Instant::now() + debounce;
            loop {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    break;
                };
                match rx.recv_timeout(remaining) {
                    Ok(Ok(ev)) => paths.extend(ev.paths),
                    Ok(Err(_)) => {}
                    Err(_) => break, // timeout or channel closed
                }
            }
            handle_fs_change(&app_handle, paths);
        }
    });
    Some(watcher)
}

fn handle_fs_change(app: &AppHandle, paths: Vec<PathBuf>) {
    refresh_tree(app);
    let state = app.state::<OpenState>();
    let current = state.current_file.lock().unwrap().clone();
    let Some(cur) = current else { return };
    let cur_canon = std::fs::canonicalize(&cur).unwrap_or_else(|_| cur.clone());
    let touched = paths.iter().any(|p| {
        std::fs::canonicalize(p)
            .map(|c| c == cur_canon)
            .unwrap_or(false)
    });
    if touched {
        if let Some(w) = app.get_webview_window("main") {
            let _ = push_render(&w, &cur);
        }
    }
}

/// Set the workspace root and (re)start the FS watcher. Pass `None` to clear.
fn set_workspace_root(app: &AppHandle, root: Option<PathBuf>) {
    let state = app.state::<OpenState>();
    // Drop the old watcher *first* so its sender closes and the consumer
    // thread exits before a fresh one starts.
    *state.watcher.lock().unwrap() = None;
    *state.workspace_root.lock().unwrap() = root.clone();
    if let Some(path) = root {
        *state.watcher.lock().unwrap() = start_watcher(app.clone(), path);
    }
}

fn refresh_tree(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let state = app.state::<OpenState>();
    let root = state.workspace_root.lock().unwrap().clone();
    let current = state.current_file.lock().unwrap().clone();
    if let Some(root) = root {
        push_file_tree(&w, &root, current.as_deref());
    }
}

fn push_render(window: &WebviewWindow, path: &Path) -> Result<(), String> {
    let text = read_text(path)?;
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    // Encode the directory as a file:// URL; JS will rewrite image src to the
    // asset:// protocol so the WebView2/WKWebView page can actually fetch them.
    let base_url = Url::from_directory_path(parent)
        .map(|u| u.to_string())
        .unwrap_or_default();
    let payload = RenderPayload {
        text,
        base_dir: base_url,
    };
    window
        .emit("mdreader:render", payload)
        .map_err(|e| e.to_string())?;

    let title = path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| format!("{s} — MDGEM"))
        .unwrap_or_else(|| "MDGEM".to_string());
    let _ = window.set_title(&title);
    Ok(())
}

/// Branch on whether the user pointed us at a file or a directory:
/// - File → existing `load_file` path.
/// - Directory → set workspace_root, auto-open a sensible md inside (if any),
///   and push the file tree so the sidebar comes up populated.
fn load_target(window: &WebviewWindow, path: PathBuf, mode: LoadMode) {
    if path.is_dir() {
        let app = window.app_handle().clone();
        if matches!(mode, LoadMode::NewWorkspace) {
            set_workspace_root(&app, Some(path.clone()));
        }
        if let Some(pick) = find_default_md_in_dir(&path) {
            // Reuse load_file but keep the workspace we just set — sidebar
            // click semantics, not "new workspace from a file's parent".
            load_file(window, pick, LoadMode::KeepWorkspace);
        } else {
            // Folder with no md inside: clear the current document and just
            // refresh the tree.
            let state = app.state::<OpenState>();
            *state.current_file.lock().unwrap() = None;
            let root = state.workspace_root.lock().unwrap().clone();
            if let Some(root) = root {
                push_file_tree(window, &root, None);
            }
        }
    } else {
        load_file(window, path, mode);
    }
}

fn load_file(window: &WebviewWindow, path: PathBuf, mode: LoadMode) {
    let app = window.app_handle().clone();
    if let Err(err) = push_render(window, &path) {
        let _ = app
            .dialog()
            .message(format!("Could not open file:\n{}\n\n{err}", path.display()))
            .kind(tauri_plugin_dialog::MessageDialogKind::Error)
            .title("MDGEM")
            .blocking_show();
        return;
    }
    if matches!(mode, LoadMode::NewWorkspace) {
        let new_root = path.parent().map(|p| p.to_path_buf());
        set_workspace_root(&app, new_root);
    }
    let state = app.state::<OpenState>();
    *state.current_file.lock().unwrap() = Some(path.clone());
    let root = state.workspace_root.lock().unwrap().clone();
    if let Some(root) = root {
        push_file_tree(window, &root, Some(&path));
    }
    add_recent(&app, &path);
}

fn open_file_dialog(window: WebviewWindow) {
    let app = window.app_handle().clone();
    app.dialog()
        .file()
        .add_filter("Markdown", MD_EXTS)
        .pick_file(move |selection| {
            let Some(file) = selection else { return };
            let path = match file {
                FilePath::Path(p) => p,
                FilePath::Url(u) => match u.to_file_path() {
                    Ok(p) => p,
                    Err(_) => return,
                },
            };
            let w = window.clone();
            window
                .run_on_main_thread(move || load_file(&w, path, LoadMode::NewWorkspace))
                .ok();
        });
}

/// Pick a folder to open as a workspace (no markdown file required).
fn open_folder_dialog(window: WebviewWindow) {
    let app = window.app_handle().clone();
    app.dialog().file().pick_folder(move |selection| {
        let Some(folder) = selection else { return };
        let path = match folder {
            FilePath::Path(p) => p,
            FilePath::Url(u) => match u.to_file_path() {
                Ok(p) => p,
                Err(_) => return,
            },
        };
        let w = window.clone();
        window
            .run_on_main_thread(move || load_target(&w, path, LoadMode::NewWorkspace))
            .ok();
    });
}

fn toast(window: &WebviewWindow, message: &str, kind: &str) {
    let m = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".to_string());
    let k = serde_json::to_string(kind).unwrap_or_else(|_| "\"info\"".to_string());
    let _ = window.eval(&format!(
        "window.MDViewerAPI && window.MDViewerAPI.toast && window.MDViewerAPI.toast({m}, {k});"
    ));
}

fn reveal_in_explorer(path: &Path) {
    let p = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer.exe")
            .arg(format!("/select,{}", p))
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        // Useful when developers run `cargo run` on a Mac to smoke-test logic.
        let _ = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if let Some(dir) = path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    }
}

fn handle_fs_op(app: &AppHandle, op: FsOp) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let path = PathBuf::from(&op.path);
    match op.op.as_str() {
        "reveal" => {
            reveal_in_explorer(&path);
        }
        "copyPath" => {
            // JS already tried navigator.clipboard.writeText and asked us to
            // do it via the platform clipboard.
            let json = serde_json::to_string(&op.path).unwrap_or_default();
            let _ = w.eval(&format!(
                "navigator.clipboard.writeText({json}).then(()=>window.MDViewerAPI.toast('Path copied','info'),()=>window.MDViewerAPI.toast('Could not copy','error'));"
            ));
        }
        "rename" => {
            let Some(new_name) = op.new_name.filter(|s| !s.trim().is_empty()) else {
                toast(&w, "Invalid name", "error");
                return;
            };
            if new_name.contains('/') || new_name.contains('\\') {
                toast(&w, "Name cannot contain / or \\", "error");
                return;
            }
            let parent = path.parent().unwrap_or_else(|| Path::new(""));
            let dst = parent.join(&new_name);
            if dst.exists() {
                toast(&w, "A file with that name already exists", "error");
                return;
            }
            match std::fs::rename(&path, &dst) {
                Ok(_) => {
                    let state = app.state::<OpenState>();
                    let was_current = {
                        let mut cur = state.current_file.lock().unwrap();
                        if cur.as_deref() == Some(path.as_path()) {
                            *cur = Some(dst.clone());
                            true
                        } else {
                            false
                        }
                    };
                    if was_current {
                        let title = dst
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|s| format!("{s} — MDGEM"))
                            .unwrap_or_else(|| "MDGEM".to_string());
                        let _ = w.set_title(&title);
                    }
                    refresh_tree(app);
                    toast(&w, "Renamed", "info");
                }
                Err(e) => toast(&w, &format!("Rename failed: {e}"), "error"),
            }
        }
        "delete" => {
            let state = app.state::<OpenState>();
            let is_current = state.current_file.lock().unwrap().as_deref() == Some(path.as_path());
            if is_current {
                toast(&w, "Close the file before deleting it", "error");
                return;
            }
            match trash::delete(&path) {
                Ok(_) => {
                    refresh_tree(app);
                    toast(&w, "Moved to Recycle Bin", "info");
                }
                Err(e) => toast(&w, &format!("Delete failed: {e}"), "error"),
            }
        }
        "newFile" | "newFolder" => {
            let Some(name) = op.new_name
                .as_ref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
            else {
                toast(&w, "Invalid name", "error");
                return;
            };
            if name.contains('/') || name.contains('\\') {
                toast(&w, "Name cannot contain / or \\", "error");
                return;
            }
            let dst = path.join(&name);
            if dst.exists() {
                toast(&w, "Already exists", "error");
                return;
            }
            let result = if op.op == "newFolder" {
                std::fs::create_dir(&dst)
            } else {
                std::fs::write(&dst, "")
            };
            match result {
                Ok(_) => {
                    refresh_tree(app);
                    toast(&w, "Created", "info");
                }
                Err(e) => toast(&w, &format!("Create failed: {e}"), "error"),
            }
        }
        _ => {}
    }
}

fn rebuild_menu(app: &AppHandle) -> tauri::Result<()> {
    let theme_pref = read_theme_pref(app);
    let is = |v: &str| theme_pref == v;

    let open = MenuItemBuilder::with_id("open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("openFolder", "Open Folder…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit MDGEM")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&open_folder)
        .separator()
        .item(&quit)
        .build()?;

    let copy = MenuItemBuilder::with_id("copy", "Copy")
        .accelerator("CmdOrCtrl+C")
        .build(app)?;
    let select_all = MenuItemBuilder::with_id("selectAll", "Select All")
        .accelerator("CmdOrCtrl+A")
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&copy)
        .item(&select_all)
        .build()?;

    let theme_system = CheckMenuItemBuilder::with_id("theme:system", "Follow System")
        .checked(is("system"))
        .build(app)?;
    let theme_light = CheckMenuItemBuilder::with_id("theme:light", "Light")
        .checked(is("light"))
        .build(app)?;
    let theme_dark = CheckMenuItemBuilder::with_id("theme:dark", "Dark")
        .checked(is("dark"))
        .build(app)?;
    let appearance = SubmenuBuilder::new(app, "Appearance")
        .item(&theme_system)
        .item(&theme_light)
        .item(&theme_dark)
        .build()?;

    let zoom_in = MenuItemBuilder::with_id("zoomIn", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoomOut", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoomReset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;

    let toggle_sidebar = MenuItemBuilder::with_id("toggleSidebar", "Toggle Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .separator()
        .item(&appearance)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .build()?;

    let about = MenuItemBuilder::with_id("about", "About MDGEM").build(app)?;
    let help_menu = SubmenuBuilder::new(app, "Help").item(&about).build()?;

    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&help_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    let window = app.get_webview_window("main");
    match id {
        "open" => {
            if let Some(w) = window {
                open_file_dialog(w);
            }
        }
        "openFolder" => {
            if let Some(w) = window {
                open_folder_dialog(w);
            }
        }
        "quit" => app.exit(0),
        "copy" => {
            if let Some(w) = window {
                let _ = w.eval("document.execCommand('copy')");
            }
        }
        "selectAll" => {
            if let Some(w) = window {
                let _ = w.eval(
                    "window.MDViewerAPI && window.MDViewerAPI.selectAllContent ? window.MDViewerAPI.selectAllContent() : document.execCommand('selectAll')",
                );
            }
        }
        "zoomIn" | "zoomOut" | "zoomReset" => {
            if let Some(w) = window {
                let cur = read_zoom_pref(app);
                let next = match id {
                    "zoomIn" => (cur + 0.1).min(3.0),
                    "zoomOut" => (cur - 0.1).max(0.4),
                    _ => 1.0,
                };
                // Round to 2 decimals so repeated steps don't drift (0.1+0.1 → 0.2…).
                let next = (next * 100.0).round() / 100.0;
                write_zoom_pref(app, next);
                push_zoom(&w, next);
            }
        }
        "toggleSidebar" => {
            if let Some(w) = window {
                let _ = w.eval(
                    "window.MDViewerAPI && window.MDViewerAPI.toggleSidebar && window.MDViewerAPI.toggleSidebar();",
                );
            }
        }
        "theme:system" | "theme:light" | "theme:dark" => {
            let value = &id["theme:".len()..];
            write_theme_pref(app, value);
            if let Some(w) = app.get_webview_window("main") {
                let name = effective_theme_name(app, &w);
                push_theme(&w, name, value);
            }
            let _ = rebuild_menu(app);
        }
        "about" => {
            let _ = app
                .dialog()
                .message("MDGEM 0.1.0\nMarkdown — a tiny gem for reading .md files.\n\nCopyright © 2026")
                .title("About MDGEM")
                .kind(tauri_plugin_dialog::MessageDialogKind::Info)
                .show(|_| {});
        }
        _ => {}
    }
}

fn handle_drop(app: &AppHandle, paths: Vec<PathBuf>) {
    // Prefer an actual .md drop (most explicit intent); fall back to a
    // dropped directory (treat as workspace).
    let pick = paths
        .iter()
        .find(|p| is_markdown_path(p))
        .cloned()
        .or_else(|| paths.into_iter().find(|p| p.is_dir()));
    if let Some(p) = pick {
        if let Some(w) = app.get_webview_window("main") {
            load_target(&w, p, LoadMode::NewWorkspace);
        }
    }
}

/// Spawn a pseudo-terminal running the platform default shell, keyed by `id`.
/// A per-terminal reader thread streams output as `mdreader:term-data` and
/// emits `mdreader:term-exit` when the shell ends.
fn term_create(app: &AppHandle, req: TermCreate) {
    let cols = req.cols.unwrap_or(80).max(1);
    let rows = req.rows.unwrap_or(24).max(1);
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(size) {
        Ok(p) => p,
        Err(_) => return,
    };
    let mut cmd = CommandBuilder::new_default_prog();
    if let Some(cwd) = req.cwd.as_ref() {
        if !cwd.is_empty() && Path::new(cwd).is_dir() {
            cmd.cwd(cwd);
        }
    }
    cmd.env("TERM", "xterm-256color");
    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(_) => return,
    };
    let mut reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(_) => return,
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(_) => return,
    };

    {
        let state = app.state::<TermState>();
        state.map.lock().unwrap().insert(
            req.id.clone(),
            TermHandle {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let app2 = app.clone();
    let id = req.id;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // Carries the trailing bytes of a multibyte UTF-8 char split across a
        // read boundary, so it completes on the next read instead of becoming `�`.
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    // Decode the valid prefix; hold an unfinished trailing char back.
                    let (data, consume) = match std::str::from_utf8(&carry) {
                        Ok(s) => (s.to_string(), carry.len()),
                        Err(e) => {
                            let vut = e.valid_up_to();
                            match e.error_len() {
                                // Truncated char at the end: keep the tail in `carry`.
                                None => (
                                    String::from_utf8_lossy(&carry[..vut]).to_string(),
                                    vut,
                                ),
                                // Genuinely invalid bytes mid-stream: emit through
                                // them lossily so the stream keeps making progress.
                                Some(bad) => (
                                    String::from_utf8_lossy(&carry[..vut + bad]).to_string(),
                                    vut + bad,
                                ),
                            }
                        }
                    };
                    carry.drain(..consume);
                    if !data.is_empty() {
                        if let Some(w) = app2.get_webview_window("main") {
                            let _ = w.emit(
                                "mdreader:term-data",
                                TermDataPayload {
                                    id: id.clone(),
                                    data,
                                },
                            );
                        }
                    }
                }
            }
        }
        // Shell ended: drop the handle and report the exit code.
        let code = {
            let st = app2.state::<TermState>();
            let mut map = st.map.lock().unwrap();
            match map.remove(&id) {
                Some(mut th) => th
                    .child
                    .wait()
                    .ok()
                    .map(|s| s.exit_code() as i32)
                    .unwrap_or(-1),
                None => -1,
            }
        };
        if let Some(w) = app2.get_webview_window("main") {
            let _ = w.emit("mdreader:term-exit", TermExitPayload { id, code });
        }
    });
}

const BRIDGE_JS: &str = include_str!("bridge.js");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_target = pick_target_from_args(std::env::args());

    let app = tauri::Builder::default()
        .manage(OpenState::default())
        .manage(TermState::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if let Some(p) = pick_target_from_args(argv) {
                    load_target(&w, p, LoadMode::NewWorkspace);
                }
            }
        }))
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                let app = window.app_handle().clone();
                let paths = paths.clone();
                handle_drop(&app, paths);
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = rebuild_menu(&handle);

            // Queue any argv target before window opens; JS will pull it once
            // ready. For directories the workspace IS the target; we also
            // pre-pick a default README/first-md so the viewer comes up with
            // something to show.
            if let Some(p) = initial_target.clone() {
                if p.is_dir() {
                    set_workspace_root(&handle, Some(p.clone()));
                    let picked = find_default_md_in_dir(&p);
                    if let Some(file) = picked.as_ref() {
                        add_recent(&handle, file);
                    }
                    let state = handle.state::<OpenState>();
                    *state.current_file.lock().unwrap() = picked;
                } else {
                    set_workspace_root(&handle, p.parent().map(|x| x.to_path_buf()));
                    let state = handle.state::<OpenState>();
                    *state.current_file.lock().unwrap() = Some(p.clone());
                    add_recent(&handle, &p);
                }
            }
            // Drop stale recents (files removed since last session) before the
            // page reads them — keeps the menu honest at startup.
            prune_recents(&handle);

            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("viewer.html".into()),
            )
            .title("MDGEM")
            .inner_size(900.0, 720.0)
            .min_inner_size(520.0, 360.0)
            .resizable(true)
            .initialization_script(BRIDGE_JS)
            .build()?;

            // JS bridge tells us when it's ready; push theme + pending file + tree.
            let h_ready = handle.clone();
            handle.listen_any("mdreader:ready", move |_event| {
                if let Some(w) = h_ready.get_webview_window("main") {
                    let pref = read_theme_pref(&h_ready);
                    let name = effective_theme_name(&h_ready, &w);
                    push_theme(&w, name, &pref);
                    push_zoom(&w, read_zoom_pref(&h_ready));
                    push_recents(&w, &read_recents(&h_ready));
                    let state = h_ready.state::<OpenState>();
                    let pending = state.current_file.lock().unwrap().clone();
                    let root = state.workspace_root.lock().unwrap().clone();
                    if let Some(p) = pending.as_ref() {
                        let _ = push_render(&w, p);
                    }
                    if let Some(root) = root {
                        push_file_tree(&w, &root, pending.as_deref());
                    }
                }
            });

            // External-link forwarder: JS catches link clicks and emits the URL.
            let h_link = handle.clone();
            handle.listen_any("mdreader:open-external", move |event| {
                let raw: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if !raw.is_empty() {
                    let _ = h_link.opener().open_url(raw, None::<&str>);
                }
            });

            // Home-page "Open File" / "Open Folder" buttons → native dialog.
            let h_ofile = handle.clone();
            handle.listen_any("mdreader:open-file-dialog", move |_event| {
                if let Some(w) = h_ofile.get_webview_window("main") {
                    open_file_dialog(w);
                }
            });
            let h_ofolder = handle.clone();
            handle.listen_any("mdreader:open-folder-dialog", move |_event| {
                if let Some(w) = h_ofolder.get_webview_window("main") {
                    open_folder_dialog(w);
                }
            });

            // Sidebar file-click forwarder: open inside the existing workspace.
            let h_open = handle.clone();
            handle.listen_any("mdreader:open-file", move |event| {
                let raw: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if raw.is_empty() {
                    return;
                }
                if let Some(w) = h_open.get_webview_window("main") {
                    load_file(&w, PathBuf::from(raw), LoadMode::KeepWorkspace);
                }
            });

            // File-system ops from the sidebar context menu.
            let h_op = handle.clone();
            handle.listen_any("mdreader:fs-op", move |event| {
                let op: FsOp = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                handle_fs_op(&h_op, op);
            });

            // Lazy-folder expansion: JS asks for the immediate children of a
            // single directory. Run on a worker thread so large folders don't
            // block the event loop.
            let h_scan = handle.clone();
            handle.listen_any("mdreader:scan-dir", move |event| {
                let req: ScanDirRequest = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let h = h_scan.clone();
                std::thread::spawn(move || {
                    let path = PathBuf::from(&req.path);
                    let children = if path.is_dir() {
                        scan_children(&path)
                    } else {
                        Vec::new()
                    };
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.emit(
                            "mdreader:scan-dir-result",
                            ScanDirResult {
                                req_id: req.req_id,
                                path: req.path,
                                children,
                            },
                        );
                    }
                });
            });

            // Text/code preview: JS asks for a file's contents. Read on a
            // worker thread, cap the size, and emit the result back.
            let h_read = handle.clone();
            handle.listen_any("mdreader:read-file-text", move |event| {
                let req: ReadFileRequest = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let h = h_read.clone();
                std::thread::spawn(move || {
                    let path = PathBuf::from(&req.path);
                    let result = match std::fs::metadata(&path) {
                        Ok(meta) if meta.len() > MAX_PREVIEW_BYTES => ReadFileResult {
                            req_id: req.req_id.clone(),
                            path: req.path.clone(),
                            ok: false,
                            text: None,
                            error: Some("File too large to preview".to_string()),
                        },
                        _ => match read_text(&path) {
                            Ok(text) => ReadFileResult {
                                req_id: req.req_id.clone(),
                                path: req.path.clone(),
                                ok: true,
                                text: Some(text),
                                error: None,
                            },
                            Err(e) => ReadFileResult {
                                req_id: req.req_id.clone(),
                                path: req.path.clone(),
                                ok: false,
                                text: None,
                                error: Some(e),
                            },
                        },
                    };
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.emit("mdreader:read-file-result", result);
                    }
                });
            });

            // AI: return the stored provider config (or null). Broadcast so the
            // requesting window (main or settings) receives it.
            let h_aicfg = handle.clone();
            handle.listen_any("mdreader:ai-get-config", move |event| {
                let req: ReqIdOnly = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let config = read_ai_config(&h_aicfg);
                let _ = h_aicfg.emit(
                    "mdreader:ai-config",
                    AiConfigPayload { req_id: req.req_id, config },
                );
            });

            // AI: persist the provider config, then broadcast so open windows
            // (the AI panel) refresh live.
            let h_aiset = handle.clone();
            handle.listen_any("mdreader:ai-set-config", move |event| {
                let req: AiSetConfig = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                write_ai_config(&h_aiset, req.config.clone());
                let _ = h_aiset.emit("mdreader:ai-config-changed", req.config);
            });

            // Settings: return the stored global UI settings blob (or null).
            // Broadcast so the requesting window (main or settings) receives it;
            // only the one holding the matching reqId resolves.
            let h_setget = handle.clone();
            handle.listen_any("mdreader:settings-get", move |event| {
                let req: ReqIdOnly = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let settings = read_ui_settings(&h_setget);
                let _ = h_setget.emit(
                    "mdreader:settings",
                    SettingsPayload { req_id: req.req_id, settings },
                );
            });

            // Settings: persist the global UI settings blob, then broadcast the
            // change to every window so open project windows apply it live.
            let h_setset = handle.clone();
            handle.listen_any("mdreader:settings-set", move |event| {
                let req: SettingsSet = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                write_ui_settings(&h_setset, req.settings.clone());
                let _ = h_setset.emit("mdreader:settings-changed", req.settings);
            });

            // Open (or focus) the standalone settings window, optionally jumping
            // to a section (#appearance/#ai/#editor/#shortcuts).
            let h_openset = handle.clone();
            handle.listen_any("mdreader:open-settings", move |event| {
                let section = serde_json::from_str::<serde_json::Value>(event.payload())
                    .ok()
                    .and_then(|v| v.get("section").and_then(|s| s.as_str()).map(String::from));
                let h = h_openset.clone();
                let _ = h_openset.run_on_main_thread(move || {
                    if let Some(w) = h.get_webview_window("settings") {
                        if let Some(sec) = &section {
                            let _ = w.eval(&format!("location.hash = '#{}';", sec));
                        }
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                        return;
                    }
                    let path = match &section {
                        Some(sec) => format!("settings.html#{}", sec),
                        None => "settings.html".to_string(),
                    };
                    let _ = WebviewWindowBuilder::new(
                        &h, "settings", WebviewUrl::App(path.into()),
                    )
                    .title("MDGEM 设置")
                    .inner_size(760.0, 560.0)
                    .min_inner_size(560.0, 420.0)
                    .focused(true)
                    .initialization_script(BRIDGE_JS)
                    .build();
                });
            });

            // Memory: return the per-workspace UI memory blob for a path (or null).
            let h_memget = handle.clone();
            handle.listen_any("mdreader:memory-get", move |event| {
                let req: MemoryGet = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let memory = read_workspace_memory(&h_memget, &req.key);
                if let Some(w) = h_memget.get_webview_window("main") {
                    let _ = w.emit(
                        "mdreader:memory",
                        MemoryPayload { req_id: req.req_id, memory },
                    );
                }
            });

            // Memory: persist the per-workspace UI memory blob for a path.
            let h_memset = handle.clone();
            handle.listen_any("mdreader:memory-set", move |event| {
                let req: MemorySet = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                write_workspace_memory(&h_memset, &req.key, req.memory);
            });

            // History: all four verbs reply on `mdreader:history-loaded` with the
            // reqId echoed back; the front-end resolves its promise from that.
            // Broadcast app-wide (not just the main window) so the standalone
            // settings window's 终端 history section receives its replies too;
            // only the window holding the matching reqId resolves.
            fn emit_history(app: &AppHandle, req_id: String, history: Option<serde_json::Value>) {
                let _ = app.emit("mdreader:history-loaded", HistoryPayload { req_id, history });
            }

            // History: list a scope's index.json (array of record metadata).
            let h_histlist = handle.clone();
            handle.listen_any("mdreader:history-list", move |event| {
                let Ok(req) = serde_json::from_str::<HistoryList>(event.payload()) else { return };
                let history = Some(history_list(&h_histlist, &req.scope));
                emit_history(&h_histlist, req.req_id, history);
            });

            // History: read one record file (or null).
            let h_histread = handle.clone();
            handle.listen_any("mdreader:history-read", move |event| {
                let Ok(req) = serde_json::from_str::<HistoryRead>(event.payload()) else { return };
                let history = history_read(&h_histread, &req.scope, &req.id);
                emit_history(&h_histread, req.req_id, history);
            });

            // History: write one record file + upsert the index.
            let h_histwrite = handle.clone();
            handle.listen_any("mdreader:history-write", move |event| {
                let Ok(req) = serde_json::from_str::<HistoryWrite>(event.payload()) else { return };
                history_write(&h_histwrite, &req.scope, &req.id, &req.record);
                emit_history(&h_histwrite, req.req_id, Some(serde_json::json!({ "ok": true })));
            });

            // History: delete one record file + drop its index entry.
            let h_histdel = handle.clone();
            handle.listen_any("mdreader:history-delete", move |event| {
                let Ok(req) = serde_json::from_str::<HistoryDelete>(event.payload()) else { return };
                history_delete(&h_histdel, &req.scope, &req.id);
                emit_history(&h_histdel, req.req_id, Some(serde_json::json!({ "ok": true })));
            });

            // AI: run a streaming chat turn on a worker thread. Text deltas are
            // emitted as they arrive; the final content + tool calls land in
            // ai-done (or ai-error). Drives the JS agent loop.
            let h_aichat = handle.clone();
            handle.listen_any("mdreader:ai-chat", move |event| {
                let req: AiChatRequest = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let h = h_aichat.clone();
                std::thread::spawn(move || {
                    let stored = read_ai_config(&h).unwrap_or(serde_json::Value::Null);
                    let creds = req.creds.clone();
                    // Effective config = per-request creds, falling back to the
                    // stored config for any missing field.
                    let pick = |k: &str| {
                        creds.get(k).and_then(|v| v.as_str())
                            .or_else(|| stored.get(k).and_then(|v| v.as_str()))
                            .unwrap_or("")
                            .to_string()
                    };
                    let mut config = serde_json::json!({
                        "baseURL": pick("baseURL"),
                        "model": pick("model"),
                        "apiKey": pick("apiKey"),
                    });
                    if let Some(t) = creds.get("temperature").and_then(|v| v.as_f64()) {
                        config["temperature"] = serde_json::json!(t);
                    }
                    let delta_handle = h.clone();
                    let delta_req = req.req_id.clone();
                    let result = ai_chat_stream(&config, req.messages, &req.tools, |piece| {
                        if let Some(w) = delta_handle.get_webview_window("main") {
                            let _ = w.emit(
                                "mdreader:ai-delta",
                                AiDeltaPayload {
                                    req_id: delta_req.clone(),
                                    text: piece.to_string(),
                                },
                            );
                        }
                    });
                    if let Some(w) = h.get_webview_window("main") {
                        match result {
                            Ok((full, tool_calls)) => {
                                let _ = w.emit(
                                    "mdreader:ai-done",
                                    AiDonePayload { req_id: req.req_id, full, tool_calls },
                                );
                            }
                            Err(error) => {
                                let _ = w.emit(
                                    "mdreader:ai-error",
                                    AiErrorPayload { req_id: req.req_id, error },
                                );
                            }
                        }
                    }
                });
            });

            // AI agent tools that need native fs/process/network access.
            let h_aitool = handle.clone();
            handle.listen_any("mdreader:ai-tool", move |event| {
                let req: AiToolRequest = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let h = h_aitool.clone();
                std::thread::spawn(move || {
                    let (ok, result) = run_agent_tool(&req.name, &req.args);
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.emit(
                            "mdreader:ai-tool-result",
                            AiToolResultPayload { req_id: req.req_id, ok, result },
                        );
                    }
                });
            });

            // AI apply-edit: write content back to a file (the JS panel already
            // got explicit user confirmation before sending this).
            let h_write = handle.clone();
            handle.listen_any("mdreader:write-file", move |event| {
                let req: WriteFileRequest = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let h = h_write.clone();
                std::thread::spawn(move || {
                    let result = std::fs::write(&req.path, req.content.as_bytes());
                    if let Some(w) = h.get_webview_window("main") {
                        let payload = match result {
                            Ok(_) => WriteResultPayload {
                                req_id: req.req_id,
                                ok: true,
                                error: None,
                            },
                            Err(e) => WriteResultPayload {
                                req_id: req.req_id,
                                ok: false,
                                error: Some(e.to_string()),
                            },
                        };
                        let _ = w.emit("mdreader:write-result", payload);
                    }
                });
            });

            // Terminal: create a pty and start streaming.
            let h_termnew = handle.clone();
            handle.listen_any("mdreader:term-create", move |event| {
                let req: TermCreate = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                term_create(&h_termnew, req);
            });

            // Terminal: forward keystrokes to the shell.
            let h_termin = handle.clone();
            handle.listen_any("mdreader:term-input", move |event| {
                let req: TermInput = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let st = h_termin.state::<TermState>();
                let mut map = st.map.lock().unwrap();
                if let Some(th) = map.get_mut(&req.id) {
                    let _ = th.writer.write_all(req.data.as_bytes());
                    let _ = th.writer.flush();
                }
            });

            // Terminal: resize the pty.
            let h_termsz = handle.clone();
            handle.listen_any("mdreader:term-resize", move |event| {
                let req: TermResize = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let st = h_termsz.state::<TermState>();
                let map = st.map.lock().unwrap();
                if let Some(th) = map.get(&req.id) {
                    let _ = th.master.resize(PtySize {
                        rows: req.rows.unwrap_or(24).max(1),
                        cols: req.cols.unwrap_or(80).max(1),
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            });

            // Terminal: kill the shell + drop the handle.
            let h_termkill = handle.clone();
            handle.listen_any("mdreader:term-kill", move |event| {
                let req: TermId = match serde_json::from_str(event.payload()) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let st = h_termkill.state::<TermState>();
                let removed = st.map.lock().unwrap().remove(&req.id);
                if let Some(mut th) = removed {
                    let _ = th.child.kill();
                }
            });

            // Sidebar Recent menu: open a recent file as a brand-new workspace
            // (its parent directory). If the file is gone, prune the list and
            // tell the user.
            let h_recent = handle.clone();
            handle.listen_any("mdreader:open-recent", move |event| {
                let raw: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if raw.is_empty() {
                    return;
                }
                let path = PathBuf::from(&raw);
                if let Some(w) = h_recent.get_webview_window("main") {
                    if !path.exists() {
                        toast(&w, "That file no longer exists", "error");
                        prune_recents(&h_recent);
                        push_recents(&w, &read_recents(&h_recent));
                        return;
                    }
                    load_target(&w, path, LoadMode::NewWorkspace);
                }
            });

            // Sidebar theme toggle: JS pushes the user's preference, we
            // persist it, re-resolve effective theme, push back, and
            // rebuild the menu so the checkmark stays in sync.
            let h_theme = handle.clone();
            handle.listen_any("mdreader:set-theme-pref", move |event| {
                let pref: String =
                    serde_json::from_str(event.payload()).unwrap_or_default();
                if pref != "system" && pref != "light" && pref != "dark" {
                    return;
                }
                write_theme_pref(&h_theme, &pref);
                if let Some(w) = h_theme.get_webview_window("main") {
                    let name = effective_theme_name(&h_theme, &w);
                    push_theme(&w, name, &pref);
                }
                let _ = rebuild_menu(&h_theme);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_handle, _event| {});
}
