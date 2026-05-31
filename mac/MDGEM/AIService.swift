import Foundation

/// AI assistant config + streaming HTTP. All providers (Qwen/DashScope, Zhipu
/// GLM, DeepSeek, custom) expose an OpenAI-compatible `/chat/completions`
/// endpoint, so a single code path serves them all. The HTTP call runs natively
/// (not in page JS) to avoid `file://`-origin CORS and to keep the API key out
/// of the web context. Config is persisted in UserDefaults.
///
/// The request is sent with `stream:true` and `tools`, so this drives the
/// agent loop in `viewer.entry.js`: the model streams text deltas (forwarded as
/// `onAiDelta`) and may finish by asking for tool calls (delivered in
/// `onAiDone`'s `toolCalls`). One turn of the loop == one `chat(...)` call.
enum AIService {
    private static let defaultsKey = "aiConfig"

    /// Returns the stored config as a JSON string for `onAiConfig`, or "null".
    static func configJSON() -> String {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }

    /// Persist a config dictionary pushed from JS.
    static func saveConfig(_ dict: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: []) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
    }

    private static func currentConfig() -> [String: Any]? {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return obj
    }

    /// One streaming chat turn. `messages` is the JS-built array of
    /// `{role, content, tool_calls?, tool_call_id?}`; `tools` is the OpenAI
    /// function-schema array (may be empty). `onDelta` fires per streamed text
    /// chunk; `onDone(content, toolCallsJSON)` fires once at the end with the
    /// full assistant text and a JSON array string of `{id, name, arguments}`
    /// (or "null"); `onError` fires on failure. All callbacks run off the main
    /// thread (the caller hops to main for evaluateJavaScript).
    /// `creds` carries the per-request {baseURL, apiKey, model, temperature?}
    /// chosen from the chat model dropdown. Falls back to the stored config for
    /// any missing field (back-compat).
    static func chat(
        creds: [String: Any]?,
        messages: [[String: Any]],
        tools: [[String: Any]],
        onDelta: @escaping (String) -> Void,
        onDone: @escaping (String, String) -> Void,
        onError: @escaping (String) -> Void
    ) {
        let cfg = currentConfig() ?? [:]
        let baseURL = ((creds?["baseURL"] as? String) ?? (cfg["baseURL"] as? String) ?? "")
            .trimmingCharacters(in: .whitespaces)
        let model = ((creds?["model"] as? String) ?? (cfg["model"] as? String) ?? "")
            .trimmingCharacters(in: .whitespaces)
        let apiKey = ((creds?["apiKey"] as? String) ?? (cfg["apiKey"] as? String) ?? "")
            .trimmingCharacters(in: .whitespaces)
        guard !baseURL.isEmpty, !model.isEmpty, !apiKey.isEmpty else {
            onError("AI is not configured yet")
            return
        }

        let trimmed = baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL
        guard let url = URL(string: trimmed + "/chat/completions") else {
            onError("Invalid API base URL")
            return
        }

        var body: [String: Any] = [
            "model": model,
            "messages": messages,
            "stream": true,
        ]
        if let temp = creds?["temperature"] as? Double {
            body["temperature"] = temp
        } else if let tempN = creds?["temperature"] as? NSNumber {
            body["temperature"] = tempN.doubleValue
        }
        if !tools.isEmpty {
            body["tools"] = tools
            body["tool_choice"] = "auto"
        }
        guard let httpBody = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            onError("Could not encode request")
            return
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = httpBody
        req.timeoutInterval = 600  // long-running agent turns

        Task {
            do {
                let (bytes, response) = try await URLSession.shared.bytes(for: req)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard status == 200 else {
                    // Drain the error body (it's small JSON, not a stream).
                    var raw = ""
                    for try await line in bytes.lines { raw += line }
                    onError(extractError(raw) ?? "HTTP \(status)")
                    return
                }

                var content = ""
                var toolAccs: [Int: ToolAcc] = [:]

                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if payload.isEmpty { continue }
                    if payload == "[DONE]" { break }
                    guard let data = payload.data(using: .utf8),
                          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let choices = obj["choices"] as? [[String: Any]],
                          let delta = choices.first?["delta"] as? [String: Any] else {
                        continue
                    }
                    if let piece = delta["content"] as? String, !piece.isEmpty {
                        content += piece
                        onDelta(piece)
                    }
                    if let calls = delta["tool_calls"] as? [[String: Any]] {
                        for call in calls {
                            let idx = call["index"] as? Int ?? 0
                            var acc = toolAccs[idx] ?? ToolAcc()
                            if let id = call["id"] as? String, !id.isEmpty { acc.id = id }
                            if let fn = call["function"] as? [String: Any] {
                                if let name = fn["name"] as? String, !name.isEmpty { acc.name = name }
                                if let args = fn["arguments"] as? String { acc.args += args }
                            }
                            toolAccs[idx] = acc
                        }
                    }
                }

                let toolJSON = encodeToolCalls(toolAccs)
                onDone(content, toolJSON)
            } catch {
                onError(error.localizedDescription)
            }
        }
    }

    /// Partial tool call assembled across streamed deltas, keyed by `index`.
    private struct ToolAcc {
        var id = ""
        var name = ""
        var args = ""
    }

    /// Serialize accumulated tool calls (ordered by index) to a JSON array
    /// string, or "null" when the model requested none.
    private static func encodeToolCalls(_ accs: [Int: ToolAcc]) -> String {
        let named = accs.keys.sorted().compactMap { idx -> [String: Any]? in
            guard let a = accs[idx], !a.name.isEmpty else { return nil }
            return ["id": a.id, "name": a.name, "arguments": a.args]
        }
        guard !named.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: named, options: []),
              let str = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return str
    }

    /// Pull a provider error message out of a non-200 body when present.
    private static func extractError(_ raw: String) -> String? {
        guard let data = raw.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return raw.isEmpty ? nil : String(raw.prefix(300))
        }
        if let err = obj["error"] as? [String: Any], let msg = err["message"] as? String {
            return msg
        }
        return obj["message"] as? String
    }
}
