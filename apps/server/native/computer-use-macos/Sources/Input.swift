// Non-disruptive synthetic input.
//
// This is the whole trick, and it is the literal port of what Codex does on
// macOS (confirmed by the reverse-engineering in the design reference):
//
//   1. Build a CGEvent for the action at the global location.
//   2. Stamp its private integer fields — button (3), subtype (7=3), the target
//      pid (40), and the target window id (51, 91, 92) — plus one click-group id
//      (58) shared by every event of a gesture.
//   3. Call the private `CGEventSetWindowLocation` with window-local
//      coordinates. This one call is what delivers the event to a background
//      window; without it nothing arrives.
//   4. Post it to the *target process* with `CGEventPostToPid`, never to the HID
//      tap. WindowServer warps the real pointer only as a side effect of
//      HID-stream events, so posting to a pid keeps the human's cursor still.
//
// The real cursor is never touched: no `CGWarpMouseCursorPosition`, no HID-tap
// posting. The agent's visible cursor is the overlay in Cursor.swift, moved in
// lockstep with these posts.
//
// Every gesture keeps one window target and releases held buttons/modifiers on
// cancellation. Background input sends synthetic activation only to its target;
// the user's application is never deactivated. Unconfirmed clicks are reported,
// never replayed. Foreground keycodes require an already-active target and never
// activate another app as a delivery fallback.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Private CoreGraphics field numbers, from the reference teardowns.
private let kFieldButtonNumber = CGEventField(rawValue: 3)!
private let kFieldSubtype = CGEventField(rawValue: 7)!
private let kFieldTargetPID = CGEventField(rawValue: 40)!
private let kFieldWindowNumber = CGEventField(rawValue: 51)!
private let kFieldClickGroup = CGEventField(rawValue: 58)!
private let kFieldWindowIDLow = CGEventField(rawValue: 91)!
private let kFieldWindowIDHigh = CGEventField(rawValue: 92)!
private let kWindowEventSubtype: Int64 = 3
/// An undocumented flag bit real mouse events carry; the reference doc's
/// click-fidelity list pairs it with `NonCoalesced`.
private let kSyntheticClickFidelityFlag: UInt64 = 0x2000_0000

/// How far a keyboard or pointer action may go to reach its target.
enum DeliveryMode: String {
  /// The default: never change which application is frontmost.
  case background
  /// Physical keycodes, only if the user already has the target active.
  /// This never grants permission to activate another application.
  case foreground

  init(param: String?) throws {
    guard let param else {
      self = .background
      return
    }
    guard let mode = DeliveryMode(rawValue: param) else {
      throw RPCError(.invalidParams, "deliveryMode must be 'background' or 'foreground'")
    }
    self = mode
  }
}

/// Synthetic activation belongs only to the agent's target, never the user's app.
struct PendingFocusRestore {
  let targetPID: pid_t
}

/// How well an action's effect could actually be observed.
///
/// Three states, not two: "we watched it land", "we watched and it did not
/// land", and "there was nothing to watch". Collapsing the last two into one
/// boolean made an unverifiable action indistinguishable from a failed one, and
/// the Node side could only read the pessimistic meaning — so an agent retried
/// text that had in fact been typed. Emitted on the wire as this raw string.
enum Verification: String {
  /// A read-back observed the effect.
  case confirmed
  /// A read-back was possible and showed no change: the app did not react.
  case unconfirmed
  /// Nothing about this target could be read back, so neither claim is honest.
  case unverifiable
}

/// Which rung of the typing ladder delivered, and how well it could be checked.
struct TypeOutcome {
  let path: String
  let verified: Verification
}

/// The same report for a pointer gesture: the rung that actually ran, and what
/// the delivery watch was able to observe.
struct PointerOutcome {
  let mode: DeliveryMode
  let verified: Verification

  var path: String { mode.rawValue }
}

/// The same report for a chord.
struct KeyOutcome {
  let path: String
  let verified: Verification
}

final class InputController {
  /// The ceiling `drag` clamps `durationMs` to, matching the contract's own cap.
  /// See `drag`: past this the per-step sleep overflows `useconds_t` and the
  /// conversion traps mid-gesture.
  static let maximumDragDurationMs = 30_000

  private let source: CGEventSource?
  private let cursor: AgentCursor

  /// The window keyboard input is currently aimed at, set by the last pointer
  /// action or by `raise-window`. Re-stamped before every key so a target change
  /// mid-type cannot pull the agent's remaining keystrokes into another window
  /// (the macOS analog of the Linux keyboard re-stamp fix).
  private var keyboardTarget: DesktopWindow?
  private let targetLock = NSLock()
  private var foregroundKeyboardPID: pid_t?

  func currentKeyboardTarget() -> DesktopWindow? {
    targetLock.lock(); defer { targetLock.unlock() }
    return keyboardTarget
  }

  /// What is logically held down right now, for the unwind path. Guarded by a
  /// lock because unwind runs from the signal source on the main queue while a
  /// gesture may still be mid-flight on the input queue.
  private struct HeldButton {
    let button: CGMouseButton
    let point: CGPoint
    let target: DesktopWindow?
    let group: Int64
  }
  private let heldLock = NSLock()
  private var heldButton: HeldButton?
  private var heldModifiers: [(code: CGKeyCode, flags: CGEventFlags)] = []
  private var heldModifierTarget: DesktopWindow?
  /// The focus record pair a background gesture has posted and not yet undone.
  private var pendingFocusRestore: PendingFocusRestore?

  init(cursor: AgentCursor) {
    self.cursor = cursor
    let source = CGEventSource(stateID: .privateState)
    // Disarm the API's hostile defaults: without this every posted event freezes
    // the human's real input for 0.25s, and a synthetic mouse-down freezes their
    // mouse until the matching up.
    source?.setLocalEventsFilterDuringSuppressionState(
      [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents],
      state: .eventSuppressionStateSuppressionInterval)
    source?.setLocalEventsFilterDuringSuppressionState(
      [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents],
      state: .eventSuppressionStateRemoteMouseDrag)
    self.source = source
  }

  // MARK: - Permission

  /// Synthetic input needs the Accessibility grant. `CGEvent.post` and
  /// `CGEventPostToPid` return void and WindowServer drops the event silently
  /// when the process is not a trusted client, so without this check every
  /// method below returns the point it was asked for and the agent believes a
  /// click landed that was never delivered.
  func requireInputPermission() throws {
    try InputCancellation.check()
    if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      session["CGSSessionScreenIsLocked"] as? Bool == true {
      throw RPCError(.notDelivered, "The Mac is locked. Unlock it before continuing computer use.")
    }
    guard AXIsProcessTrusted() else {
      throw RPCError(
        .permissionDenied,
        "Accessibility is not granted to this app, so no input can be delivered")
    }
  }

  // MARK: - Pointer

  /// Deliver real window-addressed hover and move the overlay without changing
  /// keyboard aim or the human's physical pointer.
  func move(to point: CGPoint, window: CGWindowID? = nil) throws {
    try requireInputPermission()
    if let window, Windows.window(withNumber: window) == nil {
      throw RPCError(.targetMissing, "no window has id \(window)")
    }
    let target = window.flatMap { Windows.window(withNumber: $0) } ?? Windows.topmost(at: point)
    try prime(at: point, target: target, group: Self.newClickGroup())
    cursor.glide(to: point, window: target)
  }

