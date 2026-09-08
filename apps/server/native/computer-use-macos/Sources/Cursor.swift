// The "Software Cursor" overlay — a picture, not a pointer.
//
// macOS runs exactly one real cursor and the agent never moves it. Following
// Codex's confirmed configuration (reference §2.2), this is a borderless,
// click-through NSWindow the helper draws wherever the agent is about to act, so
// the human can watch without the two fighting over the pointer. A name badge
// fades in beside it so multiple agents are distinguishable from day one (Codex
// shipped without this and immediately got a bug filed).
//
// The window is `ignoresMouseEvents` (the human's real clicks pass through) and
// `sharingType = .readOnly` (so the agent's own screenshots can include it while
// staying out of the human's way). All AppKit mutation happens on the main
// thread; callers may invoke `move`/`glide`/`setName`/`repin` from any queue.
//
// Two things this file is really about, beyond drawing an arrow:
//
//   * **It has to look like a pointer, not like a debug marker.** The arrow is
//     rendered at runtime into `CAShapeLayer`s at the destination screen's
//     `backingScaleFactor` — the outline is a separate, wider stroke *under* the
//     fill so the accent silhouette keeps its full width (a centred stroke eats
//     half of a 4 pt tail), and the outline layer carries the drop shadow so the
//     whole glyph reads over any wallpaper. The fill's tip sits exactly on the
//     point passed to `move`, because that is where the click is posted; only
//     the white ring extends past it, which is what a real cursor does too.
//
//   * **It has to move like a hand moved it, and the click has to wait for it.**
//     A jump-cut overlay is worse than none: the human sees the arrow appear
//     somewhere it has already finished clicking. The tip is a mass on a spring
//     (see "Motion" below) integrated at a fixed 1/240 s step and driven by the
//     display's own refresh, so the motion is continuous across retargets rather
//     than a sequence of independent, hard-stopping animations. `glide` is the
//     same thing plus a semaphore the ticker signals on arrival, which lets the
//     (background, serial) input lane block until the picture is true before it
//     posts a button down. The main thread is never the one waiting — it is the
//     one integrating.
//
// The overlay is ordered immediately above its target window. It must never
// cover a window the human has put above that target, including between calls.

import AppKit
import CoreGraphics
import CoreVideo
import QuartzCore

final class AgentCursor {

  // MARK: - Look

  /// 126×126 pt, the size the reference enumerated on Codex's own overlay. It is
  /// mostly empty: the arrow lives in the top-left corner and the badge to its
  /// lower-right, so the window is large enough for a long name and small enough
  /// never to cover much of what the agent is pointing at.
  private static let windowSide: CGFloat = 170
  /// Blank margin above and left of the tip, so the layer shadow has somewhere
  /// to fall. A window clips its content view, and a shadow drawn at the very
  /// edge would be sliced off on those two sides.
  private static let shadowInset: CGFloat = 8
  private static let arrowHeight: CGFloat = 22
  /// The widest the silhouette gets, as a fraction of its height — matches the
  /// unit path below and is used to place the badge clear of the glyph.
  private static let arrowWidth: CGFloat = arrowHeight * 0.62
  /// Half of the stroke width: the outline is drawn as a wider stroke *beneath*
  /// the fill, so only the outer half of it is ever visible.
  private static let outlineWidth: CGFloat = 1.5
  private static let badgeFontSize: CGFloat = 11
  private static let badgePadding: CGFloat = 6
  private static let badgeHeight: CGFloat = 17
  private static let badgeFadeDuration: CFTimeInterval = 0.15

  /// The macOS arrow silhouette in unit space: tip at the origin, +x right, +y
  /// **down**, the glyph exactly 1.0 tall. Written this way so the shape is one
  /// table rather than a dozen magic numbers spread through a path builder, and
  /// so re-rendering at another scale is a multiply.
  ///
  /// Read it as: straight left edge down from the tip, up into the notch, out
  /// along the tail's left side, across its base, back up its right side, out to
  /// the right shoulder, and home to the tip.
  private static let arrowUnitPoints: [CGPoint] = [
    CGPoint(x: 0.00, y: 0.00),  // tip — lands on the requested point
    CGPoint(x: 0.00, y: 0.80),  // bottom of the straight left edge
    CGPoint(x: 0.21, y: 0.62),  // the notch between head and tail
    CGPoint(x: 0.38, y: 1.00),  // tail, outer corner
    CGPoint(x: 0.55, y: 0.93),  // tail, inner corner
    CGPoint(x: 0.39, y: 0.57),  // tail root
    CGPoint(x: 0.62, y: 0.57),  // right shoulder of the head
  ]

  /// Where the arrow's tip sits inside the window, in AppKit (bottom-left)
  /// content coordinates. Everything else is placed relative to it, and `place`
  /// is nothing but "put this point on that global point".
  private static let tipInWindow = CGPoint(x: shadowInset, y: windowSide - shadowInset)

