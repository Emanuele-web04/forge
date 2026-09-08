// Request lanes.
//
// One serial queue for everything was the original shape, and it made the two
// halves of the helper fight each other: the pane's still-frame capture runs
// every 500 ms for as long as the computer pane is open, so with a single queue
// every click and keystroke queued behind a screenshot, and one slow AX walk
// stalled every capture behind it. The protocol correlates by request id and
// `writeMessage` is locked, so responses are free to complete out of order —
// the only ordering that has to hold is *within* a lane.
//
//   * **input** — one serial queue, arrival order. Clicks, keys, drags, and the
//     clipboard are a sequence the agent expects to happen in the order it asked
//     for, and they mutate shared state (the keyboard target, the held-button
//     bookkeeping) that is only safe because it has exactly one writer.
//   * **perception** — concurrent. Captures, window lists, and pings are pure
//     reads; a `ping` must answer while a capture is in flight, which is exactly
//     what the watchdog on the Node side is measuring.
//   * **accessibility** — its own serial queue, for the `describe-ui` walk. An
//     AX walk is synchronous IPC into other processes and can take hundreds of
//     milliseconds even bounded; the reference is explicit that it belongs off
//     the capture path, and serialising it keeps one runaway app from
//     multiplying into several blocked threads.
//
// This lane owns the *walk*, not accessibility in general. Bounded AX round
// trips run on the input lane by design — the typing ladder's read-back, the
// click's delivery watch, the keyboard focus nudge — because each one is part
// of the action it belongs to and has to happen in that action's order. Every
// one of them carries the per-window messaging timeout and a wall-clock budget
// for exactly that reason.
//
// stdin stays on its own reader thread: it only parses and hands off, so a busy
// lane never stops the helper from noticing the next request or a closed pipe.

import Dispatch

enum Lanes {
  /// Actions, in the order the agent asked for them.
  static let input = DispatchQueue(
    label: "dev.synara.computer-helper.input", qos: .userInitiated)
  /// Reads, concurrently.
  static let perception = DispatchQueue(
    label: "dev.synara.computer-helper.perception", qos: .userInitiated, attributes: .concurrent)
  /// The AX walk, alone.
  static let accessibility = DispatchQueue(
    label: "dev.synara.computer-helper.accessibility", qos: .userInitiated)
  /// Cosmetic updates preserve arrival order without queuing behind input.
  static let presentation = DispatchQueue(label: "dev.synara.computer-helper.presentation")
  /// The stdin reader.
  static let reader = DispatchQueue(
    label: "dev.synara.computer-helper.stdin", qos: .userInitiated)

  /// Which lane a method runs on. An unknown method takes the perception lane:
  /// it only produces a "method not found" error and must not sit behind input.
  ///
  /// `capabilities` and `request-permissions` both fall through to perception,
  /// which is deliberate for the second one: raising a TCC prompt is a read of
  /// the same state `capabilities` reports, and it can sit on screen until the
  /// user answers. On the serial input lane that wait would hold every click and
  /// keystroke behind a dialog; on the concurrent perception lane it holds
  /// nothing at all.
  /// Whether this method is an *action* — something the agent does to the
  /// desktop — rather than a read. Exactly the set that runs on the input lane,
  /// asked as one question so the two answers cannot drift.
  static func isAction(_ method: String) -> Bool {
    queue(for: method) === input
  }

  static func queue(for method: String) -> DispatchQueue {
    switch method {
    case "move", "click", "double-click", "triple-click", "right-click", "drag", "scroll",
      "type", "press-key", "hotkey", "set-value", "perform-action", "focus-window",
      "raise-window", "clear-focus-window", "read-clipboard", "write-clipboard", "launch-app":
      // `launch-app` is an action with the same ordering expectation as the
      // rest: "open the app, then click in it" has to happen in that order.
      return input
    case "set-agent-cursor":
      return presentation
    case "describe-ui":
      return accessibility
    default:
      return perception
    }
  }
}