  /// One pointer gesture of `count` clicks at `point`.
  ///
  /// `fixedClickState` pins the click state every click of the gesture carries
  /// instead of letting it count up. `double-click` wants the count (1 then 2,
  /// which is what a hand produces); `triple-click` wants 3 on all three pairs,
  /// so the target reads one triple-click rather than a caret, then a word
  /// selection, then a line selection — see the `triple-click` case in
  /// main.swift.
  ///
  /// `modifiers` are held down for the whole gesture, exactly as a hand holds
  /// Shift while it clicks: real key transitions posted to the target pid before
  /// the first event and released in reverse after the last, with their flag
  /// bits on every mouse event in between. An empty list posts the same events
  /// this method posted before the parameter existed.
  @discardableResult
  func click(
    at point: CGPoint, button: CGMouseButton = .left, count: Int = 1,
    clickState fixedClickState: Int? = nil, window: CGWindowID? = nil,
    modifiers: [(code: CGKeyCode, flags: CGEventFlags)] = []
  ) throws -> PointerOutcome {
    try requireInputPermission()
    let target = try aim(at: point, named: window, glide: false)
    // Make only the target believe it is active; never activate another app.
    let mode: DeliveryMode = .background
    let types = Self.eventTypes(for: button)
    let group = Self.newClickGroup()
    // What every mouse event of this gesture carries in its flags. Empty for a
    // plain click, and `formUnion` with the empty set changes nothing, so an
    // unmodified click is byte-for-byte the event stream it always was.
    let modifierFlags = Self.combinedFlags(modifiers)
    // Observe delivery once; an unchanged control is not permission to replay.
    var watch: DeliveryWatch?
    cursor.glide(to: point, window: target) {
      if mode == .background { watch = DeliveryWatch(target: target, point: point) }
    }
    let focus = try Focus.begin(for: target, cursor: cursor, controller: self, mode: mode)
    defer { focus.end() }
    // A throw between the down and the up would otherwise leave the target in a
    // phantom drag until the process exits — a rubber-band selection or a
    // grabbed slider the human cannot clear.
    defer { releaseHeldButton() }
    // One definition of the gesture, run under whichever focus is current. The
    // escalation below replays exactly these events rather than a second,
    // drifting copy of them.
    let postGesture = {
      // The modifiers are pressed inside the attempt rather than around both of
      // them: an escalated replay runs under a different focus arrangement, and
      // holding Command across the activation in between would leave it down
      // while the human's application came back.
      try self.withPointerModifiers(modifiers, target: target) {
        try self.prime(at: point, target: target, group: group, modifierFlags: modifierFlags)
        for index in 0..<max(1, count) {
          // Click state is stamped on the up as well as the down; a toolkit that
          // reads it only on one of the two sees a pair of single clicks instead
          // of a double click. It counts up across the gesture unless the caller
          // pinned it — see `fixedClickState`.
          let clickState = fixedClickState ?? (index + 1)
          try self.postMouse(
            types.down, at: point, button: button, target: target, group: group,
            clickState: clickState, held: true, modifierFlags: modifierFlags)
          usleep(1_000)
          try self.postMouse(
            types.up, at: point, button: button, target: target, group: group,
            clickState: clickState, held: false, modifierFlags: modifierFlags)
          // Under the system double-click interval, clear of coalescing into pair
          // N.
          if index + 1 < count { usleep(80_000) }
        }
      }
    }
    try postGesture()

    // An uncertain click must never be replayed: it may already have acted.
    let verified = watch?.observe() ?? .unverifiable
    return PointerOutcome(mode: mode, verified: verified)
  }

  @discardableResult
  func rightClick(
    at point: CGPoint, window: CGWindowID? = nil,
    modifiers: [(code: CGKeyCode, flags: CGEventFlags)] = []
  ) throws -> PointerOutcome {
    try click(at: point, button: .right, window: window, modifiers: modifiers)
  }

  /// Keep the requested delivery mode; background drags never escalate.
  @discardableResult
  func drag(
    from: CGPoint, to: CGPoint, durationMs: Int, mode: DeliveryMode, window: CGWindowID? = nil
  ) throws -> PointerOutcome {
    try requireInputPermission()
    // Clamped before anything is pressed. The contract caps `durationMs` at 30 s
    // on the Node side, but the arithmetic below feeds `useconds_t` — a 32-bit
    // unsigned — and `useconds_t(20_000_000 / 3 * 1000)` is a *trapping*
    // conversion, so a caller that reached the helper with a large duration
    // aborted the process between the mouse-down and the mouse-up: the human is
    // left with a latched button and a phantom drag, and every other in-flight
    // action dies with it. Defence in depth for the one path where a trap is
    // worse than a wrong answer.
    let duration = min(max(durationMs, 0), Self.maximumDragDurationMs)
    // Resolved once, at the mouse-down point, and reused for every dragged event
    // and the up — which is how macOS routes a real drag.
    let target = try aim(at: from, named: window)
    let group = Self.newClickGroup()
    let resolvedMode = mode
    let focus = try Focus.begin(for: target, cursor: cursor, controller: self, mode: resolvedMode)
    defer { focus.end() }
    defer { releaseHeldButton() }
    try prime(at: from, target: target, group: group)
    try postMouse(
      .leftMouseDown, at: from, button: .left, target: target, group: group, clickState: 1,
      held: true)
    // At least a few intermediate dragged events, or a drag silently degrades to
    // a click in many toolkits (reference §4.4).
    let steps = max(3, min(60, duration / 12))
    var previous = from
    for step in 1...steps {
      let t = CGFloat(step) / CGFloat(steps)
      let point = CGPoint(
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t)
      cursor.move(to: point)
      try postMouse(
        .leftMouseDragged, at: point, button: .left, target: target, group: group,
        clickState: 1, held: true,
        delta: CGPoint(x: point.x - previous.x, y: point.y - previous.y))
      previous = point
      usleep(useconds_t(max(1, min(duration / steps, Self.maximumDragDurationMs)) * 1000))
    }
    try postMouse(
      .leftMouseUp, at: to, button: .left, target: target, group: group, clickState: 1,
      held: false, delta: CGPoint(x: to.x - previous.x, y: to.y - previous.y))
    cursor.move(to: to)
    // A drag has no equivalent of the click's focus probe: what a drop did to
    // the target is application-specific and nothing generic can read it back.
    return PointerOutcome(mode: resolvedMode, verified: .unverifiable)
  }

  @discardableResult
  func scroll(
    at point: CGPoint?, deltaX: Double, deltaY: Double, window: CGWindowID? = nil,
    modifiers: [(code: CGKeyCode, flags: CGEventFlags)] = []
  ) throws -> PointerOutcome {
    try requireInputPermission()
    // A named window is honoured or refused, never quietly swapped for another
    // one: a scroll aimed at a window that has closed must not spin the human's
    // document instead.
    let target: DesktopWindow?
    if let point {
      target = try aim(at: point, named: window)
    } else if let window {
      guard let named = Windows.window(withNumber: window) else {
        throw RPCError(.targetMissing, "no window has id \(window)")
      }
      target = named
    } else {
      target = try resolveKeyboardTarget()
    }
    // Where the wheel turns. A window-scoped scroll with no point used to leave
    // the event at its default (0,0) *and* unstamped with a window-local
    // location, so it turned the wheel over the top-left corner of the desktop:
    // the target scrolled nothing and the call reported success. The centre of
    // the target is what "scroll this window" means.
    let aimPoint = point ?? target.map { CGPoint(x: $0.bounds.midX, y: $0.bounds.midY) }
    if point == nil, let aimPoint { cursor.glide(to: aimPoint, window: target) }
    let mode: DeliveryMode = .background
    let focus = try Focus.begin(for: target, cursor: cursor, controller: self, mode: mode)
    defer { focus.end() }
    // Scroll deltas are in pixels; a positive dy scrolls toward the content end,
    // matching the wire convention. Line units are negated the way a wheel is.
    guard
      let event = CGEvent(
        scrollWheelEvent2Source: source,
        units: .pixel,
        wheelCount: 2,
        wheel1: Geometry.clampToInt32(-deltaY),
        wheel2: Geometry.clampToInt32(-deltaX),
        wheel3: 0)
    else { throw RPCError(.internalError, "could not build a scroll event") }
    if let aimPoint { event.location = aimPoint }
    event.flags.insert(.maskNonCoalesced)
    // The held modifiers ride the wheel event as well as going down as real key
    // transitions. Both halves are load-bearing: a Command-scroll is a zoom in
    // most applications, and a wheel event that arrives without the flag bits is
    // an ordinary scroll however the modifier keys were posted. Empty leaves the
    // event exactly as it was.
    let modifierFlags = Self.combinedFlags(modifiers)
    event.flags.formUnion(modifierFlags)
    try withPointerModifiers(modifiers, target: target) {
      // A background window hit-tests a wheel event against the cursor-tracking
      // state it last saw, the same way it does a click, so the scroll gets the
      // same primed move.
      if let aimPoint, target != nil {
        try self.prime(
          at: aimPoint, target: target, group: Self.newClickGroup(),
          modifierFlags: modifierFlags)
      }
      try self.deliver(
        event, to: target, localPoint: aimPoint.map { self.localPoint($0, in: target) })
    }
    // Scroll position is not something the helper can read back generically:
    // nothing in AX reports "this view moved by 40 points".
    return PointerOutcome(mode: mode, verified: .unverifiable)
  }

