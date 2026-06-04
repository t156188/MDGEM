import Foundation
import Combine

@MainActor
final class DocumentSession: ObservableObject {
    @Published var fileURL: URL?
    @Published private(set) var text: String
    /// Pinned at the first opened file's parent directory. Subsequent loads
    /// through the in-window file tree do NOT change this — the side bar
    /// should keep showing the same workspace.
    @Published private(set) var workspaceRoot: URL?
    /// Bumped after rename / delete so the WebView re-pushes the file tree.
    @Published private(set) var treeNonce: Int = 0

    private let watcher = WorkspaceWatcher()

    init(text: String, fileURL: URL?, workspaceRoot: URL? = nil) {
        self.text = text
        self.fileURL = fileURL
        // Explicit workspace wins (folder-open path); otherwise derive it
        // from the file's parent directory as before.
        self.workspaceRoot = workspaceRoot ?? fileURL?.deletingLastPathComponent()
        watcher.onChange = { [weak self] paths in
            self?.handleFSChange(paths: paths)
        }
        watcher.watch(self.workspaceRoot)
    }

    deinit {
        watcher.stop()
    }

    /// Re-read the current file from disk and refresh the tree. Called when
    /// FSEvents reports a change inside the workspace.
    private func handleFSChange(paths: [String]) {
        bumpTree()
        guard let url = fileURL else { return }
        let target = url.standardizedFileURL.path
        let touched = paths.contains { p in
            URL(fileURLWithPath: p).standardizedFileURL.path == target
        }
        if touched {
            reload()
        }
    }

    /// Re-read the current file from disk without touching workspaceRoot.
    /// Safe to call when fileURL is nil (no-op).
    func reload() {
        guard let url = fileURL else { return }
        guard let data = try? Data(contentsOf: url) else { return }
        let s = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16)
            ?? String(decoding: data, as: UTF8.self)
        self.text = s
    }

    /// Image base for relative `![](pic.png)` links — tracks the current file.
    var imageBase: URL? {
        fileURL?.deletingLastPathComponent()
    }

    /// Load another document inside the same workspace (sidebar click).
    func load(url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        let s = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16)
            ?? String(decoding: data, as: UTF8.self)
        self.fileURL = url
        self.text = s
        RecentFiles.add(url.path)
    }

    /// Open a document as a fresh workspace inside THIS window (recent click).
    /// Unlike `load(url:)`, this re-roots `workspaceRoot` to the target's
    /// parent directory (or the folder itself), so the sidebar/tree follow the
    /// new document instead of staying pinned to the old workspace.
    func openAsWorkspace(url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        let s = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16)
            ?? String(decoding: data, as: UTF8.self)
        let newRoot = url.deletingLastPathComponent()
        self.fileURL = url
        self.text = s
        if workspaceRoot != newRoot {
            self.workspaceRoot = newRoot
            watcher.watch(newRoot)
            bumpTree()
        }
        RecentFiles.add(url.path)
    }

    /// Re-bind to a new URL after a rename of the currently-open file.
    func rebind(to url: URL) {
        self.fileURL = url
        bumpTree()
    }

    func bumpTree() {
        treeNonce &+= 1
    }
}
