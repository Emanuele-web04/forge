// synara-computer-helper — the native side of Synara's macOS computer use.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio (one object per line),
// the same wire the device helper and Codex app-server speak, so the Node side
// reuses `@synara/shared/jsonrpc-stdio`. There is no frame socket: Tier-1
// capture is a whole-desktop PNG still that the Node backend publishes on a
// timer, exactly as the KWin backend does.
//
// Requests are read on the stdin thread and run on one of three lanes (see
// Dispatch.swift): input in arrival order, perception concurrently, the AX walk
// alone. Responses may therefore complete out of order — the id correlates them
// and `writeMessage` serialises the writes.
//
// Every coordinate on the wire is global top-left screen points. See
// Geometry.swift, and docs/computer-use-macos-reference.md for the mechanism.

import AppKit
import Foundation

let arguments = CommandLine.arguments

// One-shot permission commands never start the JSON-RPC server or overlay.
if arguments.contains("--probe") || arguments.contains("--request-permissions") {
  var payload = arguments.contains("--request-permissions")
    ? Capability.requestPermissions()
    : Capability.report()
  payload["ok"] = true
  if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
  exit(0)
}

// The app must be an accessory (no Dock icon, no menu bar) so a background helper
// that draws an overlay never steals activation or appears as a running app.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Screen geometry is read from AppKit, which is main-thread API, and then
// served to every lane from an immutable snapshot. Primed here, before any lane
// exists, and refreshed on the display-parameters notification.
Geometry.startObservingScreenChanges()

let cursor = AgentCursor()
cursor.install()
let input = InputController(cursor: cursor)
let spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
) { _ in
  InputCancellation.cancelActions()
  Windows.invalidate()
  cursor.hide()
}

// MARK: - Dispatch

