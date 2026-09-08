// Private WindowServer (SkyLight) entry points, resolved at runtime.
//
// Everything here is SPI: nothing is linked, every symbol is looked up once
// with `dlsym`, and every caller has a public-API fallback for the case where a
// symbol is gone on this macOS. That is the posture the helper already takes for
// `CGEventSetWindowLocation` (moved here from Input.swift), and it is what turns
// an OS release that renames a symbol into a reported capability gap rather than
// a dyld crash at launch. `report()` says which entry points resolved so the
// backend and `--probe` can show it.
//
// Background input sends synthetic active/key-window state only to its target.
// Never send deactivation or activation records to the user's application, and
// never fall back to making another process foreground when a symbol is absent.

import AppKit
import CoreGraphics
import Foundation

/// Eight bytes, two `UInt32`s: the layout `ProcessSerialNumber` has always had.
struct ProcessSerial: Equatable {
  var high: UInt32 = 0
  var low: UInt32 = 0
}

enum SkyLight {
  typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
  private typealias GetFrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
  private typealias MainConnectionID = @convention(c) () -> UInt32
  private typealias GetWindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
  private typealias GetConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32
  private typealias SetFrontProcessWithOptions = @convention(c) (UnsafeRawPointer, UInt32, UInt32) -> Int32
  private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
  private typealias GetProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32

  /// `kCPSNoWindows`: make the process front without ordering all of its
  /// windows forward — only the named one.
  private static let setFrontNoWindows: UInt32 = 0x400

  private struct Symbols {
    let setWindowLocation: SetWindowLocation?
    let postEventRecordTo: PostEventRecordTo?
    let getFrontProcess: GetFrontProcess?
    let mainConnectionID: MainConnectionID?
    let getWindowOwner: GetWindowOwner?
    let getConnectionPSN: GetConnectionPSN?
    let setFrontProcessWithOptions: SetFrontProcessWithOptions?
    let getProcessForPID: GetProcessForPID?
    let getProcessPID: GetProcessPID?
  }

  private static let symbols: Symbols = {
    let skylight = dlopen(
      "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    if skylight == nil { logDiagnostic("SkyLight.framework did not load; focus SPI unavailable") }
    func resolve<T>(_ name: String, _ type: T.Type) -> T? {
      var pointer = skylight.flatMap { dlsym($0, name) }
      if pointer == nil { pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) }
      guard let pointer else {
        logDiagnostic("private symbol \(name) is missing on this macOS")
        return nil
      }
      return unsafeBitCast(pointer, to: type)
    }
    return Symbols(
      setWindowLocation: resolve("CGEventSetWindowLocation", SetWindowLocation.self),
      postEventRecordTo: resolve("SLPSPostEventRecordTo", PostEventRecordTo.self),
      getFrontProcess: resolve("_SLPSGetFrontProcess", GetFrontProcess.self),
      mainConnectionID: resolve("CGSMainConnectionID", MainConnectionID.self),
      getWindowOwner: resolve("SLSGetWindowOwner", GetWindowOwner.self),
      getConnectionPSN: resolve("SLSGetConnectionPSN", GetConnectionPSN.self),
      setFrontProcessWithOptions: resolve(
        "SLPSSetFrontProcessWithOptions", SetFrontProcessWithOptions.self),
      // Public but deprecated Process Manager calls; resolved the same way so the
      // deprecation does not become a build warning and their absence is handled.
      getProcessForPID: resolve("GetProcessForPID", GetProcessForPID.self),
      getProcessPID: resolve("GetProcessPID", GetProcessPID.self))
  }()

  /// Stamps a window-local point on an event; nil when the symbol is gone.
  static var setWindowLocation: SetWindowLocation? { symbols.setWindowLocation }

  /// Whether the key-window record may be posted on this OS. Evaluated once —
  /// the answer cannot change while the process runs — and reported so a
  /// dropped background gesture on Sonoma is explainable rather than mysterious.
  private static let keyWindowRecordIsSafe: Bool = {
    let major = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
    if major == 14 {
      logDiagnostic(
        "macOS 14 archives the key-window record unsafely; web input takes the visible rung")
      return false
    }
    return true
  }()

