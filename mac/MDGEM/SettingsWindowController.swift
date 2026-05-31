import AppKit
import WebKit

extension Notification.Name {
    /// Posted (by a viewer coordinator) when the user clicks the gear button.
    static let mdgemOpenSettings = Notification.Name("mdgem.openSettings")
    /// Posted (by the settings window) when settings change; viewer windows
    /// observe it and apply the new blob live. userInfo["settings"] = blob.
    static let mdgemSettingsChanged = Notification.Name("mdgem.settingsChanged")
    /// Posted when the AI config changes; viewer windows refresh the AI panel.
    /// userInfo["config"] = blob.
    static let mdgemAiConfigChanged = Notification.Name("mdgem.aiConfigChanged")
}

/// Hosts the standalone settings page (settings.html) in its own native window.
/// One shared instance; reused/refocused on subsequent opens. Reads/writes the
/// global `uiSettings` store and broadcasts changes so open project windows can
/// apply them live.
final class SettingsWindowController: NSObject, WKScriptMessageHandler {
    private var window: NSWindow?
    private weak var webView: WKWebView?

    func show(section: String? = nil) {
        if let w = window {
            if let section { navigate(to: section) }
            // Activate first, then front the window — activating afterwards can
            // let the document window re-order above it. orderFrontRegardless
            // guarantees it lands above the app's other windows.
            NSApp.activate(ignoringOtherApps: true)
            w.makeKeyAndOrderFront(nil)
            w.orderFrontRegardless()
            return
        }
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "settingsGet")
        config.userContentController.add(self, name: "settingsSet")
        config.userContentController.add(self, name: "aiGetConfig")
        config.userContentController.add(self, name: "aiSetConfig")
        // The 终端 section manages terminal command history, so this window
        // needs the same history IPC the project window exposes.
        config.userContentController.add(self, name: "historyList")
        config.userContentController.add(self, name: "historyRead")
        config.userContentController.add(self, name: "historyWrite")
        config.userContentController.add(self, name: "historyDelete")

        let frame = NSRect(x: 0, y: 0, width: 760, height: 560)
        let wv = WKWebView(frame: frame, configuration: config)
        if #available(macOS 13.3, *) { wv.isInspectable = true }
        webView = wv

        guard let baseURL = Bundle.main.url(forResource: "settings", withExtension: "html", subdirectory: "Resources")
            ?? Bundle.main.url(forResource: "settings", withExtension: "html") else { return }
        let readDir = baseURL.deletingLastPathComponent()
        // settings.entry.js reads location.hash to pick the initial section.
        var loadURL = baseURL
        if let section, var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) {
            comps.fragment = section
            if let u = comps.url { loadURL = u }
        }
        wv.loadFileURL(loadURL, allowingReadAccessTo: readDir)

        let win = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        win.title = "MDGEM 设置"
        win.contentView = wv
        win.minSize = NSSize(width: 560, height: 420)
        win.isReleasedWhenClosed = false
        win.center()
        window = win
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
    }

    /// Switch the already-open settings page to a section (settings.entry.js
    /// listens for hashchange).
    private func navigate(to section: String) {
        webView?.evaluateJavaScript("location.hash = '#\(section)';", completionHandler: nil)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        switch message.name {
        case "settingsGet":
            guard let body = message.body as? [String: Any],
                  let reqId = body["reqId"] as? String else { return }
            let json = SettingsStore.settingsJSON()
            let js = "window.MDViewerAPI && window.MDViewerAPI.onSettings && "
                + "window.MDViewerAPI.onSettings(\(encode(reqId)), \(json));"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        case "settingsSet":
            guard let body = message.body as? [String: Any],
                  let settings = body["settings"] as? [String: Any] else { return }
            SettingsStore.save(settings)
            NotificationCenter.default.post(
                name: .mdgemSettingsChanged, object: nil, userInfo: ["settings": settings]
            )
        case "aiGetConfig":
            guard let body = message.body as? [String: Any],
                  let reqId = body["reqId"] as? String else { return }
            let json = AIService.configJSON()
            let js = "window.MDViewerAPI && window.MDViewerAPI.onAiConfig && "
                + "window.MDViewerAPI.onAiConfig(\(encode(reqId)), \(json));"
            webView?.evaluateJavaScript(js, completionHandler: nil)
        case "aiSetConfig":
            guard let body = message.body as? [String: Any],
                  let cfg = body["config"] as? [String: Any] else { return }
            AIService.saveConfig(cfg)
            NotificationCenter.default.post(
                name: .mdgemAiConfigChanged, object: nil, userInfo: ["config": cfg]
            )
        case "historyList":
            guard let body = message.body as? [String: Any],
                  let reqId = body["reqId"] as? String,
                  let scope = body["scope"] as? String else { return }
            pushHistory(reqId, HistoryStore.listJSON(scope: scope))
        case "historyRead":
            guard let body = message.body as? [String: Any],
                  let reqId = body["reqId"] as? String,
                  let scope = body["scope"] as? String,
                  let id = body["id"] as? String else { return }
            pushHistory(reqId, HistoryStore.readJSON(scope: scope, id: id))
        case "historyWrite":
            guard let body = message.body as? [String: Any],
                  let reqId = body["reqId"] as? String,
                  let scope = body["scope"] as? String,
                  let id = body["id"] as? String,
                  let record = body["record"] as? [String: Any] else { return }
            HistoryStore.write(scope: scope, id: id, record: record)
            pushHistory(reqId, "{\"ok\":true}")
        case "historyDelete":
            guard let body = message.body as? [String: Any],
                  let reqId = body["reqId"] as? String,
                  let scope = body["scope"] as? String,
                  let id = body["id"] as? String else { return }
            HistoryStore.delete(scope: scope, id: id)
            pushHistory(reqId, "{\"ok\":true}")
        default:
            break
        }
    }

    // `json` is already a JSON value (array / object literal / "null").
    private func pushHistory(_ reqId: String, _ json: String) {
        let js = "window.MDViewerAPI && window.MDViewerAPI.onHistoryLoaded && "
            + "window.MDViewerAPI.onHistoryLoaded(\(encode(reqId)), \(json));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    private func encode(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])
        if let data, let j = String(data: data, encoding: .utf8), j.hasPrefix("["), j.hasSuffix("]") {
            return String(j.dropFirst().dropLast())
        }
        return "\"\""
    }
}
