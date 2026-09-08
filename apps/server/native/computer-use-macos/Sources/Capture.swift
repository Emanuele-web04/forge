// Screen capture.
//
// The chain is ScreenCaptureKit → `screencapture` CLI → error, exactly as the
// design reference specifies (§4.3), and the result reports which link served it
// so the backend can track the fallback rate as a health metric.
//
// **ScreenCaptureKit (macOS 14+, primary).** `SCScreenshotManager.captureImage`
// composites in WindowServer and hands back a `CGImage` with no temp file, no
// subprocess, and no second decode. The whole budget is applied at the source:
// `SCStreamConfiguration.width/height` carries the caller's `maxDimension` so
// WindowServer does the downscale, and `sourceRect` carries the requested region
// so only those pixels are ever composited. One ImageIO PNG encode follows and
// that is the entire pipeline.
//
// **`screencapture` (fallback).** Needs the same Screen Recording grant, never
// hangs the way `SCShareableContent` can (radar FB12114396), and composites
// across displays — which is why a region spanning two displays takes this path
// rather than the SCK one, whose filters are per-display. Also the path on
// macOS 12.3–13.x, where `SCScreenshotManager` does not exist.
//
// Reliability rules from the reference, all here: a warm `SCShareableContent`
// cache (10 s TTL, invalidated by desktop geometry changes) so the hot path skips the call that can hang; a single-flight
// gate so a hung call can never leak more than the one thread already inside it
// (the permit is released by the completion handler, never by a timed-out
// waiter, so every later caller fails fast to the fallback instead of piling
// up); and a 3 s deadline on every SCK call.
//
// The `region` in the result is always the rect these pixels actually cover, in
// global top-left points — clipped to the display when the request ran off it —
// because the Node side derives the screenshot scale from PNG pixel size over
// region point size (`screenshotFromPng`). Downscaling therefore has to keep the
// pixel dimensions proportional to the region, which is what the width/height
// computation below guarantees.

