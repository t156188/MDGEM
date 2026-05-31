import Foundation

/// Global UI settings (theme + per-surface font sizes), persisted in
/// UserDefaults as one JSON blob under "uiSettings". Mirrors the `aiConfig`
/// storage pattern in `AIService`; the front-end owns the schema
/// (`{ theme, fontUI, fontEditor, fontTerminal, fontAI }`) and round-trips it
/// via the settingsGet / settingsSet IPC.
enum SettingsStore {
    private static let defaultsKey = "uiSettings"

    /// Returns the stored settings as a JSON string for `onSettings`, or "null".
    static func settingsJSON() -> String {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }

    /// Persist a settings dictionary pushed from JS.
    static func save(_ dict: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: []) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }
}
