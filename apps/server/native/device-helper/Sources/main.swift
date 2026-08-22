// synara-device-helper — the native side of Synara's Device Pane.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio (one object per line).
// Frames do not travel on stdio; they go to the Unix socket given to
// `stream.start`, so a burst of video can never delay a command response.
//
// This is a long-running server rather than a set of subcommands because
// attaching to CoreSimulator, creating the HID client, and priming the
// accessibility translator all cost real time, and every operation needs that
// state. A subcommand design would repay it on every tap. The one exception is
// `--probe`, a one-shot preflight used by the build and setup checks.
//
// See HEADER.md for the full method list and the frame wire format.

import Foundation
import IOSurface

// MARK: - JSON-RPC plumbing

/// JSON-RPC error codes: the standard range plus helper-specific ones.
enum RPCErrorCode: Int {
  case parseError = -32700
  case invalidRequest = -32600
  case methodNotFound = -32601
  case invalidParams = -32602
  case internalError = -32603
  case notAttached = -32000
  case simulatorFailure = -32001
  /// Input this process accepted but could not deliver to the guest. Reported
  /// as an error so a caller never treats an injection that vanished as applied.
  case inputNotDelivered = -32002
}

struct RPCError: Error {
  let code: RPCErrorCode
  let message: String

  init(_ code: RPCErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }
}

/// stdout carries only JSON-RPC; diagnostics go to stderr so a chatty log can
/// never corrupt the protocol stream.
let stdoutHandle = FileHandle.standardOutput
let stdoutLock = NSLock()

func logDiagnostic(_ message: String) {
  FileHandle.standardError.write(Data("[device-helper] \(message)\n".utf8))
}

func writeMessage(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  else { return }
  stdoutLock.lock()
  defer { stdoutLock.unlock() }
  var line = data
  line.append(0x0a)
  try? stdoutHandle.write(contentsOf: line)
}

func writeResult(id: Any?, result: Any) {
  guard let id else { return }  // A notification expects no reply.
  writeMessage(["jsonrpc": "2.0", "id": id, "result": result])
}

func writeError(id: Any?, code: RPCErrorCode, message: String) {
  guard let id else {
    logDiagnostic("error with no request id: \(message)")
    return
  }
  writeMessage([
    "jsonrpc": "2.0", "id": id,
    "error": ["code": code.rawValue, "message": message],
  ])
}

/// An unsolicited event (stream lifecycle, device state).
func writeNotification(method: String, params: [String: Any]) {
  writeMessage(["jsonrpc": "2.0", "method": method, "params": params])
}

// MARK: - Parameter helpers

struct Params {
  let raw: [String: Any]

  func double(_ key: String) throws -> Double {
    guard let value = raw[key] as? NSNumber else {
      throw RPCError(.invalidParams, "missing or non-numeric parameter '\(key)'")
    }
    return value.doubleValue
  }

  func optionalDouble(_ key: String, default fallback: Double) -> Double {
    (raw[key] as? NSNumber)?.doubleValue ?? fallback
  }

  func int(_ key: String) throws -> Int {
    guard let value = raw[key] as? NSNumber else {
      throw RPCError(.invalidParams, "missing or non-numeric parameter '\(key)'")
    }
    return value.intValue
  }

  func optionalInt(_ key: String, default fallback: Int) -> Int {
    (raw[key] as? NSNumber)?.intValue ?? fallback
  }

  func string(_ key: String) throws -> String {
    guard let value = raw[key] as? String, !value.isEmpty else {
      throw RPCError(.invalidParams, "missing or empty parameter '\(key)'")
    }
    return value
  }

  func optionalString(_ key: String) -> String? {
    raw[key] as? String
  }

  func bool(_ key: String, default fallback: Bool) -> Bool {
    (raw[key] as? NSNumber)?.boolValue ?? fallback
  }

  /// A normalized 0..1 coordinate. Out-of-range values are rejected rather than
  /// clamped: they almost always mean the caller sent pixels by mistake.
  func normalized(_ key: String) throws -> Double {
    let value = try double(key)
    guard value >= 0, value <= 1 else {
      throw RPCError(.invalidParams, "parameter '\(key)' must be normalized to 0..1, got \(value)")
    }
    return value
  }
}

// MARK: - Session

/// Everything bound to one attached simulator.
final class HelperSession {
  let developerDirectory: String
  let deviceSet: SimulatorDeviceSet