  // MARK: - Keyboard

  /// Keys go to `window` from now on, whatever the last pointer gesture aimed
  /// at. `raise-window` and `focus-window` call this: the Node side points the
  /// helper at the window the agent named immediately before typing into it.
  func setKeyboardTarget(_ window: DesktopWindow?) {
    targetLock.lock(); defer { targetLock.unlock() }
    keyboardTarget = window
  }

  func typeText(_ text: String, mode: DeliveryMode) throws -> TypeOutcome {
    try requireInputPermission()
    let target = try resolveKeyboardTarget()
    // A failed verification must not poison later calls by selecting the
    // forbidden foreground route. Every background request stays background.
    if mode == .foreground {
      // An explicitly requested foreground rung takes exactly the path rung 3
      // takes. Posting pid-routed Unicode here instead — which it used to — put
      // this rung's one reason to exist on the wrong side of the activation:
      // Chromium ignores a key posted to a pid whether or not its app is front,
      // so the visible flicker bought nothing.
      let valueBefore = Accessibility.focusedValue(in: target)
      var path = "foreground-keys"
      try withForeground(target) { path = try self.postForegroundText(text, allowInsertion: mode != .foreground) }
      return TypeOutcome(
        path: path,
        verified: try verifyText(text, reached: target, before: valueBefore))
    }
    // Rung 1: an accessibility insert into the focused text element. It lands
    // in a background window without any activation dance and, for native
    // controls, its effect can often be read straight back.
    switch Accessibility.insertText(text, into: target) {
    case .inserted(let verification):
      // An insert a native control accepted but did not expose for reading is
      // still a delivery, and typing the text again on the chance that it was
      // not one is the more expensive mistake: a formatter or a secure field
      // would then hold it twice. Web content — the case the rest of this
      // ladder exists for — never arrives here at all, because `insertText`
      // refuses it outright rather than reporting an unverifiable success.
      return TypeOutcome(path: "ax-insert", verified: verification)
    case .notApplicable, .refused:
      break
    }

    // Nil means the focused element exposes no readable value, which is the
    // difference between "this did not land" and "there is no way to tell".
    let valueBefore = Accessibility.focusedValue(in: target)
    // Rung 2: keystrokes addressed at the target process. This is the invisible
    // path and it works for AppKit, but only when the target's app accepts the
    // synthetic active state — `Focus` reports whether it did.
    var routed = false
    do {
      let focus = try Focus.begin(for: target, cursor: cursor, controller: self)
      defer { focus.end() }
      if focus.targetBelievesItIsActive {
        try postText(text, to: target)
        routed = true
      }
    }
    if routed {
      guard valueBefore != nil else {
        // Unverifiable is not failed. Climbing here retyped the whole string
        // into a field that already held it — the worse of the two errors, and
        // the common one, because a great many controls expose no `AXValue` at
        // all. The caller is told what actually happened instead.
        return TypeOutcome(path: "keystrokes", verified: .unverifiable)
      }
      let verification = try verifyText(text, reached: target, before: valueBefore)
      if verification != .unconfirmed {
        return TypeOutcome(path: "keystrokes", verified: verification)
      }
      // A delayed accessibility mirror is not proof this application can never
      // accept background input. Report uncertainty without changing its route.
    }

    // Do not replay an unconfirmed background insertion through another route.
    if mode == .background {
      return TypeOutcome(path: "keystrokes", verified: .unconfirmed)
    }
    // Physical keycodes are allowed only when the target is already active.
    var path = "foreground-keys"
    try withForeground(target) { path = try self.postForegroundText(text) }
    return TypeOutcome(
      path: path, verified: try verifyText(text, reached: target, before: valueBefore))
  }

  /// Whether the target's focused element gained `text`. Compared against the
  /// value read before the attempt: asking only whether the value *contains* the
  /// text reported success when the field already held that string and the
  /// keystrokes went nowhere.
  ///
  /// Empty text is unverifiable by construction — every string contains `""`,
  /// so the comparison could only ever answer yes — and web content exposes no
  /// usable value, which is unverifiable rather than failed.
  private func verifyText(_ text: String, reached target: DesktopWindow?, before: String?)
    throws -> Verification
  {
    guard !text.isEmpty, let target, let before else { return .unverifiable }
    // Event delivery and the application's accessibility mirror update on
    // different queues. An immediate read can still see the old value after
    // a successful key event, which incorrectly triggers a replay or tells
    // the model to repeat an action that already landed. Give the receiver a
    // bounded chance to publish its value, checking cancellation throughout.
    let deadline = DispatchTime.now() + .milliseconds(200)
    repeat {
      try InputCancellation.check()
      guard let after = Accessibility.focusedValue(in: target) else { return .unverifiable }
      if after != before && after.contains(text) { return .confirmed }
      if DispatchTime.now() >= deadline { return .unconfirmed }
      usleep(20_000)
    } while true
  }

  /// PID-addressed key events while the target is visibly active.
  ///
  /// These carry a real virtual keycode, not just a Unicode payload. A
  /// `virtualKey: 0` event with `keyboardSetUnicodeString` is enough for AppKit,
  /// but Chromium translates NSEvents through the keycode, so it saw a keydown
  /// with no character and inserted nothing. The Unicode string is still
  /// attached so characters outside the ANSI table come through as themselves.
  ///
  /// Only meaningful while the target is frontmost, which the caller arranges.
  private func postForegroundText(_ text: String, allowInsertion: Bool = true) throws -> String {
    // Native editable controls can accept one insertion without clipboard
    // mutation or a per-character event stream. Web controls decline this path.
    let target = try resolveKeyboardTarget()
    try assertKeyboardWindow(target)
    if let expected = foregroundKeyboardPID, SkyLight.frontmostPID() != expected {
      throw RPCError(.notDelivered, "Input interrupted because the user switched applications.")
    }
    if allowInsertion, case .inserted = Accessibility.insertText(text, into: target) { return "foreground-ax-insert" }
    for character in text {
      let units = Array(String(character).utf16)
      // A character the tables cannot express has no keycode to send, and
      // borrowing one would type *that* key instead. Keycode 0 carrying only the
      // Unicode payload is the documented path for it: AppKit inserts the
      // character, and a toolkit that insists on a keycode simply gets nothing
      // for a character no key produces.
      guard let stroke = KeyMap.keystroke(for: character) else {
        for down in [true, false] {
          try postForegroundKey(0, down: down, flags: [], units: units)
        }
        usleep(6_000)
        continue
      }
      let flags: CGEventFlags = stroke.shift ? [.maskShift] : []
      try withForegroundShift(stroke.shift) {
        for down in [true, false] {
          try self.postForegroundKey(stroke.code, down: down, flags: flags, units: units)
        }
      }
      usleep(6_000)
    }
    return "foreground-keys"
  }

  /// Hold Shift only in the target process, and retain its owner for unwind.
  private func withForegroundShift(_ needed: Bool, _ body: () throws -> Void) throws {
    guard needed else {
      try body()
      return
    }
    let shift = KeyMap.shiftModifier
    try postForegroundKey(shift.code, down: true, flags: [.maskShift], units: nil)
    recordHeldModifiers([shift], target: currentKeyboardTarget())
    // Runs on a throw as well as on the ordinary path, so the only window in
    // which Shift is held without being releasable is the one `unwind()` covers.
    defer {
      try? postForegroundKey(shift.code, down: false, flags: [], units: nil)
      clearHeldModifiers()
    }
    try body()
  }

