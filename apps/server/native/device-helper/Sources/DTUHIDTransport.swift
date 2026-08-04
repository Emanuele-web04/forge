// DTUHID transport — the modern HID path, for the buttons Indigo cannot carry.
//
// SimulatorKit's legacy Indigo path (see HIDBridge.m) builds every event through
// `IndigoHIDMessageForButton`, which only knows a handful of *hardware* button
// sources: home, lock, side, Siri, Apple Pay. Volume up and down are
// **Consumer-page** usages, and Indigo has no source for them at all — Meta's
// idb documents exactly this, returning nil from its Indigo `button(with:)` for
// "a Consumer-page button such as play_pause that only the DTUHID transport can
// deliver".
//
// That is why pressing volume through Indigo did nothing observable: the event
// was structurally incapable of arriving, so the guest's framebuffer stayed
// byte-identical and SpringBoard logged nothing. It was never a mapping bug.
//
// The modern path is `dtuhidd`, reached over plain XPC on the simulator's
// `com.apple.coredevice.feature.remote.hid.digitizer` service. A button press is
// an `IndigoButtonEvent` naming a HID usage page and usage code, wrapped in the
// daemon's message envelope.
//
// Availability: the daemon ships with Xcode 27 / iOS 26+ runtimes. On anything
// older the service simply is not registered on the device, which is what
// `isAvailable(for:)` reports — the caller then refuses the press with a reason
// rather than pretending to deliver it.
//
// Written from the mechanism idb documents (MIT), not from its code.

import Foundation

/// USB HID usage pages and usages, from the HID Usage Tables spec.
enum HIDUsage {
  /// Consumer page (0x0C): the page media and volume keys live on.
  static let consumerPage: UInt32 = 0x0C

  static let volumeUp: UInt32 = 0xE9
  static let volumeDown: UInt32 = 0xEA
  /// Menu — how the Consumer page spells Home.
  static let menu: UInt32 = 0x40
  static let power: UInt32 = 0x30
  static let playPause: UInt32 = 0xCD
  static let voiceCommand: UInt32 = 0xCF
}

/// Press state, as the daemon numbers it (1-based, unlike Indigo's op codes).
enum DTUHIDButtonState: Int {
  case down = 1
  case up = 2
}

/// Why a DTUHID press could not be delivered. Carried to the caller so the
/// refusal names the toolchain rather than surfacing as a silent no-op.
struct DTUHIDUnavailable: Error {
  let reason: String
}

/// Sends Consumer-page button events to a simulator through `dtuhidd`.
///
/// Stateless between calls: the XPC connection is cheap to build and a press is
/// rare (a user clicking a nub), so holding one open across an idle pane would
/// cost a live connection to a daemon that may be torn down with the boot.
final class DTUHIDTransport {
  /// The simulator service the daemon listens on.
  static let serviceName = "com.apple.coredevice.feature.remote.hid.digitizer"

  private let device: SimulatorDevice

  init(device: SimulatorDevice) {
    self.device = device
  }

  /// Whether this device exposes the digitizer service at all.
  ///
  /// Checked per call rather than cached: the service belongs to the boot, so a
  /// device rebooted under an older runtime must not inherit a stale yes.
  static func isAvailable(for device: SimulatorDevice) -> Bool {
    servicePort(for: device) != nil
  }

  private static func servicePort(for device: SimulatorDevice) -> mach_port_t? {
    let selector = NSSelectorFromString("lookup:error:")
    guard device.handle.responds(to: selector) else { return nil }
    typealias LookupFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?)
      -> mach_port_t
    guard let imp = device.handle.method(for: selector) else { return nil }
    var error: NSError?
    let port = unsafeBitCast(imp, to: LookupFn.self)(
      device.handle, selector, serviceName as NSString, &error)
    // A zero port is the honest "this runtime has no dtuhidd" answer; the error
    // text distinguishes "not booted" from "service absent" for diagnostics.
    return port != 0 ? port : nil
  }

  /// Press and release a Consumer-page button.
  func tap(usagePage: UInt32, usageCode: UInt32) throws {
    try send(usagePage: usagePage, usageCode: usageCode, state: .down)
    // The daemon coalesces a down/up pair sent back to back; idb waits ~80ms
    // between them for the same reason.
    usleep(90_000)
    try send(usagePage: usagePage, usageCode: usageCode, state: .up)
  }

  func send(usagePage: UInt32, usageCode: UInt32, state: DTUHIDButtonState) throws {
    guard let port = DTUHIDTransport.servicePort(for: device) else {
      throw DTUHIDUnavailable(
        reason:
          "this simulator runtime has no \(DTUHIDTransport.serviceName) service; "
          + "volume and other Consumer-page buttons need an Xcode 27 / iOS 26 runtime")
    }
    guard let connection = DTUHIDTransport.connect(to: port) else {
      throw DTUHIDUnavailable(reason: "could not open an XPC connection to dtuhidd")
    }
    defer { xpc_connection_cancel(connection) }

    let message = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_string(message, "messageType", "IndigoButtonEvent")
    let event = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_uint64(event, "usagePage", UInt64(usagePage))
    xpc_dictionary_set_uint64(event, "usageCode", UInt64(usageCode))
    xpc_dictionary_set_int64(event, "state", Int64(state.rawValue))
    xpc_dictionary_set_value(message, "event", event)

    xpc_connection_send_message(connection, message)
    // Flushed synchronously: the connection is cancelled on return, and an
    // unflushed message dies with it.
    xpc_connection_send_barrier(connection) {}
  }

  /// Build a host-side XPC connection to a service port inside the simulator.
  ///
  /// The three `_4sim` entry points are private but present in libxpc; they are
  /// what lets a host process talk to a daemon living in the guest.
  private static func connect(to port: mach_port_t) -> xpc_connection_t? {
    typealias EndpointFn = @convention(c) (mach_port_t) -> xpc_endpoint_t?
    typealias FromEndpointFn = @convention(c) (xpc_endpoint_t, dispatch_queue_t?, UInt64)
      -> xpc_connection_t?
    typealias Sim2HostFn = @convention(c) (xpc_connection_t) -> Void

    guard
      let endpointSym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "xpc_endpoint_create_mach_port_4sim"),
      let fromEndpointSym = dlsym(
        UnsafeMutableRawPointer(bitPattern: -2), "xpc_connection_create_from_endpoint"),
      let sim2hostSym = dlsym(
        UnsafeMutableRawPointer(bitPattern: -2), "xpc_connection_enable_sim2host_4sim")
    else { return nil }

    guard let endpoint = unsafeBitCast(endpointSym, to: EndpointFn.self)(port) else { return nil }
    guard
      let connection = unsafeBitCast(fromEndpointSym, to: FromEndpointFn.self)(endpoint, nil, 0)
    else { return nil }
    unsafeBitCast(sim2hostSym, to: Sim2HostFn.self)(connection)
    xpc_connection_set_event_handler(connection) { _ in
      // Per-event errors are non-fatal; a failed press is reported by the
      // caller's own verification, not by tearing the helper down.
    }
    xpc_connection_resume(connection)
    return connection
  }
}

/// The Consumer-page usage for a hardware button name, or nil when the button
/// belongs on Indigo's hardware path instead.
func consumerUsage(forButtonNamed name: String) -> UInt32? {
  switch name {
  case "volume-up": return HIDUsage.volumeUp
  case "volume-down": return HIDUsage.volumeDown
  default: return nil
  }
}
