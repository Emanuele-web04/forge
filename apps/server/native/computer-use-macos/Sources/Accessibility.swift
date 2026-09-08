// Accessibility perception and semantic actuation.
//
// AX is the macOS analog of AT-SPI on the Linux side: the structure source the
// agent reads to decide what to do, and the path for a few semantic writes
// (`set-value`, `perform-action`) where a physical click is the wrong tool.
// Physical clicks/typing/scrolling still go through synthetic input — the
// reference's "prefer simulating physical clicks over Accessibility actions" —
// so this file is only structure plus the two semantic writes.
//
// Every AX element reports its frame in global top-left points already, so a
// node's coordinates flow straight to the pointer path with no conversion. The
// node path is the child-index route from the window root, which lets the Node
// backend re-address a control on a fresh read without holding a live handle.
//
// The walk is bounded on every axis, because AX is synchronous IPC into other
// processes and a single unresponsive app would otherwise stall the agent's
// whole perception step (reference §4.3):
//
//   * `AXUIElementSetMessagingTimeout` — 1 s per application, 0.35 s per window.
//   * One IPC per node: role, title, description, value, position, size, and
//     children come back from a single `AXUIElementCopyMultipleAttributeValues`
//     instead of seven round trips.
//   * `AXUIElementIsAttributeSettable` — the extra IPC that answers "is this
//     editable" — only for roles that can plausibly hold a value.
//   * 2048 nodes per window (the AT-SPI helper's limit) marked in band with
//     `"truncated": true` on the window node, and ~6000 for the whole desktop.
//   * Subtrees whose frame lies entirely outside their window are skipped
//     (off-screen scroll content), while zero-size containers are still
//     descended — a layout wrapper with no frame routinely holds real controls.
//   * Skipped children keep their sibling index, so `nodePath` stays the real
//     child-index route and `set-value`/`perform-action` re-resolve correctly.

import AppKit
import ApplicationServices
import CoreGraphics
import Dispatch
import Foundation

enum Accessibility {
  /// Per-window and whole-desktop node caps. The window cap matches the Linux
  /// AT-SPI helper so both platforms truncate a runaway tree at the same size.
  private static let maxNodesPerWindow = 2048
  private static let maxNodesPerDesktop = 6000
  private static let applicationMessagingTimeout: Float = 1.0
  private static let windowMessagingTimeout: Float = 0.35

  /// Attributes fetched for every node in one IPC, in this order.
  private static let nodeAttributes =
    [
      kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
      kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
    ] as CFArray

  /// Roles whose value is worth an `AXUIElementIsAttributeSettable` round trip.
  /// Asking every group and static text doubles the IPC count of a walk to learn
  /// "no" each time.
  private static let valueBearingRoles: Set<String> = [
    kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, kAXSliderRole, kAXIncrementorRole,
    kAXCheckBoxRole, kAXRadioButtonRole, kAXPopUpButtonRole, kAXMenuItemRole,
    "AXSearchField", "AXSecureTextField", "AXStepper",
  ]

  /// Whether this process is a trusted Accessibility client right now.
  static func isTrusted() -> Bool {
    AXIsProcessTrusted()
  }