func handle(method: String, params: Params) throws -> Any {
  switch method {
  case "ping":
    return ["ok": true, "pid": ProcessInfo.processInfo.processIdentifier]

  case "capabilities":
    return Capability.report()

  case "request-permissions":
    // Ask macOS for whatever this process is still missing, and answer with the
    // same report `capabilities` returns.
    //
    // This is the live twin of the one-shot `--request-permissions` command, and
    // it exists because the one-shot form could only ever be run by something
    // other than the process that drives the desktop. The grant is attributed to
    // the responsible process — Synara — either way (see Capability.swift), so
    // asking from the long-lived helper puts the prompt in front of the user at
    // the moment an agent actually needs it instead of at the moment somebody
    // presses a button in Settings.
    //
    // `Capability.requestPermissions()` prompts only for a grant that is
    // genuinely absent, so a repeat call on a granted Mac is a plain report.
    return Capability.requestPermissions()

  case "list-windows":
    // The helper's own overlay is not in this list, and must not be: see
    // Windows.swift.
    let windows = Windows.list()
    // Window *titles* come from the Screen Recording grant, and without it
    // `CGWindowListCopyWindowInfo` simply omits them. The list is then a set of
    // untitled rectangles — and because an untitled off-screen window is
    // unaddressable and therefore dropped, every minimized or off-Space window
    // disappears from it too. That is a degraded answer, not an empty desktop,
    // and it used to be reported as if it were the truth.
    let screenRecording = CGPreflightScreenCaptureAccess()
    if windows.isEmpty && !screenRecording {
      throw RPCError(
        .permissionDenied,
        "Screen Recording is not granted to this app, so no windows can be enumerated")
    }
    // The focused application's front window — asked once, and the same answer
    // fills every window's `focused` flag, so the two can never disagree. Nil
    // when the front application owns no window the agent may drive (Synara
    // itself, or an app showing only a panel).
    let focused = input.currentKeyboardTarget()
    let active = Windows.frontmost()
    // `minimized` is the owning application's own answer, and it is only asked
    // about windows WindowServer is not compositing — an on-screen window is
    // never minimized. See `Accessibility.minimizedWindowIDs`: deriving it from
    // `!onScreen`, which is what this used to report, called every window on
    // another Space minimized.
    let minimized = Accessibility.minimizedWindowIDs(among: windows.filter { !$0.onScreen })
    let payload = windows.map { window in
      Windows.dictionary(
        window, occluders: Windows.occluders(of: window, in: windows),
        focusedWindowID: focused?.windowNumber, activeWindowID: active?.windowNumber,
        minimized: minimized.contains(window.windowNumber))
    }
    var result: [String: Any] = [
      "windows": payload,
      "workspace": Geometry.rectDictionary(Geometry.workspaceRect()),
      "focusedWindowId": focused.map { String($0.windowNumber) } as Any? ?? NSNull(),
    ]
    if !screenRecording {
      // Additive and only present when it is true, so an older caller is
      // unaffected: this list has no titles and is missing every window that is
      // not currently composited.
      result["titlesUnavailable"] = true
    }
    return result

  case "screen-size":
    let rect = Geometry.workspaceRect()
    var payload = Geometry.rectDictionary(rect)
    payload["scale"] = Double(Geometry.scaleFactor(for: rect))
    return payload

  case "describe-ui":
    return try Accessibility.describeDesktop(
      maxDepth: params.optionalInt("maxDepth", default: 40),
      windowIds: try windowIdSet(from: params, key: "windowIds"))

  case "capture":
    let maxDimension = params.optionalInt("maxDimension", default: 2048)
    let prefer = params.optionalString("source").flatMap { Capture.Source(rawValue: $0) }
    let kind = try params.string("kind")
    let result: Capture.Result
    switch kind {
    case "window":
      let windowId = try params.string("windowId")
      guard let number = UInt32(windowId) else {
        throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
      }
      result = try Capture.window(
        CGWindowID(number), maxDimension: maxDimension, prefer: prefer)
    case "region":
      guard let rect = params.rect("region") else {
        throw RPCError(.invalidParams, "region capture needs a {x,y,width,height} rect")
      }
      result = try Capture.region(rect, maxDimension: maxDimension, prefer: prefer,
        deduplicate: params.raw["deduplicate"] as? Bool == true, force: params.raw["force"] as? Bool == true)
    default:
      throw RPCError(.invalidParams, "capture kind must be 'window' or 'region'")
    }
    return [
      "base64": result.pngBase64 as Any? ?? NSNull(),
      "unchanged": result.pngBase64 == nil,
      "region": Geometry.rectDictionary(result.region),
      // Which link of the capture chain served this, so the backend can track
      // the fallback rate as a health metric.
      "source": result.source.rawValue,
    ]

  case "launch-app":
    return try launchApp(app: try params.string("app"), arguments: params.stringArray("arguments"))

  case "check-input-ready":
    try Windows.requireInputSpace(try windowId(from: params))
    return ["ready": true]

  case "move":
    let point = try point(from: params)
    try input.move(to: point, window: try optionalWindowId(from: params))
    return ["x": Double(point.x), "y": Double(point.y)]

  case "click":
    let point = try point(from: params)
    return pointerResult(
      point,
      try input.click(
        at: point, window: try optionalWindowId(from: params),
        modifiers: try pointerModifiers(from: params)))

  case "double-click":
    let point = try point(from: params)
    return pointerResult(
      point,
      try input.click(
        at: point, count: 2, window: try optionalWindowId(from: params),
        modifiers: try pointerModifiers(from: params)))

  case "triple-click":
    // Three clicks the target reads as *one* triple-click. The click state is
    // pinned at 3 through the down and the up of all three pairs rather than
    // counting 1, 2, 3: a text view that reads the count off each pair would
    // otherwise place a caret, then select a word, then select the line — three
    // visible intermediate states for one gesture — and a toolkit that reads it
    // off only the down, or only the up, would see three unrelated clicks. What
    // the agent asked for is the end state, so every event of the gesture says
    // so. Everything else is `click`: the same input lane, the same clamp and
    // echo, the same aim (it points the keyboard at the window it hit), the same
    // targetMissing and invalidParams rules, and the same delivery verdict.
    let point = try point(from: params)
    return pointerResult(
      point,
      try input.click(
        at: point, count: 3, clickState: 3, window: try optionalWindowId(from: params),
        modifiers: try pointerModifiers(from: params)))

  case "right-click":
    let point = try point(from: params)
    return pointerResult(
      point,
      try input.rightClick(
        at: point, window: try optionalWindowId(from: params),
        modifiers: try pointerModifiers(from: params)))

  case "drag":
    let from = Geometry.clampToWorkspace(
      CGPoint(x: try params.double("fromX"), y: try params.double("fromY")))
    let to = Geometry.clampToWorkspace(
      CGPoint(x: try params.double("toX"), y: try params.double("toY")))
    // Background drag is best effort (no toolkit in the reference ledger delivers
    // it); `foreground: true` brings the target forward for the gesture instead.
    let mode: DeliveryMode = (params.raw["foreground"] as? Bool) == true ? .foreground : .background
    // The rung that ran, not the one requested: a background drag into an app
    // known to drop them is promoted, and reporting the request would tell the
    // agent the gesture was invisible when it was not.
    let resolved = try input.drag(
      from: from, to: to, durationMs: params.optionalInt("durationMs", default: 220), mode: mode,
      window: try optionalWindowId(from: params))
    return ["ok": true, "path": resolved.path, "verified": resolved.verified.rawValue,
      "windowId": input.currentKeyboardTarget().map { String($0.windowNumber) } as Any? ?? NSNull()]

  case "scroll":
    let x = params.optionalDouble("x")
    let y = params.optionalDouble("y")
    let point =
      (x != nil && y != nil) ? Geometry.clampToWorkspace(CGPoint(x: x!, y: y!)) : nil
    let scrolled = try input.scroll(
      at: point, deltaX: try params.double("deltaX"), deltaY: try params.double("deltaY"),
      window: try optionalWindowId(from: params),
      modifiers: try pointerModifiers(from: params))
    return ["ok": true, "path": scrolled.path, "verified": scrolled.verified.rawValue,
      "windowId": input.currentKeyboardTarget().map { String($0.windowNumber) } as Any? ?? NSNull()]

  case "type":
    try aimKeyboard(from: params)
    let outcome = try input.typeText(
      try params.text("text"), mode: try DeliveryMode(param: params.optionalString("deliveryMode")))
    return ["ok": true, "path": outcome.path, "verified": outcome.verified.rawValue,
      "windowId": input.currentKeyboardTarget().map { String($0.windowNumber) } as Any? ?? NSNull()]

  case "press-key":
    try aimKeyboard(from: params)
    let pressed = try input.pressKey(
      try params.string("key"), modifiers: params.stringArray("modifiers"),
      mode: try DeliveryMode(param: params.optionalString("deliveryMode")))
    return ["ok": true, "path": pressed.path, "verified": pressed.verified.rawValue,
      "windowId": input.currentKeyboardTarget().map { String($0.windowNumber) } as Any? ?? NSNull()]

  case "hotkey":
    try aimKeyboard(from: params)
    let keys = params.stringArray("keys")
    guard !keys.isEmpty else { throw RPCError(.invalidParams, "hotkey needs a non-empty keys array") }
    let chord = try input.hotkey(
      keys, mode: try DeliveryMode(param: params.optionalString("deliveryMode")))
    return ["ok": true, "path": chord.path, "verified": chord.verified.rawValue,
      "windowId": input.currentKeyboardTarget().map { String($0.windowNumber) } as Any? ?? NSNull()]

  case "set-value":
    let windowId = try windowId(from: params)
    try showSemanticTarget(params)
    let verified = try Accessibility.setValue(
      windowId: windowId, path: intArray(params, "nodePath"), value: try params.text("value"), accessibilityRoot: params.optionalString("accessibilityRoot") ?? "window",
      expectedRole: params.optionalString("expectedRole"), expectedLabel: params.optionalString("expectedLabel"))
    return ["ok": true, "path": "accessibility", "verified": verified.rawValue, "windowId": String(windowId)]

  case "perform-action":
    let windowId = try windowId(from: params)
    if params.optionalString("action") != "AXScrollToVisible" { try showSemanticTarget(params) }
    let activeBefore = SkyLight.frontmostPID()
    try Accessibility.performAction(
      windowId: windowId, path: intArray(params, "nodePath"), action: try params.string("action"), accessibilityRoot: params.optionalString("accessibilityRoot") ?? "window",
      expectedRole: params.optionalString("expectedRole"), expectedLabel: params.optionalString("expectedLabel"))
    return ["ok": true, "windowId": String(windowId),
      "path": activeBefore == SkyLight.frontmostPID() ? "accessibility" : "foreground-accessibility",
      "verified": "unverifiable"]

  case "clear-focus-window":
    input.setKeyboardTarget(nil)
    return ["ok": true]

  case "focus-window":
    // Raising and keyboard aim are separate, so a hover can reveal a window
    // without redirecting subsequent typing.
    let focusId = try windowId(from: params)
    guard let focusTarget = Windows.window(withNumber: focusId) else {
      throw RPCError(.targetMissing, "no window has id \(focusId)")
    }
    try Accessibility.focusWindowForKeyboard(focusTarget)
    input.setKeyboardTarget(focusTarget)
    return ["ok": true]

  case "raise-window":
    try raiseWindow(windowId: try windowId(from: params))
    return ["ok": true]

  case "read-clipboard":
    // Truncate at the source. A clipboard holding a whole document would
    // otherwise be base64'd through the line framer before the Node side got a
    // chance to refuse it.
    let clipboard = NSPasteboard.general.string(forType: .string) ?? ""
    let maxBytes = params.optionalInt("maxBytes", default: 0)
    if maxBytes > 0, clipboard.utf8.count > maxBytes {
      return ["text": "", "truncated": true, "byteLength": clipboard.utf8.count]
    }
    return ["text": clipboard, "truncated": false]

  case "write-clipboard":
    // Read the parameter before clearing: validating afterwards destroyed the
    // human's clipboard and then failed the call.
    let clipboardText = try params.text("text")
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(clipboardText, forType: .string)
    return ["ok": true]

  case "set-agent-cursor":
    cursor.setName(params.optionalString("name") ?? "", activity: params.optionalString("activity") ?? "")
    return ["ok": true]

  default:
    throw RPCError(.methodNotFound, "unknown method '\(method)'")
  }
}

