import Foundation

/// Native side of the AI agent's tools that need filesystem / process / network
/// access the web context can't safely do itself. The JS agent loop routes
/// `list_dir` / `search` / `run_command` / `web_search` here over the `aiTool`
/// message handler; plain file read/write reuse the existing readFileText /
/// writeFile IPC. Every entry point returns a plain-text result string that is
/// fed straight back to the model as the tool message content.
enum WorkspaceTools {
    /// Dispatch a tool call by name. `args` is the model-provided argument dict.
    /// `completion(ok, text)`; on `ok == false` the text is an error the model
    /// can read and recover from. Always invoked on a background queue.
    static func run(name: String, args: [String: Any], completion: @escaping (Bool, String) -> Void) {
        switch name {
        case "list_dir":
            completion(true, listDir(path: (args["path"] as? String) ?? ""))
        case "search":
            completion(true, search(query: (args["query"] as? String) ?? "",
                                    root: (args["path"] as? String) ?? ""))
        case "run_command":
            runCommand(command: (args["command"] as? String) ?? "",
                       cwd: args["cwd"] as? String,
                       completion: completion)
        case "web_search":
            webSearch(query: (args["query"] as? String) ?? "", completion: completion)
        default:
            completion(false, "Unknown tool: \(name)")
        }
    }

    // MARK: - list_dir