  /// The desktop AX forest: one child per on-screen window, already in global
  /// coordinates. `windowIds`, when given, restricts the walk to those windows —
  /// the cheap read when the agent is working inside one app.
  static func describeDesktop(maxDepth: Int, windowIds: Set<CGWindowID>?) throws -> [String: Any] {
    guard isTrusted() else {
      throw RPCError(.permissionDenied, "Accessibility is not granted to this app")
    }
    let maxDepth = min(64, max(0, maxDepth))
    let windows = Windows.list().filter { window in
      // A window WindowServer is not compositing — minimized, or on another
      // Space — has no useful geometry for the agent to act on, and walking it
      // costs the same as a visible one.
      // Explicit window targeting includes covered/other-Space windows. A full
      // desktop walk still visits only on-screen windows to bound its cost.
      if let windowIds { return windowIds.contains(window.windowNumber) }
      return window.onScreen
    }

    // Reuse each app's window list. Only an explicitly targeted app opts into
    // manual accessibility; background inventory must not reconfigure apps.
    var applications: [pid_t: Application] = [:]

    var children: [[String: Any]] = []
    var remaining = maxNodesPerDesktop
    var textBytesRemaining = 128 * 1024
    let deadline = Date().addingTimeInterval(3)
    var truncated = false
    var failedWindows: [String] = []
    var menuApps = Set<pid_t>()
    for window in windows {
      if remaining <= 0 || Date() >= deadline { truncated = true; break }
      if !window.onScreen {
        failedWindows.append(String(window.windowNumber))
        continue
      }
      let application: Application
      if let existing = applications[window.ownerPID] {
        application = existing
      } else {
        application = Application(pid: window.ownerPID, requestAccessibility: windowIds != nil || window.ownerPID == SkyLight.frontmostPID())
        applications[window.ownerPID] = application
      }
      var budget = Budget(remaining: min(maxNodesPerWindow, remaining), deadline: deadline, textBytesRemaining: textBytesRemaining)
      if windowIds != nil || window.ownerPID == SkyLight.frontmostPID(), menuApps.insert(window.ownerPID).inserted {
        for (attribute, root) in [(kAXMenuBarAttribute, "menu-bar"), ("AXExtrasMenuBar", "menu-bar-extra")] {
          if let menu = elementAttribute(application.element, attribute),
            let menuNode = node(from: menu, windowId: window.windowNumber,
              windowBounds: Geometry.workspaceRect(), depth: 0, maxDepth: maxDepth,
              path: [], budget: &budget, accessibilityRoot: root) {
            children.append(menuNode)
          }
        }
      }
      if let axWindow = application.match(window) {
        AXUIElementSetMessagingTimeout(axWindow, windowMessagingTimeout)
        if var windowNode = node(from: axWindow, windowId: window.windowNumber,
          windowBounds: window.bounds, depth: 0, maxDepth: maxDepth, path: [], budget: &budget) {
          if budget.truncated { windowNode["truncated"] = true }
          children.append(windowNode)
        }
      } else {
        failedWindows.append(String(window.windowNumber))
      }
      textBytesRemaining = budget.textBytesRemaining
      remaining -= budget.used
      truncated = truncated || budget.truncated
    }

    let workspace = Geometry.workspaceRect()
    return [
      "root": [
        "role": "desktop",
        "truncated": truncated || !failedWindows.isEmpty,
        "unavailableWindowIds": failedWindows,
        "label": NSNull(),
        "value": NSNull(),
        "description": "macOS desktop",
        "frame": Geometry.rectDictionary(workspace),
        "onScreen": true,
        "children": children,
      ]
    ]
  }

  /// Resolve `windowId` + `nodePath` to a live element and set its value.
  static func setValue(windowId: CGWindowID, path: [Int], value: String, accessibilityRoot: String = "window", expectedRole: String? = nil, expectedLabel: String? = nil) throws -> Verification {
    try Windows.requireInputSpace(windowId)
    let element = try resolve(windowId: windowId, path: path, accessibilityRoot: accessibilityRoot)
    try validateIdentity(element, role: expectedRole, label: expectedLabel)
    try InputCancellation.check()
    try Windows.requireInputSpace(windowId)
    let status = AXUIElementSetAttributeValue(
      element, kAXValueAttribute as CFString, value as CFTypeRef)
    guard status == .success else {
      throw RPCError(.notDelivered, "the control refused a value write (AX error \(status.rawValue))")
    }
    // A successful AX write is not proof that the application accepted the
    // value. Read this same element, never the field that happens to be focused.
    // Web renderers can expose an AX mirror without updating their form state.
    guard let actual = stringAttribute(element, kAXValueAttribute) else { return .unverifiable }
    if actual != value { return .unconfirmed }
    return valueContext(element) == .native ? .confirmed : .unverifiable
  }

  /// Resolve `windowId` + `nodePath` to a live element and perform an action.
  static func performAction(windowId: CGWindowID, path: [Int], action: String, accessibilityRoot: String = "window", expectedRole: String? = nil, expectedLabel: String? = nil) throws {
    try Windows.requireInputSpace(windowId)
    let element = try resolve(windowId: windowId, path: path, accessibilityRoot: accessibilityRoot)
    try validateIdentity(element, role: expectedRole, label: expectedLabel)
    let axAction = mapAction(action)
    try InputCancellation.check()
    try Windows.requireInputSpace(windowId)
    let status = AXUIElementPerformAction(element, axAction as CFString)
    guard status == .success else {
      throw RPCError(
        .notDelivered, "the control refused action \(action) (AX error \(status.rawValue))")
    }
  }

  /// `AXRaise` on the matching AX window: raises it within its application
  /// without activating that application, which is the difference between
  /// bringing a window forward and stealing the human's focus. Returns whether
  /// the action was accepted; the caller still verifies the stacking.
  static func raise(_ window: DesktopWindow) -> Bool {
    guard isTrusted() else { return false }
    let application = Application(pid: window.ownerPID, requestAccessibility: false)
    guard let axWindow = application.match(window) else { return false }
    return AXUIElementPerformAction(axWindow, kAXRaiseAction as CFString) == .success
  }

