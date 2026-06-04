import SwiftUI
import AppKit

extension Notification.Name {
    /// Posted when a document window appears, so the welcome window can close.
    static let mdgemDidOpenDocument = Notification.Name("mdgem.didOpenDocument")
}

/// First-launch home screen. MDGEM is a `DocumentGroup` viewer, so a dedicated
/// `Window` scene (see MDGEMApp) is shown at launch — this both gives the app a
/// window (which stops the DocumentGroup from popping the system Open panel on
/// cold launch) and serves as the welcome page: open a file or folder, or pick
/// a recent. It closes automatically once a document window opens.
struct WelcomeView: View {
    @Environment(\.openWindow) private var openWindow
    @AppStorage("themeOverride") private var themeOverride: String = "dark"
    @State private var recents: [String] = RecentFiles.read()

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    /// One content column width — the hero, buttons and recents all share it so
    /// everything lines up on a single centered axis.
    private let columnWidth: CGFloat = 380

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)

            // Hero — icon + name + version, all centered.
            VStack(spacing: 14) {
                Text(".md")
                    .font(.system(size: 28, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .foregroundColor(.secondary)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4]))
                            .foregroundColor(.secondary.opacity(0.45))
                    )

                VStack(spacing: 3) {
                    Text("MDGEM").font(.system(size: 22, weight: .semibold))
                    if !appVersion.isEmpty {
                        Text("v\(appVersion)")
                            .font(.system(size: 12))
                            .foregroundColor(.secondary)
                    }
                }
            }

            // Primary actions.
            HStack(spacing: 12) {
                Button { present(allowFiles: false, allowDirs: true) } label: {
                    Label("打开文件夹", systemImage: "folder")
                }
                .buttonStyle(.borderedProminent)
                Button { present(allowFiles: true, allowDirs: true) } label: {
                    Label("打开文件", systemImage: "doc.text")
                }
            }
            .controlSize(.large)
            .padding(.top, 26)

            // Recents — a titled card, aligned to the same column as everything else.
            if !recents.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("最近打开")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.secondary)
                        .textCase(.uppercase)
                        .padding(.leading, 4)

                    VStack(spacing: 0) {
                        let items = Array(recents.prefix(6))
                        ForEach(Array(items.enumerated()), id: \.element) { idx, path in
                            RecentRow(path: path) { openRecent(path) }
                            if idx < items.count - 1 {
                                Divider().opacity(0.4).padding(.leading, 40)
                            }
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Color.primary.opacity(0.035))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(Color.primary.opacity(0.07), lineWidth: 1)
                    )
                }
                .frame(width: columnWidth)
                .padding(.top, 30)
            }

            Spacer(minLength: 24)

            // Drop hint pinned near the bottom edge.
            Label("把文件或文件夹拖到窗口即可打开", systemImage: "arrow.down.doc")
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .padding(.bottom, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
        .background(WindowAccessor { window in
            window.persistFrame(autosaveName: "MDGEMWelcomeWindow")
            // Hand the welcome NSWindow + a reopen action to the delegate so it
            // can close it on document-open and reopen it on dock reactivation.
            if let delegate = NSApp.delegate as? AppDelegate {
                delegate.register(welcome: window) { openWindow(id: AppDelegate.welcomeWindowID) }
            }
        })
    }

    private func present(allowFiles: Bool, allowDirs: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = allowFiles
        panel.canChooseDirectories = allowDirs
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Open"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            open(url)
        }
    }

    private func openRecent(_ path: String) {
        guard FileManager.default.fileExists(atPath: path) else {
            RecentFiles.prune()
            recents = RecentFiles.read()
            return
        }
        open(URL(fileURLWithPath: path))
    }

    private func open(_ url: URL) {
        NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, _ in }
    }
}

/// One recent-files row — filename on top, full path beneath (tail kept visible).
private struct RecentRow: View {
    let path: String
    let action: () -> Void
    @State private var hovering = false

    /// Folder targets get a folder glyph; files get a doc glyph.
    private var glyph: String {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: path, isDirectory: &isDir)
        return isDir.boolValue ? "folder" : "doc.text"
    }

    /// The directory the file lives in (parent for files, the folder itself for
    /// folders) — shorter and more useful than echoing the full path.
    private var subtitle: String {
        (path as NSString).deletingLastPathComponent
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: glyph)
                    .font(.system(size: 15))
                    .foregroundColor(.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text((path as NSString).lastPathComponent)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(hovering ? Color.primary.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(path)
    }
}

