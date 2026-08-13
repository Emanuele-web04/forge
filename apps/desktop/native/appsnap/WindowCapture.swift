import AppKit
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

private let maximumPNGByteCount = 10 * 1024 * 1024
private let maximumCaptureDimension = 8_192
private let captureTimeoutSeconds = 6.0

struct SelectedWindow {
    let windowID: CGWindowID
    let bounds: CGRect
    let sourceAppName: String?
    let sourceBundleIdentifier: String?
    let sourceAppIconDataURL: String?
    let sourceWindowTitle: String?
}

private func appIconDataURL(for application: NSRunningApplication) -> String? {
    guard let bundleURL = application.bundleURL else {
        return nil
    }
    let sourceIcon = NSWorkspace.shared.icon(forFile: bundleURL.path)
    let iconSize = NSSize(width: 64, height: 64)
    let renderedIcon = NSImage(size: iconSize)
    renderedIcon.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    sourceIcon.draw(
        in: NSRect(origin: .zero, size: iconSize),
        from: .zero,
        operation: .copy,
        fraction: 1
    )
    renderedIcon.unlockFocus()
    guard let tiffData = renderedIcon.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffData),
          let pngData = bitmap.representation(using: .png, properties: [:]),
          pngData.count <= 128_000
    else {
        return nil
    }
    return "data:image/png;base64,\(pngData.base64EncodedString())"
}

private func number(
    in dictionary: [String: Any],
    forKey key: CFString
) -> NSNumber? {
    dictionary[key as String] as? NSNumber
}

func selectFrontmostWindow(excludedBundleIdentifier: String) -> Result<SelectedWindow, AppSnapFailure> {
    guard let application = NSWorkspace.shared.frontmostApplication, !application.isTerminated else {
        return .failure(
            AppSnapFailure(
                code: "no_frontmost_application",
                message: "There is no frontmost application to capture."
            )
        )
    }

    if application.bundleIdentifier == excludedBundleIdentifier {
        return .failure(
            AppSnapFailure(
                code: "excluded_frontmost_application",
                message: "Synara cannot capture its own window."
            )
        )
    }

    guard let windowInfo = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements],
        kCGNullWindowID
    ) as? [[String: Any]] else {
        return .failure(
            AppSnapFailure(
                code: "window_list_unavailable",
                message: "macOS did not provide a window list."
            )
        )
    }

    // The on-screen window list is ordered front to back, so the first
    // eligible window is the app's visually frontmost one. Multi-window apps
    // can still expose untitled auxiliary layer-0 windows (overlays, buffers)
    // above the focused document window, so prefer the frontmost *titled*
    // window and only fall back to the frontmost untitled candidate.
    let processIdentifier = application.processIdentifier
    var chosen: (windowID: CGWindowID, bounds: CGRect, title: String?)?
    for candidate in windowInfo {
        guard number(in: candidate, forKey: kCGWindowOwnerPID)?.int32Value == processIdentifier,
              number(in: candidate, forKey: kCGWindowLayer)?.intValue == 0,
              number(in: candidate, forKey: kCGWindowAlpha)?.doubleValue ?? 1 > 0,
              number(in: candidate, forKey: kCGWindowIsOnscreen)?.boolValue ?? true,
              number(in: candidate, forKey: kCGWindowSharingState)?.uint32Value !=
                  CGWindowSharingType.none.rawValue,
              let windowID = number(in: candidate, forKey: kCGWindowNumber)?.uint32Value,
              let boundsDictionary = candidate[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              bounds.width >= 2,
              bounds.height >= 2
        else {
            continue
        }

        let title = candidate[kCGWindowName as String] as? String
        if let title, !title.isEmpty {
            chosen = (windowID, bounds, title)
            break
        }
        if chosen == nil {
            chosen = (windowID, bounds, title)
        }
    }

    guard let chosen else {
        return .failure(
            AppSnapFailure(
                code: "no_eligible_window",
                message: "The frontmost application has no visible, shareable layer-0 window."
            )
        )
    }

    return .success(
        SelectedWindow(
            windowID: chosen.windowID,
            bounds: chosen.bounds,
            sourceAppName: application.localizedName,
            sourceBundleIdentifier: application.bundleIdentifier,
            sourceAppIconDataURL: appIconDataURL(for: application),
            sourceWindowTitle: chosen.title
        )
    )
}