  /// Hold `modifiers` down at `target` for the duration of `body` — the way a
  /// hand holds Shift while it clicks, or Command while it turns the wheel.
  ///
  /// Same shape and the same bookkeeping as `postChord`, deliberately: each
  /// modifier goes down as a real key transition posted to the *target pid*
  /// through `deliver`, accumulating flags as it goes; every press is recorded through
  /// `recordHeldModifiers` while it is down, so a throw between the down and the
  /// up, or a SIGTERM mid-gesture, runs `unwind()` with something to release
  /// instead of latching Command on the human's desktop; and the releases go out
  /// in reverse carrying the flags that remain.
  ///
  /// The empty case is a contract, not a fast path: a gesture with no modifiers
  /// must post exactly the events it posted before this parameter existed.
  private func withPointerModifiers(
    _ modifiers: [(code: CGKeyCode, flags: CGEventFlags)], target: DesktopWindow?,
    _ body: () throws -> Void
  ) throws {
    guard !modifiers.isEmpty else {
      try body()
      return
    }
    var flags = CGEventFlags()
    var pressed: [(code: CGKeyCode, flags: CGEventFlags)] = []
    // Runs on a throw as well as on the ordinary path, so the only window in
    // which a modifier is held without being releasable is the one `unwind()`
    // covers.
    defer {
      for modifier in pressed.reversed() {
        flags.remove(modifier.flags)
        try? postKey(modifier.code, down: false, flags: flags, to: target)
        usleep(8_000)
      }
      clearHeldModifiers()
    }
    for modifier in modifiers {
      flags.insert(modifier.flags)
      try postKey(modifier.code, down: true, flags: flags, to: target)
      pressed.append(modifier)
      recordHeldModifiers(pressed, target: target)
      usleep(8_000)
    }
    try body()
  }

  /// The flag bits a set of held modifiers asserts, as one mask.
  private static func combinedFlags(_ modifiers: [(code: CGKeyCode, flags: CGEventFlags)])
    -> CGEventFlags
  {
    modifiers.reduce(CGEventFlags()) { $0.union($1.flags) }
  }

  /// Note that `modifiers` are logically down, so `unwind()` can release them on
  /// whichever stream took the press.
  private func recordHeldModifiers(
    _ modifiers: [(code: CGKeyCode, flags: CGEventFlags)], target: DesktopWindow?
  ) {
    heldLock.lock()
    heldModifiers = modifiers
    heldModifierTarget = target
    heldLock.unlock()
  }

  /// Forget the held modifiers. Only ever called once their release has been
  /// posted — clearing without releasing is how a latched modifier escapes.
  private func clearHeldModifiers() {
    heldLock.lock()
    heldModifiers = []
    heldModifierTarget = nil
    heldLock.unlock()
  }

  private func assertKeyboardWindow(_ target: DesktopWindow?) throws {
    guard let target, Accessibility.keyboardWindowMatches(target) else {
      throw RPCError(.notDelivered, "The application did not focus the requested window; refusing to type into a different window. Click the intended control and try again.")
    }
  }

