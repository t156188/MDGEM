import SwiftUI
import WebKit

struct MarkdownWebView: NSViewRepresentable {
    let text: String
    let workspaceRoot: URL?
    let imageBase: URL?
    let currentFile: URL?
    let isDark: Bool
    let themePref: String
    let pageZoom: Double
    let treeNonce: Int
    let onRequestOpen: (URL) -> Void
    /// A recent-file click: open in THIS window, re-rooting the workspace to
    /// the target's directory (unlike onRequestOpen, which keeps the root).
    let onRequestOpenWorkspace: (URL) -> Void
    let onFsOp: (FsOpRequest, @escaping (String, String) -> Void) -> Void
    let onSetThemePref: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onRequestOpen: onRequestOpen,
            onRequestOpenWorkspace: onRequestOpenWorkspace,
            onFsOp: onFsOp,
            onSetThemePref: onSetThemePref
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "didRender")
        config.userContentController.add(context.coordinator, name: "openFile")
        config.userContentController.add(context.coordinator, name: "openRecent")
        config.userContentController.add(context.coordinator, name: "openFileDialog")
        config.userContentController.add(context.coordinator, name: "openFolderDialog")
        config.userContentController.add(context.coordinator, name: "fsOp")
        config.userContentController.add(context.coordinator, name: "setThemePref")
        config.userContentController.add(context.coordinator, name: "scanDir")
        config.userContentController.add(context.coordinator, name: "readFileText")
        config.userContentController.add(context.coordinator, name: "openExternal")
        config.userContentController.add(context.coordinator, name: "aiGetConfig")
        config.userContentController.add(context.coordinator, name: "aiSetConfig")
        config.userContentController.add(context.coordinator, name: "settingsGet")
        config.userContentController.add(context.coordinator, name: "settingsSet")
        config.userContentController.add(context.coordinator, name: "openSettings")
        config.userContentController.add(context.coordinator, name: "memoryGet")
        config.userContentController.add(context.coordinator, name: "memorySet")
        config.userContentController.add(context.coordinator, name: "historyList")
        config.userContentController.add(context.coordinator, name: "historyRead")
        config.userContentController.add(context.coordinator, name: "historyWrite")
        config.userContentController.add(context.coordinator, name: "historyDelete")
        config.userContentController.add(context.coordinator, name: "aiChat")
        config.userContentController.add(context.coordinator, name: "aiTool")
        config.userContentController.add(context.coordinator, name: "writeFile")
        config.userContentController.add(context.coordinator, name: "termCreate")
        config.userContentController.add(context.coordinator, name: "termInput")
        config.userContentController.add(context.coordinator, name: "termResize")
        config.userContentController.add(context.coordinator, name: "termKill")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false
        webView.pageZoom = CGFloat(pageZoom)
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        context.coordinator.webView = webView
        context.coordinator.currentWorkspace = workspaceRoot
        context.coordinator.currentFile = currentFile
        context.coordinator.lastTreeNonce = treeNonce
        loadTemplate(into: webView, workspaceRoot: workspaceRoot)

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coord = context.coordinator
        coord.onRequestOpen = onRequestOpen
        coord.onRequestOpenWorkspace = onRequestOpenWorkspace
        coord.onFsOp = onFsOp
        coord.onSetThemePref = onSetThemePref

        if abs(webView.pageZoom - CGFloat(pageZoom)) > 0.001 {
            webView.pageZoom = CGFloat(pageZoom)
        }

        let themeName = isDark ? "dark" : "light"

        if coord.currentWorkspace != workspaceRoot {
            coord.currentWorkspace = workspaceRoot
            coord.currentFile = currentFile
            coord.lastTreeNonce = treeNonce
            coord.isReady = false
            coord.pendingText = text
            coord.pendingTheme = themeName
            coord.pendingThemePref = themePref
            coord.pendingTreeJSON = FileTree.payloadJSON(root: workspaceRoot, current: currentFile)
            loadTemplate(into: webView, workspaceRoot: workspaceRoot)
            return
        }

        if coord.isReady {
            coord.pushTheme(themeName, pref: themePref)
            if coord.lastPushedText != text {
                coord.pushRender(text: text, imageBase: imageBase)
            }
            let fileChanged = coord.currentFile != currentFile
            let nonceChanged = coord.lastTreeNonce != treeNonce
            if fileChanged || nonceChanged {
                coord.currentFile = currentFile
                coord.lastTreeNonce = treeNonce
                if let json = FileTree.payloadJSON(root: workspaceRoot, current: currentFile) {
                    coord.pushTree(json: json)
                }
            }
        } else {
            coord.pendingText = text
            coord.pendingTheme = themeName
            coord.pendingThemePref = themePref
            coord.pendingTreeJSON =
                FileTree.payloadJSON(root: workspaceRoot, current: currentFile)
        }
    }

    private func loadTemplate(into webView: WKWebView, workspaceRoot: URL?) {
        let viewerURL = Bundle.main.url(forResource: "viewer", withExtension: "html", subdirectory: "Resources")
            ?? Bundle.main.url(forResource: "viewer", withExtension: "html")
        guard let viewerURL else {
            assertionFailure("viewer.html missing from bundle")
            return
        }
        let readAccessRoot: URL
        if let docDir = workspaceRoot {
            readAccessRoot = commonAncestor(viewerURL.deletingLastPathComponent(), docDir)
        } else {
            readAccessRoot = viewerURL.deletingLastPathComponent()
        }
        webView.loadFileURL(viewerURL, allowingReadAccessTo: readAccessRoot)
    }

    private func commonAncestor(_ a: URL, _ b: URL) -> URL {
        let ac = a.standardizedFileURL.pathComponents
        let bc = b.standardizedFileURL.pathComponents
        var i = 0
        while i < ac.count, i < bc.count, ac[i] == bc[i] { i += 1 }
        let shared = Array(ac.prefix(i))
        if shared.isEmpty { return URL(fileURLWithPath: "/") }
        let path = shared.joined(separator: "/").replacingOccurrences(of: "//", with: "/")
        return URL(fileURLWithPath: path.hasPrefix("/") ? path : "/" + path, isDirectory: true)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var onRequestOpen: (URL) -> Void
        var onRequestOpenWorkspace: (URL) -> Void
        var onFsOp: (FsOpRequest, @escaping (String, String) -> Void) -> Void
        var onSetThemePref: (String) -> Void
        var isReady = false
        var pendingText: String?
        var pendingTheme: String?
        var pendingThemePref: String?
        var pendingTreeJSON: String?
        var lastPushedText: String?
        var lastPushedTheme: String?
        var lastPushedThemePref: String?
        var currentWorkspace: URL?
        var currentFile: URL?
        var lastTreeNonce: Int = 0
        var terminals: [String: PTYSession] = [:]

        init(
            onRequestOpen: @escaping (URL) -> Void,
            onRequestOpenWorkspace: @escaping (URL) -> Void,
            onFsOp: @escaping (FsOpRequest, @escaping (String, String) -> Void) -> Void,
            onSetThemePref: @escaping (String) -> Void
        ) {
            self.onRequestOpen = onRequestOpen
            self.onRequestOpenWorkspace = onRequestOpenWorkspace
            self.onFsOp = onFsOp
            self.onSetThemePref = onSetThemePref
            super.init()
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleToggleSidebar),
                name: .mdgemToggleSidebar,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleRecentsChanged),
                name: .mdgemRecentsChanged,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleSettingsChanged(_:)),
                name: .mdgemSettingsChanged,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleAiConfigChanged(_:)),
                name: .mdgemAiConfigChanged,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleSave),
                name: .mdgemSave,
                object: nil
            )
        }

        @objc func handleSettingsChanged(_ note: Notification) {
            guard let blob = note.userInfo?["settings"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: blob),
                  let json = String(data: data, encoding: .utf8) else { return }
            pushSettingsChanged(settingsJSON: json)
        }

        @objc func handleAiConfigChanged(_ note: Notification) {
            guard let blob = note.userInfo?["config"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: blob),
                  let json = String(data: data, encoding: .utf8) else { return }
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiConfigChanged && "
                + "window.MDViewerAPI.onAiConfigChanged(\(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
            for (_, t) in terminals { t.kill() }
            terminals.removeAll()
        }

        @objc func handleToggleSidebar() {
            guard let webView, isReady else { return }
            webView.evaluateJavaScript(
                "window.MDViewerAPI && window.MDViewerAPI.toggleSidebar && window.MDViewerAPI.toggleSidebar();",
                completionHandler: nil
            )
        }

        // ⌘S from the File menu → save the open code/text editor in the page.
        // No-op when nothing editable is in edit mode.
        @objc func handleSave() {
            guard let webView, isReady else { return }
            webView.evaluateJavaScript(
                "window.MDViewerAPI && window.MDViewerAPI.saveActiveEditor && window.MDViewerAPI.saveActiveEditor();",
                completionHandler: nil
            )
        }

        @objc func handleRecentsChanged() {
            pushRecents()
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            // The page is reloading (Cmd+R, crash recovery, etc.). Save the
            // last known state so didFinish can re-push it into the fresh DOM.
            if pendingText == nil { pendingText = lastPushedText }
            if pendingTheme == nil { pendingTheme = lastPushedTheme }
            if pendingThemePref == nil { pendingThemePref = lastPushedThemePref }
            if pendingTreeJSON == nil, let root = currentWorkspace {
                pendingTreeJSON = FileTree.payloadJSON(root: root, current: currentFile)
            }
            isReady = false
            lastPushedText = nil
            lastPushedTheme = nil
            lastPushedThemePref = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isReady = true
            if let theme = pendingTheme {
                pushTheme(theme, pref: pendingThemePref ?? "system")
                pendingTheme = nil
                pendingThemePref = nil
            }
            if let text = pendingText {
                let base = (currentFile?.deletingLastPathComponent())
                    ?? currentWorkspace
                pushRender(text: text, imageBase: base)
                pendingText = nil
            }
            if let json = pendingTreeJSON {
                pushTree(json: json)
                pendingTreeJSON = nil
            }
            pushRecents()
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "openFile":
                guard let body = message.body as? [String: Any],
                      let path = body["path"] as? String else { return }
                let url = URL(fileURLWithPath: path)
                let cb = onRequestOpen
                DispatchQueue.main.async { cb(url) }
            case "openRecent":
                guard let body = message.body as? [String: Any],
                      let path = body["path"] as? String else { return }
                let url = URL(fileURLWithPath: path)
                // Open the recent in THIS window, re-rooting the workspace to
                // its directory (see onRequestOpenWorkspace) instead of spawning
                // a new document window. If the file is gone, prune + toast.
                let openWS = onRequestOpenWorkspace
                DispatchQueue.main.async { [weak self] in
                    if !FileManager.default.fileExists(atPath: path) {
                        RecentFiles.prune()
                        self?.toast(message: "That file no longer exists", kind: "error")
                        return
                    }
                    openWS(url)
                }
            case "fsOp":
                guard let body = message.body as? [String: Any],
                      let op = body["op"] as? String,
                      let path = body["path"] as? String else { return }
                let req = FsOpRequest(
                    op: op,
                    path: path,
                    newName: body["newName"] as? String
                )
                let handler = onFsOp
                let toast: (String, String) -> Void = { [weak self] msg, kind in
                    self?.toast(message: msg, kind: kind)
                }
                DispatchQueue.main.async { handler(req, toast) }
            case "setThemePref":
                guard let pref = message.body as? String,
                      pref == "system" || pref == "light" || pref == "dark" else { return }
                let cb = onSetThemePref
                DispatchQueue.main.async { cb(pref) }
            case "scanDir":
                guard let body = message.body as? [String: Any],
                      let path = body["path"] as? String,
                      let reqId = body["reqId"] as? String else { return }
                // Scan off the main thread; large directories can take a beat.
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    let json = FileTree.scanChildrenJSON(path: path) ?? "null"
                    DispatchQueue.main.async {
                        self?.pushScanResult(reqId: reqId, payloadJSON: json)
                    }
                }
            case "readFileText":
                guard let body = message.body as? [String: Any],
                      let path = body["path"] as? String,
                      let reqId = body["reqId"] as? String else { return }
                // Read off the main thread; cap size to keep big files from
                // hauling megabytes over the JS bridge.
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    let result = FileReader.readText(path: path)
                    DispatchQueue.main.async {
                        self?.pushReadFileResult(reqId: reqId, payload: result)
                    }
                }
            case "openExternal":
                guard let body = message.body as? [String: Any],
                      let path = body["path"] as? String else { return }
                let url = URL(fileURLWithPath: path)
                let preferBrowser = (body["browser"] as? Bool) ?? false
                DispatchQueue.main.async {
                    // HTML prefers Google Chrome; fall back to the default app
                    // (the system browser) when Chrome isn't installed.
                    if preferBrowser,
                       let chrome = NSWorkspace.shared.urlForApplication(
                           withBundleIdentifier: "com.google.Chrome") {
                        let cfg = NSWorkspace.OpenConfiguration()
                        NSWorkspace.shared.open([url], withApplicationAt: chrome,
                                                configuration: cfg) { _, err in
                            if err != nil { NSWorkspace.shared.open(url) }
                        }
                    } else {
                        NSWorkspace.shared.open(url)
                    }
                }
            case "openFileDialog":
                // Home-page "Open File" — a folder is also a valid target.
                DispatchQueue.main.async { [weak self] in
                    self?.presentOpenPanel(allowFiles: true, allowDirs: true)
                }
            case "openFolderDialog":
                DispatchQueue.main.async { [weak self] in
                    self?.presentOpenPanel(allowFiles: false, allowDirs: true)
                }
            case "aiGetConfig":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String else { return }
                let json = AIService.configJSON()
                DispatchQueue.main.async { [weak self] in
                    self?.pushAiConfig(reqId: reqId, configJSON: json)
                }
            case "aiSetConfig":
                guard let body = message.body as? [String: Any],
                      let cfg = body["config"] as? [String: Any] else { return }
                AIService.saveConfig(cfg)
            case "settingsGet":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String else { return }
                let json = SettingsStore.settingsJSON()
                DispatchQueue.main.async { [weak self] in
                    self?.pushSettings(reqId: reqId, settingsJSON: json)
                }
            case "settingsSet":
                guard let body = message.body as? [String: Any],
                      let settings = body["settings"] as? [String: Any] else { return }
                SettingsStore.save(settings)
            case "openSettings":
                let section = (message.body as? [String: Any])?["section"] as? String
                DispatchQueue.main.async {
                    NotificationCenter.default.post(
                        name: .mdgemOpenSettings, object: nil,
                        userInfo: section.map { ["section": $0] }
                    )
                }
            case "memoryGet":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let key = body["key"] as? String else { return }
                let json = WorkspaceMemory.memoryJSON(key: key)
                DispatchQueue.main.async { [weak self] in
                    self?.pushMemory(reqId: reqId, memoryJSON: json)
                }
            case "memorySet":
                guard let body = message.body as? [String: Any],
                      let key = body["key"] as? String,
                      let memory = body["memory"] as? [String: Any] else { return }
                WorkspaceMemory.save(key: key, memory: memory)
            case "historyList":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let scope = body["scope"] as? String else { return }
                let json = HistoryStore.listJSON(scope: scope)
                DispatchQueue.main.async { [weak self] in
                    self?.pushHistoryLoaded(reqId: reqId, historyJSON: json)
                }
            case "historyRead":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let scope = body["scope"] as? String,
                      let id = body["id"] as? String else { return }
                let json = HistoryStore.readJSON(scope: scope, id: id)
                DispatchQueue.main.async { [weak self] in
                    self?.pushHistoryLoaded(reqId: reqId, historyJSON: json)
                }
            case "historyWrite":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let scope = body["scope"] as? String,
                      let id = body["id"] as? String,
                      let record = body["record"] as? [String: Any] else { return }
                HistoryStore.write(scope: scope, id: id, record: record)
                DispatchQueue.main.async { [weak self] in
                    self?.pushHistoryLoaded(reqId: reqId, historyJSON: "{\"ok\":true}")
                }
            case "historyDelete":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let scope = body["scope"] as? String,
                      let id = body["id"] as? String else { return }
                HistoryStore.delete(scope: scope, id: id)
                DispatchQueue.main.async { [weak self] in
                    self?.pushHistoryLoaded(reqId: reqId, historyJSON: "{\"ok\":true}")
                }
            case "aiChat":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let messages = body["messages"] as? [[String: Any]] else { return }
                let tools = body["tools"] as? [[String: Any]] ?? []
                let creds = body["creds"] as? [String: Any]
                AIService.chat(
                    creds: creds,
                    messages: messages,
                    tools: tools,
                    onDelta: { [weak self] piece in
                        DispatchQueue.main.async { self?.pushAiDelta(reqId: reqId, text: piece) }
                    },
                    onDone: { [weak self] content, toolCallsJSON in
                        DispatchQueue.main.async {
                            self?.pushAiDone(reqId: reqId, content: content, toolCallsJSON: toolCallsJSON)
                        }
                    },
                    onError: { [weak self] err in
                        DispatchQueue.main.async { self?.pushAiError(reqId: reqId, error: err) }
                    }
                )
            case "aiTool":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let name = body["name"] as? String else { return }
                let args = body["args"] as? [String: Any] ?? [:]
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    WorkspaceTools.run(name: name, args: args) { ok, result in
                        DispatchQueue.main.async {
                            self?.pushAiToolResult(reqId: reqId, ok: ok, result: result)
                        }
                    }
                }
            case "writeFile":
                guard let body = message.body as? [String: Any],
                      let reqId = body["reqId"] as? String,
                      let path = body["path"] as? String,
                      let content = body["content"] as? String else { return }
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    var ok = true
                    var errMsg: String? = nil
                    do {
                        try content.write(toFile: path, atomically: true, encoding: .utf8)
                    } catch {
                        ok = false
                        errMsg = error.localizedDescription
                    }
                    DispatchQueue.main.async {
                        self?.pushWriteResult(reqId: reqId, ok: ok, error: errMsg)
                    }
                }
            case "termCreate":
                guard let body = message.body as? [String: Any],
                      let id = body["id"] as? String else { return }
                let cols = intValue(body["cols"]) ?? 80
                let rows = intValue(body["rows"]) ?? 24
                let cwd = body["cwd"] as? String
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if self.terminals[id] != nil { return }
                    let session = PTYSession(
                        cwd: cwd, cols: cols, rows: rows,
                        onData: { [weak self] data in
                            DispatchQueue.main.async { self?.pushTermData(id: id, data: data) }
                        },
                        onExit: { [weak self] code in
                            DispatchQueue.main.async {
                                self?.pushTermExit(id: id, code: code)
                                self?.terminals[id] = nil
                            }
                        }
                    )
                    self.terminals[id] = session
                }
            case "termInput":
                guard let body = message.body as? [String: Any],
                      let id = body["id"] as? String,
                      let data = body["data"] as? String else { return }
                DispatchQueue.main.async { [weak self] in
                    self?.terminals[id]?.write(data)
                }
            case "termResize":
                guard let body = message.body as? [String: Any],
                      let id = body["id"] as? String else { return }
                let cols = intValue(body["cols"]) ?? 80
                let rows = intValue(body["rows"]) ?? 24
                DispatchQueue.main.async { [weak self] in
                    self?.terminals[id]?.resize(cols: cols, rows: rows)
                }
            case "termKill":
                guard let body = message.body as? [String: Any],
                      let id = body["id"] as? String else { return }
                DispatchQueue.main.async { [weak self] in
                    self?.terminals[id]?.kill()
                    self?.terminals[id] = nil
                }
            default:
                break
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            // External links → system browser, never let WKWebView navigate.
            if !url.isFileURL {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            // Same-page anchor inside the viewer template — allow the scroll.
            if let current = webView.url, current.path == url.path {
                decisionHandler(.allow)
                return
            }
            // A file:// link to some other path: if it's a .md, route through
            // the in-window loader; otherwise cancel so we never lose the
            // viewer template (which would leave the WKWebView showing raw
            // text or, worse, a crashed-page "Reload" UI).
            if FileTree.extensions.contains(url.pathExtension.lowercased()) {
                let cb = onRequestOpen
                DispatchQueue.main.async { cb(url) }
            }
            decisionHandler(.cancel)
        }

        func pushTheme(_ theme: String, pref: String) {
            guard let webView, isReady else { return }
            if lastPushedTheme == theme && lastPushedThemePref == pref { return }
            lastPushedTheme = theme
            lastPushedThemePref = pref
            let js = "window.MDViewerAPI && window.MDViewerAPI.setTheme({name: \(encode(theme)), pref: \(encode(pref))});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushRender(text: String, imageBase: URL?) {
            guard let webView, isReady else { return }
            lastPushedText = text
            let base = imageBase?.absoluteString ?? ""
            let js =
                "window.MDViewerAPI && window.MDViewerAPI.render(\(encode(text)), \(encode(base)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushTree(json: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.setFileTree(\(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushRecents() {
            guard let webView, isReady else { return }
            let json = RecentFiles.payloadJSON()
            let js = "window.MDViewerAPI && window.MDViewerAPI.setRecents && window.MDViewerAPI.setRecents(\(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushScanResult(reqId: String, payloadJSON: String) {
            guard let webView, isReady else { return }
            let js =
                "window.MDViewerAPI && window.MDViewerAPI.onScanDirResult && "
                + "window.MDViewerAPI.onScanDirResult(\(encode(reqId)), \(payloadJSON));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushReadFileResult(reqId: String, payload: String) {
            guard let webView, isReady else { return }
            let js =
                "window.MDViewerAPI && window.MDViewerAPI.onReadFileResult && "
                + "window.MDViewerAPI.onReadFileResult(\(encode(reqId)), \(payload));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushAiConfig(reqId: String, configJSON: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiConfig && "
                + "window.MDViewerAPI.onAiConfig(\(encode(reqId)), \(configJSON));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        // `settingsJSON` / `memoryJSON` are already JSON values (object literal
        // or "null"), so they splice straight into the call expression.
        func pushSettings(reqId: String, settingsJSON: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onSettings && "
                + "window.MDViewerAPI.onSettings(\(encode(reqId)), \(settingsJSON));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushMemory(reqId: String, memoryJSON: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onMemory && "
                + "window.MDViewerAPI.onMemory(\(encode(reqId)), \(memoryJSON));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        // `historyJSON` is already a JSON value (object literal or "null").
        func pushHistoryLoaded(reqId: String, historyJSON: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onHistoryLoaded && "
                + "window.MDViewerAPI.onHistoryLoaded(\(encode(reqId)), \(historyJSON));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        // Live-apply a settings change broadcast from the settings window.
        func pushSettingsChanged(settingsJSON: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onSettingsChanged && "
                + "window.MDViewerAPI.onSettingsChanged(\(settingsJSON));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushAiDelta(reqId: String, text: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiDelta && "
                + "window.MDViewerAPI.onAiDelta(\(encode(reqId)), {text: \(encode(text))});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        // `toolCallsJSON` is already a JSON value (array literal or "null"), so
        // it can be spliced straight into the JS object expression.
        func pushAiDone(reqId: String, content: String, toolCallsJSON: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiDone && "
                + "window.MDViewerAPI.onAiDone(\(encode(reqId)), "
                + "{full: \(encode(content)), toolCalls: \(toolCallsJSON)});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushAiToolResult(reqId: String, ok: Bool, result: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiToolResult && "
                + "window.MDViewerAPI.onAiToolResult(\(encode(reqId)), "
                + "{ok: \(ok ? "true" : "false"), result: \(encode(result))});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushAiError(reqId: String, error: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiError && "
                + "window.MDViewerAPI.onAiError(\(encode(reqId)), {error: \(encode(error))});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushWriteResult(reqId: String, ok: Bool, error: String?) {
            guard let webView, isReady else { return }
            let errJS = error.map { encode($0) } ?? "null"
            let js = "window.MDViewerAPI && window.MDViewerAPI.onWriteResult && "
                + "window.MDViewerAPI.onWriteResult(\(encode(reqId)), {ok: \(ok ? "true" : "false"), error: \(errJS)});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushTermData(id: String, data: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onTermData && "
                + "window.MDViewerAPI.onTermData(\(encode(id)), \(encode(data)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushTermExit(id: String, code: Int32) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.onTermExit && "
                + "window.MDViewerAPI.onTermExit(\(encode(id)), \(code));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        private func intValue(_ v: Any?) -> Int? {
            if let i = v as? Int { return i }
            if let d = v as? Double { return Int(d) }
            if let n = v as? NSNumber { return n.intValue }
            return nil
        }

        func toast(message: String, kind: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.toast && window.MDViewerAPI.toast(\(encode(message)), \(encode(kind)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        /// Present the native open panel for the home-page buttons. Folders are
        /// valid workspace targets (DocumentGroup handles directory URLs).
        func presentOpenPanel(allowFiles: Bool, allowDirs: Bool) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = allowFiles
            panel.canChooseDirectories = allowDirs
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = false
            panel.prompt = "Open"
            panel.begin { response in
                guard response == .OK, let url = panel.url else { return }
                NSDocumentController.shared.openDocument(
                    withContentsOf: url, display: true
                ) { _, _, _ in }
            }
        }

        private func encode(_ s: String) -> String {
            let data = try? JSONSerialization.data(
                withJSONObject: [s], options: [.fragmentsAllowed]
            )
            if let data, let json = String(data: data, encoding: .utf8),
               json.hasPrefix("["), json.hasSuffix("]") {
                return String(json.dropFirst().dropLast())
            }
            return "\"\""
        }
    }
}
