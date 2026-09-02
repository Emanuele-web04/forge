import Foundation

struct AppSnapFailure: Error {
    let code: String
    let message: String
}

enum AppSnapMode {
    case checkPermissions
    case requestPermissions
    case watch(
        outputDirectory: URL,
        excludedBundleIdentifier: String,
        externalTrigger: Bool
    )
    case permissionGuide(pane: String, appPath: String, appName: String)
}

struct AppSnapOptions {
    let mode: AppSnapMode

    static func parse(_ arguments: [String]) throws -> AppSnapOptions {
        var requestedMode: String?
        var outputDirectory: String?
        var excludedBundleIdentifier: String?
        var externalTrigger = false
        var guidePane: String?
        var guideAppPath: String?
        var guideAppName: String?
        var index = 0

        // Consumes the value token after a flag, keeping the "--flag requires
        // …" usage errors identical across flags.
        func readValue(_ flag: String, _ what: String) throws -> String {
            index += 1
            guard index < arguments.count else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "\(flag) requires \(what)."
                )
            }
            return arguments[index]
        }

        // Watch-only flags are invalid in every non-watch mode.
        func rejectWatchArguments(_ message: String) throws {
            guard outputDirectory == nil, excludedBundleIdentifier == nil, !externalTrigger else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: message
                )
            }
        }

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--check-permissions", "--request-permissions", "--watch", "--permission-guide":
                guard requestedMode == nil else {
                    throw AppSnapFailure(
                        code: "invalid_arguments",
                        message: "Choose exactly one helper mode."
                    )
                }
                requestedMode = argument
            case "--output-dir":
                outputDirectory = try readValue("--output-dir", "a path")
            case "--excluded-bundle-id":
                excludedBundleIdentifier = try readValue("--excluded-bundle-id", "a bundle identifier")
            case "--external-trigger":
                externalTrigger = true
            case "--pane":
                guidePane = try readValue("--pane", "a value")
            case "--app-path":
                guideAppPath = try readValue("--app-path", "a path")
            case "--app-name":
                guideAppName = try readValue("--app-name", "a value")
            default:
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "Unknown argument: \(argument)"
                )
            }
            index += 1
        }

        switch requestedMode {
        case "--check-permissions":
            try rejectWatchArguments("Permission checks do not accept watch arguments.")
            return AppSnapOptions(mode: .checkPermissions)
        case "--request-permissions":
            try rejectWatchArguments("Permission requests do not accept watch arguments.")
            return AppSnapOptions(mode: .requestPermissions)
        case "--permission-guide":
            try rejectWatchArguments("The permission guide does not accept watch arguments.")
            guard let guidePane, guidePane == "screen-recording" || guidePane == "input-monitoring" else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--permission-guide requires --pane screen-recording or input-monitoring."
                )
            }
            guard let guideAppPath, !guideAppPath.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--permission-guide requires --app-path."
                )
            }
            guard let guideAppName, !guideAppName.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--permission-guide requires --app-name."
                )
            }
            return AppSnapOptions(
                mode: .permissionGuide(pane: guidePane, appPath: guideAppPath, appName: guideAppName)
            )
        case "--watch":
            guard let outputDirectory, !outputDirectory.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--watch requires --output-dir."
                )
            }
            guard let excludedBundleIdentifier, !excludedBundleIdentifier.isEmpty else {
                throw AppSnapFailure(
                    code: "invalid_arguments",
                    message: "--watch requires --excluded-bundle-id."
                )
            }
            return AppSnapOptions(
                mode: .watch(
                    outputDirectory: URL(fileURLWithPath: outputDirectory).standardizedFileURL,
                    excludedBundleIdentifier: excludedBundleIdentifier,
                    externalTrigger: externalTrigger
                )
            )
        default:
            throw AppSnapFailure(
                code: "invalid_arguments",
                message: "Expected --check-permissions, --request-permissions, or --watch."
            )
        }
    }
}

func appSnapTimestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

final class NDJSONEmitter {
    private let lock = NSLock()

    func emit(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              var data = try? JSONSerialization.data(withJSONObject: payload)
        else {
            writeDiagnostic("Could not encode helper protocol event.")
            return
        }

        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
    }

    func emitReady() {
        emit(["type": "ready"])
    }

    func emitTriggered(id: String, capturedAt: String) {
        emit([
            "type": "triggered",
            "id": id,
            "capturedAt": capturedAt,
        ])
    }

    func emitCaptured(
        id: String,
        capturedAt: String,
        path: String,
        name: String,
        sourceAppName: String?,
        sourceBundleIdentifier: String?,
        sourceAppIconDataURL: String?,
        sourceWindowTitle: String?
    ) {
        var payload: [String: Any] = [
            "type": "captured",
            "id": id,
            "capturedAt": capturedAt,
            "path": path,
            "name": name,
        ]
        if let sourceAppName, !sourceAppName.isEmpty {
            payload["sourceAppName"] = sourceAppName
        }
        if let sourceBundleIdentifier, !sourceBundleIdentifier.isEmpty {
            payload["sourceBundleIdentifier"] = sourceBundleIdentifier
        }
        if let sourceAppIconDataURL, !sourceAppIconDataURL.isEmpty {
            payload["sourceAppIconDataUrl"] = sourceAppIconDataURL
        }
        if let sourceWindowTitle, !sourceWindowTitle.isEmpty {
            payload["sourceWindowTitle"] = sourceWindowTitle
        }
        emit(payload)
    }

    func emitError(
        _ failure: AppSnapFailure,
        capturedAt: String,
        id: String? = nil,
        requestId: String? = nil
    ) {
        var payload: [String: Any] = [
            "type": "error",
            "code": failure.code,
            "message": failure.message,
            "capturedAt": capturedAt,
        ]
        if let id {
            payload["id"] = id
        }
        if let requestId {
            payload["requestId"] = requestId
        }
        emit(payload)
    }

    func emitWindows(requestId: String, windows: [[String: Any]]) {
        emit([
            "type": "windows",
            "requestId": requestId,
            "windows": windows,
        ])
    }

    func emitPermissionGuide(state: String) {
        emit([
            "type": "permission-guide",
            "state": state,
        ])
    }

    func emitPermissions(inputMonitoring: Bool, screenRecording: Bool) {
        emit([
            "type": "permissions",
            "inputMonitoring": inputMonitoring ? "granted" : "denied",
            "screenRecording": screenRecording ? "granted" : "denied",
        ])
    }

    private func writeDiagnostic(_ message: String) {
        guard let data = "[synara-appsnap-helper] \(message)\n".data(using: .utf8) else {
            return
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardError.write(data)
    }
}
