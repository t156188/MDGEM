# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

Dual-platform Markdown reader (display name: **MDGEM**). Two native shells, one shared front-end:

- `mac/` — SwiftUI + WKWebView (macOS 13+)
- `win/` — Tauri 2 (Rust) + WebView2

The front-end (markdown-it + highlight.js + KaTeX + Mermaid + sidebar UI) is **a single bundle that lives under `mac/Resources/`**. The Windows shell points `tauri.conf.json#build.frontendDist` at `../../mac/Resources`, so editing `mac/Resources/` or `mac/build-web/entries/*` ships to both platforms.

## Common commands

**Mac**
```sh
cd mac
make build            # esbuild → xcodegen → xcodebuild Release → MDGEM.app
make open-sample      # opens Samples/test-sample.md in the Release build
make project          # regenerate MDGEM.xcodeproj from project.yml
make web              # rebuild the front-end bundle only (vendor/viewer.bundle.js)
make clean            # nukes build/, the generated .xcodeproj, Resources/vendor, build-web/node_modules
```
Build product lives at `mac/build/Build/Products/Release/MDGEM.app`.

**Front-end bundle only** (used by both platforms):
```sh
cd mac/build-web && npm run build    # esbuild → ../Resources/vendor/{viewer,mermaid}.bundle.js + CSS/font copies
```

**Win** (Rust logic runs on macOS for dev; final `.exe` must build on Windows):
```sh
cd win/src-tauri
cargo run -- ../../mac/Samples/test-sample.md
cargo check                          # fast syntax + type check
```
There is no test suite in either shell.

## Architecture

### IPC contract — `window.MDViewerAPI`

The viewer bundle (`mac/build-web/entries/viewer.entry.js`) exposes a stable surface on `window.MDViewerAPI`:
```
render(text, baseDir)      setTheme({name, pref})         setFileTree(payload)
setOutline(items)          onScanDirResult(reqId, p)      toast(msg, kind)
toggleSidebar()            selectAllContent()             scrollToAnchor(id)
toggleAiPanel()            toggleTerminal()
onReadFileResult(reqId,p)  onAiConfig(reqId,cfg)          onAiDelta(reqId,{text})
onAiDone(reqId,{full,toolCalls})  onAiError(reqId,{error})  onAiToolResult(reqId,{ok,result})
onWriteResult(reqId,{ok,error})   onTermData(id,data)       onTermExit(id,code)
onMemory(reqId, blob)             onHistoryLoaded(reqId, blob)
```
Both native shells push state in via these calls; the JS calls *back* to native via two different mechanisms:

| Direction | Mac | Win |
|---|---|---|
| Native → JS | `webView.evaluateJavaScript("window.MDViewerAPI…")` | `window.emit("mdreader:*", payload)` → `bridge.js` listens → calls `MDViewerAPI.*` |
| JS → Native | `window.webkit.messageHandlers.<name>.postMessage(...)` | `window.__TAURI__.event.emit("mdreader:*", payload)` → Rust `handle.listen_any(...)` |

`win/src-tauri/src/bridge.js` is injected via `initialization_script` and is the **only** thing translating Tauri's event-based IPC into the `MDViewerAPI` shape. When adding a new IPC: register the script-message handler in `mac/MDGEM/MarkdownWebView.swift` AND a `listen_any` in `win/src-tauri/src/lib.rs` AND a translation in `bridge.js`, then expose the result via `MDViewerAPI`. The lazy-folder scan (`scanDir` ↔ `mdreader:scan-dir` / `mdreader:scan-dir-result`) is the canonical example. (IPC event names keep the historical `mdreader:` prefix — it's an internal protocol string both shells agree on, not a user-visible identifier.)

### Workspace pinning

`DocumentSession` (mac) and `OpenState.workspace_root` (win) **pin the workspace to the directory the document was first opened from**. Sidebar clicks open files inside the workspace but **do not** change the root. New-workspace entry points are: initial argv, drag-drop onto window, File → Open, single-instance forwarding. Tauri's `LoadMode::{NewWorkspace, KeepWorkspace}` and Swift's `DocumentSession.load(url:)` (which only updates `fileURL`, never `workspaceRoot`) encode this rule.