// MARK: - Method helpers

func showSemanticTarget(_ params: Params) throws {
  try input.requireInputPermission()
  try Windows.requireInputSpace(try windowId(from: params))
  // One RPC both shows the target and performs the semantic action. No hover
  // event is injected, since it could open a menu and invalidate the AX path.
  guard params.raw["x"] != nil || params.raw["y"] != nil else { return }
  let target = try point(from: params)
  try InputCancellation.check()
  cursor.glide(to: target, window: Windows.window(withNumber: try windowId(from: params)))
  try InputCancellation.check()
}

func aimKeyboard(from params: Params) throws {
  guard let id = try optionalWindowId(from: params) else { return }
  guard let window = Windows.window(withNumber: id) else {
    throw RPCError(.targetMissing, "no window has id \(id)")
  }
  try Accessibility.focusWindowForKeyboard(window)
  input.setKeyboardTarget(window)
}


/// The window the caller named for this action, if any. Absent means "whatever
/// is topmost at the point", which is how a bare coordinate behaves.
///
/// A `windowId` that is present but unreadable is a bad request, not an absent
/// one. Returning nil for it — which this used to do for a numeric JSON value,
/// or any typo — quietly demoted a window-scoped click to "whatever is topmost
/// at this coordinate", so a click the agent aimed into a partially covered
/// window landed in whatever was drawn over it.
func optionalWindowId(from params: Params) throws -> CGWindowID? {
  guard let raw = params.raw["windowId"], !(raw is NSNull) else { return nil }
  guard let id = windowIdentifier(from: raw) else {
    throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
  }
  return id
}

