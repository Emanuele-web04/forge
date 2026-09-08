import Foundation

/// Cancellation arrives on stdin, independently of the serial input lane. The
/// request retains its token until it has released any held keys/buttons.
enum InputCancellation {
  final class Token {
    private let lock = NSLock()
    let isAction: Bool
    init(isAction: Bool = false) { self.isAction = isAction }
    private var cancelled = false
    private var spaceChanged = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func cancelForSpaceChange() { lock.lock(); spaceChanged = true; lock.unlock() }
    func check() throws {
      lock.lock(); let stopped = cancelled; let changed = spaceChanged; lock.unlock()
      if changed { throw RPCError(.inactiveSpace, "Input interrupted because the user changed Spaces. Do not replay this action; it may have partially completed. Read the target before resuming on the current Space.") }
      if stopped { throw RPCError(.notDelivered, "Computer operation cancelled") }
    }
  }
  private static let lock = NSLock()
  private static var requests: [String: Token] = [:]
  private static let threadKey = "synara.inputCancellation"
  private static func key(_ id: Any?) -> String { String(describing: id ?? NSNull()) }
  static func register(_ id: Any?, isAction: Bool = false) -> Token {
    let token = Token(isAction: isAction)
    lock.lock(); requests[key(id)] = token; lock.unlock()
    return token
  }
  static func enter(_ token: Token) { Thread.current.threadDictionary[threadKey] = token }
  static func check() throws { try (Thread.current.threadDictionary[threadKey] as? Token)?.check() }
  static func cancel(_ id: Any?) {
    lock.lock(); let token = requests[key(id)]; lock.unlock()
    token?.cancel()
  }
  static func cancelActions() {
    lock.lock(); let tokens = Array(requests.values); lock.unlock()
    for token in tokens where token.isAction { token.cancelForSpaceChange() }
  }
  static func finish(_ id: Any?) {
    Thread.current.threadDictionary.removeObject(forKey: threadKey)
    lock.lock(); requests.removeValue(forKey: key(id)); lock.unlock()
  }
}
