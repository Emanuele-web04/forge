import Foundation

@main struct InputDeliveryHistoryTests {
  static func main() {
    var history = InputDeliveryHistory()
    history.recordFailure(pid: 10, windowID: 20, kind: .pointer, now: 100)
    precondition(history.requiresForeground(pid: 10, windowID: 20, kind: .pointer, now: 101))
    precondition(!history.requiresForeground(pid: 10, windowID: 20, kind: .keyboard, now: 101),
      "a failed click must not force slow keyboard delivery")
    precondition(!history.requiresForeground(pid: 10, windowID: 21, kind: .pointer, now: 101),
      "a failed click must not change other windows")
    precondition(!history.requiresForeground(pid: 11, windowID: 20, kind: .pointer, now: 101),
      "a recycled window id must not inherit another process's fallback")
    history.recordFailure(pid: 10, windowID: 20, kind: .keyboard, now: 105)
    precondition(history.requiresForeground(pid: 10, windowID: 20, kind: .keyboard, now: 106))
    precondition(!history.requiresForeground(pid: 10, windowID: 20, kind: .pointer, now: 130),
      "a new page must be allowed to try background delivery again")
    precondition(history.requiresForeground(pid: 10, windowID: 20, kind: .keyboard, now: 130))
    precondition(!history.requiresForeground(pid: 10, windowID: 20, kind: .keyboard, now: 135))
    print("Input delivery history: separate actions, windows, processes and expiry passed")
  }
}
