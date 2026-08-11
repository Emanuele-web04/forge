// CoreSimulator access.
//
// Every symbol here is private API reached by name at runtime: the frameworks
// are dlopen'd from whatever `xcode-select -p` points at, and classes and
// selectors are resolved through the Objective-C runtime. Nothing is linked at
// build time, so the helper binary stays relocatable across Xcode installs and
// fails with a diagnosable error (rather than a dyld crash) when Apple moves
// something.

import Foundation
import IOSurface

enum SimulatorError: Error, CustomStringConvertible {
  case frameworkLoadFailed(String)
  case runtimeSymbolMissing(String)
  case serviceContextUnavailable(String)
  case deviceSetUnavailable(String)
  case deviceNotFound(String)
  case deviceNotBooted(String)
  case displayUnavailable(String)

  var description: String {
    switch self {
    case .frameworkLoadFailed(let detail): return "failed to load private framework: \(detail)"
    case .runtimeSymbolMissing(let detail): return "CoreSimulator runtime symbol missing: \(detail)"
    case .serviceContextUnavailable(let detail): return "CoreSimulator service context unavailable: \(detail)"
    case .deviceSetUnavailable(let detail): return "CoreSimulator device set unavailable: \(detail)"
    case .deviceNotFound(let udid): return "no simulator with udid \(udid)"
    case .deviceNotBooted(let udid): return "simulator \(udid) is not booted"
    case .displayUnavailable(let detail): return "simulator display unavailable: \(detail)"
    }
  }
}

/// Resolves the active developer directory, preferring an explicit override so
/// callers can pin a toolchain without mutating machine-wide `xcode-select`.
func resolveDeveloperDirectory() -> String {
  if let override = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !override.isEmpty {
    return override
  }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  process.arguments = ["-p"]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  do {
    try process.run()
  } catch {
    return "/Applications/Xcode.app/Contents/Developer"
  }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let path = String(data: data, encoding: .utf8)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return path.isEmpty ? "/Applications/Xcode.app/Contents/Developer" : path
}

/// The dlopen handles the capability probe needs for `dlsym` lookups.
struct PrivateFrameworkHandles {
  /// nil when SimulatorKit itself would not load. The probe reports that as one
  /// HID failure rather than listing every Indigo symbol as missing.
  let simulatorKit: UnsafeMutableRawPointer?
}

/// dlopens CoreSimulator, SimulatorKit and the accessibility translator.
/// Idempotent; safe to call from any entry point.
///
/// Only CoreSimulator is load-fatal. `requireSimulatorKit: false` lets the probe
/// keep going when SimulatorKit is missing, so it can report input as broken
/// while still measuring framebuffer, accessibility and encoder.
@discardableResult
func loadPrivateFrameworks(
  developerDirectory: String,
  requireSimulatorKit: Bool = true
) throws -> PrivateFrameworkHandles {
  // CoreSimulator lives outside the Xcode bundle and is required.
  let coreSimulator = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
  if dlopen(coreSimulator, RTLD_NOW) == nil {
    let message = String(cString: dlerror())
    throw SimulatorError.frameworkLoadFailed("CoreSimulator (\(message))")
  }

  let simulatorKitPath = developerDirectory
    + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
  let simulatorKit = dlopen(simulatorKitPath, RTLD_NOW)
  if simulatorKit == nil && requireSimulatorKit {
    let message = String(cString: dlerror())
    throw SimulatorError.frameworkLoadFailed("SimulatorKit at \(simulatorKitPath) (\(message))")
  }

  // Accessibility translation is optional: without it `describe-ui` degrades,
  // but streaming and input still work.
  let accessibility =
    "/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation"
  _ = dlopen(accessibility, RTLD_NOW)

  // The HID bridge re-derives the SimulatorKit path; hand it the same directory
  // so an overridden DEVELOPER_DIR cannot pull the two out of agreement.
  setenv("SYNARA_DEVELOPER_DIR", developerDirectory, 1)

  return PrivateFrameworkHandles(simulatorKit: simulatorKit)
}

/// The CoreSimulator device-set, and lookups over it.
struct SimulatorDeviceSet {
  let handle: NSObject

  static func resolve(developerDirectory: String) throws -> SimulatorDeviceSet {
    guard let contextClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
      throw SimulatorError.runtimeSymbolMissing("SimServiceContext")
    }

    let contextSelector = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    typealias ContextFn = @convention(c) (
      AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    guard let contextImp = contextClass.method(for: contextSelector) else {
      throw SimulatorError.runtimeSymbolMissing("sharedServiceContextForDeveloperDir:error:")
    }
    var contextError: NSError?
    let context = withUnsafeMutablePointer(to: &contextError) { pointer -> AnyObject? in
      unsafeBitCast(contextImp, to: ContextFn.self)(
        contextClass, contextSelector, developerDirectory as NSString,
        AutoreleasingUnsafeMutablePointer(pointer))
    }
    guard let context = context as? NSObject else {
      throw SimulatorError.serviceContextUnavailable(
        contextError?.localizedDescription ?? "unknown error")
    }

    let setSelector = NSSelectorFromString("defaultDeviceSetWithError:")
    typealias SetFn = @convention(c) (
      AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> AnyObject?
    guard let setImp = context.method(for: setSelector) else {
      throw SimulatorError.runtimeSymbolMissing("defaultDeviceSetWithError:")
    }
    var setError: NSError?
    let deviceSet = withUnsafeMutablePointer(to: &setError) { pointer -> AnyObject? in
      unsafeBitCast(setImp, to: SetFn.self)(
        context, setSelector, AutoreleasingUnsafeMutablePointer(pointer))
    }
    guard let deviceSet = deviceSet as? NSObject else {
      throw SimulatorError.deviceSetUnavailable(setError?.localizedDescription ?? "unknown error")
    }

    return SimulatorDeviceSet(handle: deviceSet)
  }

  var devices: [SimulatorDevice] {
    guard let raw = handle.value(forKey: "devices") as? NSArray else {
      return []
    }
    return raw.compactMap { entry in
      (entry as AnyObject as? NSObject).map(SimulatorDevice.init(handle:))
    }
  }

  func device(udid: String) throws -> SimulatorDevice {
    let wanted = udid.lowercased()
    guard let match = devices.first(where: { $0.udid.lowercased() == wanted }) else {
      throw SimulatorError.deviceNotFound(udid)
    }
    return match
  }
}

/// A single simulator device.
struct SimulatorDevice {
  /// CoreSimulator's `SimDeviceState` for a fully booted device.
  static let bootedState = 3