    /// One level of directory entries, folders suffixed with `/`.
    static func listDir(path: String) -> String {
        let dir = path.isEmpty ? FileManager.default.currentDirectoryPath : path
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dir, isDirectory: &isDir), isDir.boolValue else {
            return "Error: not a directory: \(dir)"
        }
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else {
            return "Error: cannot list \(dir)"
        }
        if entries.isEmpty { return "(empty directory)" }
        let lines = entries.sorted().map { name -> String in
            var sub: ObjCBool = false
            fm.fileExists(atPath: (dir as NSString).appendingPathComponent(name), isDirectory: &sub)
            return sub.boolValue ? "\(name)/" : name
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - search (workspace grep)

    private static let maxMatches = 80
    private static let maxFileBytes = 1_000_000

    /// Case-insensitive substring grep over text files under `root`, skipping
    /// hidden entries and the lazy (node_modules/build/…) directories. Returns
    /// `relative/path:line: text` lines, capped at `maxMatches`.
    static func search(query: String, root: String) -> String {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return "Error: empty search query." }
        let rootURL = URL(fileURLWithPath: root.isEmpty ? FileManager.default.currentDirectoryPath : root)
        let fm = FileManager.default
        guard let en = fm.enumerator(
            at: rootURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return "Error: cannot scan \(rootURL.path)"
        }

        let lower = needle.lowercased()
        var out: [String] = []
        var truncated = false
        for case let url as URL in en {
            let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                if FileTree.lazyDirNames.contains(url.lastPathComponent) { en.skipDescendants() }
                continue
            }
            guard let attrs = try? fm.attributesOfItem(atPath: url.path),
                  let size = attrs[.size] as? Int, size <= maxFileBytes else { continue }
            guard let data = try? Data(contentsOf: url),
                  let text = String(data: data, encoding: .utf8) else { continue }
            let rel = url.path.hasPrefix(rootURL.path)
                ? String(url.path.dropFirst(rootURL.path.count).drop(while: { $0 == "/" }))
                : url.path
            var lineNo = 0
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                lineNo += 1
                if line.lowercased().contains(lower) {
                    let snippet = line.trimmingCharacters(in: .whitespaces)
                    out.append("\(rel):\(lineNo): \(String(snippet.prefix(200)))")
                    if out.count >= maxMatches { truncated = true; break }
                }
            }
            if truncated { break }
        }
        if out.isEmpty { return "No matches for \"\(needle)\"." }
        var result = out.joined(separator: "\n")
        if truncated { result += "\n… (truncated at \(maxMatches) matches)" }
        return result
    }

    // MARK: - run_command

    private static let commandTimeout: TimeInterval = 120
    private static let maxOutputChars = 20_000

    /// Run a one-shot shell command via a login zsh (so PATH is populated),
    /// merging stdout+stderr through a single pipe (no deadlock), with a
    /// watchdog terminate. The JS layer already got user approval.
    static func runCommand(command: String, cwd: String?, completion: @escaping (Bool, String) -> Void) {
        let cmd = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty else { completion(false, "Error: empty command"); return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", cmd]
        if let cwd, !cwd.isEmpty { proc.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe

        do {
            try proc.run()
        } catch {
            completion(false, "Error: \(error.localizedDescription)")
            return
        }

        var timedOut = false
        let watchdog = DispatchWorkItem {
            if proc.isRunning { timedOut = true; proc.terminate() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + commandTimeout, execute: watchdog)

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        watchdog.cancel()

        var out = String(data: data, encoding: .utf8) ?? ""
        if out.count > maxOutputChars {
            out = String(out.prefix(maxOutputChars)) + "\n… (output truncated)"
        }
        let code = proc.terminationStatus
        var header = "exit code: \(code)"
        if timedOut { header += " (terminated after \(Int(commandTimeout))s timeout)" }
        let body = out.isEmpty ? "(no output)" : out
        completion(code == 0 && !timedOut, "\(header)\n\(body)")
    }

    // MARK: - web_search (DuckDuckGo HTML, no API key)

    /// Best-effort public web search by scraping DuckDuckGo's HTML endpoint.
    /// No key needed; swap for a keyed provider later if reliability matters.
    static func webSearch(query: String, completion: @escaping (Bool, String) -> Void) {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { completion(false, "Error: empty query"); return }
        guard let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://html.duckduckgo.com/html/?q=\(enc)") else {
            completion(false, "Error: bad query"); return
        }
        var req = URLRequest(url: url)
        req.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/605.1.15",
            forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 30
        URLSession.shared.dataTask(with: req) { data, _, err in
            if let err { completion(false, "Error: \(err.localizedDescription)"); return }
            guard let data, let html = String(data: data, encoding: .utf8) else {
                completion(false, "Error: empty response"); return
            }
            let parsed = parseDuckDuckGo(html)
            completion(true, parsed.isEmpty ? "No results found." : parsed)
        }.resume()
    }

    private static let maxResults = 6

    private static func parseDuckDuckGo(_ html: String) -> String {
        let links = matches(in: html,
            pattern: "<a[^>]*class=\"result__a\"[^>]*href=\"([^\"]*)\"[^>]*>(.*?)</a>")
        let snippets = matches(in: html,
            pattern: "<a[^>]*class=\"result__snippet\"[^>]*>(.*?)</a>")
        var out: [String] = []
        for (i, link) in links.prefix(maxResults).enumerated() {
            let urlStr = decodeRedirect(link.0)
            let title = stripTags(link.1)
            let snippet = i < snippets.count ? stripTags(snippets[i].0) : ""
            var entry = "\(i + 1). \(title)\n   \(urlStr)"
            if !snippet.isEmpty { entry += "\n   \(snippet)" }
            out.append(entry)
        }
        return out.joined(separator: "\n\n")
    }

    /// Returns capture groups 1 (and 2 if present) for each match.
    private static func matches(in text: String, pattern: String) -> [(String, String)] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators]) else {
            return []
        }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { m in
            let g1 = m.numberOfRanges > 1 && m.range(at: 1).location != NSNotFound
                ? ns.substring(with: m.range(at: 1)) : ""
            let g2 = m.numberOfRanges > 2 && m.range(at: 2).location != NSNotFound
                ? ns.substring(with: m.range(at: 2)) : ""
            return (g1, g2)
        }
    }

    private static func stripTags(_ s: String) -> String {
        let noTags = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        return noTags
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#x27;", with: "'")
            .replacingOccurrences(of: "&#39;", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// DuckDuckGo wraps result URLs as `…/l/?uddg=<percent-encoded real url>`.
    private static func decodeRedirect(_ href: String) -> String {
        var h = href
        if h.hasPrefix("//") { h = "https:" + h }
        guard let comps = URLComponents(string: h),
              let uddg = comps.queryItems?.first(where: { $0.name == "uddg" })?.value else {
            return h
        }
        return uddg
    }
}
