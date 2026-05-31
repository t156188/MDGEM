import Foundation

/// Per-workspace UI memory (last opened file, sidebar / panel state, expanded
/// folders, terminal cwd …), persisted globally in UserDefaults under
/// "workspaceMemory" as a map keyed by the workspace root path. Nothing is
/// written into the user's project — the memory travels with the app. The
/// front-end owns the per-workspace blob schema and round-trips it via the
/// memoryGet / memorySet IPC.
enum WorkspaceMemory {
    private static let defaultsKey = "workspaceMemory"

    private static func all() -> [String: Any] {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return obj
    }

    /// Returns the stored blob for `key` as a JSON string, or "null".
    static func memoryJSON(key: String) -> String {
        let map = all()
        guard let entry = map[key],
              let data = try? JSONSerialization.data(withJSONObject: entry, options: []),
              let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }

    /// Merge-replace the blob for `key`.
    static func save(key: String, memory: [String: Any]) {
        var map = all()
        map[key] = memory
        if let data = try? JSONSerialization.data(withJSONObject: map, options: []) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}
