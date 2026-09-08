// Window enumeration via CGWindowList.
//
// The on-screen window list is the macOS analog of the KWin plugin's window
// document: id, title, owning app + pid, global bounds, and a stacking order.
// CGWindowListCopyWindowInfo already returns windows front-to-back, which gives
// a stacking index for free and lets the input path resolve which window a bare
// coordinate would hit.
//
// Two properties this file is responsible for:
//
//   1. **No helper instance's windows are in the list.** The Software Cursor
//      overlay is a normal-level NSWindow parked exactly at the point the agent
//      is about to act on and ordered frontmost, so an unfiltered `topmost(at:)`
//      resolves *our own overlay* as the click target and `CGEventPostToPid`
//      delivers the click back to this process — the action silently never
//      reaches the app. Filtering by pid here keeps the overlay out of
//      `list-windows`, occluder computation, `describe-ui`, and every hit test
//      at once. (It stays visible in captures: that is the point of the overlay,
//      and `sharingType = .readOnly` keeps it in the frame.) A *second* copy of
//      the helper is filtered the same way, by executable path — see
//      `isHelperProcess`.
//   2. **One CGWindowList round trip per gesture.** A click resolves a target,
//      stamps it on two events, and re-checks it for keyboard routing; a drag
//      does that plus one event per step. A ~30 ms memo makes the repeats free
//      while staying short enough that the next gesture sees the stacking the
//      previous one changed.

import AppKit
import CoreGraphics
import Darwin
import Dispatch
import Foundation

struct DesktopWindow {
  let windowNumber: CGWindowID
  let ownerPID: pid_t
  let title: String
  let appName: String
  let bounds: CGRect
  let stackingIndex: Int
  /// Whether WindowServer is compositing this window right now. **Not** the same
  /// question as "is it minimized": a window on another Space is off screen and
  /// perfectly un-minimized. There used to be a second stored `minimized` field
  /// here holding exactly `!onScreen`, which is how `list-windows` came to report
  /// eight of ten windows as minimized on an ordinary two-Space desktop. The
  /// honest answer needs accessibility and is computed only where it is
  /// reported — see `Accessibility.minimizedWindowIDs`.
  let onScreen: Bool
}

enum Windows {
  /// This helper's own pid. Every window it owns is excluded from the list — see
  /// the file header: the agent must never target its own overlay.
  private static let ownProcessID = ProcessInfo.processInfo.processIdentifier

  /// The file name of this helper binary. Any other process running the same
  /// executable is a sibling helper whose windows are excluded too.
  private static let helperExecutableName: String = {
    if let bundled = Bundle.main.executableURL?.lastPathComponent, !bundled.isEmpty {
      return bundled
    }
    if let argv0 = ProcessInfo.processInfo.arguments.first, !argv0.isEmpty {
      let name = URL(fileURLWithPath: argv0).lastPathComponent
      if !name.isEmpty { return name }
    }
    return "synara-computer-helper"
  }()