/// Reports the hosting NSWindow exactly once, the first time it exists. Firing
/// once (rather than on every SwiftUI update) matters for frame autosave: a
/// repeated callback would keep re-applying the saved frame and fight the user
/// resizing a window. Internal so document windows can reuse it too.
struct WindowAccessor: NSViewRepresentable {
    var onWindow: (NSWindow) -> Void
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        context.coordinator.attach(v, onWindow)
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.attach(nsView, onWindow)
    }
    final class Coordinator {
        private var done = false
        /// Retries on each update until the view has a window, then fires once.
        func attach(_ view: NSView, _ cb: @escaping (NSWindow) -> Void) {
            if done { return }
            DispatchQueue.main.async { [weak view] in
                guard !self.done, let w = view?.window else { return }
                self.done = true
                cb(w)
            }
        }
    }
}

extension NSWindow {
    /// Restore this window's last-used frame (position + size) and keep saving
    /// it under `name` in UserDefaults. No-op if already wired. AppKit stores it
    /// as the `NSWindow Frame <name>` default — nothing the app manages directly.
    func persistFrame(autosaveName name: NSWindow.FrameAutosaveName) {
        guard frameAutosaveName != name else { return }
        setFrameUsingName(name)        // apply the saved frame (no-op if none yet)
        setFrameAutosaveName(name)     // persist future moves/resizes
    }

    /// Restore + remember this window's native-fullscreen state under `key`.
    /// AppKit's frame autosave only stores the non-fullscreen frame, never the
    /// fullscreen flag, so we track it ourselves: re-enter fullscreen on open if
    /// the last session left it fullscreen, then record every enter/exit. The
    /// `FullscreenStateKeeper` is retained on the window via associated objects,
    /// so observation lives as long as the window. No-op if already wired.
    func persistFullscreen(key: String) {
        guard objc_getAssociatedObject(self, &fullscreenKeeperKey) == nil else { return }
        if UserDefaults.standard.bool(forKey: key), !styleMask.contains(.fullScreen) {
            toggleFullScreen(nil)
        }
        let keeper = FullscreenStateKeeper(key: key)
        let nc = NotificationCenter.default
        nc.addObserver(keeper, selector: #selector(FullscreenStateKeeper.didEnter),
                       name: NSWindow.didEnterFullScreenNotification, object: self)
        nc.addObserver(keeper, selector: #selector(FullscreenStateKeeper.didExit),
                       name: NSWindow.didExitFullScreenNotification, object: self)
        objc_setAssociatedObject(self, &fullscreenKeeperKey, keeper, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }
}

private var fullscreenKeeperKey: UInt8 = 0

/// Persists a window's native-fullscreen flag to UserDefaults on every
/// enter/exit, so the next launch can restore it (see `persistFullscreen`).
final class FullscreenStateKeeper: NSObject {
    private let key: String
    init(key: String) { self.key = key }
    @objc func didEnter() { UserDefaults.standard.set(true, forKey: key) }
    @objc func didExit()  { UserDefaults.standard.set(false, forKey: key) }
}

/// Manages the welcome window's lifecycle: close it when a document opens,
/// reopen it on dock reactivation with no windows, and keep the system Open
/// panel from appearing on launch.
final class AppDelegate: NSObject, NSApplicationDelegate {
    static let welcomeWindowID = "welcome"

    weak var welcomeWindow: NSWindow?
    var reopenWelcome: (() -> Void)?
    private let settingsController = SettingsWindowController()
    // Set when a document opens before the welcome window has registered (e.g.
    // launched by double-clicking a file): the welcome scene closes itself as
    // soon as it appears. Consumed (reset) on close so dock-reopen still works.
    private var pendingClose = false

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(documentOpened),
            name: .mdgemDidOpenDocument, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(openSettings(_:)),
            name: .mdgemOpenSettings, object: nil
        )
    }

    @objc private func openSettings(_ note: Notification) {
        settingsController.show(section: note.userInfo?["section"] as? String)
    }

    /// Called by the welcome view once its NSWindow exists.
    func register(welcome window: NSWindow?, reopen: @escaping () -> Void) {
        welcomeWindow = window
        reopenWelcome = reopen
        if pendingClose {
            pendingClose = false
            window?.close()
        }
    }

    @objc private func documentOpened() {
        if let w = welcomeWindow {
            w.close()
        } else {
            pendingClose = true
        }
    }

    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            if let w = welcomeWindow {
                w.makeKeyAndOrderFront(nil)
            } else {
                reopenWelcome?()
            }
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }
}