  // MARK: - Motion
  //
  // The tip is a mass on a spring pulled toward the target, integrated with
  // symplectic (semi-implicit) Euler at a fixed 1/240 s step, sub-stepped from
  // the *real* elapsed time of each display refresh. Three properties fall out
  // of that and none of them were true of the old fixed-duration tween:
  //
  //   1. **Velocity is state, so it survives a retarget.** Consecutive gestures
  //      flow into one another instead of decelerating to a dead stop at every
  //      waypoint and starting again from zero, and a drag's stream of 12 ms
  //      updates is followed rather than restarted 30 times.
  //   2. **The integrator is driven by the display, not by a run-loop timer.**
  //      A `Timer` at 60 Hz drifts and coalesces under load, which is exactly
  //      the stutter a human reads as "not smooth"; a `CADisplayLink` fires in
  //      step with the panel (including 120 Hz ProMotion), and integrating real
  //      elapsed time means a dropped frame costs a longer step, not a lurch.
  //   3. The animation link is invalidated when the tip settles. A separate,
  //      low-frequency check keeps the overlay attached to its target window.
  //
  // The spring is deliberately *nonlinear*: its angular frequency falls off with
  // the remaining distance (ω = C·d^-α with α near ½). A linear spring cannot
  // satisfy the two ends of the brief at once — its settling time is
  // scale-invariant, so tuning it to cross 600 pt in a third of a second makes a
  // 30 pt nudge take just as long, and forcing the long move to settle to within
  // a point in that time demands a violent 5000 pt/s launch that reads as a
  // jump-cut. With α ≈ ½ the restoring *force* is nearly independent of
  // distance, i.e. the tip accelerates and brakes at a roughly constant effort —
  // the bang-bang-plus-damping shape that models goal-directed hand movement,
  // whose duration grows with √distance. That gives 600 pt in ~340 ms and 30 pt
  // in ~100 ms out of one law, with a symmetric bell-shaped speed profile
  // peaking near 3400 pt/s instead of 5600, and it stiffens as it closes so the
  // last point is taken crisply rather than crept up on.
  //
  // Measured from the live per-frame trace (`SYNARA_CURSOR_TRACE=1` logs the tip
  // to stderr once per frame; 60 Hz panel, frame interval median 16.70 ms):
  // 600 pt settles to within a point in 317–333 ms, 303 pt in 267 ms, 30 pt in
  // 83–100 ms, a 1909 pt corner-to-corner traverse in 400 ms. Overshoot is
  // 0.00 pt at every distance and the tip comes to rest within 0.02 pt of the
  // requested point. The largest frame-to-frame change in speed through the body
  // of a 600 pt glide is 10–11 % of its peak, and a 300 pt drag's overlay never
  // trails the gesture by more than 7.2 pt (2.4 %).

  /// The physics step. Fixed, so the trajectory does not depend on the frame
  /// rate of whatever display the overlay happens to be on; the leftover of each
  /// frame's real elapsed time is carried into the next frame rather than
  /// stretched into a longer step.
  private static let physicsStep: CFTimeInterval = 1.0 / 240.0
  /// The most simulated time one frame may consume. A stalled main thread (a
  /// modal drag, a wake from sleep) must cost the tip a jump, not a thousand
  /// substeps in one frame.
  private static let maximumCatchUp: CFTimeInterval = 0.1

  /// ω = `stiffnessScale` · distance^-`stiffnessExponent`, in rad/s with the
  /// distance in points. The exponent just under ½ is what makes the effort
  /// roughly constant while letting the duration grow slightly slower than
  /// √distance, which is what puts both the 600 pt and the 30 pt case inside
  /// their windows.
  private static let stiffnessScale: CGFloat = 190
  private static let stiffnessExponent: CGFloat = 0.42
  /// The far end of the ramp: past ~500 pt the law stops getting lazier. This
  /// floor is set by `glide`'s 450 ms cap, not by taste — a move that settles
  /// after the cap releases its waiter early and the click lands before the
  /// picture does. At 15 rad/s a 1915 pt corner-to-corner traverse settles in
  /// 415 ms and 2500 pt in 435 ms, both inside the cap, while the 600 pt case is
  /// barely touched at 325 ms.
  private static let minimumStiffness: CGFloat = 15
  /// The near end: inside ~5 pt the law would run away, and ω·dt must stay well
  /// under 2 for the integrator to be stable. 95 rad/s is ω·dt = 0.40.
  private static let maximumStiffness: CGFloat = 95
  /// Damping ratio. Just under critical, which is a hair livelier than a dead
  /// stop; because ω *rises* as the tip closes, the braking rises with it and
  /// the measured overshoot is 0.00 pt at every distance — which matters,
  /// because the click is posted where the tip is and must not swing past it.
  private static let damping: CGFloat = 0.90