private func backingScale(for windowBounds: CGRect) -> CGFloat {
    var displayCount: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &displayCount) == .success, displayCount > 0 else {
        return 2
    }

    var displays = Array(repeating: CGDirectDisplayID(), count: Int(displayCount))
    guard CGGetActiveDisplayList(displayCount, &displays, &displayCount) == .success else {
        return 2
    }

    var bestIntersectionArea: CGFloat = 0
    var bestScale: CGFloat = 2
    for display in displays.prefix(Int(displayCount)) {
        let displayBounds = CGDisplayBounds(display)
        let intersection = displayBounds.intersection(windowBounds)
        let area = max(0, intersection.width) * max(0, intersection.height)
        guard area > bestIntersectionArea, displayBounds.width > 0 else {
            continue
        }
        bestIntersectionArea = area
        bestScale = CGFloat(CGDisplayPixelsWide(display)) / displayBounds.width
    }
    return max(1, bestScale)
}

private func captureDimensions(for window: SCWindow, selectedBounds: CGRect) -> (width: Int, height: Int)? {
    let scale = backingScale(for: selectedBounds)
    var width = max(1, Int(ceil(window.frame.width * scale)))
    var height = max(1, Int(ceil(window.frame.height * scale)))
    guard width > 1, height > 1 else {
        return nil
    }

    let largestDimension = max(width, height)
    if largestDimension > maximumCaptureDimension {
        let reduction = Double(maximumCaptureDimension) / Double(largestDimension)
        width = max(1, Int((Double(width) * reduction).rounded(.down)))
        height = max(1, Int((Double(height) * reduction).rounded(.down)))
    }
    return (width, height)
}

final class OneFrameWindowCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    typealias Completion = (Result<CGImage, AppSnapFailure>) -> Void

    private let selectedWindow: SelectedWindow
    private let completion: Completion
    private let outputQueue = DispatchQueue(label: "dev.synara.appsnap.stream-output")
    private let completionLock = NSLock()
    private var stream: SCStream?
    private var completed = false

    init(selectedWindow: SelectedWindow, completion: @escaping Completion) {
        self.selectedWindow = selectedWindow
        self.completion = completion
    }

    func start() {
        outputQueue.asyncAfter(deadline: .now() + captureTimeoutSeconds) { [weak self] in
            self?.finish(
                .failure(
                    AppSnapFailure(
                        code: "capture_timed_out",
                        message: "Timed out while preparing or capturing the window."
                    )
                )
            )
        }

        SCShareableContent.getExcludingDesktopWindows(
            true,
            onScreenWindowsOnly: true
        ) { [weak self] content, error in
            guard let self else { return }
            self.outputQueue.async {
                self.handleShareableContent(content, error: error)
            }
        }
    }

    private func handleShareableContent(_ content: SCShareableContent?, error: Error?) {
        completionLock.lock()
        let shouldContinue = !completed
        completionLock.unlock()
        guard shouldContinue else { return }

        if let error {
            finish(
                .failure(
                    AppSnapFailure(
                        code: "shareable_content_unavailable",
                        message: "Could not read shareable windows: \(error.localizedDescription)"
                    )
                )
            )
            return
        }
        guard let window = content?.windows.first(where: {
            $0.windowID == selectedWindow.windowID
        }) else {
            finish(
                .failure(
                    AppSnapFailure(
                        code: "window_unavailable",
                        message: "The selected window disappeared before it could be captured."
                    )
                )
            )
            return
        }
        startStream(for: window)
    }

    private func startStream(for window: SCWindow) {
        guard let dimensions = captureDimensions(for: window, selectedBounds: selectedWindow.bounds) else {
            finish(
                .failure(
                    AppSnapFailure(
                        code: "invalid_window_dimensions",
                        message: "The selected window has invalid capture dimensions."
                    )
                )
            )
            return
        }

        let configuration = SCStreamConfiguration()
        configuration.width = dimensions.width
        configuration.height = dimensions.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.queueDepth = 1
        configuration.scalesToFit = true
        configuration.showsCursor = false
        configuration.colorSpaceName = CGColorSpace.sRGB as CFString

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)

        completionLock.lock()
        guard !completed else {
            completionLock.unlock()
            return
        }
        self.stream = stream
        completionLock.unlock()

        do {
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
        } catch {
            finish(
                .failure(
                    AppSnapFailure(
                        code: "capture_setup_failed",
                        message: "Could not configure window capture: \(error.localizedDescription)"
                    )
                )
            )
            return
        }

        stream.startCapture { [weak self] error in
            guard let self, let error else { return }
            self.finish(
                .failure(
                    AppSnapFailure(
                        code: "capture_start_failed",
                        message: "Could not start window capture: \(error.localizedDescription)"
                    )
                )
            )
        }

    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .screen,
              sampleBuffer.isValid,
              sampleBuffer.dataReadiness == .ready,
              isCompleteFrame(sampleBuffer),
              let imageBuffer = sampleBuffer.imageBuffer
        else {
            return
        }

        let image = CIImage(cvPixelBuffer: imageBuffer)
        let context = CIContext(options: [.cacheIntermediates: false])
        guard let cgImage = context.createCGImage(image, from: image.extent) else {
            finish(
                .failure(
                    AppSnapFailure(
                        code: "frame_conversion_failed",
                        message: "Could not convert the captured frame into an image."
                    )
                )
            )
            return
        }
        finish(.success(cgImage))
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        finish(
            .failure(
                AppSnapFailure(
                    code: "capture_stopped",
                    message: "Window capture stopped unexpectedly: \(error.localizedDescription)"
                )
            )
        )
    }

    private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer,
            createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
            let frame = attachments.first,
            let status = frame[.status] as? NSNumber
        else {
            return false
        }
        return status.intValue == SCFrameStatus.complete.rawValue
    }

    private func finish(_ result: Result<CGImage, AppSnapFailure>) {
        completionLock.lock()
        guard !completed else {
            completionLock.unlock()
            return
        }
        completed = true
        let activeStream = stream
        completionLock.unlock()

        if let activeStream {
            activeStream.stopCapture { _ in }
        }
        completion(result)
    }
}

