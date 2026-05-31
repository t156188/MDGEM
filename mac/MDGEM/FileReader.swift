import Foundation

/// Reads small text/code files for the in-app preview. Returns a JSON string
/// shaped for `window.MDViewerAPI.onReadFileResult(reqId, payload)`:
/// `{ "path": ..., "ok": Bool, "text"?: ..., "error"?: ... }`.
enum FileReader {
    /// Files larger than this are refused — the preview is for source/text,
    /// not for hauling megabytes across the JS bridge.
    static let maxBytes = 2 * 1024 * 1024

    static func readText(path: String) -> String {
        let url = URL(fileURLWithPath: path)
        func payload(_ dict: [String: Any]) -> String {
            (try? JSONSerialization.data(withJSONObject: dict, options: []))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        }

        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        if let size = attrs?[.size] as? Int, size > maxBytes {
            return payload(["path": path, "ok": false, "error": "File too large to preview"])
        }

        guard let data = try? Data(contentsOf: url) else {
            return payload(["path": path, "ok": false, "error": "Could not read file"])
        }
        guard let text = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16) else {
            return payload(["path": path, "ok": false, "error": "Not a text file"])
        }
        return payload(["path": path, "ok": true, "text": text])
    }
}