  /// A retarget that lands within this of the previous one is a *stream*, not a
  /// new gesture: `drag` issues its steps every ~12 ms. Streams get a stiff,
  /// critically damped spring instead of the distance law, because a follower's
  /// steady-state lag behind a target moving at V is 2ζV/ω — at the 750 pt/s of
  /// a 300 pt/400 ms drag the distance law would trail by a third of the drag,
  /// while ω = 160 keeps it under 6 %.
  private static let trackingGap: CFTimeInterval = 0.040
  private static let trackingStiffness: CGFloat = 160
  private static let trackingDamping: CGFloat = 1.0

  /// The restoring force is faded in over `launchTurns / ω` seconds with a
  /// smoothstep (≈45 ms for a screen-crossing move, ≈11 ms for a nudge). Without
  /// it acceleration steps from zero to its maximum in one frame, which is a
  /// visible flick at the start of every move; with it the speed profile leaves
  /// zero smoothly. Damping is *not* faded — a retarget that reverses direction
  /// must still be able to brake immediately.
  private static let launchTurns: CGFloat = 0.45

  /// The gentle arc. Rather than a Bézier the tip is tweened along, the spring's
  /// aim point is pushed off the chord perpendicular by `bow`, tapered linearly
  /// to zero as the remaining distance closes — so the path bows out and comes
  /// home to the exact target with no separate arrival case, and a retarget
  /// mid-arc is just another aim point rather than a new curve to splice on.
  /// Alternating rather than random sides: a constant bow makes a back-and-forth
  /// sequence trace the same crescent twice, and a random one is untestable.
  /// The peak lateral excursion is about half of `bow` (17 pt on a 600 pt move).
  private static let bowFraction: CGFloat = 0.14
  private static let bowLimit: CGFloat = 36
  /// Below this a bow is noise, not a gesture.
  private static let bowMinimumDistance: CGFloat = 12

  /// `glide` returns once the tip is this close and this slow — visually
  /// arrived. It keeps integrating afterwards, so the caller is released the
  /// moment the picture is true rather than at full numerical convergence.
  private static let arrivalDistance: CGFloat = 1.0
  private static let arrivalSpeed: CGFloat = 30
  /// …and this is convergence: the tip is snapped exactly onto the target and
  /// the display link is torn down.
  private static let restDistance: CGFloat = 0.05
  private static let restSpeed: CGFloat = 2

  /// The ceiling on `glide`'s block. A glide can be retargeted while a caller
  /// waits, so the wait is capped rather than trusted: a stuck main thread must
  /// cost one late click, never a wedged input lane.
  static let maximumGlideWait: TimeInterval = 0.45

  /// How long the overlay stays on screen after the last action completes.
  ///
  /// Long enough that the human can see where the agent's last click went and
  /// that a sequence of actions never blinks between them (the input lane is
  /// serial, and even a slow gesture is well inside this), short enough that an
  /// idle helper is not leaving a second arrow on the desktop.
  static let idleHideDelay: TimeInterval = 3

  // MARK: - State (main thread only, except the semaphores)

  private var window: NSWindow?
  private var targetWindow: DesktopWindow?
  private var visibilityTimer: Timer?
  private var outlineLayer: CAShapeLayer?
  private var fillLayer: CAShapeLayer?
  private var badgeLayer: CALayer?
  private var badgeTextLayer: CATextLayer?
  private var badgeName = ""
  private var badgeActivity = ""
  private var badgeLabel: String { badgeActivity.isEmpty ? badgeName : badgeActivity }
  /// The backing scale the vectors were last rasterised for; 0 until installed.
  private var renderedScale: CGFloat = 0

  /// Where the tip is *right now*, in global top-left points, and how fast it is
  /// going. Both are integrator state and both survive a retarget, which is what
  /// makes a sequence of moves one continuous motion.
  private var position: CGPoint = .zero
  private var velocity: CGVector = .zero
  private var target: CGPoint = .zero
  /// The distance this leg started with, which the bow taper is measured against.
  private var legDistance: CGFloat = 1
  private var bowNormal: CGVector = .zero
  private var bowAmount: CGFloat = 0
  private var sinceRetarget: CFTimeInterval = 0
  private var launchDuration: CFTimeInterval = 0.001
  private var tracking = false
  private var lastRetargetAt: CFTimeInterval = -.greatestFiniteMagnitude
  private var lastFrameAt: CFTimeInterval = 0
  private var stepRemainder: CFTimeInterval = 0
  private var arcSign: CGFloat = 1
  private var ticker: DisplayTicker?
  private var arrivalWaiters: [DispatchSemaphore] = []
  /// Whether the overlay is currently ordered out.
  ///
  /// It starts that way and goes back to it a short while after the agent stops
  /// acting. A helper is alive for as long as the backend wants one — which on a
  /// Mac with the Computer pane open is the whole session — and an overlay that
  /// is never ordered out is a permanent second arrow on the human's desktop
  /// pointing at wherever the agent last clicked, hours ago. Codex hides its
  /// Software Cursor when idle for the same reason.
  private var hidden = true
  /// The pending hide, cancelled by the next action.
  private var idleHide: DispatchWorkItem?
  /// Per-frame tip trace to stderr, off unless `SYNARA_CURSOR_TRACE` is set.
  /// This is how the motion is measured (speed profile, overshoot, settling)
  /// without a debug RPC that would have to exist in the shipped protocol.
  private static let tracing = ProcessInfo.processInfo.environment["SYNARA_CURSOR_TRACE"] != nil

