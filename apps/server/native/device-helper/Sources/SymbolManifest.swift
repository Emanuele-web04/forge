// The single source of truth for every private symbol the helper resolves at
// runtime.
//
// Nothing here is linked at build time: classes come from `NSClassFromString`,
// protocols from `NSProtocolFromString`, and the Indigo HID entry points from
// `dlsym`. That makes the helper relocatable across Xcode installs, but it also
// means a symbol Apple renamed fails at the point of use, deep inside a capture
// or an input event, with no indication of which name went missing.
//
// Collecting the strings here instead lets `--probe` walk the table and name the
// exact symbol and the Xcode build it is missing from, so a broken capability
// reports "AXPTranslator missing on Xcode 26.4" rather than a dead pane.
//
// When adding a runtime lookup anywhere in the helper, add it here too and use
// the constant. The probe is only as honest as this table is complete.

import Foundation

/// The helper capability a symbol belongs to. A missing symbol degrades exactly
/// one capability; the rest keep working.
enum HelperCapability: String, CaseIterable {
  /// Reading the device framebuffer (CoreSimulator display + IOSurface).
  case framebuffer
  /// Injecting touch, key and button events (SimulatorKit Indigo HID).
  case hid
  /// Reading the accessibility tree (AXPTranslator).
  case accessibility
  /// Hardware H.264 encoding (VideoToolbox).
  case encoder
}

/// How a symbol is resolved, which determines how the probe checks for it.
enum SymbolKind {
  /// An Objective-C class, via `NSClassFromString`.
  case objcClass
  /// An Objective-C protocol, via `NSProtocolFromString`.
  case objcProtocol
  /// A C function in SimulatorKit, via `dlsym`.
  case simulatorKitFunction
  /// A selector that must exist on a resolved class.
  case selector(onClass: String)
  /// A selector declared by a protocol. The concrete display classes are
  /// ROCK proxies generated per boot, so there is no class to check it on;
  /// the protocol's own method list is the stable thing to verify.
  case protocolSelector(onProtocol: String)
}

struct RuntimeSymbol {
  let name: String
  let kind: SymbolKind
  let capability: HelperCapability
  /// Why the helper needs it, surfaced in diagnostics.
  let purpose: String
}

/// Every runtime-resolved symbol, grouped by the capability it supports.
///
/// Selectors are deliberately sparse: only the ones whose absence is silent and
/// fatal are listed. A selector the helper already guards with
/// `respondsToSelector:` degrades on its own and does not need to fail a probe.
enum SymbolManifest {
  static let all: [RuntimeSymbol] = [
    // ── Framebuffer ──────────────────────────────────────────────────
    RuntimeSymbol(
      name: "SimServiceContext", kind: .objcClass, capability: .framebuffer,
      purpose: "entry point to CoreSimulator"),
    RuntimeSymbol(
      name: "sharedServiceContextForDeveloperDir:error:",
      kind: .selector(onClass: "SimServiceContext"), capability: .framebuffer,
      purpose: "opens the service context for the active Xcode"),
    RuntimeSymbol(
      name: "SimDevice", kind: .objcClass, capability: .framebuffer,
      purpose: "a simulator device"),
    RuntimeSymbol(
      name: "SimDisplayIOSurfaceRenderable", kind: .objcProtocol, capability: .framebuffer,
      purpose: "identifies the display port that exposes a framebuffer"),
    RuntimeSymbol(
      name: "framebufferSurface",
      kind: .protocolSelector(onProtocol: "SimDisplayIOSurfaceRenderable"),
      capability: .framebuffer, purpose: "reads the current framebuffer IOSurface"),
    RuntimeSymbol(
      name: "registerCallbackWithUUID:damageRectanglesCallback:",
      kind: .protocolSelector(onProtocol: "SimDisplayRenderable"),
      capability: .framebuffer, purpose: "delivers the display updates that drive the stream"),

    // ── HID ──────────────────────────────────────────────────────────
    RuntimeSymbol(
      name: "lastBootedAt", kind: .selector(onClass: "SimDevice"), capability: .hid,
      purpose: "per-boot identity; detects an externally rebooted simulator whose "
        + "HID client would otherwise swallow input silently"),
    RuntimeSymbol(
      name: "IndigoHIDMessageForButton", kind: .simulatorKitFunction, capability: .hid,
      purpose: "builds hardware button events"),
    RuntimeSymbol(
      name: "IndigoHIDMessageForKeyboardArbitrary", kind: .simulatorKitFunction, capability: .hid,
      purpose: "builds key events from USB HID usage codes"),
    RuntimeSymbol(
      name: "IndigoHIDMessageForMouseNSEvent", kind: .simulatorKitFunction, capability: .hid,
      purpose: "seeds the touch event the helper rewrites into a digitizer message"),

    // ── Accessibility ────────────────────────────────────────────────
    RuntimeSymbol(
      name: "AXPTranslator", kind: .objcClass, capability: .accessibility,
      purpose: "translates the guest accessibility tree to host elements"),
    RuntimeSymbol(
      name: "frontmostApplicationWithDisplayId:bridgeDelegateToken:",
      kind: .selector(onClass: "AXPTranslator"), capability: .accessibility,
      purpose: "resolves the frontmost application's root element"),
    RuntimeSymbol(
      name: "macPlatformElementFromTranslation:", kind: .selector(onClass: "AXPTranslator"),
      capability: .accessibility, purpose: "converts a translation into a readable element"),
    RuntimeSymbol(
      name: "AXPTranslatorResponse", kind: .objcClass, capability: .accessibility,
      purpose: "carries accessibility responses; `empty` unblocks a timed-out read"),
    RuntimeSymbol(
      name: "sendAccessibilityRequestAsync:completionQueue:completionHandler:",
      kind: .selector(onClass: "SimDevice"), capability: .accessibility,
      purpose: "the CoreSimulator transport for accessibility requests"),
  ]

  static func symbols(for capability: HelperCapability) -> [RuntimeSymbol] {
    all.filter { $0.capability == capability }
  }
}

/// The name of a symbol the probe could not resolve.
struct MissingSymbol {
  let name: String
  let purpose: String
}

/// The outcome of probing one capability.
struct CapabilityReport {
  let capability: HelperCapability
  let missing: [MissingSymbol]
  /// Set when the capability failed for a reason other than a missing symbol
  /// (a framework that would not load, a session that would not start).
  let failure: String?

  var ok: Bool { missing.isEmpty && failure == nil }

  var json: Any {
    if ok { return "ok" }
    var payload: [String: Any] = [:]
    if let first = missing.first {
      // `missingSymbol` names one symbol so a caller can render a short
      // sentence; `missingSymbols` carries the rest for diagnostics.
      payload["missingSymbol"] = first.name
      payload["purpose"] = first.purpose
    }
    if missing.count > 1 {
      payload["missingSymbols"] = missing.map(\.name)
    }
    if let failure {
      payload["error"] = failure
    }
    return payload
  }
}