import CryptoKit
import CoreGraphics
import CoreVideo
import Dispatch
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Capture {
  /// Which link of the chain produced an image.
  enum Source: String {
    case screenCaptureKit = "screencapturekit"
    case screencapture = "screencapture"
  }

  struct Result {
    let pngBase64: String?
    let region: CGRect
    let source: Source
  }

  /// Capture one desktop rect, in global top-left points.
  ///
  /// The rect is clipped to the desktop before anything else happens. Both links
  /// of the chain need that: ScreenCaptureKit rejects a `sourceRect` that misses
  /// its display and falls through, and the `screencapture` arguments below are
  /// integers — `Int(1e30)` is a trapping conversion, so a region far off the
  /// desktop used to abort the helper outright and take every other in-flight
  /// action with it.
  static func region(_ requested: CGRect, maxDimension: Int, prefer: Source?, deduplicate: Bool = false, force: Bool = false) throws -> Result {
    let rect = try Geometry.clampRectToWorkspace(requested)
    if prefer != .screencapture, #available(macOS 14.0, *) {
      if let capture = captureRegionWithSCK(rect, maxDimension: maxDimension) {
        return try encode(capture.image, region: capture.region, source: .screenCaptureKit,
          deduplicate: deduplicate, force: force)
      }
    }
    let size = outputPixelSize(points: rect.size, scale: Geometry.scaleFactor(for: rect), maxDimension: maxDimension)
    guard let canvas = CaptureCanvas(region: rect, width: size.width, height: size.height) else {
      throw RPCError(.internalError, "Could not allocate the screenshot")
    }
    var captured = false
    for display in Geometry.displayFrames() {
      let tile = display.intersection(rect)
      guard !tile.isNull, tile.width >= 1, tile.height >= 1 else { continue }
      let args = ["-x", "-o", "-t", "png", "-R",
        "\(Int(tile.minX)),\(Int(tile.minY)),\(Int(tile.width)),\(Int(tile.height))"]
      let raw = try runScreencapture(extraArgs: args)
      let covered = coveredRect(requested: tile, png: raw)
      guard abs(covered.width - tile.width) <= 1, abs(covered.height - tile.height) <= 1 else {
        throw RPCError(.internalError, "The fallback screenshot did not cover the requested display region")
      }
      let image = try maskHostWindows(raw, region: covered)
      canvas.draw(image, covering: covered)
      captured = true
    }
    guard captured, let image = canvas.image() else {
      throw RPCError(.internalError, "No display intersects the screenshot region")
    }
    return try encode(image, region: rect, source: .screencapture, deduplicate: deduplicate, force: force)
  }

  private static func maskHostWindows(_ png: Data, region: CGRect) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let canvas = CaptureCanvas(region: region, width: image.width, height: image.height),
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]
    else { throw RPCError(.internalError, "Could not exclude Synara from the fallback screenshot") }
    canvas.draw(image, covering: region)
    for window in windows {
      guard let pid = window[kCGWindowOwnerPID as String] as? NSNumber, Windows.isHostOwned(pid.int32Value),
        let raw = window[kCGWindowBounds as String] as? [String: Any],
        let frame = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
      canvas.mask(frame)
    }
    guard let masked = canvas.image() else {
      throw RPCError(.internalError, "Could not encode the masked screenshot")
    }
    return masked
  }

  /// Capture one window by its `CGWindowID`. The returned region is the window's
  /// current global bounds, which is the rect these pixels cover.
  static func window(_ number: CGWindowID, maxDimension: Int, prefer: Source?) throws -> Result {
    guard let target = Windows.window(withNumber: number) else {
      throw RPCError(.targetMissing, "no window has id \(number)")
    }
    // WindowServer marks fully covered and other-Space windows off-screen too.
    // SCK's desktop-independent window capture can still return their surface;
    // try it before deciding the explicitly requested window is unavailable.
    // A window whose bounds miss every display is the same trapping-conversion
    // hazard as a region, and equally has nothing to show.
    guard (try? Geometry.clampRectToWorkspace(target.bounds)) != nil else {
      throw RPCError(.targetMissing, "window \(number) is not on any display")
    }
    if prefer != .screencapture, #available(macOS 14.0, *) {
      if let capture = captureWindowWithSCK(number, maxDimension: maxDimension) {
        return Result(
          pngBase64: capture.png.base64EncodedString(), region: capture.frame,
          source: .screenCaptureKit)
      }
    }
    guard target.onScreen else {
      throw RPCError(.targetMissing, "window \(number) has no available background capture")
    }
    // `screencapture -l` composites the window's whole *surface*, which is not
    // the rect `CGWindowList` reports: measured against a Terminal window the
    // image started 32 pt above the enumerated origin, so every coordinate an
    // agent read off it mapped 32 pt low on the desktop. The image is fine; the
    // origin has to come from the same place ScreenCaptureKit takes it,
    // `SCWindow.frame`. `SCShareableContent` is macOS 12.3, so this is available
    // on every OS the helper supports, including the ones with no
    // `SCScreenshotManager`.
    //
    // When the window cannot be found there — the content list is unavailable or
    // hung, or the window is not shareable — this refuses instead of guessing.
    // A capture whose reported region is wrong is worse than no capture: the
    // agent cannot tell, and every click it derives lands somewhere else.
    guard let surface = shareableWindowFrame(number) else {
      throw RPCError(
        .targetMissing,
        "window \(number) could not be measured for the screencapture fallback; "
          + "capture its bounds as a region instead")
    }
    let args = ["-x", "-o", "-t", "png", "-l", String(number)]
    let png = try runScreencapture(extraArgs: args)
    let covered = coveredRect(requested: surface, png: png)
    // …and then check that the surface really is what came back. An origin taken
    // from `SCWindow.frame` is only right if the CLI composited that same rect,
    // and the audit's 32 pt case is exactly a disagreement about extent: the
    // image is taller than the measured surface, so the pixels start somewhere
    // above the reported origin and every coordinate read off them lands low.
    // Measured on this machine the two agree exactly for every open window, but
    // a disagreement is unknowable rather than correctable — nothing says
    // whether the extra pixels are above or below — so it is refused instead of
    // described. Whole points of tolerance, since the extent is recovered by
    // dividing pixels by the backing scale.
    guard abs(covered.width - surface.width) <= 1, abs(covered.height - surface.height) <= 1 else {
      throw RPCError(
        .internalError,
        "screencapture returned \(Int(covered.width))×\(Int(covered.height)) pt for window "
          + "\(number), whose surface measures \(Int(surface.width))×\(Int(surface.height)) pt; "
          + "refusing to report a region these pixels do not cover")
    }
    return Result(
      pngBase64: try downscaleAndEncode(png, maxDimension: maxDimension),
      region: covered,
      source: .screencapture)
  }

  /// The `SCWindow` for a `CGWindowID`, or nil. A window opened inside the cache
  /// TTL is not in the warm copy, so one forced refresh covers it; anything still
  /// missing is not shareable.
  private static func shareableWindow(_ number: CGWindowID) -> SCWindow? {
    if let window = shareableContent()?.windows.first(where: { $0.windowID == number }) {
      return window
    }
    invalidateShareableContent()
    return shareableContent()?.windows.first { $0.windowID == number }
  }

  /// The window's surface frame according to ScreenCaptureKit, in global
  /// top-left points — the rect the composited pixels actually cover, whichever
  /// link of the chain produced them.
  private static func shareableWindowFrame(_ number: CGWindowID) -> CGRect? {
    shareableWindow(number)?.frame
  }

  /// The rect a fallback capture's pixels actually cover, in global top-left
  /// points: the requested origin with the extent the PNG really has, recovered
  /// by dividing its pixel size by the display's backing scale. Falls back to
  /// the requested rect when the PNG cannot be measured, which is no worse than
  /// what it replaces.
  private static func coveredRect(requested: CGRect, png: Data) -> CGRect {
    guard let source = CGImageSourceCreateWithData(png as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let pixelWidth = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
      let pixelHeight = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue,
      pixelWidth > 0, pixelHeight > 0
    else { return requested }
    let scale = Double(Geometry.scaleFactor(for: requested))
    guard scale > 0 else { return requested }
    return CGRect(
      x: requested.origin.x,
      y: requested.origin.y,
      width: pixelWidth / scale,
      height: pixelHeight / scale)
  }

  // MARK: - ScreenCaptureKit

  @available(macOS 14.0, *)
  private static func captureRegionWithSCK(_ rect: CGRect, maxDimension: Int)
    -> (image: CGImage, region: CGRect)?
  {
    guard rect.width >= 1, rect.height >= 1, let content = shareableContent() else { return nil }

    let size = outputPixelSize(points: rect.size, scale: Geometry.scaleFactor(for: rect), maxDimension: maxDimension)
    let scaleX = CGFloat(size.width) / rect.width
    let scaleY = CGFloat(size.height) / rect.height
    let exclusions = hostWindows(in: content)
    // Submit independent display captures together; share one deadline and
    // never draw concurrently into the composition canvas.
    var captures: [(rect: CGRect, box: Box<CGImage?>, done: DispatchSemaphore)] = []
    let deadline = DispatchTime.now() + captureDeadlineSeconds
    for display in content.displays {
      let bounds = CGDisplayBounds(display.displayID)
      let clipped = bounds.intersection(rect)
      guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { continue }
      let filter = SCContentFilter(display: display, excludingWindows: exclusions)
      let configuration = SCStreamConfiguration()
      configuration.sourceRect = clipped.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
      configuration.width = max(1, Int((clipped.width * scaleX).rounded()))
      configuration.height = max(1, Int((clipped.height * scaleY).rounded()))
      apply(commonSettings: configuration)
      if #available(macOS 14.2, *) {
        configuration.ignoreShadowsDisplay = true
        configuration.ignoreGlobalClipDisplay = true
      }
      // A desktop normally has a handful of displays. Bound outstanding work
      // even if WindowServer reports a pathological virtual-display count.
      guard captures.count < 8 else { return nil }
      let pending = startCaptureImage(filter: filter, configuration: configuration)
      captures.append((clipped, pending.box, pending.done))
    }
    guard !captures.isEmpty else { return nil }
    var images: [(CGRect, CGImage)] = []
    for capture in captures {
      guard capture.done.wait(timeout: deadline) == .success, let image = capture.box.value else { return nil }
      images.append((capture.rect, image))
    }
    // A one-display capture already has the correct dimensions and color space.
    if images.count == 1, images[0].0 == rect,
      images[0].1.width == size.width, images[0].1.height == size.height {
      return (images[0].1, rect)
    }
    guard let canvas = CaptureCanvas(region: rect, width: size.width, height: size.height) else { return nil }
    for (covered, image) in images { canvas.draw(image, covering: covered) }
    guard let image = canvas.image() else { return nil }
    return (image, rect)
  }

  @available(macOS 14.0, *)
  private static func captureWindowWithSCK(_ number: CGWindowID, maxDimension: Int)
    -> (png: Data, frame: CGRect)?
  {
    guard let scWindow = shareableWindow(number) else { return nil }

    let filter = SCContentFilter(desktopIndependentWindow: scWindow)
    let configuration = SCStreamConfiguration()
    let size = outputPixelSize(
      points: filter.contentRect.size,
      scale: CGFloat(filter.pointPixelScale),
      maxDimension: maxDimension)
    configuration.width = size.width
    configuration.height = size.height
    apply(commonSettings: configuration)
    if #available(macOS 14.2, *) {
      // Single-window equivalents of the CLI's `-o`: no drop shadow, and no clip
      // to the display, so an off-screen edge still comes back.
      configuration.ignoreShadowsSingleWindow = true
      configuration.ignoreGlobalClipSingleWindow = true
      configuration.includeChildWindows = false
    }

    guard let image = captureImage(filter: filter, configuration: configuration),
      let png = pngData(image)
    else { return nil }
    // The window's own frame, from the same `SCWindow` that produced these
    // pixels. Pairing them with `CGWindowList` bounds read separately meant the
    // region and the image could describe two different moments — and the Node
    // side derives the screenshot scale from pixels ÷ region, so a disagreement
    // there sends every coordinate the agent reads off this image to the wrong
    // place on the desktop.
    return (png, scWindow.frame)
  }

  /// The shareable windows belonging to the application this helper runs for —
  /// Synara, and the processes it was spawned through.
  ///
  /// Exactly the predicate `Windows.enumerate` uses to keep Synara out of the
  /// agent's reach, so "what the agent can act on" and "what the agent is shown"
  /// stay the same set. The helper's *own* overlay is deliberately **not**
  /// excluded: the agent cursor is the one thing the still exists to show, and
  /// its window is `.readOnly` precisely so it composites into captures.
  private static func hostWindows(in content: SCShareableContent) -> [SCWindow] {
    content.windows.filter { window in
      guard let pid = window.owningApplication?.processID else { return false }
      return Windows.isHostOwned(pid)
    }
  }

  @available(macOS 14.0, *)
  private static func apply(commonSettings configuration: SCStreamConfiguration) {
    configuration.capturesAudio = false
    // The human's real pointer is not part of the agent's observation; the agent
    // cursor is an ordinary `.readOnly` window and is composited like any other.
    configuration.showsCursor = false
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.colorSpaceName = CGColorSpace.sRGB
    configuration.scalesToFit = true
    configuration.queueDepth = 3
  }

  /// Pixel dimensions for `points` at `scale`, capped so the longest side fits
  /// `maxDimension`. Both sides are scaled by the same factor, which is what
  /// keeps `pixels / region points` a single meaningful scale on the Node side.
  private static func outputPixelSize(points: CGSize, scale: CGFloat, maxDimension: Int)
    -> (width: Int, height: Int)
  {
    let backing = scale > 0 ? scale : 1
    let fullWidth = points.width * backing
    let fullHeight = points.height * backing
    let longest = max(fullWidth, fullHeight)
    var factor: CGFloat = 1
    if maxDimension > 0, longest > CGFloat(maxDimension) {
      factor = CGFloat(maxDimension) / longest
    }
    return (
      max(1, Int((fullWidth * factor).rounded())),
      max(1, Int((fullHeight * factor).rounded()))
    )
  }

  /// One SCK screenshot under a 3 s deadline. A deadline miss is reported as a
  /// failure so the caller drops to the fallback rather than waiting on a call
  /// that may never return.
  @available(macOS 14.0, *)
  private static func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration)
    -> CGImage?
  {
    let pending = startCaptureImage(filter: filter, configuration: configuration)
    let (box, done) = (pending.box, pending.done)
    guard done.wait(timeout: .now() + captureDeadlineSeconds) == .success else {
      logDiagnostic("ScreenCaptureKit capture exceeded its \(captureDeadlineSeconds)s deadline")
      return nil
    }
    return box.value
  }

  private static let captureSlots = DispatchSemaphore(value: 8)

  @available(macOS 14.0, *)
  private static func startCaptureImage(filter: SCContentFilter, configuration: SCStreamConfiguration)
    -> (box: Box<CGImage?>, done: DispatchSemaphore)
  {
    let box = Box<CGImage?>(nil)
    let done = DispatchSemaphore(value: 0)
    // Hold the permit until the OS callback, even after a caller times out.
    // Repeated timeouts must not accumulate unlimited outstanding captures.
    guard captureSlots.wait(timeout: .now()) == .success else {
      done.signal()
      return (box, done)
    }
    SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) {
      image, error in
      defer { captureSlots.signal() }
      if let error {
        logDiagnostic("ScreenCaptureKit capture failed: \(error.localizedDescription)")
      }
      box.value = image
      done.signal()
    }
    return (box, done)
  }

  // MARK: - Shareable content (cached, single-flight, deadlined)

  private static let captureDeadlineSeconds: Double = 3
  private static let contentTTLNanoseconds: UInt64 = 10_000_000_000
  private static let contentLock = NSLock()
  private static var cachedContent: SCShareableContent?
  private static var cachedContentAt: UInt64 = 0
  private static var cachedDesktopSignature: String?
  /// At most one outstanding `SCShareableContent` request, ever — but everyone
  /// else **waits on it** rather than giving up.
  ///
  /// The gate used to be a semaphore taken with a zero timeout, so every loser
  /// was handed the (possibly nil) warm copy immediately and fell through to the
  /// CLI. The perception lane is concurrent and the pane opens with a burst of
  /// captures, so a cold helper served one image through ScreenCaptureKit and
  /// every other one through `screencapture` — the slow path, and the path whose
  /// geometry has to be reconstructed. Waiting costs a loser nothing it would
  /// not have spent anyway: the winner is already under the same 3 s deadline,
  /// and the waiters share it rather than each starting a fresh one, so the
  /// whole burst is bounded by the one request's budget.
  ///
  /// A request that never returns (FB12114396) still leaks nothing: the flag is
  /// cleared only by the completion handler, waiters past the shared deadline
  /// fall through to the warm copy at once, and no second request is ever
  /// started behind it.
  private static let contentCondition = NSCondition()
  private static var contentRequestInFlight = false
  /// The in-flight request's own deadline, shared by everyone waiting on it.
  private static var contentRequestDeadline = Date.distantPast
  /// Bumped every time a request finishes, so a waiter can tell "the request I
  /// was waiting for is done" from a spurious wakeup.
  private static var contentGeneration: UInt64 = 0

  private static func invalidateShareableContent() {
    contentLock.lock()
    cachedContent = nil
    contentLock.unlock()
  }

  /// Cheap WindowServer metadata invalidates cached SCK geometry after moves,
  /// new windows, host windows, or display changes. Never extends stale frames.
  private static func desktopSignature() -> String? {
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] else { return nil }
    let entries = windows.compactMap { entry -> String? in
      guard let id = entry[kCGWindowNumber as String] as? NSNumber,
        let pid = entry[kCGWindowOwnerPID as String] as? NSNumber,
        let raw = entry[kCGWindowBounds as String] as? [String: Any],
        let frame = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return nil }
      // The helper cursor moves every frame; its geometry is not used for a
      // window capture or a host exclusion filter.
      if pid.int32Value == ProcessInfo.processInfo.processIdentifier { return nil }
      return "\(id):\(pid):\(frame)"
    }
    return entries.joined(separator: "|") + String(describing: Geometry.displayFrames())
  }

  /// The cached content, and whether it is inside its TTL.
  private static func cachedShareableContent() -> (content: SCShareableContent?, fresh: Bool) {
    let now = DispatchTime.now().uptimeNanoseconds
    let signature = desktopSignature()
    contentLock.lock()
    defer { contentLock.unlock() }
    let fresh = signature != nil && signature == cachedDesktopSignature
      && cachedContent != nil && now &- cachedContentAt <= contentTTLNanoseconds
    return (cachedContent, fresh)
  }

  private static func shareableContent() -> SCShareableContent? {
    let warmed = cachedShareableContent()
    if warmed.fresh { return warmed.content }

    contentCondition.lock()
    if contentRequestInFlight {
      let generation = contentGeneration
      let deadline = contentRequestDeadline
      while contentRequestInFlight, contentGeneration == generation, Date() < deadline {
        _ = contentCondition.wait(until: deadline)
      }
      contentCondition.unlock()
      // Whatever the winner managed to store, or the warm copy if it stored
      // nothing (failed, or still hung past the shared deadline).
      return cachedShareableContent().content ?? warmed.content
    }
    contentRequestInFlight = true
    contentRequestDeadline = Date().addingTimeInterval(captureDeadlineSeconds)
    contentCondition.unlock()

    let signature = desktopSignature()
    let done = DispatchSemaphore(value: 0)
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) {
      content, error in
      if let content {
        contentLock.lock()
        cachedContent = content
        cachedContentAt = DispatchTime.now().uptimeNanoseconds
        cachedDesktopSignature = signature
        contentLock.unlock()
      } else if let error {
        logDiagnostic("SCShareableContent failed: \(error.localizedDescription)")
      }
      finishShareableContentRequest()
      done.signal()
    }
    if done.wait(timeout: .now() + captureDeadlineSeconds) != .success {
      // The flag is deliberately *not* cleared here: the call is still out there
      // and clearing it would let a second one start behind it. Waiters are
      // released by the shared deadline instead.
      logDiagnostic("SCShareableContent exceeded its \(captureDeadlineSeconds)s deadline")
    }
    return cachedShareableContent().content ?? warmed.content
  }

  /// Wake everyone waiting on the in-flight request. Called from the completion
  /// handler and nowhere else.
  private static func finishShareableContentRequest() {
    contentCondition.lock()
    contentRequestInFlight = false
    contentGeneration &+= 1
    contentCondition.broadcast()
    contentCondition.unlock()
  }

  /// A mutable cell a completion handler can write into from another thread; the
  /// semaphore around it is the synchronisation, hence `@unchecked`.
  private final class Box<Value>: @unchecked Sendable {
    var value: Value
    init(_ value: Value) { self.value = value }
  }

  // MARK: - screencapture fallback

  private static func runScreencapture(extraArgs: [String]) throws -> Data {
    let directory = FileManager.default.temporaryDirectory
    let file = directory.appendingPathComponent("synara-capture-\(UUID().uuidString).png")
    defer { try? FileManager.default.removeItem(at: file) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = extraArgs + [file.path]
    let errorPipe = Pipe()
    process.standardError = errorPipe
    // The file header promises this path "never hangs the way SCShareableContent
    // can"; without a deadline that is only true of the OS's good behaviour, and
    // a wedged subprocess would hold the perception lane open indefinitely.
    //
    // Armed before `run()`: a process that exits between the launch and the
    // assignment never calls a handler installed afterwards, and the wait below
    // would then have burned the whole deadline on a subprocess that had
    // already finished.
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    do {
      try process.run()
    } catch {
      throw RPCError(.internalError, "screencapture could not start: \(error.localizedDescription)")
    }
    if finished.wait(timeout: .now() + captureDeadlineSeconds) == .timedOut {
      process.terminate()
      _ = finished.wait(timeout: .now() + 1)
      throw RPCError(
        .internalError, "screencapture exceeded its \(captureDeadlineSeconds)s deadline")
    }

    let detail =
      String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard process.terminationStatus == 0 else {
      // Only claim a permission problem when the grant really is missing.
      // Reporting every failure as -32000 made the backend latch
      // `captureGranted = false` on a transient error and blank the live pane
      // for the rest of the session.
      throw captureFailure(
        "screencapture failed (\(process.terminationStatus))",
        detail: detail)
    }
    guard let data = try? Data(contentsOf: file), !data.isEmpty else {
      throw captureFailure("screencapture produced no image", detail: detail)
    }
    return data
  }

  /// A capture failure classified by the grant that is actually in force, so a
  /// transient error is retryable and a real denial is actionable.
  private static func captureFailure(_ summary: String, detail: String) -> RPCError {
    let suffix = detail.isEmpty ? "" : ": \(detail)"
    if !CGPreflightScreenCaptureAccess() {
      return RPCError(
        .permissionDenied, "\(summary); grant Screen Recording to this app\(suffix)")
    }
    return RPCError(.internalError, "\(summary)\(suffix)")
  }

  // MARK: - Encoding

  private static let stillDigestLock = NSLock()
  private static var previousStillDigest: SHA256.Digest?

  /// Compare pixels before PNG and base64 encoding. Only still requests use
  /// this memo; action observations cannot consume a pane's pending frame.
  private static func encode(_ image: CGImage, region: CGRect, source: Source,
    deduplicate: Bool, force: Bool) throws -> Result {
    if deduplicate {
      stillDigestLock.lock()
      defer { stillDigestLock.unlock() }
      let rowBytes = (image.width * image.bitsPerPixel + 7) / 8
      if let data = image.dataProvider?.data,
        CFDataGetLength(data) >= (image.height - 1) * image.bytesPerRow + rowBytes {
        var hash = SHA256()
        hash.update(data: Data("\(region):\(image.width):\(image.height):\(image.bytesPerRow):\(image.bitmapInfo.rawValue)".utf8))
        // Exclude row padding, which can contain allocator-dependent bytes.
        let pixels = data as Data
        pixels.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
          for row in 0..<image.height {
            let start = row * image.bytesPerRow
            hash.update(bufferPointer: UnsafeRawBufferPointer(rebasing: buffer[start..<(start + rowBytes)]))
          }
        }
        let digest = hash.finalize()
        if !force, digest == previousStillDigest {
          return Result(pngBase64: nil, region: region, source: source)
        }
        guard let png = pngData(image) else { throw RPCError(.internalError, "Could not encode the screenshot") }
        previousStillDigest = digest
        return Result(pngBase64: png.base64EncodedString(), region: region, source: source)
      }
    }
    guard let png = pngData(image) else { throw RPCError(.internalError, "Could not encode the screenshot") }
    return Result(pngBase64: png.base64EncodedString(), region: region, source: source)
  }

  private static func pngData(_ image: CGImage) -> Data? {
    let output = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        output, UTType.png.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    return output as Data
  }

  /// The fallback path's budget pass: `screencapture` always writes full-scale
  /// pixels, so a capture over budget is decoded, downscaled, and re-encoded
  /// once. The SCK path never reaches here — it is downscaled at the source.
  private static func downscaleAndEncode(_ png: Data, maxDimension: Int) throws -> String {
    guard maxDimension > 0,
      let source = CGImageSourceCreateWithData(png as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      // If it cannot be decoded here it is still a PNG the caller can decode;
      // ship it as-is rather than failing the whole capture.
      return png.base64EncodedString()
    }
    let longest = max(image.width, image.height)
    if longest <= maxDimension {
      return png.base64EncodedString()
    }
    let scale = CGFloat(maxDimension) / CGFloat(longest)
    let width = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let height = max(1, Int((CGFloat(image.height) * scale).rounded()))
    guard
      let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
      return png.base64EncodedString()
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage(), let encoded = pngData(scaled) else {
      return png.base64EncodedString()
    }
    return encoded.base64EncodedString()
  }
}