  // MARK: - Install

  /// Build the overlay window. Must run on the main thread.
  func install() {
    let frame = NSRect(x: 0, y: 0, width: Self.windowSide, height: Self.windowSide)
    let window = NSWindow(
      contentRect: frame,
      styleMask: [.borderless],
      backing: .buffered,
      defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    // The glyph draws its own shadow; a window shadow would outline the whole
    // 126 pt square instead of the arrow.
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.sharingType = .readOnly
    window.level = .normal
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    // Nothing about this window should ever be animated by AppKit: its motion is
    // the integrator's job, at the integrator's timing.
    window.animationBehavior = .none

    let container = NSView(frame: frame)
    container.wantsLayer = true
    container.layer?.masksToBounds = false

    let path = Self.arrowPath()
    // The outline is the same silhouette stroked at twice the visible width and
    // filled, sitting *under* the accent fill. A centred stroke on the fill
    // layer would eat half its width inward, which pinches the 4 pt tail down to
    // a line; this way the accent keeps its full area and the white ring is
    // entirely outside it — the construction every real pointer uses.
    let outline = CAShapeLayer()
    outline.path = path
    outline.fillColor = NSColor.white.cgColor
    outline.strokeColor = NSColor.white.cgColor
    outline.lineWidth = Self.outlineWidth * 2
    outline.lineJoin = .round
    outline.lineCap = .round
    // Soft, offset downward (AppKit's +y is up), so the arrow floats over a
    // light wallpaper as readably as over a dark one.
    outline.shadowColor = NSColor.black.cgColor
    outline.shadowOpacity = 0.38
    outline.shadowRadius = 3
    outline.shadowOffset = CGSize(width: 0, height: -1.5)
    container.layer?.addSublayer(outline)

    let fill = CAShapeLayer()
    fill.path = path
    fill.fillColor = Self.accentColor()
    fill.strokeColor = nil
    container.layer?.addSublayer(fill)

    let badge = CALayer()
    badge.backgroundColor = Self.accentColor(alpha: 0.9)
    badge.cornerRadius = Self.badgeHeight / 2
    badge.opacity = 0
    let badgeText = CATextLayer()
    badgeText.alignmentMode = .center
    badgeText.truncationMode = .end
    badgeText.foregroundColor = NSColor.white.cgColor
    badgeText.font = NSFont.systemFont(ofSize: Self.badgeFontSize, weight: .semibold)
    badgeText.fontSize = Self.badgeFontSize
    badge.addSublayer(badgeText)
    container.layer?.addSublayer(badge)

    window.contentView = container
    self.window = window
    self.outlineLayer = outline
    self.fillLayer = fill
    self.badgeLayer = badge
    self.badgeTextLayer = badgeText

    // Start where the human's pointer is rather than in the corner of the
    // screen: the first thing the agent does is glide away from it, which reads
    // as "something picked the pointer up" instead of "a marker appeared".
    let primaryHeight = Geometry.primaryScreenHeight()
    let mouse = NSEvent.mouseLocation
    position = CGPoint(x: mouse.x, y: primaryHeight - mouse.y)
    target = position
    layoutBadge()
    place(position)
    applyScale(window.screen?.backingScaleFactor ?? 2)
    // Deliberately not ordered in here. An installed-but-idle helper shows the
    // human nothing; the first action wakes the overlay at the human's pointer
    // and glides away from it, which reads as the agent picking the pointer up.
  }

  // MARK: - Public API

  /// Retarget the spring and return immediately.
  ///
  /// This is what a drag's per-step updates want: they arrive every ~12 ms and
  /// pace themselves, so the integrator's job is to follow them, not to schedule
  /// its own arrival. See `retarget` for how a stream of small updates is kept
  /// from lagging behind.
  func move(to global: CGPoint) {
    onMain { self.retarget(to: global) }
  }

  /// Retarget, and block the **calling** thread until the overlay has arrived.
  ///
  /// The click has to fire when the cursor visually arrives or the picture lies,
  /// and `aim` is the one place that knows a gesture is about to be posted. Only
  /// ever called from the serial input lane (a background queue), so blocking it
  /// blocks exactly one gesture; the main thread keeps running the integrator
  /// that eventually signals the semaphore. Called *on* the main thread it
  /// degrades to `move`, because waiting there would deadlock against the
  /// display link.
  func glide(to global: CGPoint, window: DesktopWindow?, whileMoving: () -> Void = {}) {
    // An off-screen target has no visible cursor journey to synchronize with.
    // Keep the overlay animation, but never park input waiting for its display
    // link (which may itself be throttled while the target is covered).
    if let window, !window.onScreen || Windows.list().contains(where: {
      $0.onScreen && $0.stackingIndex < window.stackingIndex
        && $0.bounds.contains(window.bounds)
    }) {
      onMain {
        self.targetWindow = window
        self.retarget(to: global)
      }
      whileMoving()
      return
    }
    guard !Thread.isMainThread else {
      targetWindow = window
      retarget(to: global)
      whileMoving()
      return
    }
    let arrival = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      // Enqueued before the retarget, because a zero-length move signals its
      // waiters synchronously from inside `retarget`.
      self.arrivalWaiters.append(arrival)
      self.targetWindow = window
      self.retarget(to: global)
    }
    let deadline = DispatchTime.now() + Self.maximumGlideWait
    whileMoving()
    _ = arrival.wait(timeout: deadline)
  }