/// The modifier keys a pointer gesture holds down for its duration.
///
/// Read before the gesture reaches `InputController`, so an unreadable name is
/// `invalidParams` with nothing posted — not a modifier silently dropped from a
/// gesture that then runs as something else. Absent, null and `[]` all mean the
/// same thing and produce the same event stream the method produced before the
/// parameter existed.
func pointerModifiers(from params: Params) throws -> [(code: CGKeyCode, flags: CGEventFlags)] {
  guard let raw = params.raw["modifiers"], !(raw is NSNull) else { return [] }
  guard let entries = raw as? [Any] else {
    throw RPCError(.invalidParams, "modifiers must be an array of modifier names")
  }
  // `stringArray` would `compactMap` a non-string entry away, which is the same
  // silent narrowing the window-id readers were fixed for: `[1]` would arrive as
  // "no modifiers" and the gesture would run unmodified.
  let names = try entries.map { entry -> String in
    guard let name = entry as? String else {
      throw RPCError(.invalidParams, "modifiers must be an array of modifier names")
    }
    return name
  }
  return try KeyMap.pointerModifiers(for: names)
}

/// One reading of a window id, whatever shape JSON delivered it in, and it is
/// deliberately strict.
///
/// The two readers this replaces were both loose in ways that turn a bad request
/// into a wrong action. `int64Value` on an `NSNumber` truncates, so `12.7`
/// resolved to window 12 — a real, different window; `true` is an `NSNumber`
/// too, and resolved to window 1. And the `describe-ui` reader took
/// `number.uint32Value` with no range check at all, so `-1` wrapped to
/// 4294967295 and a filter the caller thought named one window silently named
/// none. A value that is not an exact, in-range, non-negative integer is a bad
/// request; the caller finds out.
func windowIdentifier(from raw: Any) -> CGWindowID? {
  if let text = raw as? String {
    return UInt32(text).map { CGWindowID($0) }
  }
  guard let value = raw as? NSNumber else { return nil }
  // `JSONSerialization` hands booleans back as `NSNumber`s wrapping
  // `CFBoolean`; without this `true` reads as window 1.
  if CFGetTypeID(value) == CFBooleanGetTypeID() { return nil }
  let double = value.doubleValue
  guard double.isFinite, double >= 0, double <= Double(UInt32.max),
    double == double.rounded(.towardZero)
  else { return nil }
  return CGWindowID(value.uint32Value)
}