  /// The outcome of the accessibility typing rung.
  enum TextInsertion {
    /// The focused element accepted the text. The verification is `confirmed`
    /// only when the element's value could be read back before and after and
    /// gained the text — never for web content, whose accessibility value is a
    /// renderer-side mirror the ledger treats as untrusted.
    case inserted(Verification)
    /// No focused text element in that app: this rung does not apply.
    case notApplicable
    /// The element exists but refused the write; the caller falls through.
    case refused(String)
  }

  /// Bundle ids of terminal emulators. An `AXSelectedText` write into a terminal
  /// view lands in the accessibility mirror and never reaches the pty, so the
  /// typing ladder must skip this rung for them.
  private static let terminalBundleIDs: Set<String> = [
    "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "io.alacritty", "co.zeit.hyper",
    "com.github.wez.wezterm",
  ]

  private static let textRoles: Set<String> = [
    kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole, "AXSearchField", "AXSecureTextField",
  ]

  /// Insert `text` at the caret of the focused text element in `window`'s
  /// application by writing `AXSelectedText`: an atomic, background-safe write
  /// that native controls and web views both implement. Applies only when the
  /// app's focused element is a text control (or lives inside a web area) and
  /// the app is not a terminal.
  static func insertText(_ text: String, into window: DesktopWindow) -> TextInsertion {
    guard (try? Windows.requireInputSpace(window.windowNumber, ownerPID: window.ownerPID)) != nil else { return .refused("target left current Space") }
    guard isTrusted() else { return .notApplicable }
    if let bundle = NSRunningApplication(processIdentifier: window.ownerPID)?.bundleIdentifier,
      terminalBundleIDs.contains(bundle)
    {
      return .notApplicable
    }
    let application = Application(pid: window.ownerPID, requestAccessibility: false)
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return .notApplicable }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    guard windowID(of: focused) == window.windowNumber else { return .notApplicable }
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    let valueBefore = stringAttribute(focused, kAXValueAttribute)
    let role = stringAttribute(focused, kAXRoleAttribute) ?? ""
    let inWebArea = valueContext(focused) == .web
    // Browser address bars expose writable AX text but that write may update
    // only the accessibility mirror, leaving Enter pointed at the old URL.
    // Keep atomic insertion for native multiline editors; use real keystrokes
    // for single-line controls, including browser chrome.
    guard role == "AXTextArea", !inWebArea else { return .notApplicable }
    guard isSettable(focused, kAXSelectedTextAttribute) else { return .notApplicable }
    guard (try? InputCancellation.check()) != nil else { return .refused("cancelled") }
    guard (try? Windows.requireInputSpace(window.windowNumber, ownerPID: window.ownerPID)) != nil else { return .refused("target left current Space") }
    let status = AXUIElementSetAttributeValue(
      focused, kAXSelectedTextAttribute as CFString, text as CFTypeRef)
    guard status == .success else {
      return .refused("AX error \(status.rawValue)")
    }
    // Web content is deliberately never accepted here, even though the write
    // above reports success. A Chromium/Electron accessibility value is a
    // renderer-side mirror: setting it satisfies AX without the page ever
    // seeing an input event, so this rung used to report `inserted` for a form
    // field that stayed empty — and because the ladder returns on any
    // `inserted`, the reliable rungs below never ran. An unverifiable rung is
    // worse than no rung, so it declines and lets keystrokes do the work.
    if inWebArea { return .refused("accessibility writes into web content cannot be verified") }
    // Compared against the value read before the write, the same rule the
    // keystroke rungs follow. Asking only whether the value *contains* the text
    // reported a confirmed insert for a field that already held that string —
    // and for an empty insert, which every string contains — so the write could
    // never be judged to have failed.
    guard !text.isEmpty, let valueBefore,
      let valueAfter = stringAttribute(focused, kAXValueAttribute)
    else { return .inserted(.unverifiable) }
    return .inserted(valueAfter != valueBefore && valueAfter.contains(text) ? .confirmed : .unconfirmed)
  }

  /// The target's focused element's current value, or nil when there is none to
  /// read. Callers compare before and after a keystroke rung to tell a delivery
  /// that landed from one that did not. Web content exposes no usable value, so
  /// nil there means unproven rather than failed.
  ///
  /// The distinction is load-bearing, which is why the missing-value case
  /// returns nil rather than the empty string it used to. An element with no
  /// readable `AXValue` read back as `""` both before and after the keystrokes,
  /// which is indistinguishable from a field that stayed empty — so the ladder
  /// concluded "not delivered", climbed to the visible rung, and typed the whole
  /// string a second time.
  static func focusedValue(in window: DesktopWindow) -> String? {
    guard isTrusted() else { return nil }
    let application = Application(pid: window.ownerPID, requestAccessibility: false)
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    return stringAttribute(focused, kAXValueAttribute)
  }

  // There is deliberately no "is this web content?" probe here any more. Two of
  // them existed only to route web content to the visible input rung, and that
  // rule is gone: Chromium does not drop pid-posted input because it is web
  // content, it drops input aimed at a window that is not key, which SkyLight's
  // `makeKeyWindow` now fixes for every toolkit at once. Re-adding one would put
  // a synchronous accessibility round trip back on the path of every gesture.

  /// One gesture's accessibility probe: a single application handle, a tight
  /// messaging timeout, and a wall-clock budget.
  ///
  /// The click path used to build three separate `Application` handles and make
  /// roughly ten AX round trips per background click, each one entitled to the
  /// full one-second application timeout — on the *input* lane, which is serial,
  /// so one hung application wedged every subsequent click and keystroke behind
  /// it. This is the same measurement in one handle, with the per-window
  /// timeout, and a deadline after which the probe stops asking and reports
  /// that it could not tell rather than paying again.
  final class GestureProbe {
    private let application: Application
    private var deadline: DispatchTime

    init?(window: DesktopWindow, budgetSeconds: Double) {
      guard isTrusted() else { return nil }
      self.deadline = .now() + budgetSeconds
      // The watch is an optimisation, not a delivery step: it may never cost
      // more than a fraction of a gesture, so it takes the per-window timeout
      // rather than the per-application one.
      self.application = Application(
        pid: window.ownerPID, requestAccessibility: false,
        messagingTimeout: windowMessagingTimeout)
    }

    /// Whether the probe has already spent its budget. Every read checks this
    /// first, so a hung application costs the budget once and never again.
    var expired: Bool { DispatchTime.now() > deadline }

    /// Give the probe a fresh budget for a second look — after an escalated
    /// replay, which is a new question about the same expectation.
    func renew(budgetSeconds: Double) {
      deadline = .now() + budgetSeconds
    }

    /// The element under a screen point, and whether it is something a click
    /// would be expected to focus — which is what entitles the watch to draw a
    /// conclusion at all.
    ///
    /// Only an element that can actually *take* focus gives it an expectation to
    /// test; a click on a label, a background, or a static image legitimately
    /// moves nothing. Merely exposing `AXFocused` is not that test, and reading
    /// it as one was a false-negative machine: Chromium publishes the attribute
    /// on every node in a page, so a click on a plain `<div>` armed the probe
    /// with that div, blurred the focused field to the document body, and the
    /// mismatch was scored as a click that never arrived — which then condemned
    /// the whole browser to the visible rung for the rest of the session.
    /// Settability is the question that was meant, and it is one call not two.
    ///
    /// `focused` is the signature of whatever the application considered focused
    /// *before* the gesture. The watch needs both: a click that moves focus to
    /// the expected element landed, a click that leaves focus exactly where it
    /// was did not, and a click that moved focus somewhere neither predicted nor
    /// previous plainly did *something* and must not be replayed.
    func expectation(at point: CGPoint) -> (element: String, focused: String, alreadyFocused: Bool)?
    {
      guard !expired else { return nil }
      var raw: AXUIElement?
      guard
        AXUIElementCopyElementAtPosition(
          application.element, Float(point.x), Float(point.y), &raw) == .success,
        let hit = raw, !expired
      else { return nil }
      AXUIElementSetMessagingTimeout(hit, windowMessagingTimeout)
      var settable: DarwinBoolean = false
      guard
        AXUIElementIsAttributeSettable(hit, kAXFocusedAttribute as CFString, &settable) == .success,
        settable.boolValue
      else { return nil }
      guard let hitSignature = signature(of: hit, isExpired: { self.expired }),
        let focused = focusedSignature()
      else { return nil }
      return (hitSignature, focused, hitSignature == focused)
    }

    /// Whatever the application currently considers focused, or nil when it
    /// exposes nothing — or when the budget is gone, which is the same answer:
    /// no evidence either way.
    func focusedSignature() -> String? {
      guard !expired else { return nil }
      var raw: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(
          application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
        let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
      else { return nil }
      // swiftlint:disable:next force_cast
      let focused = value as! AXUIElement
      AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
      return signature(of: focused, isExpired: { self.expired })
    }

  }

  /// A cheap identity for one element: role, title, value, frame.
  ///
  /// `isExpired` is consulted between the reads, not just before them. Each one
  /// is synchronous IPC that can block for the messaging timeout, so a probe
  /// with a wall-clock budget has to be able to give up part way through an
  /// unresponsive application rather than paying four more timeouts to finish a
  /// signature nobody will use.
  fileprivate static func signature(of element: AXUIElement, isExpired: () -> Bool = { false })
    -> String?
  {
    if isExpired() { return nil }
    let role = stringAttribute(element, kAXRoleAttribute) ?? ""
    if isExpired() { return nil }
    let title = stringAttribute(element, kAXTitleAttribute) ?? ""
    if isExpired() { return nil }
    let text = stringAttribute(element, kAXValueAttribute) ?? ""
    if isExpired() { return nil }
    let box = frame(of: element).map { "\($0.origin.x),\($0.origin.y),\($0.width),\($0.height)" }
      ?? ""
    return "\(role)|\(title)|\(text)|\(box)"
  }

  /// A cheap identity for whatever the app currently considers focused: role
  /// plus title plus value plus frame. Compared before and after a gesture to
  /// tell a click that landed from one that went nowhere. Nil when the app
  /// exposes no focused element, which is not evidence either way.
  static func focusedElementSignature(in window: DesktopWindow) -> String? {
    guard isTrusted() else { return nil }
    let application = Application(pid: window.ownerPID, requestAccessibility: false)
    var raw: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        application.element, kAXFocusedUIElementAttribute as CFString, &raw) == .success,
      let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    // swiftlint:disable:next force_cast
    let focused = value as! AXUIElement
    AXUIElementSetMessagingTimeout(focused, windowMessagingTimeout)
    return signature(of: focused)
  }

  private enum ValueContext { case native, web, unknown }

  /// Exhausting the bounded walk or losing AX access cannot prove a field is
  /// native. In particular, deeply nested web fields must not become confirmed.
  private static func valueContext(_ element: AXUIElement) -> ValueContext {
    var current = element
    for _ in 0..<12 {
      var raw: CFTypeRef?
      guard
        AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &raw) == .success,
        let value = raw, CFGetTypeID(value) == AXUIElementGetTypeID()
      else { return .unknown }
      // swiftlint:disable:next force_cast
      current = value as! AXUIElement
      guard let role = stringAttribute(current, kAXRoleAttribute) else { return .unknown }
      if role == "AXWebArea" { return .web }
      if role == "AXWindow" || role == "AXApplication" { return .native }
    }
    return .unknown
  }

  static func keyboardWindowMatches(_ window: DesktopWindow) -> Bool {
    let application = AXUIElementCreateApplication(window.ownerPID)
    AXUIElementSetMessagingTimeout(application, windowMessagingTimeout)
    guard let focused = elementAttribute(application, kAXFocusedWindowAttribute) else { return false }
    if let number = windowID(of: focused) { return number == window.windowNumber }
    guard let ownWindow = matchWindow(attributeElements(application, kAXWindowsAttribute), to: window) else { return false }
    return CFEqual(focused, ownWindow)
  }

  static func focusWindowForKeyboard(_ window: DesktopWindow) throws {
    if SkyLight.frontmostPID() == window.ownerPID && !keyboardWindowMatches(window) {
      throw RPCError(.notDelivered, "Refusing to change the user's active window")
    }
    try Windows.requireInputSpace(window.windowNumber, ownerPID: window.ownerPID)
    // AXFocused/AXFocusedWindow writes can switch macOS Spaces even without an
    // application activation notification. Focus.begin handles guarded key records.
  }

  /// Which of `candidates` the owning application says are actually minimized.
  ///
  /// `list-windows` used to answer this with `!onScreen`, which is a different
  /// question: WindowServer stops compositing a window when it is minimized
  /// **and** when it is on another Space, so on an ordinary multi-Space desktop
  /// most windows were reported minimized — and an agent told a window is
  /// minimized stops trying to use it. `kAXMinimizedAttribute` is the app's own
  /// answer and the only honest one.
  ///
  /// Only ever asked about windows that are already off screen: an on-screen
  /// window is by construction not minimized, so the common desktop costs
  /// nothing. One `Application` handle per owning pid, the per-window messaging
  /// timeout, and a wall-clock budget, because this runs inside a `list-windows`
  /// that the pane polls.
  ///
  /// A window whose app cannot be asked — accessibility not granted, no matching
  /// AX window, the budget spent — is reported **not** minimized. That is the
  /// safe direction: a real minimized window described as ordinary costs one
  /// failed capture that says so, while an ordinary window described as
  /// minimized is one the agent will not touch at all.
  static func minimizedWindowIDs(among candidates: [DesktopWindow], budgetSeconds: Double = 0.75)
    -> Set<CGWindowID>
  {
    guard isTrusted(), !candidates.isEmpty else { return [] }
    minimizedLock.lock()
    defer { minimizedLock.unlock() }
    let now = DispatchTime.now().uptimeNanoseconds
    let keys = Set(candidates.map { "\($0.ownerPID):\($0.windowNumber)" })
    minimizedCache = minimizedCache.filter { keys.contains($0.key) && now &- $0.value.at < 1_000_000_000 }
    let deadline = DispatchTime.now() + budgetSeconds
    var applications: [pid_t: Application] = [:]
    var minimized: Set<CGWindowID> = []
    for window in candidates {
      let key = "\(window.ownerPID):\(window.windowNumber)"
      if let cached = minimizedCache[key] {
        if cached.minimized { minimized.insert(window.windowNumber) }
        continue
      }
      guard DispatchTime.now() < deadline else { break }
      let application =
        applications[window.ownerPID]
        ?? Application(
          pid: window.ownerPID, requestAccessibility: false,
          messagingTimeout: windowMessagingTimeout)
      applications[window.ownerPID] = application
      minimizedCache[key] = (now, false)
      guard let axWindow = application.match(window) else { continue }
      let isMinimized = boolAttribute(axWindow, kAXMinimizedAttribute) == true
      minimizedCache[key] = (now, isMinimized)
      if isMinimized {
        minimized.insert(window.windowNumber)
      }
    }
    return minimized
  }

  private static let minimizedLock = NSLock()
  private static var minimizedCache: [String: (at: UInt64, minimized: Bool)] = [:]

  // MARK: - Application handle

  /// One application element and one lazily loaded window list per request.
  private final class Application {
    let element: AXUIElement
    private var windows: [AXUIElement]?

    init(pid: pid_t, requestAccessibility: Bool = true, messagingTimeout: Float? = nil) {
      element = AXUIElementCreateApplication(pid)
      AXUIElementSetMessagingTimeout(element, messagingTimeout ?? applicationMessagingTimeout)
      if requestAccessibility {
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
      }
    }

    /// The app's windows, fetched once however many desktop windows it owns.
    func match(_ window: DesktopWindow) -> AXUIElement? {
      let candidates = windows ?? attributeElements(element, kAXWindowsAttribute)
      windows = candidates
      return matchWindow(candidates, to: window)
    }

  }

  // MARK: - Walk

  /// Node accounting for one window: how many more nodes may be emitted, and
  /// whether the cap actually cut the tree short.
  private struct Budget {
    var remaining: Int
    let deadline: Date
    var used = 0
    var truncated = false
    var textBytesRemaining = 128 * 1024
  }

  private struct Snapshot {
    var role = "AXUnknown"
    var title: String?
    var detail: String?
    var value: String?
    var frame: CGRect?
    var children: [AXUIElement] = []
    var textTruncated = false
  }

  private static func node(
    from element: AXUIElement,
    windowId: CGWindowID,
    windowBounds: CGRect,
    depth: Int,
    maxDepth: Int,
    path: [Int],
    budget: inout Budget,
    accessibilityRoot: String = "window"
  ) -> [String: Any]? {
    // Belt and braces: every caller checks the budget before descending — that
    // is where truncation is *recorded*, because only the caller knows whether
    // a node was actually left unemitted. Marking the tree truncated here as
    // well claimed a cut whenever the budget merely ran out exactly.
    guard budget.remaining > 0, Date() < budget.deadline else { budget.truncated = true; return nil }
    var snapshot = read(element)
    snapshot.title = boundedText(snapshot.title, budget: &budget, truncated: &snapshot.textTruncated)
    snapshot.detail = boundedText(snapshot.detail, budget: &budget, truncated: &snapshot.textTruncated)
    snapshot.value = boundedText(snapshot.value, budget: &budget, truncated: &snapshot.textTruncated)
    let frame = snapshot.frame ?? .zero
    // Off-screen scroll content: a real frame that misses the window entirely is
    // not something the agent can act on, and those subtrees are where the node
    // count explodes. A zero-size node is a layout container, not a position, so
    // it is still descended.
    let offscreen = depth > 0 && frame.width > 0 && frame.height > 0 && !frame.intersects(windowBounds)
    // Keep a shallow address for known fields so AXScrollToVisible can reveal
    // them. Do not walk off-screen subtrees or spend the visible-node budget on
    // their layout containers.
    if offscreen && !valueBearingRoles.contains(snapshot.role) {
      return nil
    }
    budget.remaining -= 1
    budget.used += 1

    var children: [[String: Any]] = []
    if !offscreen && depth < maxDepth {
      for (index, child) in snapshot.children.enumerated() {
        // The cap cut this window's tree short exactly when a child still
        // existed and there was no budget left to emit it.
        guard budget.remaining > 0, Date() < budget.deadline else {
          budget.truncated = true
          break
        }
        // The child's index is its real position among its siblings even when a
        // sibling was skipped, so `nodePath` stays a valid re-resolve route.
        if let childNode = node(
          from: child,
          windowId: windowId,
          windowBounds: windowBounds,
          depth: depth + 1,
          maxDepth: maxDepth,
          path: path + [index],
          budget: &budget, accessibilityRoot: accessibilityRoot)
        {
          children.append(childNode)
        }
      }
    } else if !offscreen && !snapshot.children.isEmpty {
      budget.truncated = true
    }

    var payload: [String: Any] = [
      "role": snapshot.role,
      "label": (snapshot.title ?? snapshot.detail) as Any? ?? NSNull(),
      "value": snapshot.value as Any? ?? NSNull(),
      "description": (snapshot.title == nil ? nil : snapshot.detail) as Any? ?? NSNull(),
      "frame": Geometry.rectDictionary(frame),
      "activationPoint": [
        "x": Double(frame.midX),
        "y": Double(frame.midY),
      ],
      "onScreen": !offscreen,
      "windowId": String(windowId),
      "editable": valueBearingRoles.contains(snapshot.role)
        && isSettable(element, kAXValueAttribute),
      "children": children,
    ]
    // The window root is addressed by its window id alone; every node below it
    // carries the absolute child-index route from that root.
    if depth > 0 || accessibilityRoot != "window" { payload["nodePath"] = path }
    if snapshot.textTruncated { payload["truncated"] = true; budget.truncated = true }
    payload["accessibilityRoot"] = accessibilityRoot
    return payload
  }

  /// Bound UTF-8 output before JSON encoding. AX itself may still allocate the
  /// full value, but it never crosses the helper pipe or accumulates in the tree.
  private static func boundedText(_ value: String?, budget: inout Budget, truncated: inout Bool) -> String? {
    guard let value else { return nil }
    let limit = min(16 * 1024, budget.textBytesRemaining)
    let prefix = Array(value.utf8.prefix(limit + 1))
    if prefix.count <= limit {
      budget.textBytesRemaining -= prefix.count
      return value
    }
    truncated = true
    var bytes = Array(prefix.prefix(max(0, limit - 3)))
    while !bytes.isEmpty && String(bytes: bytes, encoding: .utf8) == nil { bytes.removeLast() }
    let result = (String(bytes: bytes, encoding: .utf8) ?? "") + (limit >= 3 ? "…" : "")
    budget.textBytesRemaining -= result.utf8.count
    return result
  }

  /// Every attribute this walk needs, in one IPC round trip.
  private static func read(_ element: AXUIElement) -> Snapshot {
    var snapshot = Snapshot()
    var raw: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, nodeAttributes, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
      let values = raw as? [Any], values.count == 7
    else { return snapshot }
    if let role = string(values[0]) { snapshot.role = role }
    snapshot.title = string(values[1])
    snapshot.detail = string(values[2])
    snapshot.value = string(values[3])
    if let origin = axPoint(values[4]), let size = axSize(values[5]) {
      snapshot.frame = CGRect(origin: origin, size: size)
    }
    snapshot.children = values[6] as? [AXUIElement] ?? []
    return snapshot
  }

  // MARK: - Internals

  /// A child-index path can resolve to a different control after a rerender.
  /// Refuse before delivery when its observed identity no longer matches.
  private static func validateIdentity(_ element: AXUIElement, role: String?, label: String?) throws {
    AXUIElementSetMessagingTimeout(element, windowMessagingTimeout)
    if let role, stringAttribute(element, kAXRoleAttribute) != role {
      throw RPCError(.targetChanged, "The target control changed. Read the window state again.")
    }
    if let label {
      let actual = stringAttribute(element, kAXTitleAttribute) ?? stringAttribute(element, kAXDescriptionAttribute)
      guard actual == label else {
        throw RPCError(.targetChanged, "The target label changed. Read the window state again.")
      }
    }
  }

  private static func mapAction(_ action: String) -> String {
    switch action {
    case "press", "click", "activate": return kAXPressAction
    case "increment": return kAXIncrementAction
    case "decrement": return kAXDecrementAction
    case "showMenu": return kAXShowMenuAction
    default: return action
    }
  }

  private static func resolve(windowId: CGWindowID, path: [Int], accessibilityRoot: String) throws -> AXUIElement {
    guard isTrusted() else {
      throw RPCError(.permissionDenied, "Accessibility is not granted to this app")
    }
    guard let window = Windows.window(withNumber: windowId) else {
      throw RPCError(.targetMissing, "no window has id \(windowId)")
    }
    let application = Application(pid: window.ownerPID, requestAccessibility: true)
    let root: AXUIElement?
    switch accessibilityRoot {
    case "menu-bar": root = elementAttribute(application.element, kAXMenuBarAttribute)
    case "menu-bar-extra": root = elementAttribute(application.element, "AXExtrasMenuBar")
    case "window": root = application.match(window)
    default: throw RPCError(.invalidParams, "Unknown accessibility root")
    }
    guard var current = root else {
      throw RPCError(.targetMissing, "no accessibility root matched id \(windowId)")
    }
    for index in path {
      let kids = attributeElements(current, kAXChildrenAttribute)
      guard index >= 0, index < kids.count else {
        throw RPCError(.targetMissing, "node path left the tree at index \(index)")
      }
      current = kids[index]
    }
    return current
  }

  /// `_AXUIElementGetWindow` — the private call that maps an AX window element
  /// to its `CGWindowID`. Resolved at runtime with the same posture as the
  /// SkyLight SPI: absent means fall back, never crash.
  private typealias GetWindowID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) ->
    AXError
  private static let getWindowID: GetWindowID? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow")
    else {
      logDiagnostic("_AXUIElementGetWindow is missing; AX windows match on title/frame instead")
      return nil
    }
    return unsafeBitCast(symbol, to: GetWindowID.self)
  }()

  private static func windowID(of element: AXUIElement) -> CGWindowID? {
    guard let getWindowID else { return nil }
    var identifier: CGWindowID = 0
    return getWindowID(element, &identifier) == .success ? identifier : nil
  }

  /// Pick the AX window that matches a `CGWindow`.
  ///
  /// By window id where the OS will tell us, because that is the only exact
  /// answer. Title was the first key here, and two windows of one app sharing a
  /// title — two "Untitled" TextEdit documents, two Terminal tabs named "bash" —
  /// both resolved to whichever came first: perception described one window
  /// twice, and a `set-value` addressed at the second wrote into the first.
  /// Title is still consulted, but only when it is unambiguous.
  private static func matchWindow(_ candidates: [AXUIElement], to window: DesktopWindow)
    -> AXUIElement?
  {
    if candidates.isEmpty { return nil }
    for candidate in candidates where windowID(of: candidate) == window.windowNumber {
      return candidate
    }
    if !window.title.isEmpty {
      let titled = candidates.filter {
        stringAttribute($0, kAXTitleAttribute) == window.title
      }
      // Exactly one match is an answer; several is the ambiguity that made this
      // wrong, so those fall through to the frame overlap below.
      if titled.count == 1 { return titled[0] }
    }
    // Frame overlap, and only a *real* overlap counts. This used to start at
    // `bestArea = -1`, so the first candidate with a readable frame won even
    // when it shared no pixel with the window being matched — an app whose AX
    // window list and CGWindowList disagree then had one AX window answer for
    // two CGWindows, `describe-ui` emitted the same tree twice under two ids,
    // and a `set-value` at the phantom id wrote into the other window
    // (reproduced live). No overlap is no answer.
    var best: AXUIElement?
    var bestArea: CGFloat = 0
    for candidate in candidates {
      guard let frame = frame(of: candidate) else { continue }
      let overlap = frame.intersection(window.bounds)
      guard !overlap.isNull else { continue }
      let area = overlap.width * overlap.height
      if area > bestArea {
        bestArea = area
        best = candidate
      }
    }
    return best
  }

  private static func attributeElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]
  {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
      let array = value as? [AXUIElement]
    else { return [] }
    return array
  }

  private static func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
      let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }

  private static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
    else { return nil }
    return string(value as Any)
  }

  private static func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
    else { return nil }
    return (value as? NSNumber)?.boolValue
  }

  private static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
    else { return false }
    return settable.boolValue
  }

  private static func frame(of element: AXUIElement) -> CGRect? {
    var raw: CFArray?
    guard
      AXUIElementCopyMultipleAttributeValues(
        element, [kAXPositionAttribute, kAXSizeAttribute] as CFArray,
        AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
      let values = raw as? [Any], values.count == 2,
      let origin = axPoint(values[0]), let size = axSize(values[1])
    else { return nil }
    return CGRect(origin: origin, size: size)
  }

  // MARK: - Value decoding
  //
  // A failed attribute inside a multi-value read comes back as an `AXValue` of
  // type `.axError` rather than a hole, so every decoder simply refuses
  // anything that is not the type it wants.

  private static func string(_ value: Any) -> String? {
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    return nil
  }

  private static func axValue(_ value: Any, _ type: AXValueType) -> AXValue? {
    let object = value as CFTypeRef
    guard CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
    // swiftlint:disable:next force_cast
    let axValue = object as! AXValue
    return AXValueGetType(axValue) == type ? axValue : nil
  }

  private static func axPoint(_ value: Any) -> CGPoint? {
    guard let wrapper = axValue(value, .cgPoint) else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(wrapper, .cgPoint, &point) else { return nil }
    return point
  }

  private static func axSize(_ value: Any) -> CGSize? {
    guard let wrapper = axValue(value, .cgSize) else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(wrapper, .cgSize, &size) else { return nil }
    return size
  }
}