  let handle: NSObject

  var udid: String {
    if let uuid = handle.value(forKey: "UDID") as? NSUUID {
      return uuid.uuidString
    }
    return (handle.value(forKey: "UDID") as? String) ?? ""
  }

  var name: String { (handle.value(forKey: "name") as? String) ?? "" }
  var state: Int { (handle.value(forKey: "state") as? NSNumber)?.intValue ?? -1 }
  var isBooted: Bool { state == Self.bootedState }

  /// A marker that changes on every boot of this device.
  ///
  /// `lastBootedAt` updates each time CoreSimulator boots the device (it is
  /// also persisted in device.plist), so a changed value means an attachment's
  /// HID client and display descriptor belong to a dead boot even though the
  /// udid still matches. `bootSessionUUID` exists as a selector but returns
  /// nil on current CoreSimulator (26.x), so the timestamp is the reliable
  /// identity. Nil when the property is unavailable; callers must treat nil
  /// as "cannot verify", never as "still valid".
  var bootIdentity: String? {
    let selector = NSSelectorFromString("lastBootedAt")
    guard handle.responds(to: selector),
      let value = handle.perform(selector)?.takeUnretainedValue() as? NSDate
    else { return nil }
    return String(value.timeIntervalSinceReferenceDate)
  }

  var runtimeIdentifier: String? {
    guard let runtime = handle.value(forKey: "runtime") as? NSObject else { return nil }
    return runtime.value(forKey: "identifier") as? String
  }

  var deviceTypeIdentifier: String? {
    guard let deviceType = handle.value(forKey: "deviceType") as? NSObject else { return nil }
    return deviceType.value(forKey: "identifier") as? String
  }

  /// Point size and scale of the main screen, from the device type. Used to map
  /// pixel coordinates to the points a caller thinks in.
  var screenGeometry: (pointWidth: Int, pointHeight: Int, scale: Int)? {
    guard let deviceType = handle.value(forKey: "deviceType") as? NSObject,
      let size = deviceType.value(forKey: "mainScreenSize") as? NSValue,
      let scale = (deviceType.value(forKey: "mainScreenScale") as? NSNumber)?.intValue,
      scale > 0
    else {
      return nil
    }
    let pixels = size.sizeValue
    return (Int(pixels.width) / scale, Int(pixels.height) / scale, scale)
  }

  /// The display descriptor backing the largest framebuffer, which is the main
  /// screen. Devices publish several IO ports; only some are renderable, and an
  /// early-boot device may publish a renderable port with no surface yet.
  func mainDisplayDescriptor() throws -> NSObject {
    guard let renderable = NSProtocolFromString("SimDisplayIOSurfaceRenderable") else {
      throw SimulatorError.runtimeSymbolMissing("SimDisplayIOSurfaceRenderable")
    }
    guard let io = handle.value(forKey: "io") as? NSObject,
      let ports = io.value(forKey: "ioPorts") as? NSArray
    else {
      throw SimulatorError.displayUnavailable("device publishes no IO ports")
    }

    let descriptorSelector = NSSelectorFromString("descriptor")
    typealias DescriptorFn = @convention(c) (AnyObject, Selector) -> AnyObject?

    var best: NSObject?
    var bestArea = 0
    for port in ports {
      guard let port = port as AnyObject as? NSObject,
        let imp = port.method(for: descriptorSelector)
      else { continue }
      guard
        let descriptor = unsafeBitCast(imp, to: DescriptorFn.self)(port, descriptorSelector)
          as? NSObject,
        descriptor.conforms(to: renderable)
      else { continue }
      guard let surface = descriptor.currentFramebufferSurface() else { continue }
      let area = IOSurfaceGetWidth(surface) * IOSurfaceGetHeight(surface)
      if area > bestArea {
        bestArea = area
        best = descriptor
      }
    }

    guard let descriptor = best else {
      throw SimulatorError.displayUnavailable("no renderable display with a framebuffer")
    }
    return descriptor
  }
}

extension NSObject {
  /// The descriptor's current framebuffer, or nil when it has none yet.
  func currentFramebufferSurface() -> IOSurfaceRef? {
    let selector = NSSelectorFromString("framebufferSurface")
    guard responds(to: selector),
      let unmanaged = perform(selector)
    else {
      return nil
    }
    let value = unmanaged.takeUnretainedValue()
    guard CFGetTypeID(value) == IOSurfaceGetTypeID() else {
      return nil
    }
    return unsafeBitCast(value, to: IOSurfaceRef.self)
  }
}