/// A requested point, clamped onto the desktop.
///
/// The helper used to echo whatever it was given, which made the backend's
/// `clampedTo` reporting structurally dead: request and answer were the same
/// number by construction. Worse, a coordinate off the desktop resolved no
/// target window and the action silently did nothing. Clamping onto the
/// workspace makes the action land somewhere real and makes the echoed point an
/// honest answer to "where did this go", which is what the backend compares.
func point(from params: Params) throws -> CGPoint {
  let requested = CGPoint(x: try params.double("x"), y: try params.double("y"))
  return Geometry.clampToWorkspace(requested)
}

/// The reply every pointer gesture makes: where it went, which rung took it
/// there, and what the delivery watch was able to observe. The helper knew the
/// last two and used to drop them, so a click that reached nothing and one the
/// target visibly reacted to were the same reply.
func pointerResult(_ point: CGPoint, _ outcome: PointerOutcome) -> [String: Any] {
  [
    "x": Double(point.x),
    "y": Double(point.y),
    "path": outcome.path,
    "verified": outcome.verified.rawValue,
  ]
}

func windowId(from params: Params) throws -> CGWindowID {
  guard let number = UInt32(try params.string("windowId")) else {
    throw RPCError(.invalidParams, "windowId must be a numeric CGWindowID")
  }
  return CGWindowID(number)
}

/// An optional window-id filter: absent means "every window".
///
/// An entry that cannot be read is an error, not a dropped filter term. Dropping
/// it silently narrowed the walk to the ids that happened to parse — or, when
/// every entry was unreadable, to the empty set, which `describe-ui` serves as
/// "no windows at all" rather than as the whole desktop the caller thought it
/// had asked for.
func windowIdSet(from params: Params, key: String) throws -> Set<CGWindowID>? {
  guard let raw = params.raw[key] else { return nil }
  if raw is NSNull { return nil }
  guard let entries = raw as? [Any] else {
    throw RPCError(.invalidParams, "\(key) must be an array of numeric CGWindowIDs")
  }
  var ids: Set<CGWindowID> = []
  for entry in entries {
    guard let id = windowIdentifier(from: entry) else {
      throw RPCError(.invalidParams, "\(key) contains an entry that is not a numeric CGWindowID")
    }
    ids.insert(id)
  }
  return ids
}

func intArray(_ params: Params, _ key: String) -> [Int] {
  (params.raw[key] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue } ?? []
}

/// How long `open` may take to hand a launch off before the input lane gives up.
let launchDeadlineSeconds: Double = 10

func launchApp(app: String, arguments: [String]) throws -> [String: Any] {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  // `-a` opens by application name or path; anything after `--args` is passed to
  // the launched app. `open` returns as soon as the launch is handed off.
  var args = ["-g", "-a", app]
  if !arguments.isEmpty {
    args.append("--args")
    args.append(contentsOf: arguments)
  }
  process.arguments = args
  // `open` normally returns as soon as the launch is handed off, but it can sit
  // there — a first launch of a quarantined app puts up a system dialog, and a
  // wedged LaunchServices does not answer at all. `waitUntilExit()` is
  // unbounded, and this runs on the serial input lane, so that one call used to
  // hold every subsequent click and keystroke behind it for as long as the
  // subprocess lived. Same deadline shape the capture fallback uses.
  let finished = DispatchSemaphore(value: 0)
  process.terminationHandler = { _ in finished.signal() }
  do {
    try process.run()
  } catch {
    throw RPCError(.internalError, "could not launch \(app): \(error.localizedDescription)")
  }
  if finished.wait(timeout: .now() + launchDeadlineSeconds) == .timedOut {
    process.terminate()
    _ = finished.wait(timeout: .now() + 1)
    throw RPCError(
      .internalError, "launching \(app) exceeded its \(launchDeadlineSeconds)s deadline")
  }
  guard process.terminationStatus == 0 else {
    throw RPCError(.targetMissing, "no application named \(app) could be opened")
  }
  return ["resolvedCommand": "open -g -a \(app)"]
}

