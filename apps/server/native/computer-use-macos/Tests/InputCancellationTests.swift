import Foundation

@main
struct InputCancellationTests {
  static func main() throws {
    let running = InputCancellation.register("running", isAction: true)
    let queued = InputCancellation.register("queued", isAction: true)
    let capture = InputCancellation.register("capture")
    try running.check()
    InputCancellation.cancelActions()
    for token in [running, queued] {
      do { try token.check(); fatalError("Space change did not cancel input") }
      catch let error as RPCError { precondition(error.code == .inactiveSpace) }
    }
    try capture.check()
    let resumed = InputCancellation.register("resumed", isAction: true)
    try resumed.check()
    InputCancellation.enter(resumed)
    InputCancellation.cancel("resumed")
    do { try InputCancellation.check(); fatalError("Explicit cancellation ignored") }
    catch let error as RPCError { precondition(error.code == .notDelivered) }
    for id in ["running", "queued", "capture", "resumed"] { InputCancellation.finish(id) }
    try InputCancellation.check()
    print("PASS: running and queued input cancelled, perception preserved, new requests resume, explicit cancellation preserved")
  }
}