  /// Re-order the overlay above its target without moving it. Changing another app's
  /// AppKit-active state (the focus prelude in Input.swift) can drop the overlay
  /// behind that app's windows. Safe during a glide: it touches ordering only,
  /// and it will not bring back an overlay that has gone idle.
  func repin() {
    onMain { self.presentAboveTarget() }
  }

  /// Keep the cursor visible between model calls while a thread owns control.
  /// Unowned manual input retains the short grace before the overlay hides.
  func markIdle() {
    onMain {
      self.idleHide?.cancel()
      self.idleHide = nil
      guard self.badgeLabel.isEmpty else { return }
      let hide = DispatchWorkItem { [weak self] in self?.hide() }
      self.idleHide = hide
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleHideDelay, execute: hide)
    }
  }

  /// Order the overlay out now. Also called on the way out of the process, where
  /// it is best effort: `shutdown()` runs on the main queue for a signal, so the
  /// hop is synchronous there, and from the stdin reader the `exit()` that
  /// follows takes the window down anyway.
  func hide() {
    onMain {
      self.idleHide?.cancel()
      self.idleHide = nil
      guard !self.hidden else { return }
      self.hidden = true
      self.visibilityTimer?.invalidate()
      self.visibilityTimer = nil
      self.window?.orderOut(nil)
    }
  }

  func setName(_ name: String, activity: String = "") {
    onMain {
      let activity = String(activity.prefix(32))
      guard self.badgeName != name || self.badgeActivity != activity else { return }
      self.badgeName = name
      self.badgeActivity = activity
      self.layoutBadge()
      self.setBadgeVisible(!self.badgeLabel.isEmpty)
      self.idleHide?.cancel()
      self.idleHide = nil
      if self.badgeLabel.isEmpty { self.hide() }
    }
  }

  // MARK: - Motion

  /// Aim the spring at `global` from wherever the tip currently is, **keeping
  /// its velocity**.
  ///
  /// Nothing here touches `position` or `velocity`, which is the whole point: a
  /// retarget changes where the force pulls, not where the mass is or how fast
  /// it is going, so a mid-flight redirect curves into the new target and a
  /// gesture issued while the previous one is still settling never stops.
  private func retarget(to global: CGPoint) {
    guard window != nil else {
      // No overlay (install failed): never leave a caller parked on `glide`.
      signalArrival()
      return
    }
    // Any motion is activity: bring the overlay back if it had gone idle, and
    // cancel whatever hide was pending.
    wake()
    // The destination screen decides the raster scale, not the current one —
    // `window.screen` still reports where the overlay *was*, so reading it here
    // would re-render one move too late on every crossing between a Retina and a
    // non-Retina display.
    applyScale(Geometry.scaleFactor(for: CGRect(x: global.x, y: global.y, width: 1, height: 1)))

    let now = CACurrentMediaTime()
    // A stream of updates (a drag) rather than a fresh gesture. Decided by the
    // cadence of the retargets themselves, which is the only thing that actually
    // distinguishes the two cases.
    tracking = (now - lastRetargetAt) < Self.trackingGap
    lastRetargetAt = now

    let dx = global.x - position.x
    let dy = global.y - position.y
    let distance = (dx * dx + dy * dy).squareRoot()
    target = global

    // Already there and already stopped: place it exactly and release any
    // waiter synchronously, rather than spinning up a display link to travel
    // zero distance. Deliberately *not* taken when the tip is close but still
    // moving — zeroing a live velocity is the jerk this whole file exists to
    // avoid, and the integrator lands it within a frame or two anyway.
    let speed = (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot()
    if distance <= Self.restDistance && speed <= Self.restSpeed {
      position = global
      velocity = .zero
      place(position)
      stopTicker()
      presentAboveTarget()
      signalArrival()
      return
    }

    legDistance = max(distance, 0.001)
    sinceRetarget = 0
    let launchStiffness = Self.stiffness(forDistance: legDistance)
    // A stream is already smooth by construction and must not be softened: its
    // steps are 12 ms apart and a 30 ms fade-in would be most of each one.
    launchDuration = tracking ? 0.0005 : CFTimeInterval(Self.launchTurns / launchStiffness)

    if !tracking && distance > Self.bowMinimumDistance {
      arcSign = -arcSign
      bowAmount = min(distance * Self.bowFraction, Self.bowLimit) * arcSign
      bowNormal = CGVector(dx: -dy / distance, dy: dx / distance)
    } else {
      bowAmount = 0
      bowNormal = .zero
    }

    presentAboveTarget()
    startTicker()
  }

  /// One display refresh: integrate the real elapsed time in fixed substeps,
  /// then draw once. Runs on the main thread.
  private func frame() {
    let now = CACurrentMediaTime()
    let elapsed = max(0, now - lastFrameAt)
    lastFrameAt = now

    var budget = min(stepRemainder + elapsed, Self.maximumCatchUp)
    while budget >= Self.physicsStep {
      integrate(Self.physicsStep)
      budget -= Self.physicsStep
    }
    stepRemainder = budget

    let dx = target.x - position.x
    let dy = target.y - position.y
    let distance = (dx * dx + dy * dy).squareRoot()
    let speed = (velocity.dx * velocity.dx + velocity.dy * velocity.dy).squareRoot()
    let settled = distance <= Self.restDistance && speed <= Self.restSpeed
    if settled {
      position = target
      velocity = .zero
    }
    place(position)
    if Self.tracing { trace(now: now, distance: distance, speed: speed) }

    // Visually arrived is enough to let the click go; numerically converged is
    // what tears the link down.
    if distance <= Self.arrivalDistance && speed <= Self.arrivalSpeed {
      signalArrival()
    }
    if settled {
      stopTicker()
      presentAboveTarget()
    }
  }

  /// Symplectic (semi-implicit) Euler on `v' = ω²·(aim − x) − 2ζω·v`, `x' = v`.
  ///
  /// Velocity is advanced with the force at the current position and position
  /// with the *new* velocity, which is the same ordering velocity-Verlet uses
  /// and is what keeps a spring from pumping energy; at ω·dt ≤ 0.4 its period
  /// error is well under a percent, far below a point of travel.
  private func integrate(_ dt: CFTimeInterval) {
    let step = CGFloat(dt)
    let dx = target.x - position.x
    let dy = target.y - position.y
    let distance = (dx * dx + dy * dy).squareRoot()

    let omega = tracking ? Self.trackingStiffness : Self.stiffness(forDistance: distance)
    let zeta = tracking ? Self.trackingDamping : Self.damping

    // The aim point: the target, pushed off the chord perpendicular by a bow
    // that tapers to nothing as the tip closes, so the arc dissolves into an
    // exact arrival instead of having to be cancelled.
    let taper = min(1, distance / legDistance) * bowAmount
    let aimX = dx + bowNormal.dx * taper
    let aimY = dy + bowNormal.dy * taper

    sinceRetarget += dt
    let ramp = min(1, CGFloat(sinceRetarget / launchDuration))
    let gate = ramp * ramp * (3 - 2 * ramp)

    let pull = gate * omega * omega
    let drag = 2 * zeta * omega
    velocity.dx += (pull * aimX - drag * velocity.dx) * step
    velocity.dy += (pull * aimY - drag * velocity.dy) * step
    position.x += velocity.dx * step
    position.y += velocity.dy * step
  }

  /// ω for a remaining distance, clamped at both ends. Under a tenth of a point
  /// the power law is meaningless, and the clamp is what keeps ω·dt stable.
  private static func stiffness(forDistance distance: CGFloat) -> CGFloat {
    guard distance > 0.001 else { return maximumStiffness }
    let raw = stiffnessScale * pow(distance, -stiffnessExponent)
    return min(maximumStiffness, max(minimumStiffness, raw))
  }

  /// Put the arrow's tip on `global`.
  ///
  /// The primary screen's height comes from `Geometry`'s snapshot, which the
  /// display-parameters notification refreshes: caching it at init misplaced the
  /// overlay on every subsequent display change (resolution switch, external
  /// display, a laptop lid closing) until the helper restarted. The origin is quantised to the destination's backing
  /// pixels so successive frames step by whole device pixels rather than
  /// whatever AppKit happens to round a fractional frame to.
  private func place(_ global: CGPoint) {
    guard let window else { return }
    let primaryHeight = Geometry.primaryScreenHeight()
    let tip = Self.tipInWindow
    let scale = renderedScale > 0 ? renderedScale : 1
    let x = ((global.x - tip.x) * scale).rounded() / scale
    let y = ((primaryHeight - global.y - tip.y) * scale).rounded() / scale
    window.setFrameOrigin(NSPoint(x: x, y: y))
  }

  private func startTicker() {
    if ticker != nil { return }
    lastFrameAt = CACurrentMediaTime()
    stepRemainder = 0
    ticker = DisplayTicker(window: window) { [weak self] in self?.frame() }
  }

  private func stopTicker() {
    ticker?.invalidate()
    ticker = nil
    stepRemainder = 0
  }

  /// Keep the cursor in the target's stacking position, never globally on top.
  /// Compare WindowServer stacking without accessibility traversal. If it closes, minimizes or leaves the active Space, order out
  /// without ending ownership; it can reappear when that same target returns.
  private func presentAboveTarget() {
    guard !hidden, let window else { return }
    guard let targetWindow,
      let entries = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
        as? [[String: Any]],
      let targetIndex = entries.firstIndex(where: {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == targetWindow.windowNumber
      })
    else {
      window.orderOut(nil)
      return
    }
    let entry = entries[targetIndex]
    guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == targetWindow.ownerPID,
      (entry[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true else {
      window.orderOut(nil)
      return
    }
    // The full stacking snapshot lets an idle cursor avoid reordering itself
    // every 100ms while still following actual restacks by the human.
    let cursorIndex = entries.firstIndex { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == window.windowNumber }
    if cursorIndex != targetIndex - 1 {
      window.order(.above, relativeTo: Int(targetWindow.windowNumber))
    }
  }

  /// Follow user restacking and minimize/restore changes even while the model
  /// is thinking. Only runs while the cursor is awake; no AX traversal or input
  /// is performed. Animation remains driven by the display link.
  private func wake() {
    idleHide?.cancel()
    idleHide = nil
    hidden = false
    if visibilityTimer == nil {
      let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
        self?.presentAboveTarget()
      }
      timer.tolerance = 0.05
      RunLoop.main.add(timer, forMode: .common)
      visibilityTimer = timer
    }
    presentAboveTarget()
  }

  private func signalArrival() {
    guard !arrivalWaiters.isEmpty else { return }
    let waiters = arrivalWaiters
    arrivalWaiters = []
    for waiter in waiters { waiter.signal() }
  }

  private func trace(now: CFTimeInterval, distance: CGFloat, speed: CGFloat) {
    let line = String(
      format: "cursor-trace t=%.4f x=%.3f y=%.3f speed=%.1f dist=%.3f\n",
      now, position.x, position.y, speed, distance)
    FileHandle.standardError.write(Data(line.utf8))
  }

  // MARK: - Rendering

  private static func arrowPath() -> CGPath {
    let tip = tipInWindow
    let path = CGMutablePath()
    for (index, unit) in arrowUnitPoints.enumerated() {
      // Unit space runs +y down; AppKit content space runs +y up.
      let point = CGPoint(
        x: tip.x + unit.x * arrowHeight,
        y: tip.y - unit.y * arrowHeight)
      if index == 0 {
        path.move(to: point)
      } else {
        path.addLine(to: point)
      }
    }
    path.closeSubpath()
    return path
  }

  /// A saturated accent that reads as "not the system cursor".
  ///
  /// The user's own accent colour is the friendlier choice — it is the colour
  /// their machine already uses for "this is the active thing" — but the
  /// graphite accent is a grey, and a grey arrow with a white outline is very
  /// nearly the stock pointer. Below a saturation floor the agent takes system
  /// blue instead, so the two cursors are never confusable.
  private static func accentColor(alpha: CGFloat = 1) -> CGColor {
    let fallback = NSColor.systemBlue.usingColorSpace(.sRGB) ?? NSColor.blue
    let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB)
    let chosen = (accent?.saturationComponent ?? 0) >= 0.25 ? (accent ?? fallback) : fallback
    return chosen.withAlphaComponent(alpha).cgColor
  }

  /// Re-rasterise the vectors for a display's backing scale. Cheap and idempotent:
  /// the shapes are paths, so this is a property assignment, not a redraw of
  /// anything we own.
  private func applyScale(_ scale: CGFloat) {
    guard scale > 0, scale != renderedScale else { return }
    renderedScale = scale
    let layers: [CALayer?] = [
      window?.contentView?.layer, outlineLayer, fillLayer, badgeLayer, badgeTextLayer,
    ]
    withoutImplicitAnimations {
      for layer in layers { layer?.contentsScale = scale }
    }
  }

  /// Size the pill to its text and park it to the arrow's lower-right, clear of
  /// the glyph. A name too long for the window is truncated rather than allowed
  /// to run under the window's clip, which would cut a word in half mid-glyph.
  private func layoutBadge() {
    guard let badge = badgeLayer, let text = badgeTextLayer else { return }
    let font = NSFont.systemFont(ofSize: Self.badgeFontSize, weight: .semibold)
    let measured = (badgeLabel as NSString).size(withAttributes: [.font: font]).width
    let tip = Self.tipInWindow
    let originX = tip.x + Self.arrowWidth + 3
    let available = Self.windowSide - originX - Self.shadowInset
    let width = max(
      Self.badgeHeight, min(available, measured.rounded(.up) + Self.badgePadding * 2))
    // Vertically overlapping the arrow's lower half, so the pair reads as one
    // object rather than as an arrow and a floating label.
    let top = tip.y - Self.arrowHeight * 0.75
    let lineHeight = font.ascender - font.descender
    withoutImplicitAnimations {
      badge.frame = CGRect(
        x: originX, y: top - Self.badgeHeight, width: width, height: Self.badgeHeight)
      text.frame = badge.bounds.insetBy(
        dx: Self.badgePadding, dy: (Self.badgeHeight - lineHeight) / 2)
      text.string = badgeLabel
    }
  }

  /// Fade rather than `isHidden`: a badge that blinks in and out draws the eye
  /// harder than the cursor it is labelling.
  private func setBadgeVisible(_ visible: Bool) {
    guard let badge = badgeLayer else { return }
    let target: Float = visible ? 1 : 0
    guard badge.opacity != target else { return }
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = badge.presentation()?.opacity ?? badge.opacity
    fade.toValue = target
    fade.duration = Self.badgeFadeDuration
    fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    badge.opacity = target
    badge.add(fade, forKey: "badge-fade")
  }

  private func withoutImplicitAnimations(_ body: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    body()
    CATransaction.commit()
  }

  private func onMain(_ body: @escaping () -> Void) {
    if Thread.isMainThread {
      body()
    } else {
      DispatchQueue.main.async(execute: body)
    }
  }
}