  private func postForegroundKey(
    _ code: CGKeyCode, down: Bool, flags: CGEventFlags, units: [UniChar]?
  ) throws {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw RPCError(.internalError, "could not build a keyboard event")
    }
    event.flags = flags
    if var mutable = units, !mutable.isEmpty {
      event.keyboardSetUnicodeString(stringLength: mutable.count, unicodeString: &mutable)
    }
    let target = down ? try resolveKeyboardTarget() : currentKeyboardTarget()
    if down, let expected = foregroundKeyboardPID, SkyLight.frontmostPID() != expected {
      throw RPCError(.notDelivered, "Input interrupted because the user switched applications. Read the target before continuing.")
    }
    // PID delivery closes the race between checking activation and posting.
    try deliver(event, to: target, localPoint: nil)
    usleep(2_000)
  }

  func pressKey(_ key: String, modifiers: [String], mode: DeliveryMode) throws -> KeyOutcome {
    try requireInputPermission()
    guard let code = KeyMap.code(for: key) else {
      throw RPCError(.invalidParams, "unknown key '\(key)'")
    }
    return try postChord(code, modifiers: try KeyMap.modifierCodes(for: modifiers), mode: mode)
  }

  func hotkey(_ keys: [String], mode: DeliveryMode) throws -> KeyOutcome {
    try requireInputPermission()
    var modifiers: [String] = []
    var mainKeys: [String] = []
    for key in keys {
      if KeyMap.isModifier(key) {
        modifiers.append(key)
      } else {
        mainKeys.append(key)
      }
    }
    // A name this helper knows as neither a modifier nor a key is reported as
    // exactly that. `hotkey` splits its input on `KeyMap.isModifier`, so an
    // unknown *modifier* — `["hyper", "cmd", "a"]` — falls into `mainKeys` and
    // used to come back as "takes exactly one non-modifier key, got 2", which
    // sends the caller looking for a second key it did not send instead of at
    // the word the helper could not read. `press-key` has always named it
    // (`KeyMap.modifierCodes`); this makes the two agree.
    let unknown = mainKeys.filter { KeyMap.code(for: $0) == nil }
    if let first = unknown.first {
      throw RPCError(
        .invalidParams,
        "'\(first)' is not a key or a modifier this helper knows"
          + (unknown.count > 1 ? " (\(unknown.count) unknown names in \(keys))" : ""))
    }
    // Silently keeping only the last one turned `cmd+k+v` into `cmd+v` and
    // reported success, so the agent believed a chord it never sent had run.
    guard mainKeys.count == 1, let mainKey = mainKeys.first else {
      throw RPCError(
        .invalidParams, "hotkey takes exactly one non-modifier key, got \(mainKeys.count)")
    }
    guard let code = KeyMap.code(for: mainKey) else {
      throw RPCError(.invalidParams, "unknown key '\(mainKey)'")
    }
    return try postChord(code, modifiers: try KeyMap.modifierCodes(for: modifiers), mode: mode)
  }

  // MARK: - Unwind

  /// Release anything logically held, on the way out. Safe to call from a signal
  /// source, and idempotent.
  func unwind() {
    releaseHeldButton()

    heldLock.lock()
    let modifiers = heldModifiers
    let modifierTarget = heldModifierTarget
    heldModifiers = []
    heldLock.unlock()

    // All rungs use PID-addressed events. Release against the saved owner even
    // if its window has since closed or the keyboard aim has been cleared.
    var flags = modifiers.reduce(CGEventFlags()) { $0.union($1.flags) }
    for modifier in modifiers.reversed() {
      flags.remove(modifier.flags)
      if let event = CGEvent(keyboardEventSource: source, virtualKey: modifier.code, keyDown: false)
      {
        event.flags = flags
        try? deliver(event, to: modifierTarget, localPoint: nil)
      }
    }

    restorePendingFocus()
  }

  /// Posts the matching up for whatever button is logically down, if any.
  /// Idempotent: the bookkeeping is cleared under the lock before the event is
  /// built, so a gesture's `defer` and a concurrent `unwind()` cannot both post.
  private func releaseHeldButton() {
    heldLock.lock()
    let button = heldButton
    heldButton = nil
    heldLock.unlock()

    guard let button else { return }
    let types = Self.eventTypes(for: button.button)
    // Built the same way every other event of the gesture was. The direct
    // `CGEvent` construction this used to take skips the NSEvent window
    // association, which is exactly the part a Chromium view requires — so the
    // one event that must land, the up that ends a phantom drag, was the one
    // most likely to be ignored.
    guard
      let event = Self.mouseEvent(
        type: types.up, at: button.point, button: button.button, target: button.target,
        clickState: 1, source: source)
    else { return }
    stamp(event, button: button.button, group: button.group, clickState: 1, delta: nil)
    try? deliver(event, to: button.target, localPoint: localPoint(button.point, in: button.target))
  }

  /// Unwind target-only synthetic activation when input is interrupted.
  private func restorePendingFocus() {
    guard let pending = takePendingFocusRestore() else { return }
    performFocusRestore(pending)
  }

  /// Claim the outstanding focus debt, atomically.
  ///
  /// `Focus.end()` on the input lane and `unwind()` from the signal source both
  /// pay this debt, and both used to read it and clear it as two steps — so a
  /// SIGTERM landing between them had them both post the inverse record pair,
  /// deactivating the human's application a second time on the way out. Exactly
  /// one caller can win this.
  fileprivate func takePendingFocusRestore() -> PendingFocusRestore? {
    heldLock.lock()
    defer { heldLock.unlock() }
    let pending = pendingFocusRestore
    pendingFocusRestore = nil
    return pending
  }

  /// Shared by normal completion and cancellation; neither activates an app.
  fileprivate func performFocusRestore(_ pending: PendingFocusRestore) {
    _ = SkyLight.restoreActivation(from: pending.targetPID)
  }

  /// Records, or clears, the focus pair a gesture still owes the human.
  fileprivate func setPendingFocusRestore(_ pending: PendingFocusRestore?) {
    heldLock.lock()
    pendingFocusRestore = pending
    heldLock.unlock()
  }

  // MARK: - Focus prelude and postlude

  /// Synthetic input state belongs to the target process only. Never deactivate
  /// the user's application or restore it through a real foreground activation.
  private struct Focus {
    private let cursor: AgentCursor
    private unowned let controller: InputController
    private let needsRestore: Bool
    let targetBelievesItIsActive: Bool

    static func begin(
      for target: DesktopWindow?, cursor: AgentCursor, controller: InputController,
      mode: DeliveryMode = .background
    ) throws -> Focus {
      guard let target else {
        throw RPCError(.notDelivered, "No input target is selected")
      }
      try Windows.requireInputSpace(target.windowNumber, ownerPID: target.ownerPID)
      let isActive = SkyLight.frontmostPID() == target.ownerPID
      if mode == .foreground && !isActive {
        throw RPCError(.notDelivered, "Background input was not delivered; activating another application is forbidden")
      }
      if !Accessibility.keyboardWindowMatches(target) {
        if isActive { throw RPCError(.notDelivered, "Refusing to change the user's active window") }
        try Windows.requireInputSpace(target.windowNumber, ownerPID: target.ownerPID)
        SkyLight.makeKeyWindow(pid: target.ownerPID, windowID: target.windowNumber)
        usleep(20_000)
      }
      if isActive {
        return Focus(cursor: cursor, controller: controller, needsRestore: false,
          targetBelievesItIsActive: true)
      }
      try Windows.requireInputSpace(target.windowNumber, ownerPID: target.ownerPID)
      let outcome = SkyLight.activateWithoutRaise(
        pid: target.ownerPID, windowID: target.windowNumber)
      if outcome.needsRestore {
        controller.setPendingFocusRestore(PendingFocusRestore(targetPID: target.ownerPID))
        usleep(50_000)
        cursor.repin()
      }
      guard outcome.activated else {
        throw RPCError(.notDelivered, "Target did not accept background input; application activation is forbidden")
      }
      return Focus(cursor: cursor, controller: controller, needsRestore: outcome.needsRestore,
        targetBelievesItIsActive: outcome.activated)
    }

    func end() {
      guard needsRestore else { return }
      usleep(50_000)
      if let pending = controller.takePendingFocusRestore() {
        controller.performFocusRestore(pending)
      }
      cursor.repin()
    }
  }

  /// Foreground keycodes are permitted only while the user already has this
  /// application active. This path never activates or raises an application.
  private func withForeground(_ target: DesktopWindow?, _ body: () throws -> Void) throws {
    let focus = try Focus.begin(for: target, cursor: cursor, controller: self, mode: .foreground)
    defer { focus.end() }
    guard focus.targetBelievesItIsActive else {
      throw RPCError(
        .notDelivered, "target did not become frontmost; refusing to type into whatever is")
    }
    guard let target, Accessibility.keyboardWindowMatches(target) else {
      throw RPCError(.notDelivered, "The requested keyboard window is not selected")
    }
    foregroundKeyboardPID = target.ownerPID
    defer { foregroundKeyboardPID = nil }
    try body()
  }

  /// Move the agent cursor to `point` and resolve the one window every event of
  /// this gesture will be stamped with.
  ///
  /// `named` is the window the caller resolved this point to. It wins over the
  /// topmost window at the point, and that is the whole reason a click on a
  /// partially covered window works: the event is stamped with, and posted to,
  /// the window the caller meant rather than whatever is drawn over it. Falling
  /// back to `topmost` keeps a bare coordinate behaving the way a real pointer
  /// does, hitting whatever is on top.
  ///
  /// A *named* window that no longer exists is refused rather than fallen back
  /// on. Falling through to `topmost` there silently re-aimed the gesture at
  /// whatever happened to be over that coordinate — a click the agent asked to
  /// deliver to a closed window landing in the human's editor instead. An
  /// unresolvable target is the caller's cue to re-read the window list.
  private func aim(at point: CGPoint, named: CGWindowID? = nil, glide: Bool = true) throws -> DesktopWindow? {
    let target: DesktopWindow?
    if let named {
      guard let namedTarget = Windows.window(withNumber: named) else {
        throw RPCError(.targetMissing, "no window has id \(named)")
      }
      target = namedTarget
    } else {
      target = Windows.topmost(at: point)
    }
    if let target { try Windows.requireInputSpace(target.windowNumber, ownerPID: target.ownerPID) }
    // Resolve before moving so the overlay has the same window as the input.
    // The bounded glide waits for the picture to arrive before posting events.
    if glide { cursor.glide(to: point, window: target) }
    setKeyboardTarget(target)
    return target
  }

  /// A before/after look at the one thing a click reliably moves when it lands:
  /// which element the target application considers focused.
  ///
  /// It only draws a conclusion when it is entitled to one. The click must have
  /// been aimed at a focusable element that was *not* already focused; then, and
  /// only then, does an unchanged focus mean the gesture went nowhere. Without
  /// that gate the probe reported failure for a click into a text area that
  /// already held the caret — observed against TextEdit, an app whose background
  /// delivery works perfectly — and would have condemned it to the visible rung
  /// forever. A wrong "delivered" costs nothing; a wrong "undelivered" costs a
  /// permanent flicker, so this errs toward saying nothing.
  private struct DeliveryWatch {
    /// The whole watch — the expectation before the gesture and the look after
    /// it — is capped at this many seconds of accessibility IPC. Past it the
    /// probe stops asking and the click is reported as unverifiable, which is
    /// the truthful answer and keeps a wedged application from holding the
    /// serial input lane while every later click queues behind it.
    private static let budgetSeconds: Double = 0.75
    private let probe: Accessibility.GestureProbe?
    private let expected: String?
    /// What the application considered focused *before* the gesture. Focus that
    /// has not moved from this is the only thing that means "nothing arrived".
    private let focusedBefore: String?

    init(target: DesktopWindow?, point: CGPoint) {
      // One handle for the whole gesture rather than one per question: the
      // expectation, the look after the click, and the look after an escalated
      // replay are all asked of this.
      guard let target,
        let probe = Accessibility.GestureProbe(window: target, budgetSeconds: Self.budgetSeconds)
      else {
        self.probe = nil
        self.expected = nil
        self.focusedBefore = nil
        return
      }
      self.probe = probe
      guard let expectation = probe.expectation(at: point), !expectation.alreadyFocused else {
        self.expected = nil
        self.focusedBefore = nil
        return
      }
      self.expected = expectation.element
      self.focusedBefore = expectation.focused
    }

    /// What the target did about the gesture: `confirmed` when the element the
    /// click was aimed at now holds focus, `unconfirmed` when focus has not moved
    /// at all, and `unverifiable` when there was never anything to check — a
    /// click on a label, a click on the already-focused control, an app that
    /// exposes no accessibility, or a probe that has spent its budget.
    ///
    /// The three-way split matters because `unconfirmed` is not just a report:
    /// `click` replays the entire gesture on the visible rung when it sees one,
    /// and a replayed click is a **second** click on the user's desktop, not a
    /// flicker. This used to answer `unconfirmed` for any focus that was not the
    /// predicted element — but focus landing somewhere neither predicted nor
    /// previous is proof the click *did* arrive and merely moved focus somewhere
    /// the hit test did not foresee (a container took it, the app moved it on).
    /// Only focus that is exactly where it was before is evidence of a gesture
    /// that went nowhere, and only that may cost a duplicate click.
    func observe() -> Verification {
      guard let probe, let expected else { return .unverifiable }
      // A changed focus can confirm delivery immediately. Keep the entire
      // original grace before declaring failure, since failure replays a click.
      let deadline = DispatchTime.now() + .milliseconds(120)
      repeat {
        guard let after = probe.focusedSignature() else { return .unverifiable }
        if after == expected { return .confirmed }
        if after != focusedBefore { return .unverifiable }
        if DispatchTime.now() >= deadline { return .unconfirmed }
        usleep(10_000)
      } while true
    }

    /// A second look, with a fresh budget, after an escalated replay.
    func renewedObservation() -> Verification {
      probe?.renew(budgetSeconds: Self.budgetSeconds)
      return observe()
    }
  }

  /// Build a mouse event the way the design reference specifies: as an
  /// `NSEvent` carrying the target's window number, then converted to a
  /// `CGEvent`.
  ///
  /// This is step 1-2 of the confirmed mechanism (reference §2.3), and building
  /// the `CGEvent` directly instead — which this used to do — skips it. An
  /// NSEvent-derived event carries the AppKit window association and event
  /// bookkeeping that a synthesised `CGEvent(mouseEventSource:)` has never had,
  /// and a Chromium web view ignores an event that lacks it. Note the location
  /// is window-local in AppKit's bottom-left space, which is what
  /// `windowNumber` scopes it to; the global location and the private
  /// window-local stamp are applied afterwards by `deliver`.
  ///
  /// Falls back to the direct construction when AppKit declines — an unscoped
  /// event still reaches a frontmost target, which is better than no event.
  private static func mouseEvent(
    type: CGEventType, at point: CGPoint, button: CGMouseButton, target: DesktopWindow?,
    clickState: Int, source: CGEventSource?
  ) -> CGEvent? {
    if let target, let nsType = Self.appKitType(for: type) {
      // `NSEvent.mouseEvent(with:…)` is a pure value constructor: it fills in an
      // event record from its arguments and touches no window, view, or shared
      // AppKit state, which is why it is safe on the input lane rather than
      // needing a hop to main. (`NSScreen` is the AppKit API that does need one,
      // and that read lives behind `Geometry`'s snapshot.)
      //
      // AppKit window space: origin bottom-left of the window, y upwards.
      let local = CGPoint(
        x: point.x - target.bounds.origin.x,
        y: target.bounds.height - (point.y - target.bounds.origin.y))
      if let nsEvent = NSEvent.mouseEvent(
        with: nsType,
        location: local,
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: Int(target.windowNumber),
        context: nil,
        eventNumber: Int(Self.nextEventNumber()),
        clickCount: max(1, clickState),
        pressure: type == .leftMouseDown || type == .rightMouseDown ? 1 : 0),
        let converted = nsEvent.cgEvent
      {
        return converted
      }
    }
    return CGEvent(
      mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  }

  /// Whether an event carries a pointer location, and so must not be posted at
  /// an unresolved target.
  private static func isMouseEvent(_ type: CGEventType) -> Bool {
    switch type {
    case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown,
      .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
      .scrollWheel:
      return true
    default:
      return false
    }
  }

  /// AppKit's event type for a Quartz mouse type, or nil for the types NSEvent
  /// cannot express, which take the direct construction.
  private static func appKitType(for type: CGEventType) -> NSEvent.EventType? {
    switch type {
    case .leftMouseDown: return .leftMouseDown
    case .leftMouseUp: return .leftMouseUp
    case .rightMouseDown: return .rightMouseDown
    case .rightMouseUp: return .rightMouseUp
    case .otherMouseDown: return .otherMouseDown
    case .otherMouseUp: return .otherMouseUp
    case .mouseMoved: return .mouseMoved
    case .leftMouseDragged: return .leftMouseDragged
    case .rightMouseDragged: return .rightMouseDragged
    default: return nil
    }
  }

  private static let eventNumberLock = NSLock()
  private static var eventNumberCounter: Int32 = 0
  /// Monotonic per-event id, the way a real event stream numbers its events.
  private static func nextEventNumber() -> Int32 {
    eventNumberLock.lock()
    defer { eventNumberLock.unlock() }
    eventNumberCounter &+= 1
    return eventNumberCounter
  }

  private static func eventTypes(for button: CGMouseButton)
    -> (down: CGEventType, up: CGEventType)
  {
    switch button {
    case .right: return (.rightMouseDown, .rightMouseUp)
    case .left: return (.leftMouseDown, .leftMouseUp)
    default: return (.otherMouseDown, .otherMouseUp)
    }
  }

  private static func newClickGroup() -> Int64 {
    Int64(UInt32.random(in: 1...UInt32.max))
  }

  /// A stamped `mouseMoved` at the target before a down/up. AppKit hit-tests a
  /// control against the cursor-tracking state its window last saw; a background
  /// window that never received a move has stale state, so the synthetic
  /// mouseDown lands "outside" the control and `-mouseDown:` never fires.
  ///
  /// It carries the gesture's modifier flags too: the move a hand makes while it
  /// holds Shift carries them, and a tracking update that disagreed with the
  /// clicks that follow it is a state the target never sees from real hardware.
  private func prime(
    at point: CGPoint, target: DesktopWindow?, group: Int64, modifierFlags: CGEventFlags = []
  ) throws {
    guard target != nil else { return }
    guard
      let event = Self.mouseEvent(
        type: .mouseMoved, at: point, button: .left, target: target, clickState: 0, source: source)
    else { throw RPCError(.internalError, "could not build a mouse event") }
    stamp(
      event, button: .left, group: group, clickState: 0, delta: nil,
      modifierFlags: modifierFlags)
    try deliver(event, to: target, localPoint: localPoint(point, in: target))
    usleep(15_000)
  }

  private func postMouse(
    _ type: CGEventType,
    at point: CGPoint,
    button: CGMouseButton,
    target: DesktopWindow?,
    group: Int64,
    clickState: Int,
    held: Bool,
    delta: CGPoint? = nil,
    modifierFlags: CGEventFlags = []
  ) throws {
    guard
      let event = Self.mouseEvent(
        type: type, at: point, button: button, target: target, clickState: clickState,
        source: source)
    else { throw RPCError(.internalError, "could not build a mouse event") }
    stamp(
      event, button: button, group: group, clickState: clickState, delta: delta,
      modifierFlags: modifierFlags)
    heldLock.lock()
    heldButton = held ? HeldButton(button: button, point: point, target: target, group: group) : nil
    heldLock.unlock()
    try deliver(event, to: target, localPoint: localPoint(point, in: target))
  }

  private func stamp(
    _ event: CGEvent, button: CGMouseButton, group: Int64, clickState: Int, delta: CGPoint?,
    modifierFlags: CGEventFlags = []
  ) {
    event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    // Must match the button encoded in the event type: a right-down stamped as
    // button 0 routes as a left click on the receiving side.
    event.setIntegerValueField(kFieldButtonNumber, value: Int64(button.rawValue))
    event.setIntegerValueField(kFieldClickGroup, value: group)
    if let delta {
      event.setIntegerValueField(.mouseEventDeltaX, value: Geometry.clampToInt64(delta.x))
      event.setIntegerValueField(.mouseEventDeltaY, value: Geometry.clampToInt64(delta.y))
    }
    // Real hardware events carry it; some toolkits treat its absence as a
    // coalesced move they may drop. The reference doc's click-fidelity note
    // (§8) pairs it with an undocumented 0x20000000 bit that real events also
    // carry — without it a Chromium web view ignores the event entirely.
    event.flags.insert(.maskNonCoalesced)
    event.flags = CGEventFlags(rawValue: event.flags.rawValue | kSyntheticClickFidelityFlag)
    // Whatever the gesture is holding down. A union, so the empty set — every
    // gesture that names no modifiers — leaves the flags untouched.
    event.flags.formUnion(modifierFlags)
  }

  /// Text as Unicode-string key events, 20 UTF-16 units per chunk (delivery
  /// truncates past ~20), never splitting a surrogate pair, flags zeroed on every
  /// event because Chromium infers modifier state from them and would otherwise
  /// see an uppercase letter as Shift+letter with the Shift leaking onward.
  private func postText(_ text: String, to target: DesktopWindow?) throws {
    try assertKeyboardWindow(target)
    let units = Array(text.utf16)
    var index = 0
    while index < units.count {
      var end = min(index + 20, units.count)
      if end < units.count, units[end - 1] >= 0xD800, units[end - 1] <= 0xDBFF {
        end -= 1
      }
      try postUnicode(Array(units[index..<end]), to: target)
      index = end
    }
  }

  private func postUnicode(_ units: [UniChar], to target: DesktopWindow?) throws {
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
        throw RPCError(.internalError, "could not build a keyboard event")
      }
      event.flags = []
      var mutable = units
      event.keyboardSetUnicodeString(stringLength: mutable.count, unicodeString: &mutable)
      try deliver(event, to: target, localPoint: nil)
      usleep(8_000)
    }
  }

  /// A key with modifiers, delivered the way a hand does it: each modifier goes
  /// down (accumulating flags), the key goes down and up with the full set, and
  /// the modifiers come up in reverse. Mouse-style flag bits alone are not a
  /// sufficient modifier model for every AppKit host — Finder's collection views
  /// are the classic example — and the real transitions cost nothing.
  private func postChord(
    _ code: CGKeyCode, modifiers: [(code: CGKeyCode, flags: CGEventFlags)], mode: DeliveryMode
  ) throws -> KeyOutcome {
    let target = try resolveKeyboardTarget()
    // What the target considered focused on either side of the chord. A chord
    // that edits or moves the selection changes this; one that copies, or opens
    // a menu, legitimately does not — so an unchanged signature is
    // `unverifiable` rather than a failure, and only an unreadable target is
    // worse than that.
    //
    // Both reads happen **inside** the focus scope, bracketing the keystrokes
    // and nothing else. Reading `before` outside it — which this used to do —
    // meant the foreground rung's own activation sat between the two samples:
    // activating an application moves its focused element, so every chord that
    // took the visible rung reported `confirmed` whether or not the keys did
    // anything at all. A change is only evidence when the keystrokes are the
    // only thing that could have caused it.
    var signatureBefore: String?
    var signatureAfter: String?
    func verification() -> Verification {
      guard let signatureBefore, let signatureAfter else { return .unverifiable }
      return signatureAfter != signatureBefore ? .confirmed : .unverifiable
    }
    // The chord itself, written once and parameterised on how a single
    // transition is posted. The two rungs differ in nothing else — pid-routed
    // for the invisible path, foreground route for the visible one, which is reached
    // only for an app already caught dropping background input — and a second
    // copy of this would be a second place for a modifier to latch.
    let body: (
      _ post: (CGKeyCode, Bool, CGEventFlags) throws -> Void
    ) throws -> Void = { post in
      // Sampled here, after whichever focus arrangement the caller made and
      // before the first transition of the chord.
      signatureBefore = Accessibility.focusedElementSignature(in: target)
      var flags = CGEventFlags()
      var pressed: [(code: CGKeyCode, flags: CGEventFlags)] = []
      defer {
        for modifier in pressed.reversed() {
          flags.remove(modifier.flags)
          try? post(modifier.code, false, flags)
          usleep(8_000)
        }
        self.clearHeldModifiers()
        // The closing sample: the chord is complete, the modifiers are up, and
        // the caller's focus arrangement is still in place (every rung restores
        // it after `body` returns). Nothing but the keystrokes has happened
        // between this and `signatureBefore`.
        signatureAfter = Accessibility.focusedElementSignature(in: target)
      }
      for modifier in modifiers where !pressed.contains(where: { $0.code == modifier.code }) {
        flags.insert(modifier.flags)
        try post(modifier.code, true, flags)
        pressed.append(modifier)
        self.recordHeldModifiers(pressed, target: target)
        usleep(8_000)
      }
      try post(code, true, flags)
      usleep(8_000)
      try post(code, false, flags)
      usleep(8_000)
    }
    let throughPid: (CGKeyCode, Bool, CGEventFlags) throws -> Void = { code, down, flags in
      try self.postKey(code, down: down, flags: flags, to: target)
    }
    let throughForeground: (CGKeyCode, Bool, CGEventFlags) throws -> Void = { code, down, flags in
      try self.postForegroundKey(code, down: down, flags: flags, units: nil)
    }
    if mode == .foreground {
      try withForeground(target) { try body(throughForeground) }
      return KeyOutcome(path: "foreground", verified: verification())
    }
    let focus = try Focus.begin(for: target, cursor: cursor, controller: self)
    defer { focus.end() }
    try assertKeyboardWindow(target)
    try body(throughPid)
    return KeyOutcome(path: "keystrokes", verified: verification())
  }

  private func postKey(_ code: CGKeyCode, down: Bool, flags: CGEventFlags, to target: DesktopWindow?)
    throws
  {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else {
      throw RPCError(.internalError, "could not build a keyboard event")
    }
    // Always overwritten, including to the empty set, so a modifier the human is
    // physically holding cannot leak into a targeted key press.
    event.flags = flags
    try deliver(event, to: target, localPoint: nil)
  }

  /// The window keys go to, plus the one nudge a background window needs: an app
  /// that is not the active app still routes keys to whichever of its windows it
  /// considers focused, and a window that is not drops them. Setting `AXFocused`
  /// costs one round trip, is skipped when the target's app is already frontmost,
  /// and deliberately does *not* also set `AXMain` — many apps implement that as
  /// `makeKeyAndOrderFront:`, so the old call raised the target window on every
  /// keystroke into a background app.
  ///
  /// There is no frontmost fallback. It used to return "whatever is in front"
  /// when no window had been aimed at, which meant a `type` with no preceding
  /// click or `focus-window` wrote the agent's text into the human's own
  /// document — including through the accessibility rung, which needs no
  /// activation at all. An unaimed keyboard action is refused instead.
  ///
  /// The aim is also **re-resolved**, not merely remembered. `keyboardTarget` is
  /// a struct captured whenever the last gesture ran, and `window_id` is optional
  /// on all three keyboard methods, so the cached aim is the common path. Once
  /// the aimed window closed, `postToPid` addressed a dead pid — or a recycled
  /// one, which is worse — WindowServer dropped the event silently, and the
  /// helper answered `ok: true, verified: "unverifiable"`: the agent was told its
  /// keystrokes were merely unobservable when in fact there was nothing left to
  /// observe them in. A window that is gone, or whose id now belongs to another
  /// process, is `targetMissing` and the aim is dropped so the next call cannot
  /// inherit it. Re-resolving also refreshes the bounds the window-local stamp
  /// is computed from.
  private func resolveKeyboardTarget() throws -> DesktopWindow {
    guard let aimed = currentKeyboardTarget() else {
      throw RPCError(
        .targetMissing,
        "no window is aimed for keyboard input; click, focus, or raise a window first")
    }
    guard let current = Windows.window(withNumber: aimed.windowNumber),
      current.ownerPID == aimed.ownerPID
    else {
      setKeyboardTarget(nil)
      throw RPCError(
        .targetMissing,
        "the window keyboard input was aimed at (\(aimed.windowNumber)) no longer exists; "
          + "click, focus, or raise a window again")
    }
    try Windows.requireInputSpace(current.windowNumber, ownerPID: current.ownerPID)
    setKeyboardTarget(current)
    if SkyLight.frontmostPID() != current.ownerPID {
      try Accessibility.focusWindowForKeyboard(current)
    }
    return current
  }

  /// Stamp the window fields and window-local location, then post to the target
  /// pid.
  ///
  /// There is deliberately no HID-tap fallback. Posting to `.cgSessionEventTap`
  /// is the one path that makes WindowServer warp the human's physical pointer,
  /// which is exactly what this file's first rule rules out — and it is reached
  /// in ordinary situations, not just pathological ones (every window minimised,
  /// or a Space showing only the desktop). An action with no resolvable target
  /// is refused instead, so the backend reports an unresolved target rather than
  /// hijacking the pointer.
  private func deliver(_ event: CGEvent, to target: DesktopWindow?, localPoint: CGPoint?) throws {
    let releasing = [.keyUp, .leftMouseUp, .rightMouseUp, .otherMouseUp].contains(event.type)
    if !releasing { try InputCancellation.check() }
    if event.type == .keyDown { try assertKeyboardWindow(target) }

    if !releasing, let target {
      try Windows.requireInputSpace(target.windowNumber, ownerPID: target.ownerPID)
      guard let current = Windows.window(withNumber: target.windowNumber),
        current.ownerPID == target.ownerPID else {
        throw RPCError(.targetMissing, "The input target closed or changed owner")
      }
    }
    // There is no frontmost fallback for either kind of event. An unstamped
    // pointer event is posted at the frontmost app carrying the global
    // coordinate the agent aimed somewhere else, so it clicks that coordinate
    // inside the human's own window; an unstamped *key* event is no better,
    // because it types the agent's text into whatever the human is using.
    // Both are refused, and the backend reports an unresolved target.
    guard let destination = target else {
      throw RPCError(
        .targetMissing,
        Self.isMouseEvent(event.type)
          ? "no window is available to receive this pointer event"
          : "no window is available to receive this event")
    }
    event.setIntegerValueField(kFieldSubtype, value: kWindowEventSubtype)
    event.setIntegerValueField(kFieldTargetPID, value: Int64(destination.ownerPID))
    event.setIntegerValueField(kFieldWindowNumber, value: Int64(destination.windowNumber))
    event.setIntegerValueField(kFieldWindowIDLow, value: Int64(destination.windowNumber))
    event.setIntegerValueField(kFieldWindowIDHigh, value: Int64(destination.windowNumber))
    if let localPoint, let setWindowLocation = SkyLight.setWindowLocation {
      setWindowLocation(event, localPoint)
    }
    event.postToPid(destination.ownerPID)
  }

  private func localPoint(_ global: CGPoint, in target: DesktopWindow?) -> CGPoint {
    guard let target else { return global }
    return CGPoint(x: global.x - target.bounds.origin.x, y: global.y - target.bounds.origin.y)
  }
}