Folders are valid open targets: `Info.plist` declares `public.folder` (rank `None`, so MDGEM never claims default folder-handler status), `MarkdownDocument` detects `configuration.file.isDirectory` and picks `README.md` (case-insensitive) or the first `.md` alphabetically. The Tauri side mirrors this via `find_default_md_in_dir` + `load_target`. The default `File → Open…` menu only allows files; a separate `File → Open Folder…` (⌘⇧O) uses an `NSOpenPanel` with `canChooseDirectories=true` because SwiftUI's `DocumentGroup` open panel hard-codes folder selection off.

### Lazy file tree

`FileTree.swift` (mac) and `lib.rs#scan_tree` (win) share a hardcoded `LAZY_DIR_NAMES` set: `node_modules, dist, build, out, target, vendor, release, coverage, Pods, DerivedData, __pycache__`. When the scanner enters one of these, it emits a stub node `{type:"dir", lazy:true, children:nil}` and skips recursion. The viewer renders these with a `…` hint; clicking issues a `scanDir` / `mdreader:scan-dir` request with a `reqId`, the backend scans one level off the main thread, and `onScanDirResult` merges the children back into `currentTree`. Without this, opening a typical project froze the UI scanning thousands of `node_modules/*/README.md` files. Keep the two lists in sync if you edit them.

The tree lists **all** files (not just markdown) IDE-style; auto-open on workspace entry still only picks a README/`.md`. The viewer's `previewFile()` (in `viewer.entry.js`) decides how to show a clicked file by extension: markdown → host open path; image/video/html → a tag pointed straight at the file URL (win converts via `window.__mdr.convertFileSrc`); text/code → `readFileText` ↔ `mdreader:read-file-text` round-trip (≤2 MB) rendered with highlight.js; anything else → a "preview not supported" card with an "open externally" button.

### AI panel & terminal

Two sidebar-footer buttons (`#sb-ai-btn`, `#sb-term-btn`) toggle a right-side AI panel and a bottom terminal; the `Panels` controller in `viewer.entry.js` owns show/hide + drag-resize, and lazily inits each via `PanelHooks`.

- **AI** (`AIPanel`): a streaming **agent** over an OpenAI-compatible provider (presets in `settings.entry.js#AI_PRESETS`: 智谱 GLM, 智谱 GLM Coding Plan, DeepSeek, 通义千问, 自定义 — all hit `{baseURL}/chat/completions`). HTTP runs **natively** (`AIService.swift` URLSession streaming / `lib.rs ai_chat_stream` reqwest blocking + SSE), never page `fetch`, to dodge `file://` CORS and keep the key out of the web context. Config persists in UserDefaults (mac) / tauri-store key `aiConfig` (win).
  - **Agent loop lives in `viewer.entry.js`** (`AIPanel.runAgent`): each turn sends `stream:true` + the OpenAI `tools` schema; native streams text deltas (`onAiDelta`) and finishes with `onAiDone({full, toolCalls})`. If the model asked for tool calls, JS executes them and loops, until it stops calling tools (cap: 24 steps). `convo` (the full OpenAI message array incl. assistant `tool_calls` + `tool` results) is the source of truth, re-rendered each step as bubbles + collapsible tool-step chips.
  - **Tools** (`aiToolSpecs()`): `read_file` / `write_file` reuse the existing `readFileText` ↔ `writeFile` IPC; `edit_file` is read→exact-substring-replace→write in JS. `list_dir` / `search` / `run_command` / `web_search` go through one native channel — `aiTool` ↔ `onAiToolResult` — dispatched by `WorkspaceTools.run` (mac) / `run_agent_tool` (win): workspace grep (skips `LAZY_DIR_NAMES`), one-level dir list, one-shot shell exec (zsh `-lc` mac / `cmd /C`\|`sh -lc` win, merged stdout+stderr, timeout-terminated), and a keyless DuckDuckGo-HTML web search. `run_command`/`web_search` are gated by `AI_CAPS`.
  - **Gating**: read-only tools (`read_file`/`list_dir`/`search`/`web_search`) auto-run; mutating ones (`edit_file`/`write_file`/`run_command`) go through a confirm modal unless the per-session **自动执行** toggle is on (`autoApprove`). IPC: `aiGetConfig/aiSetConfig/aiChat/aiTool/writeFile` ↔ `onAiConfig/onAiDelta/onAiDone/onAiError/onAiToolResult/onWriteResult`.
  - **History** (`AIPanel`): multi-session, per-workspace. `convo` is snapshotted into a `sessions` list after every agent turn and on ✚-new-chat; the 🕘 overlay lists/loads/deletes (hard delete) past conversations. Persisted via the `historyLoad/historySave` IPC with `scope:'ai'`, keyed by workspace root path.