/// A callback delivered once per display refresh, on the main thread.
///
/// Three tiers, best first. `CADisplayLink` (macOS 14) is the one that actually
/// runs here: it is vended by the window, so it follows the overlay onto whatever
/// display it is on and fires at that panel's rate (120 Hz on ProMotion), and it
/// already delivers on the main run loop. `CVDisplayLink` is the same idea for
/// older systems but calls back on its own high-priority thread, so its frames
/// are hopped to main and coalesced — a main thread that falls behind must drop
/// frames, not queue them. A `Timer` is the last resort and exists only so that a
/// machine where neither link can be created still animates rather than jumping.
///
/// Every tier is added to the run loop in `.common` mode, so the overlay keeps
/// moving while the human holds a menu open or drags a window — the modes where a
/// `.default` timer stops firing and the cursor would freeze mid-flight.
///
/// Construction cannot fail: the `Timer` tier needs nothing from the display
/// server, so there is always a tier left. This used to be a failable
/// initialiser, which made the caller carry a "no ticker at all" fallback that
/// nothing could ever reach.
private final class DisplayTicker: NSObject {

  private let onFrame: () -> Void
  /// Both links are held as `AnyObject` so that neither the 14.0-only
  /// `CADisplayLink` nor the 15.0-deprecated `CVDisplayLink` appears in a
  /// declaration this file has to compile against a 12.3 deployment target.
  private var displayLink: AnyObject?
  private var legacyLink: AnyObject?
  private var timer: Timer?
  /// Set on the CV link's own thread, cleared on main: at most one frame is ever
  /// in flight, so a slow main thread drops frames instead of accumulating them.
  private let pending = PendingFlag()