/// US-ANSI key-name → virtual keycode map, plus modifier handling.
///
/// Named keys (enter, tab, arrows, function keys) need real keycodes so
/// modifiers and shortcuts dispatch; single printable characters map through the
/// same table where they are ANSI, and fall back to the Unicode-string path in
/// `typeText` for anything else (layout-independent, no AZERTY/Dvorak handling).
enum KeyMap {
  private static let named: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  private static let ansi: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
  ]

  /// Whitespace as literal characters. A typed line is mostly these, and they
  /// live here rather than in `ansi` so there is one table to consult whether
  /// the caller spelled the key ("space") or passed the character itself.
  private static let whitespace: [Character: CGKeyCode] = [
    "\n": 36, "\r": 36, "\t": 48, " ": 49,
  ]

  /// The US-layout characters produced by holding shift over another key.
  ///
  /// Shift state cannot be inferred from the character for these the way it can
  /// for a letter: `!` is already its own lowercase, so the "is it uppercase"
  /// test says no shift, and the character is in neither `named` nor `ansi`. The
  /// result was keycode 0 — the `A` key — for every symbol on this row, so an
  /// email address typed through the foreground route arrived as `robertaexample`.
  private static let shiftedAnsi: [Character: CGKeyCode] = [
    "!": 18, "@": 19, "#": 20, "$": 21, "%": 23, "^": 22, "&": 26, "*": 28, "(": 25, ")": 29,
    "_": 27, "+": 24, "{": 33, "}": 30, "|": 42, ":": 41, "\"": 39, "<": 43, ">": 47, "?": 44,
    "~": 50,
  ]

  /// Left-hand modifier keycodes with the flag each one asserts.
  private static let modifiers: [String: (code: CGKeyCode, flags: CGEventFlags)] = [
    "cmd": (55, .maskCommand), "command": (55, .maskCommand), "meta": (55, .maskCommand),
    "super": (55, .maskCommand), "win": (55, .maskCommand),
    "shift": (56, .maskShift),
    "alt": (58, .maskAlternate), "option": (58, .maskAlternate), "opt": (58, .maskAlternate),
    "ctrl": (59, .maskControl), "control": (59, .maskControl),
    "fn": (63, .maskSecondaryFn),
  ]

  /// Left shift, for the foreground typing path, which asserts it directly
  /// rather than going through the caller-supplied modifier list.
  static let shiftModifier: (code: CGKeyCode, flags: CGEventFlags) = (56, .maskShift)

  static func isModifier(_ key: String) -> Bool {
    modifiers[key.lowercased()] != nil
  }

  /// Every named modifier, or an error naming the first one this map does not
  /// know.
  ///
  /// Dropping the unknown ones — which `compactMap` did silently — turned
  /// `["hyper", "cmd"] + "a"` into plain `cmd+a` and reported it as delivered,
  /// so the agent believed a chord it never sent had run. A modifier the helper
  /// cannot express is a bad request, not a smaller chord.
  static func modifierCodes(for names: [String]) throws -> [(code: CGKeyCode, flags: CGEventFlags)] {
    try names.map { name in
      guard let modifier = modifiers[name.lowercased()] else {
        throw RPCError(.invalidParams, "unknown modifier '\(name)'")
      }
      return modifier
    }
  }

  /// The names a *pointer* gesture may hold, and only these four.
  ///
  /// Deliberately narrower than `modifierCodes`: the wire contract for a gesture
  /// modifier (`ComputerInputModifier`, packages/contracts/src/computer.ts) is
  /// exactly `ctrl | alt | shift | meta`, so an alias the chord path accepts —
  /// `cmd`, `option`, `fn` — is a name no legitimate caller of a pointer method
  /// sends, and quietly honouring it would let two spellings of one request
  /// drift apart. The keycodes still come from the one table above, so there is
  /// no second copy of them to go stale.
  private static let pointerModifierNames: Set<String> = ["ctrl", "alt", "shift", "meta"]

  /// Every named pointer modifier, or an error naming the first one this map
  /// does not know.
  ///
  /// An unknown name is a bad request rather than a smaller gesture that quietly
  /// runs — the same rule `modifierCodes` follows for chords, and for the same
  /// reason: a Command-click silently demoted to a plain click is a *different*
  /// action on almost every surface, and the agent would be told the one it
  /// asked for had happened. Duplicates are dropped instead, because
  /// `["shift", "shift"]` is one key however many times it was named, and
  /// pressing it twice would leave one down after the release.
  static func pointerModifiers(for names: [String]) throws -> [(
    code: CGKeyCode, flags: CGEventFlags
  )] {
    var seen: Set<CGKeyCode> = []
    var strokes: [(code: CGKeyCode, flags: CGEventFlags)] = []
    for name in names {
      let lowered = name.lowercased()
      guard pointerModifierNames.contains(lowered), let modifier = modifiers[lowered] else {
        throw RPCError(
          .invalidParams,
          "'\(name)' is not a pointer modifier this helper knows; "
            + "use ctrl, alt, shift or meta")
      }
      guard seen.insert(modifier.code).inserted else { continue }
      strokes.append(modifier)
    }
    return strokes
  }

  /// A single character is looked up as itself; only a spelled-out key *name* is
  /// trimmed and lowercased.
  ///
  /// Trimming first is what broke typing: `" "` trimmed to the empty string,
  /// matched nothing, and every space in a line went out as keycode 0 — the `A`
  /// key — so `hello world` arrived as `helloaworld`.
  static func code(for key: String) -> CGKeyCode? {
    if key.count == 1, let character = key.first {
      return keystroke(for: character)?.code
    }
    let trimmed = key.trimmingCharacters(in: .whitespaces).lowercased()
    if let named = named[trimmed] { return named }
    if trimmed.count == 1, let character = trimmed.first { return keystroke(for: character)?.code }
    return nil
  }

  /// The physical key and shift state that produces `character` on a US layout,
  /// or nil for anything the ANSI tables cannot express — an accented or CJK
  /// character — which the caller sends as a Unicode payload instead.
  static func keystroke(for character: Character) -> (code: CGKeyCode, shift: Bool)? {
    if let code = whitespace[character] { return (code, false) }
    if let code = ansi[character] { return (code, false) }
    if let code = shiftedAnsi[character] { return (code, true) }
    // Upper case is the one shift relationship worth deriving rather than
    // tabulating. Guarded on a single-scalar lowercase, because some scripts
    // lower one character into two.
    let lowered = String(character).lowercased()
    if lowered.count == 1, let single = lowered.first, single != character,
      let code = ansi[single]
    {
      return (code, true)
    }
    return nil
  }
}