  private(set) var device: SimulatorDevice?
  private(set) var hid: SynaraHIDBridge?
  private(set) var accessibility: SynaraAXBridge?
  private var stream: FrameStream?
  private var displayDescriptor: NSObject?
  /// The boot the current attachment belongs to. Compared against the device's
  /// live boot identity before input so an externally rebooted simulator
  /// (simctl, Simulator.app, an agent's shell) cannot silently swallow HID
  /// events on a client bound to the previous boot.
  private var attachedBootSession: String?

  init(developerDirectory: String, deviceSet: SimulatorDeviceSet) {
    self.developerDirectory = developerDirectory
    self.deviceSet = deviceSet
  }

  func attach(udid: String) throws -> [String: Any] {
    let device = try deviceSet.device(udid: udid)
    guard device.isBooted else {
      throw RPCError(.simulatorFailure, "simulator \(udid) is not booted (state \(device.state))")
    }

    let descriptor = try device.mainDisplayDescriptor()
    guard let surface = descriptor.currentFramebufferSurface() else {
      throw RPCError(.simulatorFailure, "display has no framebuffer surface yet")
    }

    let hidBridge = SynaraHIDBridge()
    var hidFailure: String?
    var hidReady = false
    do {
      try hidBridge.attach(toDevice: device.handle)
      hidReady = true
    } catch {
      // Input is degraded, not fatal: streaming and reads remain useful.
      hidFailure = error.localizedDescription
      logDiagnostic("HID unavailable: \(error.localizedDescription)")
    }

    // The accessibility translator is a process-wide singleton, so it is primed
    // once per attach and rebound to the current device.
    let axBridge = SynaraAXBridge()
    axBridge.device = device.handle
    let axReady = axBridge.prepare()
    if !axReady {
      logDiagnostic("accessibility translator unavailable; describe-ui will fail")
    }

    self.device = device
    self.displayDescriptor = descriptor
    self.hid = hidReady ? hidBridge : nil
    self.accessibility = axReady ? axBridge : nil
    self.attachedBootSession = device.bootIdentity

    let pixelWidth = IOSurfaceGetWidth(surface)
    let pixelHeight = IOSurfaceGetHeight(surface)
    let geometry = device.screenGeometry
    // Fall back to deriving scale from the framebuffer when the device type does
    // not publish geometry (older runtimes).
    let scale = geometry?.scale ?? 3

    return [
      "udid": device.udid,
      "name": device.name,
      "runtime": device.runtimeIdentifier as Any? ?? NSNull(),
      "deviceType": device.deviceTypeIdentifier as Any? ?? NSNull(),
      "pixelWidth": pixelWidth,
      "pixelHeight": pixelHeight,
      "pointWidth": geometry?.pointWidth ?? pixelWidth / scale,
      "pointHeight": geometry?.pointHeight ?? pixelHeight / scale,
      "scale": scale,
      "capabilities": [
        "input": hid != nil,
        "accessibility": accessibility != nil,
      ],
      "degraded": [
        "hid": hidFailure as Any? ?? NSNull(),
      ],
    ]
  }

  func requireDevice() throws -> SimulatorDevice {
    guard let device else {
      throw RPCError(.notAttached, "not attached to a simulator; call 'attach' first")
    }
    return device
  }

  func requireHID() throws -> SynaraHIDBridge {
    // Verify first: a stale boot session re-attaches and replaces `hid`, so
    // the guard must read the post-verification client, not the old one.
    try verifyBootSession()
    guard let hid else {
      throw RPCError(.notAttached, "HID input is unavailable for this simulator")
    }
    return hid
  }

  /// Fail input when the simulator has been rebooted since we attached.
  ///
  /// An external reboot (simctl, Simulator.app, an agent's shell) leaves this
  /// process holding a SimDevice HID client for a boot that no longer exists.
  /// Injecting into it does not error — events are accepted and vanish — so
  /// the undelivered-counter honesty check never fires. The boot identity (lastBootedAt)
  /// is the reliable tripwire: it changes on every boot. When it no longer
  /// matches, attempt one transparent re-attach to the new boot; if that
  /// fails, surface `notAttached` so the caller re-attaches explicitly.
  /// A nil UUID on either side means we cannot verify — re-attach then too,
  /// because guessing "still valid" is how this bug shipped the first time.
  private func verifyBootSession() throws {
    guard let device else {
      throw RPCError(.notAttached, "not attached to a simulator; call 'attach' first")
    }
    let current = device.bootIdentity
    if let expected = attachedBootSession, let current, current == expected { return }
    logDiagnostic(
      "boot session changed (attached \(attachedBootSession ?? "unknown"), "
        + "now \(current ?? "unknown")); re-attaching")
    let udid = device.udid
    _ = stopStream()
    do {
      _ = try attach(udid: udid)
    } catch {
      throw RPCError(
        .notAttached,
        "simulator \(udid) was rebooted and re-attach failed: \(error.localizedDescription)")
    }
  }