  init(window: NSWindow?, onFrame: @escaping () -> Void) {
    self.onFrame = onFrame
    super.init()
    if #available(macOS 14.0, *), let window {
      let link = window.displayLink(target: self, selector: #selector(displayLinkFired(_:)))
      link.add(to: .main, forMode: .common)
      displayLink = link
      return
    }
    if startLegacyLink() { return }
    let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
      self?.onFrame()
    }
    RunLoop.main.add(timer, forMode: .common)
    self.timer = timer
  }

  func invalidate() {
    if #available(macOS 14.0, *), let link = displayLink as? CADisplayLink {
      link.invalidate()
    }
    displayLink = nil
    stopLegacyLink()
    timer?.invalidate()
    timer = nil
  }

  /// Typed `Any` rather than `CADisplayLink` so the selector can exist on a
  /// class that also compiles for systems without it.
  @objc private func displayLinkFired(_ sender: Any) {
    onFrame()
  }

  @available(macOS, deprecated: 15.0, message: "CVDisplayLink is the pre-14 fallback path.")
  private func startLegacyLink() -> Bool {
    var link: CVDisplayLink?
    guard CVDisplayLinkCreateWithActiveCGDisplays(&link) == kCVReturnSuccess, let link else {
      return false
    }
    let flag = pending
    let fire = onFrame
    CVDisplayLinkSetOutputHandler(link) { _, _, _, _, _ in
      guard flag.take() else { return kCVReturnSuccess }
      DispatchQueue.main.async {
        flag.clear()
        fire()
      }
      return kCVReturnSuccess
    }
    guard CVDisplayLinkStart(link) == kCVReturnSuccess else { return false }
    legacyLink = link
    return true
  }

  @available(macOS, deprecated: 15.0, message: "CVDisplayLink is the pre-14 fallback path.")
  private func stopLegacyLink() {
    guard let held = legacyLink, CFGetTypeID(held) == CVDisplayLinkGetTypeID() else { return }
    let link = held as! CVDisplayLink
    CVDisplayLinkStop(link)
    legacyLink = nil
  }
}

/// One bit, guarded, shared between the CV display link's thread and main.
private final class PendingFlag {
  private let lock = NSLock()
  private var busy = false

  /// True if this caller now owns the in-flight slot.
  func take() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if busy { return false }
    busy = true
    return true
  }

  func clear() {
    lock.lock()
    busy = false
    lock.unlock()
  }
}