- **Terminal** (`TerminalPanel`): real interactive PTY via xterm.js (`mac/build-web/entries/terminal.entry.js` → `terminal.bundle.js`, lazy-loaded like mermaid). Backends: `PTYSession.swift` (posix_openpt + Process) on mac, `portable-pty` (`TermState` in `lib.rs`) on win. Bytes flow as utf8 strings. IPC: `termCreate/termInput/termResize/termKill` ↔ `onTermData(id,data)/onTermExit(id,code)`, keyed by a JS-generated terminal id.
  - **Command history + autocomplete** (`TerminalPanel`): the PTY is a raw byte stream, so `handleTermInput`/`trackInput` reconstruct the typed line best-effort and mark it "uncertain" on any cursor movement / Tab-completion / `\x1b[?1049h` alt-screen (vim, less) — suppressing both recording and suggestion until the next fresh prompt. Completed lines are learned into a per-workspace `{cmd,count,lastUsed}` list. A fish-style dim ghost (`refreshGhost`, positioned at `term.buffer.active.cursorX/Y` via the internal cell dims, purely additive — failure only hides it) is accepted with **Right-arrow**; the 🕘 panel lists 常用/最近 commands (click → Ctrl-U + insert, no auto-exec). Persisted via `historyLoad/historySave` with `scope:'term'`.

### History storage

History uses two different shapes under `MDGEM/<scope>/`, both driven by the same four IPC verbs. `scope` is `'chat'` or `'term'`:

```
MDGEM/chat/index.json   [{id,workspace,title,createdAt,updatedAt}, …]
MDGEM/chat/<id>.json    {id,workspace,title,createdAt,updatedAt, messages:[…]}   one file per conversation
MDGEM/term/commands.json {id:"commands", commands:{ "<workspace>": [{cmd,count,lastUsed}, …] }}  single record
```

- **chat** = one file per conversation. `id` is a front-end-generated filename `YYYY_MMDD_HHMM_xx` (`fmtId()` in `viewer.entry.js`); `index.json` lists metadata so the 🕘 overlay renders without reading every file; the front-end filters the list by the `workspace` field.
- **term** = a single record `term/commands.json` (fixed id `"commands"`), a `{ "<workspace>": [{cmd,count,lastUsed}] }` frequent-commands table. The terminal learns commands as you type (`recordCommand` bumps count + recency) and drives the inline ghost suggestion from the current workspace's slice; **management (delete a command / 清空全部) lives in the Settings window → 终端**, which merges all workspaces into one 常用 list. There is **no** full terminal transcript and no per-session term files.

