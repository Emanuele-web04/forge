import AppKit
import Darwin
import Foundation

let emitter = NDJSONEmitter()

do {
    let options = try AppSnapOptions.parse(Array(CommandLine.arguments.dropFirst()))
    switch options.mode {
    case .checkPermissions:
        let permissions = preflightAppSnapPermissions()
        emitter.emitPermissions(
            inputMonitoring: permissions.inputMonitoring,
            screenRecording: permissions.screenRecording
        )
    case .requestPermissions:
        let permissions = requestAppSnapPermissions()
        emitter.emitPermissions(
            inputMonitoring: permissions.inputMonitoring,
            screenRecording: permissions.screenRecording
        )
    case let .watch(outputDirectory, excludedBundleIdentifier, externalTrigger):
        _ = umask(0o077)
        try preparePrivateOutputDirectory(outputDirectory)
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let coordinator = AppSnapCaptureCoordinator(
            emitter: emitter,
            outputDirectory: outputDirectory,
            excludedBundleIdentifier: excludedBundleIdentifier
        )
        let parentProcessMonitor = ParentProcessMonitor()
        parentProcessMonitor.start()

        let requestListener = ExternalTriggerListener(
            emitter: emitter,
            emitsReady: externalTrigger
        ) {
            coordinator.handleGesture()
        } onListWindows: { requestId in
            coordinator.handleListWindows(requestId: requestId)
        } onCaptureWindow: { requestId, windowID in
            coordinator.handleCaptureWindow(windowID: windowID, requestId: requestId)
        }
        requestListener.start()

        let gestureSource: AnyObject
        if externalTrigger {
            gestureSource = requestListener
        } else {
            let monitor = OptionChordMonitor(emitter: emitter) {
                coordinator.handleGesture()
            }
            monitor.start()
            gestureSource = monitor
        }

        withExtendedLifetime((coordinator, gestureSource, requestListener, parentProcessMonitor)) {
            RunLoop.main.run()
        }
    case let .permissionGuide(pane, appPath, appName):
        _ = NSApplication.shared.setActivationPolicy(.accessory)

        let coach: GrantCoach = MainActor.assumeIsolated {
            let coach = GrantCoach(
                appName: appName,
                appPath: appPath,
                pane: pane,
                emitter: emitter
            )
            let parentProcessMonitor = ParentProcessMonitor()
            parentProcessMonitor.start()
            coach.present(
                onGranted: {
                    emitter.emitPermissionGuide(state: "granted")
                    exit(0)
                },
                onDismissed: {
                    emitter.emitPermissionGuide(state: "closed")
                    exit(0)
                }
            )
            emitter.emitPermissionGuide(state: "shown")
            return coach
        }

        // The parent closes the guide by writing a `close` line to stdin.
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                FileHandle.standardInput.readabilityHandler = nil
                return
            }
            let line = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard line == "close" else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    coach.dismissFromParent()
                }
            }
        }

        // NSApplication.run() is what pumps NSEvents; a bare RunLoop.main.run()
        // never dispatches mouse events, which left the drag chip dead.
        withExtendedLifetime(coach) {
            NSApplication.shared.run()
        }
    }
} catch let failure as AppSnapFailure {
    emitter.emitError(failure, capturedAt: appSnapTimestamp())
    exit(EX_USAGE)
} catch {
    emitter.emitError(
        AppSnapFailure(
            code: "helper_failed",
            message: error.localizedDescription
        ),
        capturedAt: appSnapTimestamp()
    )
    exit(EXIT_FAILURE)
}
