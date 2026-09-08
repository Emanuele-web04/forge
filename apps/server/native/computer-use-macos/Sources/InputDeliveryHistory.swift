import Foundation

/// A failed pointer gesture says nothing about keyboard delivery, another
/// window, or a later page. Keep fallback decisions narrow and short-lived.
/// Accessed only from the helper's serial input lane.
struct InputDeliveryHistory {
  enum Kind: Hashable { case pointer, keyboard }

  private struct Key: Hashable {
    let pid: Int32
    let windowID: UInt32
    let kind: Kind
  }

  private var expiry: [Key: TimeInterval] = [:]
  private let lifetime: TimeInterval = 30

  func requiresForeground(
    pid: Int32, windowID: UInt32, kind: Kind,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) -> Bool {
    (expiry[Key(pid: pid, windowID: windowID, kind: kind)] ?? 0) > now
  }

  mutating func recordFailure(
    pid: Int32, windowID: UInt32, kind: Kind,
    now: TimeInterval = ProcessInfo.processInfo.systemUptime
  ) {
    expiry = expiry.filter { $0.value > now }
    // A long-lived helper must not accumulate every closed window it saw.
    if expiry.count >= 128 { expiry.removeAll(keepingCapacity: true) }
    expiry[Key(pid: pid, windowID: windowID, kind: kind)] = now + lifetime
  }
}
