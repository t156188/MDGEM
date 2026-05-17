# MDGEM

**MDGEM** = **M**ark**D**own + **gem**。一颗用来读 `.md` 的小宝石。

轻量 Markdown 阅读器，双端原生：

- **`mac/`** — macOS（SwiftUI + WKWebView）
- **`win/`** — Windows（Tauri 2 + WebView2）

两端共用 `mac/Resources/` 下的前端（markdown-it + highlight.js + KaTeX + Mermaid），渲染一致。

## 能干什么

- 双击 `.md` 即开，支持 `md / markdown / mdown / mkd / mkdn`
- 渲染 GFM 表格、任务列表、代码高亮、Mermaid、KaTeX
- 侧栏：文件树 + 大纲，可折叠（`⌘B` / `Ctrl+B`）
- 主题：跟随系统 / 浅色 / 深色
- 缩放：`⌘=` / `⌘-` / `⌘0`（Win 用 `Ctrl`）
- 右键文件树：打开、在 Finder/Explorer 中显示、重命名、移到废纸篓
- 一些彩蛋（藏在侧栏底部的 `❀`，遇事不决可以问问）

## 仓库结构

```
MDGEM/
├── mac/      # macOS 项目（SwiftUI）
├── win/      # Windows 项目（Tauri 2）
└── .github/workflows/   # CI：自动出 .dmg / .exe
```

前端代码在 `mac/Resources/`，两端共用。

## 开发

**Mac**
```sh
cd mac
brew install xcodegen     # 仅首次
make build                # 产物：build/.../MDGEM.app
make open-sample
```

**Win**（开发时可在 Mac 上 `cargo run` 验证；最终 `.exe` 需在 Windows 构建）
```sh
cd win/src-tauri
cargo run -- ../../mac/Samples/test-sample.md
```

详见 `win/README.md`。

## 下载

去 [Releases](../../releases) 拿最新版本：

- macOS：`MDGEM-arm64.dmg`（Apple Silicon）/ `MDGEM-intel.dmg`（Intel）
- Windows：`MDGEM_x.y.z_x64-setup.exe`（NSIS）