Four IPC verbs replace the old load/save pair, all resolving on the existing `onHistoryLoaded(reqId,value)` callback: `historyList(scope)` → index array, `historyRead(scope,id)` → record|null, `historyWrite(scope,id,record)` → `{ok:true}`, `historyDelete(scope,id)` → `{ok:true}`. Mac script handlers (`historyList/Read/Write/Delete` in `MarkdownWebView.swift`) → `HistoryStore.swift`; win `mdreader:history-{list,read,write,delete}` listeners in `lib.rs`; the `mdreader:history-loaded` → `onHistoryLoaded` bridge translation is unchanged (all four verbs reply on it). **Native maintains `index.json`** by lifting a fixed `META_KEYS`/`metaKeys` allow-list (`id,workspace,title,createdAt,updatedAt`) from each written record — the front-end never writes the index directly. `id` is **sanitized** to `[A-Za-z0-9_]` natively (it's used as a filename) to prevent path traversal. Old `history-ai.json`/`history-term.json` from before this layout are not migrated — left in place, ignored.

Both shells deliberately use the friendly folder name `MDGEM`, not the bundle id. On win this means **all** self-managed storage — the `settings.json` store (theme/zoom/recents/aiConfig/uiSettings/workspaceMemory) plus the history files — is relocated from the default `app_data_dir()` (`%APPDATA%\com.mdgem.app\`) into `%APPDATA%\MDGEM\` via `mdgem_data_dir()` (`lib.rs`): history paths build on it directly, and `app.store(settings_path(app))` passes an absolute path so the store plugin lands the file there too. There is **no migration** — a user upgrading from a build that wrote `com.mdgem.app\` simply starts fresh in `MDGEM\`; the old files are small and left in place, ignored. The **one exception** is `.window-state.json`, written by `tauri-plugin-window-state`, which has no dir-override API and stays under `com.mdgem.app`. On mac, UserDefaults is unavoidably `~/Library/Preferences/com.mdgem.app.plist` (macOS convention); only the history files live under the `MDGEM` folder.

### Build flow specifics

- `mac/project.yml` is the source of truth for the Xcode project. `make build` runs `xcodegen generate` every time, so **do not edit `MDGEM.xcodeproj` directly** — it's regenerated from `project.yml`. `Info.plist` and `MDGEM.entitlements` are excluded from xcodegen's source globs and edited by hand.
- `Resources/` (with `type: folder`) is copied wholesale into the bundle. `Resources/vendor/` is produced by `mac/build-web/build.mjs` (esbuild) and **gitignored** (`mac/.gitignore`); the `mac/build-web` step runs as part of `make web` / `make build`. build.mjs emits three IIFE bundles — `viewer.bundle.js`, `mermaid.bundle.js`, and `terminal.bundle.js` (xterm.js + fit addon, globalName `MDTerm`, lazy-loaded on first terminal open) — plus the hljs/KaTeX/xterm CSS copies.
- Win adds `reqwest` (native AI HTTP, blocking + rustls) and `portable-pty` (terminal) to `Cargo.toml`; `capabilities/default.json` grants `fs:allow-write-*`. New mac Swift files (`AIService.swift`, `WorkspaceTools.swift`, `PTYSession.swift`, `FileReader.swift`) are picked up automatically by xcodegen's folder glob.
- After Info.plist changes that affect Launch Services (UTI registration, file associations), run `lsregister -f /path/to/MDGEM.app` before testing or macOS may still use the old metadata.
- Win uses `tauri-plugin-single-instance`: a second `open` call is forwarded to the existing window via the closure in `lib.rs`'s `single_instance::init`. Drag-drop is wired through `WindowEvent::DragDrop` on `on_window_event`.

### Version numbers

Five files must move together: `mac/project.yml` (`MARKETING_VERSION`), `mac/MDGEM/Info.plist` (`CFBundleShortVersionString`), `mac/build-web/package.json` + `package-lock.json`, `win/src-tauri/Cargo.toml`, `win/src-tauri/tauri.conf.json`. After editing `Cargo.toml`, run `cargo update -p mdgem --offline` to sync `Cargo.lock`.

### Release workflow

Two distinct triggers:

- **"提交" / "提交代码" / "commit"** — stage modified files, draft a commit message, confirm with user, then `git commit` (do **not** push). Adds `Co-Authored-By` per repo convention.
- **"推送" / "提交推送"** — same as above plus `git push origin main`.
- **"发版" / "发布" / "发更新" / "出版本"** — full release flow below.

Plain commit / push paths **do not** touch version numbers, tags, or GitHub Releases.

**Full release flow**, with two confirmation gates. Artifacts are built and published entirely on GitHub; nothing is downloaded locally during the release.

0. **Preflight.** `git status` must be clean — if there are uncommitted changes, ask the user whether to include them in the release commit, stash, or commit separately first. Then `git fetch origin && git pull --ff-only origin main` to sync with remote so the upcoming version-bump commit lands on top of `origin/main` (avoids reject-on-push / merge conflicts on the release commit). If `--ff-only` refuses (local has diverged), stop and ask the user before doing anything destructive.
1. Bump the patch version (1.0.0 → 1.0.1 → … → 1.0.11) across the five manifest files (see "Version numbers"). Run `cargo update -p mdgem --offline` to sync `Cargo.lock`. Only bump minor/major when explicitly asked. Exception: if the current version hasn't shipped (no GitHub Release for it), release as-is — don't bump.
2. **🛑 GATE 1 — version confirmation.** Show the user the new version and wait for confirmation before any commit.
3. On confirm: commit (`Release X.Y.Z: <subject>`) and `git push origin main`. This also triggers the per-push smoke-test workflows (`macos-build.yml` / `windows-build.yml`), which are independent of the release.
4. Create and push the tag: `git tag -a vX.Y.Z -m "MDGEM X.Y.Z"` + `git push origin vX.Y.Z`. The tag push triggers `.github/workflows/release.yml`, which builds mac arm64 + intel + win and creates a **draft** GitHub Release with the three artifacts attached.
5. Watch with `gh run watch`. When the `release` job finishes, give the user the draft URL via `gh release view vX.Y.Z --web` (or just print the URL) and ask them to download from the Release page and install/test.
6. **🛑 GATE 2 — publish confirmation.** Wait for explicit "OK / 可以发" before step 7. State-check questions like "是不是…?" are *not* approval.
7. On confirm: `gh release edit vX.Y.Z --draft=false` to flip the draft to a public Release. The tag already exists from step 4, so nothing else is needed.
8. **Archive binaries.** `mkdir -p release/vX.Y.Z/`, then `gh release download vX.Y.Z -D release/vX.Y.Z/` to pull the three published artifacts into the repo (`MDGEM-arm64.dmg`, `MDGEM-intel.dmg`, `MDGEM_X.Y.Z_x64-setup.exe` — keep CI filenames as-is). Commit as a **separate** follow-up: `Archive X.Y.Z release binaries`. The `release/` directory is intentionally **not** gitignored — it's the in-repo binary archive so anyone can grab a known-good build without re-running CI.

**If GATE 2 is rejected:** version stays bumped (don't roll back). Choose one:
- Leave the draft Release alone (it stays invisible to the public) and cut the next patch — rejected 1.0.2 → next attempt is 1.0.3.
- Or fully clean up: `gh release delete vX.Y.Z --cleanup-tag` (removes the draft Release **and** deletes the tag locally + on origin), then next attempt re-uses the same patch number. Ask the user before deleting.

**Signing:** the mac build currently uses ad-hoc signing (`CODE_SIGN_IDENTITY="-"`, `CODE_SIGNING_REQUIRED=NO`); the win build is fully unsigned. When the user is ready to add Developer ID signing + notarization, the change is contained to `release.yml` and a handful of GitHub Secrets — no flow changes above.

## CI

`.github/workflows/macos-build.yml` (matrix: arm64 + intel → two DMGs) triggers on `mac/**` push. `windows-build.yml` (NSIS `.exe`) triggers on `win/**` or `mac/Resources/**` push, since the win shell consumes `mac/Resources/`. Both are **smoke tests on main pushes** — artifacts are in the workflow run's Artifacts panel and are not published anywhere.

`.github/workflows/release.yml` is the **release** workflow: it triggers on tag push (`v*`) or `workflow_dispatch`, builds mac arm64 + intel + win in parallel, and creates a draft GitHub Release with the three artifacts. See "Release workflow" for the full flow.