  func requireAccessibility() throws -> SynaraAXBridge {
    guard let accessibility else {
      throw RPCError(.notAttached, "accessibility translation is unavailable for this simulator")
    }
    return accessibility
  }

  func currentSurface() throws -> IOSurfaceRef {
    guard let displayDescriptor else {
      throw RPCError(.notAttached, "not attached to a simulator; call 'attach' first")
    }
    guard let surface = displayDescriptor.currentFramebufferSurface() else {
      throw RPCError(.simulatorFailure, "display has no framebuffer surface")
    }
    return surface
  }

  func startStream(socketPath: String, keyframeIntervalSeconds: Double) throws -> [String: Any] {
    let device = try requireDevice()
    guard let displayDescriptor else {
      throw RPCError(.notAttached, "not attached to a simulator; call 'attach' first")
    }
    if stream != nil {
      throw RPCError(.invalidRequest, "stream already running; call 'stream.stop' first")
    }

    let writer = try FrameSocketWriter(path: socketPath)
    let frameStream = try FrameStream(
      descriptor: displayDescriptor,
      deviceId: device.udid,
      writer: writer,
      keyframeIntervalSeconds: keyframeIntervalSeconds)
    try frameStream.start()
    stream = frameStream

    return [
      "pixelWidth": frameStream.pixelWidth,
      "pixelHeight": frameStream.pixelHeight,
      "codec": "h264-annexb",
      "socketPath": socketPath,
    ]
  }

  func stopStream() -> [String: Any] {
    guard let stream else {
      return ["running": false]
    }
    let stats: [String: Any] = [
      "running": false,
      "emittedFrames": stream.emittedFrames,
      "droppedBusyFrames": stream.droppedBusyFrames,
      "droppedSocketFrames": stream.droppedSocketFrames,
    ]
    stream.stop()
    self.stream = nil
    return stats
  }

  func streamStats() -> [String: Any] {
    guard let stream else { return ["running": false] }
    return [
      "running": true,
      "emittedFrames": stream.emittedFrames,
      "droppedBusyFrames": stream.droppedBusyFrames,
      "droppedSocketFrames": stream.droppedSocketFrames,
      "pixelWidth": stream.pixelWidth,
      "pixelHeight": stream.pixelHeight,
    ]
  }

  func shutdown() {
    _ = stopStream()
  }
}

// MARK: - Method dispatch

/// Run one HID injection and fail if the bridge could not deliver it.
///
/// Every injection path in SynaraHIDBridge returns silently when it has no
/// client or a private symbol is missing, and this layer used to answer
/// `{"ok": true}` regardless. A half-attached HID client therefore looked
/// exactly like a working one: taps were acked and nothing moved. Comparing the
/// undelivered counter around the call turns that into a real error.
private func withHIDDelivery(_ hid: SynaraHIDBridge, _ body: () -> Void) throws {
  let before = hid.undeliveredEventCount
  body()
  let dropped = hid.undeliveredEventCount - before
  if dropped > 0 {
    throw RPCError(
      .inputNotDelivered,
      "\(dropped) HID event(s) were not delivered to the simulator; re-attach and retry")
  }
}

