import CoreGraphics
import Foundation

/// Reads request lines from the parent process on stdin. `trigger` fires the
/// capture gesture (used when Electron owns shortcut detection via its global
/// accelerator registration, so the helper needs no keyboard event tap).
/// `list-windows` and `capture-window` serve the composer window picker and
/// work in every watch mode.
final class ExternalTriggerListener {
    private let emitter: NDJSONEmitter
    private let emitsReady: Bool
    private let onTrigger: () -> Void
    private let onListWindows: (String) -> Void
    private let onCaptureWindow: (String, CGWindowID) -> Void
    private var buffer = Data()

    init(
        emitter: NDJSONEmitter,
        emitsReady: Bool,
        onTrigger: @escaping () -> Void,
        onListWindows: @escaping (String) -> Void,
        onCaptureWindow: @escaping (String, CGWindowID) -> Void
    ) {
        self.emitter = emitter
        self.emitsReady = emitsReady
        self.onTrigger = onTrigger
        self.onListWindows = onListWindows
        self.onCaptureWindow = onCaptureWindow
    }

    func start() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            if data.isEmpty {
                // EOF: the parent closed stdin; ParentProcessMonitor owns exit.
                FileHandle.standardInput.readabilityHandler = nil
                return
            }
            self.consume(data)
        }
        if emitsReady {
            emitter.emitReady()
        }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
            let line = String(data: buffer[buffer.startIndex ..< newlineIndex], encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(buffer.startIndex ... newlineIndex)
            guard let line, !line.isEmpty else {
                continue
            }
            handle(line: line)
        }
    }

    private func handle(line: String) {
        let parts = line.split(
            separator: " ",
            maxSplits: 2,
            omittingEmptySubsequences: true
        ).map(String.init)

        switch parts.first {
        case "trigger" where parts.count == 1:
            DispatchQueue.main.async { [onTrigger] in
                onTrigger()
            }
        case "list-windows" where parts.count == 2:
            let requestId = parts[1]
            DispatchQueue.main.async { [onListWindows] in
                onListWindows(requestId)
            }
        case "capture-window" where parts.count == 3:
            guard let windowID = UInt32(parts[2]) else {
                emitter.emitError(
                    AppSnapFailure(
                        code: "invalid_request",
                        message: "capture-window requires a numeric window id."
                    ),
                    capturedAt: appSnapTimestamp(),
                    requestId: parts[1]
                )
                return
            }
            let requestId = parts[1]
            DispatchQueue.main.async { [onCaptureWindow] in
                onCaptureWindow(requestId, CGWindowID(windowID))
            }
        default:
            let requestId = parts.count == 2 && parts[0] == "list-windows" ? parts[1] : nil
            emitter.emitError(
                AppSnapFailure(
                    code: "invalid_request",
                    message: "Unknown AppSnap helper request."
                ),
                capturedAt: appSnapTimestamp(),
                requestId: requestId
            )
        }
    }
}