/// Compatibility endpoint: an already revealed window needs no action. Never
/// raise another window, since even AXRaise may activate its application.
func raiseWindow(windowId: CGWindowID) throws {
  try input.requireInputPermission()
  guard let window = Windows.window(withNumber: windowId) else {
    throw RPCError(.targetMissing, "no window has id \(windowId)")
  }
  guard window.onScreen else {
    throw RPCError(.notDelivered, "window \(windowId) is not on the current desktop")
  }
  if input.currentKeyboardTarget()?.windowNumber == windowId, Windows.isRevealed(window) {
    Windows.invalidate()
    return
  }
  // Raising another app can activate it even through AXRaise. Refuse rather
  // than move the user's windows; input recovery must not take over the desktop.
  if Windows.isRevealed(window) { return }
  throw RPCError(.notDelivered, "window \(windowId) is covered; refusing to raise or activate it")
}

// MARK: - Shutdown

/// Never leave a button or a modifier latched for the human: whatever the reason
/// this process is going away, the matching up events go out first.
func shutdown(_ code: Int32) -> Never {
  // Best effort, and only meaningful when this runs on the main queue (the
  // signal sources do). From the stdin reader the `exit` below takes the window
  // down before the hop could run, which is the same outcome.
  cursor.hide()
  input.unwind()
  exit(code)
}

// MARK: - stdin loop

func handleLine(_ line: Data) {
  guard !line.isEmpty else { return }
  let parsed: Any
  do {
    parsed = try JSONSerialization.jsonObject(with: line)
  } catch {
    writeError(
      id: NSNull(), code: .parseError, message: "invalid JSON: \(error.localizedDescription)")
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
  if method == "cancel-request" {
    InputCancellation.cancel(params.raw["id"])
    return
  }
  let cancellation = InputCancellation.register(id, isAction: Lanes.isAction(method))
  // Parsing happens on the reader thread; the work itself goes to the lane that
  // owns this method so a capture never queues behind a click, or vice versa.
  Lanes.queue(for: method).async {
    InputCancellation.enter(cancellation)
    defer { InputCancellation.finish(id) }

    // The overlay hides itself a few seconds after the agent stops acting, so
    // an idle helper — which on a Mac with the Computer pane open means most of
    // the session — is not leaving a second arrow on the human's desktop. Armed
    // per completed *action*: a perception call must not keep it alive, or the
    // pane's own 2 Hz polling would hold the arrow on screen forever.
    defer { if Lanes.isAction(method) { cursor.markIdle() } }
    do {
      try InputCancellation.check()
      let result = try handle(method: method, params: params)
      writeResult(id: id, result: result)
    } catch let error as RPCError {
      writeError(id: id, code: error.code, message: error.message)
    } catch {
      writeError(id: id, code: .internalError, message: error.localizedDescription)
    }
  }
}

Lanes.reader.async {
  let stdin = FileHandle.standardInput
  var buffer = Data()
  while true {
    let chunk = stdin.availableData
    if chunk.isEmpty { break }  // stdin closed: the server is shutting down.
    buffer.append(chunk)
    while let newline = buffer.firstIndex(of: 0x0a) {
      let line = buffer.subdata(in: buffer.startIndex..<newline)
      buffer.removeSubrange(buffer.startIndex...newline)
      handleLine(line)
    }
  }
  shutdown(0)
}

var signalSources: [DispatchSourceSignal] = []
for signalNumber in [SIGTERM, SIGINT] {
  signal(signalNumber, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
  source.setEventHandler { shutdown(0) }
  source.resume()
  signalSources.append(source)
}

writeNotification(method: "ready", params: ["protocolVersion": 1])

// AppKit main loop drives the overlay window; RPC runs on the lane queues.
app.run()