func handle(method: String, params: Params, session: HelperSession) throws -> Any {
  switch method {

  case "ping":
    return ["ok": true, "pid": ProcessInfo.processInfo.processIdentifier]

  case "list":
    let devices = session.deviceSet.devices.map { device -> [String: Any] in
      [
        "udid": device.udid,
        "name": device.name,
        "state": device.state,
        "booted": device.isBooted,
        "runtime": device.runtimeIdentifier as Any? ?? NSNull(),
        "deviceType": device.deviceTypeIdentifier as Any? ?? NSNull(),
      ]
    }
    return ["devices": devices]

  case "attach":
    return try session.attach(udid: try params.string("udid"))

  case "stream.start":
    return try session.startStream(
      socketPath: try params.string("socketPath"),
      // ~2s between keyframes: a late joiner waits at most that long, without
      // paying the bitrate cost of frequent I-frames.
      keyframeIntervalSeconds: params.optionalDouble("keyframeIntervalSeconds", default: 2.0))

  case "stream.stop":
    return session.stopStream()

  case "stream.stats":
    return session.streamStats()

  case "tap":
    let hid = try session.requireHID()
    let tapX = try params.normalized("x")
    let tapY = try params.normalized("y")
    try withHIDDelivery(hid) {
      hid.tap(x: tapX, y: tapY, holdMs: params.optionalInt("holdMs", default: 80))
    }
    return ["ok": true]

  case "touch":
    let hid = try session.requireHID()
    let phase = try params.string("phase")
    let touchX = try params.normalized("x")
    let touchY = try params.normalized("y")
    guard phase == "down" || phase == "move" || phase == "up" else {
      throw RPCError(.invalidParams, "phase must be one of down, move, up")
    }
    try withHIDDelivery(hid) {
      hid.sendTouch(x: touchX, y: touchY, down: phase != "up")
    }
    return ["ok": true]

  case "swipe", "drag":
    let hid = try session.requireHID()
    let startX = try params.normalized("startX")
    let startY = try params.normalized("startY")
    let endX = try params.normalized("endX")
    let endY = try params.normalized("endY")
    try withHIDDelivery(hid) {
      hid.drag(
        startX: startX, startY: startY, endX: endX, endY: endY,
        durationMs: params.optionalInt("durationMs", default: 250))
    }
    return ["ok": true]

  case "key":
    let hid = try session.requireHID()
    let usage = try params.int("usage")
    guard usage > 0, usage <= 0xFFFF else {
      throw RPCError(.invalidParams, "usage must be a positive USB HID usage code")
    }
    let keyPhase = params.optionalString("phase")
    if let keyPhase, keyPhase != "down", keyPhase != "up" {
      throw RPCError(.invalidParams, "phase must be 'down' or 'up'")
    }
    try withHIDDelivery(hid) {
      switch keyPhase {
      case "down": hid.sendKey(usage: UInt32(usage), down: true)
      case "up": hid.sendKey(usage: UInt32(usage), down: false)
      default: hid.tapKey(usage: UInt32(usage))
      }
    }
    return ["ok": true]

  case "text":
    let hid = try session.requireHID()
    let text = try params.string("text")
    var skipped = 0
    try withHIDDelivery(hid) { skipped = hid.type(text: text) }
    // Reported rather than thrown: partial entry is usually still what the
    // caller wanted, and silence would hide the gap.
    return ["ok": true, "characters": text.count, "skipped": skipped]

  case "button":
    let hid = try session.requireHID()
    let name = try params.string("name")
    var button = SynaraHardwareButton.home
    guard SynaraHardwareButtonFromName(name, &button) else {
      throw RPCError(
        .invalidParams,
        "unknown button '\(name)'; expected home, lock, side, siri, volume-up or volume-down")
    }
    let buttonPhase = params.optionalString("phase")
    if let buttonPhase, buttonPhase != "down", buttonPhase != "up" {
      throw RPCError(.invalidParams, "phase must be 'down' or 'up'")
    }
    try withHIDDelivery(hid) {
      switch buttonPhase {
      case "down": hid.sendButton(button, down: true)
      case "up": hid.sendButton(button, down: false)
      default: hid.tapButton(button)
      }
    }
    return ["ok": true]

  case "screenshot":
    let surface = try session.currentSurface()
    let png = try encodePNG(surface: surface)
    if let path = params.optionalString("path") {
      do {
        try png.write(to: URL(fileURLWithPath: path))
      } catch {
        throw RPCError(.internalError, "cannot write screenshot: \(error.localizedDescription)")
      }
      return ["path": path, "bytes": png.count]
    }
    return ["base64": png.base64EncodedString(), "bytes": png.count]

  case "describe-ui":
    let bridge = try session.requireAccessibility()
    // Depth-capped so a runaway hierarchy cannot produce an unbounded response.
    do {
      let tree = try bridge.frontmostTree(maxDepth: params.optionalInt("maxDepth", default: 40))
      return ["tree": tree]
    } catch {
      throw RPCError(
        .simulatorFailure, "accessibility tree unavailable: \(error.localizedDescription)")
    }

  default:
    throw RPCError(.methodNotFound, "unknown method '\(method)'")
  }
}

// MARK: - Entry point

let arguments = CommandLine.arguments
let developerDirectory = resolveDeveloperDirectory()
let isProbe = arguments.contains("--probe")

func emitPayloadAndExit(_ payload: [String: Any]) -> Never {
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(payload["ok"] as? Bool == true ? 0 : 2)
}