private func resizedImage(_ image: CGImage, width: Int, height: Int) -> CGImage? {
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil,
              width: width,
              height: height,
              bitsPerComponent: 8,
              bytesPerRow: 0,
              space: colorSpace,
              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          )
    else {
        return nil
    }

    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

func encodePNGUnderAttachmentLimit(_ image: CGImage) throws -> Data {
    var currentImage = image

    for _ in 0..<20 {
        let bitmap = NSBitmapImageRep(cgImage: currentImage)
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw AppSnapFailure(
                code: "png_encoding_failed",
                message: "Could not encode the captured window as PNG."
            )
        }
        if data.count < maximumPNGByteCount {
            return data
        }

        let byteRatio = Double(maximumPNGByteCount - 1) / Double(data.count)
        let scale = min(0.82, max(0.25, sqrt(byteRatio) * 0.9))
        let width = max(1, Int((Double(currentImage.width) * scale).rounded(.down)))
        let height = max(1, Int((Double(currentImage.height) * scale).rounded(.down)))
        guard width < currentImage.width || height < currentImage.height,
              let nextImage = resizedImage(currentImage, width: width, height: height)
        else {
            break
        }
        currentImage = nextImage
    }

    throw AppSnapFailure(
        code: "png_too_large",
        message: "The captured window could not be reduced below the 10 MiB image limit."
    )
}

func preparePrivateOutputDirectory(_ directory: URL) throws {
    do {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: directory.path
        )
    } catch {
        throw AppSnapFailure(
            code: "output_directory_unavailable",
            message: "Could not prepare the private capture directory: \(error.localizedDescription)"
        )
    }
}

func writePrivatePNG(_ data: Data, id: String, to directory: URL) throws -> (path: String, name: String) {
    let name = "appsnap-\(id).png"
    let destination = directory.appendingPathComponent(name, isDirectory: false)
    do {
        try data.write(to: destination, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: destination.path
        )
        return (destination.path, name)
    } catch {
        try? FileManager.default.removeItem(at: destination)
        throw AppSnapFailure(
            code: "output_write_failed",
            message: "Could not write the captured PNG: \(error.localizedDescription)"
        )
    }
}

