// Coordinate-space helpers.
//
// One rule runs through the whole helper: every coordinate on the wire — window
// bounds, AX frames, capture regions, pointer targets — is in **global top-left
// screen space**, in logical points. `CGWindowList`, `AXUIElement`, and
// `CGEvent` already share that space, so an AX-derived target feeds a synthetic
// click with no conversion. AppKit (`NSScreen`, `NSWindow`) is the one subsystem
// with a bottom-left origin, so anything that touches AppKit converts here and
// nowhere else.

import AppKit
import CoreGraphics

enum Geometry {
  /// A point pinned inside the desktop's bounding rect.
  ///
  /// A coordinate outside every display resolves no target window, so the event
  /// is posted nowhere and the action reports success having done nothing.
  /// Clamping puts it on the nearest edge instead, and the caller echoes the
  /// clamped point so the backend can tell the agent the request moved.
  /// Non-finite input collapses to the workspace origin rather than propagating
  /// a NaN through the event fields.
  static func clampToWorkspace(_ point: CGPoint) -> CGPoint {
    let rect = workspaceRect()
    guard point.x.isFinite, point.y.isFinite else { return rect.origin }
    return CGPoint(
      x: min(max(point.x, rect.minX), rect.maxX),
      y: min(max(point.y, rect.minY), rect.maxY))
  }

  /// A rect clipped to the part of it that is actually on a display.
  ///
  /// Unlike a point, a rect cannot be pushed onto the nearest edge and still
  /// mean anything, so this refuses rather than inventing a region: a request
  /// that misses every display has no pixels to return, and pretending it does
  /// hands the Node side a region its image never covered. Refusing is also the
  /// only safe answer for the arithmetic — `Int(1e30)` is a trapping conversion
  /// that aborts the whole helper, and a region that far out used to reach one.
  static func clampRectToWorkspace(_ rect: CGRect) throws -> CGRect {
    guard rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite,
      rect.height.isFinite
    else {
      throw RPCError(.invalidParams, "region must be finite numbers")
    }
    let clipped = rect.standardized.intersection(workspaceRect())
    guard !clipped.isNull, !clipped.isEmpty, clipped.width >= 1, clipped.height >= 1 else {
      throw RPCError(.invalidParams, "region does not intersect the desktop")
    }
    return clipped
  }

  /// The union of every screen's frame, in global top-left points — the
  /// workspace the Node backend translates into its 0-based agent space.
  static func displayFrames() -> [CGRect] { screens().displays.map { $0.frame } }

  static func workspaceRect() -> CGRect {
    screens().workspace
  }

  /// The flip axis for AppKit's bottom-left space: the primary screen's height.
  static func primaryScreenHeight() -> CGFloat {
    screens().primaryHeight
  }

  /// The backing scale factor of the screen that most contains `rect`.
  static func scaleFactor(for rect: CGRect) -> CGFloat {
    var best: CGFloat = 1
    var bestArea: CGFloat = -1
    for screen in screens().displays {
      let overlap = screen.frame.intersection(rect)
      let area = overlap.isNull ? 0 : overlap.width * overlap.height
      if area > bestArea {
        bestArea = area
        best = screen.scale
      }
    }
    return best
  }

  // MARK: - Screen snapshot

  /// One display, already flipped into global top-left points.
  private struct Display {
    let frame: CGRect
    let scale: CGFloat
  }

  /// Everything this file needs from AppKit, read once on the main thread.
  ///
  /// `NSScreen` is main-thread API, and every lane asks for the workspace rect:
  /// the capture lane sizes its region against it, the input lane clamps every
  /// coordinate through it, and the window lane reports it. Reading `NSScreen`
  /// from those lanes was a data race against AppKit's own updates, so the read
  /// happens once on main and the lanes are served this immutable snapshot.
  private struct ScreenSnapshot {
    let workspace: CGRect
    let primaryHeight: CGFloat
    let displays: [Display]
  }

  private static let snapshotLock = NSLock()
  private static var cachedScreens: ScreenSnapshot?
  private static var screenObserver: NSObjectProtocol?

  /// Prime the snapshot and keep it current. Called on the main thread at
  /// startup; the notification is delivered on main too, so every write to the
  /// snapshot happens there and the lanes only ever read it.
  static func startObservingScreenChanges() {
    refreshScreens()
    guard screenObserver == nil else { return }
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { _ in
      refreshScreens()
    }
  }

  @discardableResult
  private static func refreshScreens() -> ScreenSnapshot {
    let all = NSScreen.screens
    let snapshot: ScreenSnapshot
    if let primary = all.first {
      // AppKit's global space is bottom-left with the primary screen's origin at
      // (0,0); flip into the top-left space CGWindow/CGEvent use. The primary
      // screen height is the flip axis for every other screen too.
      let primaryHeight = primary.frame.height
      let displays = all.map {
        Display(
          frame: flipToTopLeft($0.frame, primaryHeight: primaryHeight),
          scale: $0.backingScaleFactor)
      }
      var union = displays[0].frame
      for display in displays.dropFirst() { union = union.union(display.frame) }
      snapshot = ScreenSnapshot(
        workspace: union, primaryHeight: primaryHeight, displays: displays)
    } else {
      snapshot = ScreenSnapshot(
        workspace: CGRect(x: 0, y: 0, width: 1, height: 1), primaryHeight: 0, displays: [])
    }
    snapshotLock.lock()
    cachedScreens = snapshot
    snapshotLock.unlock()
    return snapshot
  }

  private static func screens() -> ScreenSnapshot {
    snapshotLock.lock()
    let cached = cachedScreens
    snapshotLock.unlock()
    if let cached { return cached }
    // Only reachable before `startObservingScreenChanges()` has run, which
    // happens on the main thread at startup before any lane exists — the
    // one-shot `--probe` path is the case that gets here.
    return refreshScreens()
  }

  /// Convert one AppKit (bottom-left) rect into global top-left points.
  static func flipToTopLeft(_ rect: CGRect, primaryHeight: CGFloat) -> CGRect {
    CGRect(
      x: rect.origin.x,
      y: primaryHeight - rect.origin.y - rect.height,
      width: rect.width,
      height: rect.height)
  }

  /// Saturating `Double` -> integer conversions.
  ///
  /// Swift's `Int32(_: Double)` and `Int64(_: Double)` are trapping
  /// initialisers: a value outside the destination range, or a NaN, aborts the
  /// process. Every number these convert arrives over the wire, so an
  /// out-of-range scroll delta or capture region would be a repeatable way to
  /// kill the helper — and with it every desktop action — from a single tool
  /// call. Saturating is the right answer for a delta rather than rejecting: a
  /// scroll of ten million pixels means "as far as this goes". A *region* is
  /// rejected instead, by `clampRectToWorkspace`, because a rect that misses
  /// every display has no honest saturated answer.
  static func clampToInt32(_ value: Double) -> Int32 {
    guard value.isFinite else { return 0 }
    let rounded = value.rounded()
    if rounded <= Double(Int32.min) { return Int32.min }
    if rounded >= Double(Int32.max) { return Int32.max }
    return Int32(rounded)
  }

  static func clampToInt64(_ value: Double) -> Int64 {
    guard value.isFinite else { return 0 }
    let rounded = value.rounded()
    if rounded <= Double(Int64.min) { return Int64.min }
    if rounded >= Double(Int64.max) { return Int64.max }
    return Int64(rounded)
  }

  static func rectDictionary(_ rect: CGRect) -> [String: Any] {
    [
      "x": Double(rect.origin.x),
      "y": Double(rect.origin.y),
      "width": Double(rect.width),
      "height": Double(rect.height),
    ]
  }
}
