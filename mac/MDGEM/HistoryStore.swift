import Foundation

/// Per-conversation / per-terminal-session history, stored as **one JSON file
/// per record** under `~/Library/Application Support/MDGEM/<scope>/`, plus an
/// `index.json` listing every record's metadata for fast list rendering.
///
/// Layout:
/// ```
/// MDGEM/chat/index.json          [{id,workspace,title,createdAt,updatedAt}, …]
/// MDGEM/chat/<id>.json           {id,workspace,title,createdAt,updatedAt, messages:[…]}
/// MDGEM/term/index.json          [{id,workspace,createdAt,updatedAt}, …]
/// MDGEM/term/<id>.json           {id,workspace,createdAt,updatedAt, lines:[{cmd,ts}, …]}
/// ```
///
/// The front-end owns the per-record blob schema; native stays schema-agnostic
/// except for the fixed META_KEYS it lifts from each record to maintain the
/// index. `id` arrives from the web context and is used as a filename, so it is
/// strictly sanitized to guard against path traversal.
enum HistoryStore {
    /// Index metadata fields copied from a record into `index.json`. Records may
    /// carry more (e.g. `messages` / `lines`); those stay only in the per-id file.
    private static let metaKeys = ["id", "workspace", "title", "createdAt", "updatedAt", "deleted"]

    // MARK: - Paths

    private static func baseDir() -> URL? {
        let fm = FileManager.default
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        return base.appendingPathComponent("MDGEM", isDirectory: true)
    }

    /// `MDGEM/<chat|term|misc>/`, created on demand.
    private static func scopeDir(_ scope: String) -> URL? {
        guard let base = baseDir() else { return nil }
        let safe = (scope == "chat" || scope == "term") ? scope : "misc"
        let dir = base.appendingPathComponent(safe, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Only `[A-Za-z0-9_]` ids are honored — anything else (slashes, dots,
    /// "..", empty) is rejected so a record can never escape its scope dir.
    private static func sanitized(_ id: String) -> String? {
        guard !id.isEmpty, id.count <= 128,
              id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else {
            return nil
        }
        return id
    }

    private static func recordURL(_ scope: String, _ id: String) -> URL? {
        guard let dir = scopeDir(scope), let safe = sanitized(id) else { return nil }
        return dir.appendingPathComponent("\(safe).json")
    }

    private static func indexURL(_ scope: String) -> URL? {
        scopeDir(scope)?.appendingPathComponent("index.json")
    }

    // MARK: - Index helpers

    private static func loadIndex(_ scope: String) -> [[String: Any]] {
        guard let url = indexURL(scope),
              let data = try? Data(contentsOf: url),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return arr
    }

    private static func saveIndex(_ scope: String, _ arr: [[String: Any]]) {
        guard let url = indexURL(scope),
              let out = try? JSONSerialization.data(withJSONObject: arr, options: []) else {
            return
        }
        try? out.write(to: url, options: .atomic)
    }

    // MARK: - Public API

    /// The whole `index.json` as a JSON array string (or "[]").
    static func listJSON(scope: String) -> String {
        let arr = loadIndex(scope)
        guard let data = try? JSONSerialization.data(withJSONObject: arr, options: []),
              let json = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return json
    }

    /// One record file as a JSON string (or "null").
    static func readJSON(scope: String, id: String) -> String {
        guard let url = recordURL(scope, id),
              let data = try? Data(contentsOf: url),
              let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }

    /// Write `<id>.json` and upsert the record's metadata into `index.json`.
    static func write(scope: String, id: String, record: [String: Any]) {
        guard let url = recordURL(scope, id),
              let out = try? JSONSerialization.data(withJSONObject: record, options: []) else {
            return
        }
        try? out.write(to: url, options: .atomic)

        var meta: [String: Any] = [:]
        for k in metaKeys where record[k] != nil { meta[k] = record[k] }
        meta["id"] = id // authoritative
        var idx = loadIndex(scope)
        if let i = idx.firstIndex(where: { ($0["id"] as? String) == id }) {
            idx[i] = meta
        } else {
            idx.insert(meta, at: 0)
        }
        saveIndex(scope, idx)
    }

    /// Delete `<id>.json` and drop its index entry.
    static func delete(scope: String, id: String) {
        if let url = recordURL(scope, id) {
            try? FileManager.default.removeItem(at: url)
        }
        guard sanitized(id) != nil else { return }
        var idx = loadIndex(scope)
        idx.removeAll { ($0["id"] as? String) == id }
        saveIndex(scope, idx)
    }
}
