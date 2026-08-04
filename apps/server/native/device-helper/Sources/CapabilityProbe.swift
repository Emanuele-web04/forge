// Per-capability preflight.
//
// `--probe` used to answer one question ("can the helper run?"), which meant a
// single renamed accessibility symbol took streaming and input down with it.
// This reports each capability separately so the app can degrade precisely:
// accessibility broken, streaming and input unaffected.
//
// Symbol presence comes from `SymbolManifest`; where a live check is cheap and
// meaningfully stronger than a name lookup, the probe performs it (the encoder
// actually creates a VideoToolbox session, since a present framework that
// refuses to allocate is exactly the failure worth catching).

import Foundation
import VideoToolbox

enum CapabilityProbe {

  /// Probes every capability. `simulatorKitHandle` is the already-dlopen'd
  /// SimulatorKit, or nil when it would not load — in which case HID is
  /// reported as failed rather than silently passing on name lookups.
  static func run(simulatorKitHandle: UnsafeMutableRawPointer?) -> [CapabilityReport] {
    HelperCapability.allCases.map { capability in
      switch capability {
      case .framebuffer, .accessibility:
        return CapabilityReport(
          capability: capability,
          missing: missingSymbols(for: capability, simulatorKitHandle: simulatorKitHandle),
          failure: nil)
      case .hid:
        guard simulatorKitHandle != nil else {
          return CapabilityReport(
            capability: capability, missing: [],
            failure: "SimulatorKit could not be loaded from the active Xcode")
        }
        return CapabilityReport(
          capability: capability,
          missing: missingSymbols(for: capability, simulatorKitHandle: simulatorKitHandle),
          failure: nil)
      case .encoder:
        return probeEncoder()
      }
    }
  }

  private static func missingSymbols(
    for capability: HelperCapability,
    simulatorKitHandle: UnsafeMutableRawPointer?
  ) -> [MissingSymbol] {
    SymbolManifest.symbols(for: capability).compactMap { symbol in
      resolves(symbol, simulatorKitHandle: simulatorKitHandle)
        ? nil
        : MissingSymbol(name: symbol.name, purpose: symbol.purpose)
    }
  }

  private static func resolves(
    _ symbol: RuntimeSymbol,
    simulatorKitHandle: UnsafeMutableRawPointer?
  ) -> Bool {
    switch symbol.kind {
    case .objcClass:
      return NSClassFromString(symbol.name) != nil
    case .objcProtocol:
      return NSProtocolFromString(symbol.name) != nil
    case .simulatorKitFunction:
      guard let simulatorKitHandle else { return false }
      return dlsym(simulatorKitHandle, symbol.name) != nil
    case .selector(let className):
      guard let owner = NSClassFromString(className) else { return false }
      let selector = NSSelectorFromString(symbol.name)
      // Checked on both the metaclass and instances: the manifest mixes class
      // methods (the service-context entry point) with instance methods.
      return owner.responds(to: selector) || owner.instancesRespond(to: selector)
    case .protocolSelector(let protocolName):
      guard let proto = NSProtocolFromString(protocolName) else { return false }
      return protocolDeclares(NSSelectorFromString(symbol.name), in: proto)
    }
  }

  /// Whether a protocol declares a selector, required or optional.
  private static func protocolDeclares(_ selector: Selector, in proto: Protocol) -> Bool {
    for isRequired in [true, false] {
      var count: UInt32 = 0
      guard
        let descriptions = protocol_copyMethodDescriptionList(proto, isRequired, true, &count)
      else { continue }
      defer { free(descriptions) }
      for index in 0..<Int(count) where descriptions[index].name == selector {
        return true
      }
    }
    return false
  }

  /// Creates and tears down a small compression session. A missing VideoToolbox
  /// is not the realistic failure — a session that will not allocate is, and
  /// only an allocation catches it.
  private static func probeEncoder() -> CapabilityReport {
    var session: VTCompressionSession?
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      width: 256,
      height: 256,
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: nil,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &session)

    guard status == noErr, let session else {
      return CapabilityReport(
        capability: .encoder, missing: [],
        failure: "VideoToolbox could not create an H.264 compression session (status \(status))")
    }
    VTCompressionSessionInvalidate(session)
    return CapabilityReport(capability: .encoder, missing: [], failure: nil)
  }

  /// The probe's JSON payload: per-capability results plus the toolchain they
  /// were measured against, so a report pins the exact Xcode that broke.
  static func payload(
    reports: [CapabilityReport],
    developerDirectory: String,
    deviceSetError: String?,
    deviceCount: Int?,
    bootedCount: Int?
  ) -> [String: Any] {
    var capabilities: [String: Any] = [:]
    for report in reports {
      capabilities[report.capability.rawValue] = report.json
    }

    var payload: [String: Any] = [
      // `ok` stays the whole-helper answer so an older caller keeps working.
      "ok": reports.allSatisfy(\.ok) && deviceSetError == nil,
      "protocolVersion": 1,
      "developerDirectory": developerDirectory,
      "capabilities": capabilities,
      "toolchain": toolchainInfo(developerDirectory: developerDirectory),
    ]
    if let deviceSetError {
      payload["error"] = deviceSetError
    }
    if let deviceCount { payload["deviceCount"] = deviceCount }
    if let bootedCount { payload["bootedCount"] = bootedCount }
    return payload
  }

  static func toolchainInfo(developerDirectory: String) -> [String: Any] {
    var info: [String: Any] = [
      "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
      "developerDirectory": developerDirectory,
    ]
    let version = xcodebuildVersion()
    if let version {
      // Parsed here so every consumer reads the same fields rather than
      // re-deriving them from raw `xcodebuild` output.
      if let marketing = firstMatch(#"Xcode\s+([\d.]+)"#, in: version) {
        info["xcodeVersion"] = marketing
      }
      if let build = firstMatch(#"Build version\s+(\S+)"#, in: version) {
        info["xcodeBuild"] = build
      }
    }
    return info
  }

  private static func xcodebuildVersion() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    process.arguments = ["xcodebuild", "-version"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private static func firstMatch(_ pattern: String, in text: String) -> String? {
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let range = NSRange(text.startIndex..., in: text)
    guard let match = regex.firstMatch(in: text, range: range), match.numberOfRanges > 1,
      let captured = Range(match.range(at: 1), in: text)
    else { return nil }
    return String(text[captured])
  }
}
