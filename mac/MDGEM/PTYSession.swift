import Foundation
import Darwin

/// A single interactive pseudo-terminal: opens a pty master/slave pair, launches
/// the user's login shell on the slave, streams the master fd's output to
/// `onData`, and forwards keystrokes/resize back. Pure POSIX + Process (no
/// fork), which is the safe route from Swift. Output is decoded as UTF-8 and
/// handed up as a String; the caller hops to the main thread to push it into JS.
final class PTYSession {
    private let masterFD: Int32
    private let process = Process()
    private var source: DispatchSourceRead?
    private let onData: (String) -> Void
    private let onExit: (Int32) -> Void
    private var exited = false
    // Holds the trailing bytes of a multibyte UTF-8 char that got split across a
    // read boundary, so the next read can complete it instead of emitting `�`.
    private var carry: [UInt8] = []

    init?(
        cwd: String?,
        cols: Int,
        rows: Int,
        onData: @escaping (String) -> Void,
        onExit: @escaping (Int32) -> Void
    ) {
        self.onData = onData
        self.onExit = onExit

        // Open the pty master and unlock its slave.
        let master = posix_openpt(O_RDWR | O_NOCTTY)
        guard master >= 0, grantpt(master) == 0, unlockpt(master) == 0,
              let slaveNamePtr = ptsname(master) else {
            if master >= 0 { close(master) }
            return nil
        }
        let slavePath = String(cString: slaveNamePtr)
        let slave = open(slavePath, O_RDWR | O_NOCTTY)
        guard slave >= 0 else { close(master); return nil }
        self.masterFD = master

        // Seed the window size before the shell starts.
        var ws = winsize(
            ws_row: UInt16(max(1, rows)),
            ws_col: UInt16(max(1, cols)),
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(master, TIOCSWINSZ, &ws)

        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-l"]
        if let cwd, !cwd.isEmpty,
           FileManager.default.fileExists(atPath: cwd) {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }
        var env = ProcessInfo.processInfo.environment
        env["TERM"] = "xterm-256color"
        process.environment = env

        // The shell's stdio is the slave; we keep the master. closeOnDealloc is
        // false so we control the slave fd's lifetime explicitly.
        let slaveHandle = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
        process.standardInput = slaveHandle
        process.standardOutput = slaveHandle
        process.standardError = slaveHandle
        process.terminationHandler = { [weak self] proc in
            self?.finish(proc.terminationStatus)
        }

        do {
            try process.run()
        } catch {
            close(master)
            close(slave)
            return nil
        }
        // The child holds its own dup'd copy now; drop the parent's slave fd so
        // the master sees EOF when the shell exits.
        close(slave)

        startReading()
    }

    /// Number of trailing bytes that form an *incomplete* UTF-8 sequence (0–3),
    /// i.e. a multibyte char cut off at the buffer's end. Those bytes should be
    /// carried to the next read rather than decoded now.
    private static func incompleteSuffixLength(_ bytes: [UInt8]) -> Int {
        var i = bytes.count - 1
        var conts = 0
        while i >= 0, (bytes[i] & 0xC0) == 0x80, conts < 3 {
            conts += 1
            i -= 1
        }
        if i < 0 { return conts }
        let lead = bytes[i]
        let need: Int
        if lead & 0x80 == 0x00 { need = 1 }       // ASCII
        else if lead & 0xE0 == 0xC0 { need = 2 }
        else if lead & 0xF0 == 0xE0 { need = 3 }
        else if lead & 0xF8 == 0xF0 { need = 4 }
        else { return 0 }                          // invalid lead — let decoder cope
        let have = conts + 1
        return have < need ? have : 0
    }

    private func startReading() {
        let src = DispatchSource.makeReadSource(
            fileDescriptor: masterFD,
            queue: DispatchQueue.global(qos: .userInitiated)
        )
        src.setEventHandler { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: 8192)
            let n = buf.withUnsafeMutableBytes { read(self.masterFD, $0.baseAddress, $0.count) }
            if n > 0 {
                // Append to any carried-over bytes, decode only the complete
                // UTF-8 prefix, and keep an unfinished trailing char for later.
                self.carry.append(contentsOf: buf[0..<n])
                let cut = self.carry.count - PTYSession.incompleteSuffixLength(self.carry)
                if cut > 0 {
                    let s = String(decoding: self.carry[0..<cut], as: UTF8.self)
                    if !s.isEmpty { self.onData(s) }
                    self.carry.removeFirst(cut)
                }
            } else {
                // EOF or error → the shell is gone.
                self.finish(self.process.isRunning ? -1 : self.process.terminationStatus)
            }
        }
        source = src
        src.resume()
    }

    func write(_ s: String) {
        let bytes = Array(s.utf8)
        bytes.withUnsafeBytes { ptr in
            _ = Darwin.write(masterFD, ptr.baseAddress, ptr.count)
        }
    }

    func resize(cols: Int, rows: Int) {
        var ws = winsize(
            ws_row: UInt16(max(1, rows)),
            ws_col: UInt16(max(1, cols)),
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(masterFD, TIOCSWINSZ, &ws)
    }

    func kill() {
        if process.isRunning { process.terminate() }
        finish(process.isRunning ? -1 : process.terminationStatus)
    }

    private func finish(_ code: Int32) {
        guard !exited else { return }
        exited = true
        source?.cancel()
        source = nil
        close(masterFD)
        onExit(code)
    }
}