  /// Every process this helper descends from.
  ///
  /// The helper is spawned by Synara's backend, which is itself a child of the
  /// Synara app, so walking the parent chain names both without needing to know
  /// a bundle id — and it is correct in a development checkout, where the helper
  /// lives outside any `Synara.app`, as well as in a packaged build.
  ///
  /// Synara's own windows have to be excluded for the same reason the helper's
  /// overlay is: an agent that can drive the app driving it can approve its own
  /// approval dialogs, close the window it is being watched through, or type
  /// into the composer that is instructing it. The design reference lists
  /// "cannot drive Synara itself" as a limit; without this it was not one.
  private static let ancestorProcessIDs: Set<pid_t> = {
    var chain: Set<pid_t> = []
    var current = ProcessInfo.processInfo.processIdentifier
    // Bounded: a runaway or cyclic parent chain must not hang startup.
    for _ in 0..<16 {
      var info = proc_bsdinfo()
      let size = MemoryLayout<proc_bsdinfo>.size
      let read = proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info, Int32(size))
      guard read == Int32(size) else { break }
      let parent = pid_t(info.pbi_ppid)
      guard parent > 1, !chain.contains(parent) else { break }
      chain.insert(parent)
      current = parent
    }
    return chain
  }()

  /// Synara's own bundle identifiers, production and development.
  ///
  /// The ancestor walk above catches the normal case, where this helper is a
  /// descendant of the app. This catches the rest — a helper started out of band
  /// for a bench run, or a second Synara the user also has open — because
  /// "the agent must not drive Synara" is a property of the app, not of who
  /// happened to spawn the helper. Matching is by identifier and by `.dev`
  /// suffix so the development build is covered without a second constant.
  private static let hostBundlePrefix = "com.emanueledipietro.synara"

  /// `NSRunningApplication` is documented as returning its properties
  /// atomically, so this is safe from the enumeration whichever lane runs it;
  /// it is the one piece of AppKit this file touches off the main thread.
  ///
  /// Memoised on the same terms as `helperProcessCache`: this is asked once per
  /// window per enumeration *and* once per shareable window on every capture
  /// (see `Capture.hostWindows`), which with the pane open is a few hundred
  /// `NSRunningApplication` lookups a second for an answer that does not change.
  private static func isHostApplication(_ pid: pid_t) -> Bool {
    cacheLock.lock()
    if let cached = hostApplicationCache[pid] {
      cacheLock.unlock()
      return cached
    }
    cacheLock.unlock()

    let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    let isHost =
      bundle == hostBundlePrefix || bundle?.hasPrefix("\(hostBundlePrefix).") == true

    cacheLock.lock()
    if hostApplicationCache.count >= helperProcessCacheLimit { hostApplicationCache.removeAll() }
    hostApplicationCache[pid] = isHost
    cacheLock.unlock()
    return isHost
  }

  /// Whether `pid` belongs to the application this helper is running on behalf
  /// of — Synara itself, or one of the processes it was spawned through.
  ///
  /// Exposed because two subsystems need the same answer for the same reason.
  /// `enumerate()` uses it to keep Synara out of every hit test, and
  /// `Capture` uses it to keep Synara's own windows out of the whole-desktop
  /// still: the Computer pane is drawn from those stills, so leaving it in the
  /// frame made every still differ from the last (the pane had just redrawn the
  /// previous one), which defeated the byte-identity dedupe on the Node side and
  /// mirrored the pane inside itself.
  static func isHostOwned(_ pid: pid_t) -> Bool {
    ancestorProcessIDs.contains(pid) || isHostApplication(pid)
  }

  private static let cacheLock = NSLock()
  private static var cachedWindows: [DesktopWindow] = []
  private static var cachedAt: UInt64 = 0
  private static var hasCache = false
  /// `pid -> is this pid running our own executable`. Resolving a path costs a
  /// syscall per window per enumeration otherwise. Pids are recycled rarely
  /// enough that a stale entry is a non-issue, and the map is dropped wholesale
  /// once it grows past a desktop's worth of processes.
  private static var helperProcessCache: [pid_t: Bool] = [:]
  /// The same memo for "is this pid Synara" — see `isHostApplication`.
  private static var hostApplicationCache: [pid_t: Bool] = [:]
  private static let helperProcessCacheLimit = 256
  /// `PROC_PIDPATHINFO_MAXSIZE` (`4 * MAXPATHLEN`) from `<sys/proc_info.h>`. The
  /// macro itself does not survive the Swift importer, so it is restated here.
  private static let processPathMaxLength = 4 * 1024
  /// Memo lifetime. Long enough that one gesture shares a single enumeration,
  /// short enough that a raise or a click that restacks is visible immediately
  /// afterwards.
  private static let cacheTTLNanoseconds: UInt64 = 30_000_000

  /// The current on-screen window list, front-to-back, filtered to real
  /// application windows (normal window layer, non-zero size) owned by some
  /// *other* process. Menus, the Dock, and the wallpaper are dropped: an agent
  /// drives application windows, and a desktop-layer surface is exactly the
  /// "click landed on wallpaper" trap the Linux runs hit.
  static func list() -> [DesktopWindow] {
    snapshot(maxAgeNanoseconds: cacheTTLNanoseconds)
  }

  /// A guaranteed-fresh enumeration, for the few places that must observe a
  /// stacking change they just caused (`raise-window`).
  static func fresh() -> [DesktopWindow] {
    snapshot(maxAgeNanoseconds: 0)
  }

  /// Never select or inject into a window outside the user's current Space.
  /// Use a fresh snapshot: the regular cache can survive a Space transition.
  static func requireInputSpace(_ number: CGWindowID, ownerPID: pid_t? = nil) throws {
    try InputCancellation.check()
    // Query only this window. Full enumeration also sorts every window and
    // resolves application metadata; doing that for each key event adds latency.
    guard let entries = CGWindowListCopyWindowInfo(.optionIncludingWindow, number)
      as? [[String: Any]],
      let entry = entries.first(where: {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == number
      }), let currentPID = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
      ownerPID == nil || currentPID == ownerPID else {
      throw RPCError(.targetMissing, "The input target closed or changed owner")
    }
    guard (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true else {
      throw RPCError(.inactiveSpace,
        "Input paused: the target window is outside the current Space or minimized. "
        + "Do not retry input, activate the app, or switch Spaces. Screenshots remain available; "
        + "resume input only after the user returns the target to the current Space.")
    }
  }

  /// Check stacking, not keyboard focus. Include Synara here: it can hide the
  /// target even though it is deliberately absent from the agent's window list.
  static func isRevealed(_ window: DesktopWindow) -> Bool {
    guard let entries = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return false }
    for entry in entries {
      guard let number = entry[kCGWindowNumber as String] as? NSNumber else { continue }
      if number.uint32Value == window.windowNumber { return true }
      guard let pid = entry[kCGWindowOwnerPID as String] as? NSNumber,
        pid.int32Value != ownProcessID, !isHelperProcess(pid.int32Value),
        (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
        (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue != 0,
        let raw = entry[kCGWindowBounds as String] as? [String: Any],
        let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary)
      else { continue }
      if bounds.intersects(window.bounds) { return false }
    }
    return false
  }

  /// Drop the memo so the next `list()` re-enumerates.
  static func invalidate() {
    cacheLock.lock()
    hasCache = false
    cacheLock.unlock()
  }

  /// The window whose id matches, if any.
  static func window(withNumber number: CGWindowID) -> DesktopWindow? {
    list().first { $0.windowNumber == number }
  }

  /// The focused application's frontmost on-screen window, or nil.
  ///
  /// This used to be "the first on-screen window in the list", which is the
  /// *stacking*-topmost one — and that is not the same question. A floating
  /// panel belonging to some other application sits above everything without
  /// being focused at all, so with Terminal frontmost the helper reported a
  /// ChatGPT window as the focused one, and every caller that used this to
  /// decide "is my target the front app" or "where do unaimed keys go" was
  /// answered with a window the human was not using.
  ///
  /// Focus is a property of the process, so the process is what is asked:
  /// WindowServer's front pid, then that pid's frontmost on-screen window.
  /// There is deliberately no fallback to the topmost window — a front
  /// application with no window in this list (Synara itself, the helper, an app
  /// showing only a panel) has no answer, and inventing one is the bug above.
  static func frontmost() -> DesktopWindow? {
    guard let pid = SkyLight.frontmostPID() else { return nil }
    return list().first { $0.onScreen && $0.ownerPID == pid }
  }

  /// The topmost window whose bounds contain `point` — what an unscoped click at
  /// that global point would be delivered to.
  static func topmost(at point: CGPoint) -> DesktopWindow? {
    // `list()` is front-to-back, so the first hit is the topmost.
    list().first { $0.onScreen && $0.bounds.contains(point) }
  }

  /// Ids of the windows above `window` that overlap its bounds, so the backend
  /// can warn that a coordinate click would land elsewhere.
  static func occluders(of window: DesktopWindow, in all: [DesktopWindow]) -> [String] {
    all
      .filter {
        $0.windowNumber != window.windowNumber
          && $0.stackingIndex < window.stackingIndex
          && $0.bounds.intersects(window.bounds)
      }
      .map { String($0.windowNumber) }
  }

  /// `focusedWindowID` is passed in rather than derived per window: it costs one
  /// WindowServer round trip, and every window in a `list-windows` reply is
  /// describing the same instant.
  ///
  /// `minimized` is passed in for a different reason: it is an accessibility
  /// read, not a CGWindowList one (see `Accessibility.minimizedWindowIDs`), and
  /// only the `list-windows` handler is entitled to pay for it. An on-screen
  /// window is never minimized, so only the off-screen ones cost anything.
  static func dictionary(
    _ window: DesktopWindow, occluders: [String], focusedWindowID: CGWindowID?, activeWindowID: CGWindowID? = nil, minimized: Bool
  ) -> [String: Any] {
    var payload: [String: Any] = [
      "id": String(window.windowNumber),
      "title": window.title,
      "appName": window.appName,
      "pid": Int(window.ownerPID),
      "bounds": Geometry.rectDictionary(window.bounds),
      // Truthful now. This was hard-coded false, so `list-windows` reported a
      // desktop in which nothing at all was focused.
      "focused": window.windowNumber == focusedWindowID,
      "active": window.windowNumber == activeWindowID,
      "minimized": minimized,
      "visible": window.onScreen,
      "stackingIndex": window.stackingIndex,
    ]
    if !occluders.isEmpty {
      payload["occludedBy"] = occluders
    }
    return payload
  }

  // MARK: - Internals

  private static func snapshot(maxAgeNanoseconds: UInt64) -> [DesktopWindow] {
    if maxAgeNanoseconds > 0 {
      let now = DispatchTime.now().uptimeNanoseconds
      cacheLock.lock()
      if hasCache, now &- cachedAt <= maxAgeNanoseconds {
        let cached = cachedWindows
        cacheLock.unlock()
        return cached
      }
      cacheLock.unlock()
    }
    // Two threads racing here both enumerate and both store; CGWindowList is
    // cheap and thread-safe, and the loser simply overwrites with an equally
    // fresh list, so the memo needs no in-flight bookkeeping.
    let windows = enumerate()
    cacheLock.lock()
    cachedWindows = windows
    cachedAt = DispatchTime.now().uptimeNanoseconds
    hasCache = true
    cacheLock.unlock()
    return windows
  }

  /// Whether `pid` is another instance of this same helper binary.
  ///
  /// `proc_pidpath` is the cheapest identification available: it needs no
  /// accessibility permission and works for processes with no bundle. A pid we
  /// cannot resolve (exited, or a path we are not entitled to read) is reported
  /// as *not* a helper, so an unidentifiable window stays visible to the agent
  /// rather than silently disappearing.
  private static func isHelperProcess(_ pid: pid_t) -> Bool {
    cacheLock.lock()
    if let cached = helperProcessCache[pid] {
      cacheLock.unlock()
      return cached
    }
    cacheLock.unlock()

    var buffer = [CChar](repeating: 0, count: processPathMaxLength)
    let written = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    let isHelper =
      written > 0
      && URL(fileURLWithPath: String(cString: buffer)).lastPathComponent == helperExecutableName

    cacheLock.lock()
    if helperProcessCache.count >= helperProcessCacheLimit { helperProcessCache.removeAll() }
    helperProcessCache[pid] = isHelper
    cacheLock.unlock()
    return isHelper
  }

  private static func enumerate() -> [DesktopWindow] {
    // The all-window list includes minimized/off-Space windows, but its order
    // can disagree with actual stacking after AXRaise (observed on macOS 27).
    // Use the on-screen snapshot for visual order and current geometry, then
    // append the remaining entries so minimized windows stay discoverable.
    guard
      let all = CGWindowListCopyWindowInfo(
        [.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
      let visible = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return [] }
    let visibleIDs = Set(visible.compactMap {
      ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    })
    let info = visible + all.filter {
      guard let id = ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { return false }
      return !visibleIDs.contains(id)
    }

    var windows: [DesktopWindow] = []
    for entry in info {
      guard
        let number = entry[kCGWindowNumber as String] as? NSNumber,
        let ownerPID = entry[kCGWindowOwnerPID as String] as? NSNumber,
        let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
        let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
      else { continue }

      // The helper's own overlay is a layer-0, normal-sized window sitting on
      // the exact point the agent is acting on: without this line it wins every
      // hit test and every click is posted back to this process.
      let pid = pid_t(ownerPID.int32Value)
      if pid == ownProcessID { continue }
      // Synara itself, and the backend that spawned this helper. See
      // `ancestorProcessIDs`: the agent must not be able to drive the app that
      // is driving it.
      if isHostOwned(pid) { continue }
      // Two helpers can be alive at once — the installed Synara.app keeps its
      // own helper running while a dev server spawns a second one — and the
      // other instance's overlay is exactly as bad a click target as ours. It
      // cannot be recognised by name (both report kCGWindowOwnerName "Synara",
      // the helper bundle's CFBundleName) so match on the owner's executable.
      if isHelperProcess(pid) { continue }

      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
      // Layer 0 is the normal application-window layer. Anything above is a
      // panel/menu/overlay the agent must not treat as a target window.
      if layer != 0 {
        let allowedLayers: Set<Int> = [3, 8, 24, 25, 101]
        guard allowedLayers.contains(layer),
          let app = NSRunningApplication(processIdentifier: pid),
          app.activationPolicy != .prohibited,
          app.bundleIdentifier != "com.apple.loginwindow",
          app.bundleIdentifier != "com.apple.systemuiserver",
          app.bundleIdentifier != "com.apple.controlcenter",
          app.bundleIdentifier != "com.apple.notificationcenterui" else { continue }
      }
      if bounds.width < 1 || bounds.height < 1 { continue }

      let title = (entry[kCGWindowName as String] as? String) ?? ""
      let appName = (entry[kCGWindowOwnerName as String] as? String) ?? ""
      let onScreen = (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
      // An off-screen window is only worth reporting if the agent could name
      // it. Measured on a normal desktop, dropping `.optionOnScreenOnly` turned
      // 6 windows into 54: the other 48 were untitled scratch surfaces owned by
      // AutoFill, Siri, loginwindow and view services, and exactly 2 were real
      // minimized windows — both titled. A title is what separates the two, and
      // an untitled off-screen window is unaddressable anyway.
      if !onScreen && title.isEmpty { continue }

      windows.append(
        DesktopWindow(
          windowNumber: CGWindowID(number.uint32Value),
          ownerPID: pid_t(ownerPID.int32Value),
          title: title,
          appName: appName,
          bounds: bounds,
          stackingIndex: 0,
          onScreen: onScreen))
    }

    // On-screen windows first, in the front-to-back order CGWindowList gave
    // them, so `stackingIndex`, `topmost(at:)`, and occluder computation all
    // keep meaning what they meant. Off-screen windows follow: they are
    // reportable but never a hit-test result.
    var ordered: [DesktopWindow] = []
    for window in windows where window.onScreen { ordered.append(window) }
    for window in windows where !window.onScreen { ordered.append(window) }
    for (position, window) in ordered.enumerated() {
      ordered[position] = DesktopWindow(
        windowNumber: window.windowNumber,
        ownerPID: window.ownerPID,
        title: window.title,
        appName: window.appName,
        bounds: window.bounds,
        stackingIndex: position,
        onScreen: window.onScreen)
    }
    return ordered
  }
}