let frameworkHandles: PrivateFrameworkHandles
do {
  // The probe tolerates a missing SimulatorKit so it can still measure the
  // other three capabilities; a serving helper does not.
  frameworkHandles = try loadPrivateFrameworks(
    developerDirectory: developerDirectory, requireSimulatorKit: !isProbe)
} catch {
  // A load failure is still reported per capability, so the pane renders "all
  // four unavailable on this Xcode" rather than an untyped error.
  var payload: [String: Any] = [
    "ok": false,
    "protocolVersion": 1,
    "developerDirectory": developerDirectory,
    "error": "\(error)",
    "toolchain": CapabilityProbe.toolchainInfo(developerDirectory: developerDirectory),
  ]
  var capabilities: [String: Any] = [:]
  for capability in HelperCapability.allCases {
    capabilities[capability.rawValue] = ["error": "\(error)"]
  }
  payload["capabilities"] = capabilities
  emitPayloadAndExit(payload)
}

// `--probe` reports each capability separately and exits. The build script, the
// pane's setup checklist and the smoke CLI all read it.
if isProbe {
  let reports = CapabilityProbe.run(simulatorKitHandle: frameworkHandles.simulatorKit)
  var deviceSetError: String?
  var deviceCount: Int?
  var bootedCount: Int?
  do {
    let deviceSet = try SimulatorDeviceSet.resolve(developerDirectory: developerDirectory)
    deviceCount = deviceSet.devices.count
    bootedCount = deviceSet.devices.filter(\.isBooted).count
  } catch {
    deviceSetError = "\(error)"
  }
  emitPayloadAndExit(
    CapabilityProbe.payload(
      reports: reports,
      developerDirectory: developerDirectory,
      deviceSetError: deviceSetError,
      deviceCount: deviceCount,
      bootedCount: bootedCount))
}

let deviceSet: SimulatorDeviceSet
do {
  deviceSet = try SimulatorDeviceSet.resolve(developerDirectory: developerDirectory)
} catch {
  logDiagnostic("cannot reach CoreSimulator: \(error)")
  exit(2)
}

let session = HelperSession(developerDirectory: developerDirectory, deviceSet: deviceSet)

/// Signal sources must outlive their registration, so they are held here for
/// the process lifetime.
var signalSources: [DispatchSourceSignal] = []

// Requests are served on a background queue: several handlers block (HID holds,
// synchronous accessibility XPC), and the main run loop must stay free to
// service the display callbacks that drive the frame stream.
let requestQueue = DispatchQueue(label: "dev.synara.device-helper.rpc")

func handleLine(_ line: Data) {
  guard !line.isEmpty else { return }
  let parsed: Any
  do {
    parsed = try JSONSerialization.jsonObject(with: line)
  } catch {
    writeError(id: NSNull(), code: .parseError, message: "invalid JSON: \(error.localizedDescription)")
    return
  }
  guard let object = parsed as? [String: Any] else {
    writeError(id: NSNull(), code: .invalidRequest, message: "request must be a JSON object")
    return
  }
  let id = object["id"]
  guard let method = object["method"] as? String else {
    writeError(id: id, code: .invalidRequest, message: "request is missing 'method'")
    return
  }
  let params = Params(raw: object["params"] as? [String: Any] ?? [:])

  do {
    let result = try handle(method: method, params: params, session: session)
    writeResult(id: id, result: result)
  } catch let error as RPCError {
    writeError(id: id, code: error.code, message: error.message)
  } catch let error as SimulatorError {
    writeError(id: id, code: .simulatorFailure, message: error.description)
  } catch {
    writeError(id: id, code: .internalError, message: error.localizedDescription)
  }
}

requestQueue.async {
  let input = FileHandle.standardInput
  var buffer = Data()
  while true {
    let chunk = input.availableData
    if chunk.isEmpty { break }  // stdin closed: the server is shutting down.
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0a) {
      let line = buffer.subdata(in: buffer.startIndex..<newline)
      buffer.removeSubrange(buffer.startIndex...newline)
      handleLine(line)
    }
  }
  session.shutdown()
  exit(0)
}

// SIGTERM/SIGINT must tear the stream down cleanly so the simulator is not left
// with dangling display callbacks.
for signalNumber in [SIGTERM, SIGINT] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler {
    session.shutdown()
    exit(0)
  }
  source.resume()
  // Retained for process lifetime; cancelling would drop the handler.
  signalSources.append(source)
}

writeNotification(method: "ready", params: ["protocolVersion": 1, "developerDirectory": developerDirectory])

RunLoop.main.run()
