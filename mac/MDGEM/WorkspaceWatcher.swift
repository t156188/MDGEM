import Foundation
import CoreServices
import AppKit

/// Recursive file-system watcher backed by FSEventStream. Emits a coalesced
/// list of changed paths per debounce window. The stream is started/stopped
/// from the owner — we never multiplex across roots.
final class WorkspaceWatcher {
    private var stream: FSEventStreamRef?
    private let queue = DispatchQueue(label: "mdgem.workspace-watcher")
    private var watchedRoot: URL?
    /// Manual +1 on ourselves, held for the stream's entire lifetime so the C
    /// callback's `info` pointer can never dangle (see watch()).
    private var selfRetain: Unmanaged<WorkspaceWatcher>?
    private var terminateObserver: NSObjectProtocol?

    /// Called on the main queue with the deduped list of changed paths.
    var onChange: (([String]) -> Void)?

    init() {
        // FSEvents can deliver a queued callback during app termination, after
        // the owning DocumentSession's deinit would normally have stopped us —
        // but on quit those deinits often don't run. Stop the stream up front
        // when the app is terminating so no callback fires into a half-torn-down
        // process (the original EXC_BAD_ACCESS crash).
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.stop()
        }
    }

    deinit {
        if let o = terminateObserver {
            NotificationCenter.default.removeObserver(o)
        }
        stopUnsafe()
    }

    func watch(_ url: URL?) {
        // No-op if the root didn't change — avoids tearing down a healthy
        // stream when SwiftUI re-renders the host.
        if watchedRoot?.standardizedFileURL == url?.standardizedFileURL {
            return
        }
        stop()
        guard let url else { return }
        let paths: CFArray = [url.path] as CFArray
        // Take a manual strong reference to ourselves and hand its opaque
        // pointer to FSEvents as the callback `info`. This guarantees `self`
        // outlives the stream regardless of whether FSEvents honors context
        // retain/release callbacks, so an in-flight callback can never
        // dereference freed memory. Released in stopUnsafe().
        let token = Unmanaged.passRetained(self)
        var context = FSEventStreamContext(
            version: 0,
            info: token.toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        // UseCFTypes is REQUIRED: the callback below reads `eventPaths` as a
        // CFArray<CFString>. Without this flag FSEvents passes a raw C `char**`
        // instead, and reinterpreting those C strings as Obj-C objects makes
        // `str as String` send a message to a path-string buffer → EXC_BAD_ACCESS
        // in objc_msgSend (the file-change crash).
        let flags = UInt32(
            kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagNoDefer
        )
        let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info else { return }
            let me = Unmanaged<WorkspaceWatcher>.fromOpaque(info)
                .takeUnretainedValue()
            // eventPaths is documented as a CFArrayRef of CFString when the
            // file-events flag is set.
            let cfArr = Unmanaged<CFArray>.fromOpaque(eventPaths)
                .takeUnretainedValue()
            var collected: [String] = []
            collected.reserveCapacity(numEvents)
            let count = CFArrayGetCount(cfArr)
            for i in 0..<count {
                let raw = CFArrayGetValueAtIndex(cfArr, i)
                let str = Unmanaged<CFString>.fromOpaque(raw!).takeUnretainedValue()
                collected.append(str as String)
            }
            me.deliver(paths: collected)
        }
        guard let s = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.3, // latency seconds — FSEvents coalesces inside this window
            flags
        ) else {
            // Creation failed — drop the manual ref we just took.
            token.release()
            return
        }
        selfRetain = token
        FSEventStreamSetDispatchQueue(s, queue)
        FSEventStreamStart(s)
        stream = s
        watchedRoot = url
    }

    func stop() {
        stopUnsafe()
        watchedRoot = nil
    }

    private func stopUnsafe() {
        guard let s = stream else { return }
        stream = nil
        // Tear down on the same serial queue the callbacks run on, so an
        // in-flight event finishes before invalidation rather than racing it.
        // Not called from `queue` itself (only from main/deinit), so no
        // deadlock.
        queue.sync {
            FSEventStreamStop(s)
            FSEventStreamInvalidate(s)
            FSEventStreamRelease(s)
        }
        // Drop our manual self-ref now that no further callbacks can fire. A
        // strong owner (DocumentSession) still holds us across stop(), so this
        // never re-enters deinit.
        selfRetain?.release()
        selfRetain = nil
    }

    private func deliver(paths: [String]) {
        let cb = onChange
        DispatchQueue.main.async {
            cb?(paths)
        }
    }
}