  /// Which entry points resolved on this OS, for `capabilities` and `--probe`.
  static func report() -> [String: Bool] {
    [
      "setWindowLocation": symbols.setWindowLocation != nil,
      "focusWithoutRaise": symbols.postEventRecordTo != nil && symbols.getFrontProcess != nil
        && (symbols.getConnectionPSN != nil || symbols.getProcessForPID != nil),
      "setFrontProcess": symbols.setFrontProcessWithOptions != nil,
      "keyWindowRecord": symbols.postEventRecordTo != nil && keyWindowRecordIsSafe,
    ]
  }

  static var focusWithoutRaiseAvailable: Bool { report()["focusWithoutRaise"] == true }

  // MARK: - Processes

  /// The pid WindowServer considers front right now. Unlike
  /// `NSWorkspace.frontmostApplication` this does not depend on our own run loop
  /// having processed an activation notification, so it is current immediately
  /// after a change we caused.
  static func frontmostPID() -> pid_t? {
    if let psn = frontProcess(), let pid = pid(for: psn) { return pid }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  private static func frontProcess() -> ProcessSerial? {
    guard let getFront = symbols.getFrontProcess else { return nil }
    var psn = ProcessSerial()
    let status = withUnsafeMutablePointer(to: &psn) { getFront(UnsafeMutableRawPointer($0)) }
    return status == 0 ? psn : nil
  }

  private static func pid(for psn: ProcessSerial) -> pid_t? {
    guard let getPID = symbols.getProcessPID else { return nil }
    var serial = psn
    var pid: pid_t = 0
    let status = withUnsafePointer(to: &serial) { getPID(UnsafeRawPointer($0), &pid) }
    return status == 0 && pid > 0 ? pid : nil
  }

  /// The serial of the process owning `windowID`: through WindowServer's own
  /// connection table first, then the Process Manager by pid.
  private static func process(owning windowID: CGWindowID, pid: pid_t) -> ProcessSerial? {
    if let connectionID = symbols.mainConnectionID, let getOwner = symbols.getWindowOwner,
      let getPSN = symbols.getConnectionPSN
    {
      var owner: UInt32 = 0
      if getOwner(connectionID(), windowID, &owner) == 0, owner != 0 {
        var psn = ProcessSerial()
        let status = withUnsafeMutablePointer(to: &psn) { getPSN(owner, UnsafeMutableRawPointer($0)) }
        if status == 0 { return psn }
      }
    }
    guard let getForPID = symbols.getProcessForPID else { return nil }
    var psn = ProcessSerial()
    let status = withUnsafeMutablePointer(to: &psn) { getForPID(pid, UnsafeMutableRawPointer($0)) }
    return status == 0 ? psn : nil
  }

  // MARK: - Focus

  /// The outcome of a focus prelude.
  ///
  /// Whether target-only synthetic activation was accepted and needs unwinding.
  struct FocusOutcome {
    let activated: Bool
    let needsRestore: Bool
  }

  /// Whether the focus record pair is even available for this target.
  ///
  /// A cheap precondition check that posts nothing: without the SPI, or without
  /// a resolvable process serial for the target, the pair cannot be sent and a
  /// background gesture will be hit-tested as background. Callers use it to
  /// decide the delivery rung before building any event.
  static func canActivateWithoutRaise(pid: pid_t, windowID: CGWindowID) -> Bool {
    guard focusWithoutRaiseAvailable, frontProcess() != nil,
      process(owning: windowID, pid: pid) != nil
    else { return false }
    return true
  }

  /// Make `pid` believe it is the active application, addressed at `windowID`,
  /// without raising anything or switching Spaces. The caller proceeds whatever
  /// this returns, since the pid-targeted post that follows is what actually
  /// delivers the event — but it must honour `needsRestore`.
  static func activateWithoutRaise(
    pid: pid_t, windowID: CGWindowID
  ) -> FocusOutcome {
    guard let previous = frontProcess(), let target = process(owning: windowID, pid: pid),
      previous != target
    else { return FocusOutcome(activated: false, needsRestore: false) }
    // Only the target receives synthetic activation. Deactivating the user's
    // app, even without restacking, interrupts its keyboard and active state.
    let activated = post(record(kind: .activate, windowID: windowID), to: target)
    guard activated else { return FocusOutcome(activated: false, needsRestore: false) }
    // Active is not the same as key, and Chromium needs both. Posted
    // unconditionally rather than only when the activate reported success: the
    // return above is WindowServer accepting the record, not the app having
    // acted on it, and the key-window pair is harmless when the window already
    // is key.
    makeKeyWindow(windowID: windowID, in: target)
    return FocusOutcome(activated: activated, needsRestore: true)
  }

  /// Tell `psn`'s application that `windowID` is its key window.
  ///
  /// A separate record from the activate above, and not implied by it: the
  /// activate flips the process's active state, this names which of its windows
  /// owns the keyboard and is hit-tested as the frontmost one. The distinction
  /// is invisible on native AppKit — a background TextEdit takes pid-posted
  /// clicks and keys with the activate record alone — and decisive on Chromium,
  /// where without it a pid-posted mouseDown into the page produces no
  /// `mousedown` event whatsoever.
  ///
  /// The bytes are yabai's `window_manager_make_key_window`: the same 248-byte
  /// envelope as `record`, but carrying event kinds 0x01 then 0x02 at 0x08,
  /// 0x10 at 0x3A, and 0xFF through 0x20..<0x30. Measured, that pair moves key
  /// status without generating any content-level click — the probe page's
  /// `mousedown` counter does not move when only these are posted — and without
  /// changing z-order, Space, or which application is frontmost.
  ///
  /// Skipped entirely on macOS 14. On Sonoma `SLPSPostEventRecordTo` runs the
  /// record through `CGSEncodeEventRecord` → `NSKeyedArchiver`, which reads the
  /// 0xFF fill at 0x20 as an Objective-C class pointer and aborts *the calling
  /// process* — a helper crash, not a dropped gesture (paneru#123, with the
  /// `objc_msgSend_uncached` → `_SLEventRecordCreateData` stack). The
  /// activate/deactivate record has no such fill and is unaffected. Sonoma
  /// therefore keeps the pre-existing behaviour: the target keeps whatever key
  /// window it had, a background click into a web view is dropped, and
  /// `DeliveryWatch` promotes that application to the visible rung the same way
  /// it does for anything else that drops one.
  static func makeKeyWindow(pid: pid_t, windowID: CGWindowID) {
    guard let target = process(owning: windowID, pid: pid) else { return }
    makeKeyWindow(windowID: windowID, in: target)
  }

  private static func makeKeyWindow(windowID: CGWindowID, in psn: ProcessSerial) {
    guard keyWindowRecordIsSafe else { return }
    var bytes = [UInt8](repeating: 0, count: 0xF8)
    bytes[0x04] = 0xF8
    bytes[0x3A] = 0x10
    bytes[0x3C] = UInt8(windowID & 0xFF)
    bytes[0x3D] = UInt8((windowID >> 8) & 0xFF)
    bytes[0x3E] = UInt8((windowID >> 16) & 0xFF)
    bytes[0x3F] = UInt8((windowID >> 24) & 0xFF)
    for index in 0x20..<0x30 { bytes[index] = 0xFF }
    bytes[0x08] = 0x01
    _ = post(bytes, to: psn)
    bytes[0x08] = 0x02
    _ = post(bytes, to: psn)
  }

  /// Undo only the target's synthetic active state. The user's app is untouched.
  static func restoreActivation(from targetPID: pid_t)
    -> Bool
  {
    // The user's app was never deactivated. Only unwind the target's synthetic
    // state, and leave it alone if the user has since made it active themselves.
    guard frontmostPID() != targetPID else { return true }
    guard let target = process(owning: 0, pid: targetPID) else { return true }
    return post(record(kind: .deactivate, windowID: 0), to: target)
  }

  private enum RecordKind: UInt8 {
    case activate = 0x01
    case deactivate = 0x02
  }

  /// The 248-byte process-level event record: size at 0x04, kind 0x0D at 0x08,
  /// the window id little-endian at 0x3C, and the activate/deactivate marker at
  /// 0x8A. Every other byte is zero.
  private static func record(kind: RecordKind, windowID: CGWindowID) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: 0xF8)
    bytes[0x04] = 0xF8
    bytes[0x08] = 0x0D
    bytes[0x3C] = UInt8(windowID & 0xFF)
    bytes[0x3D] = UInt8((windowID >> 8) & 0xFF)
    bytes[0x3E] = UInt8((windowID >> 16) & 0xFF)
    bytes[0x3F] = UInt8((windowID >> 24) & 0xFF)
    bytes[0x8A] = kind.rawValue
    return bytes
  }

  private static func post(_ record: [UInt8], to psn: ProcessSerial) -> Bool {
    guard let post = symbols.postEventRecordTo else { return false }
    var serial = psn
    return record.withUnsafeBufferPointer { bytes in
      withUnsafePointer(to: &serial) { post(UnsafeRawPointer($0), bytes.baseAddress!) }
    } == 0
  }
}