final class AppSnapCaptureCoordinator {
    private let emitter: NDJSONEmitter
    private let outputDirectory: URL
    private let excludedBundleIdentifier: String
    private let captureFeedback = AppSnapCaptureFeedback()
    private let queue = DispatchQueue(label: "dev.synara.appsnap.capture")
    private var activeCapture: OneFrameWindowCapture?

    init(
        emitter: NDJSONEmitter,
        outputDirectory: URL,
        excludedBundleIdentifier: String
    ) {
        self.emitter = emitter
        self.outputDirectory = outputDirectory
        self.excludedBundleIdentifier = excludedBundleIdentifier
    }

    func handleGesture() {
        queue.async { [weak self] in
            self?.beginCapture()
        }
    }

    private func beginCapture() {
        let id = UUID().uuidString.lowercased()
        let capturedAt = appSnapTimestamp()

        // Resolve the target before notifying Electron. That prevents any focus
        // response to `triggered` from changing which application is captured.
        let selection = DispatchQueue.main.sync {
            selectFrontmostWindow(excludedBundleIdentifier: excludedBundleIdentifier)
        }

        // Overlapping chords report only the overlap error; emitting `triggered`
        // first would mis-order protocol semantics for consumers correlating ids.
        guard activeCapture == nil else {
            emitter.emitError(
                AppSnapFailure(
                    code: "capture_in_progress",
                    message: "A previous AppSnap capture is still in progress."
                ),
                capturedAt: capturedAt,
                id: id
            )
            return
        }
        emitter.emitTriggered(id: id, capturedAt: capturedAt)

        guard case let .success(selectedWindow) = selection else {
            if case let .failure(failure) = selection {
                emitter.emitError(failure, capturedAt: capturedAt, id: id)
            }
            return
        }

        guard CGPreflightScreenCaptureAccess() else {
            emitter.emitError(
                AppSnapFailure(
                    code: "screen-recording-required",
                    message: "Screen Recording permission is required to capture a window."
                ),
                capturedAt: capturedAt,
                id: id
            )
            return
        }

        let capture = OneFrameWindowCapture(selectedWindow: selectedWindow) { [weak self] result in
            self?.queue.async {
                self?.completeCapture(
                    result,
                    selectedWindow: selectedWindow,
                    id: id,
                    capturedAt: capturedAt
                )
            }
        }
        activeCapture = capture
        capture.start()
    }

    private func completeCapture(
        _ result: Result<CGImage, AppSnapFailure>,
        selectedWindow: SelectedWindow,
        id: String,
        capturedAt: String
    ) {
        switch result {
        case let .failure(failure):
            emitter.emitError(failure, capturedAt: capturedAt, id: id)
            activeCapture = nil
        case let .success(image):
            do {
                let png = try encodePNGUnderAttachmentLimit(image)
                let file = try writePrivatePNG(png, id: id, to: outputDirectory)
                // Retain the coordinator through feedback and the final emit so
                // every successful capture deterministically releases its lock.
                DispatchQueue.main.async { [self] in
                    captureFeedback.play(for: selectedWindow.bounds) { [self] in
                        queue.async { [self] in
                            emitter.emitCaptured(
                                id: id,
                                capturedAt: capturedAt,
                                path: file.path,
                                name: file.name,
                                sourceAppName: selectedWindow.sourceAppName,
                                sourceBundleIdentifier: selectedWindow.sourceBundleIdentifier,
                                sourceAppIconDataURL: selectedWindow.sourceAppIconDataURL,
                                sourceWindowTitle: selectedWindow.sourceWindowTitle
                            )
                            // The capture lock guards the whole pipeline through
                            // the final emit; releasing it earlier would let a
                            // second chord interleave with the pending feedback
                            // and captured event.
                            activeCapture = nil
                        }
                    }
                }
            } catch let failure as AppSnapFailure {
                emitter.emitError(failure, capturedAt: capturedAt, id: id)
                activeCapture = nil
            } catch {
                emitter.emitError(
                    AppSnapFailure(
                        code: "capture_processing_failed",
                        message: "Could not process the captured window: \(error.localizedDescription)"
                    ),
                    capturedAt: capturedAt,
                    id: id
                )
                activeCapture = nil
            }
        }
    }
}
