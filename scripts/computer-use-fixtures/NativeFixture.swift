// A test target only. It does not inject input or inspect other applications.
import AppKit
import Foundation

func emit(_ value: [String: Any]) {
  guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return }
  FileHandle.standardOutput.write(bytes + Data([10]))
}

final class Controls: NSObject, NSTextFieldDelegate {
  let label: String
  let window: NSWindow
  let text = NSTextField(string: "abc")
  let button = NSButton(title: "Counter: 0", target: nil, action: nil)
  var clicks = 0
  var edits = 0
  var mouseEvents: [[String: Any]] = []

  init(label: String, offset: Int) {
    self.label = label
    window = NSWindow(contentRect: NSRect(x: 100 + offset, y: 200, width: 540, height: 320),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()
    window.title = "Synara Native Fixture \(ProcessInfo.processInfo.processIdentifier) \(label)"
    window.isReleasedWhenClosed = false
    window.animationBehavior = .none
    text.frame = NSRect(x: 30, y: 170, width: 440, height: 32)
    text.setAccessibilityLabel("Fixture text")
    text.delegate = self
    button.frame = NSRect(x: 30, y: 220, width: 180, height: 40)
    button.target = self
    button.action = #selector(clicked)
    window.contentView?.addSubview(button)
    window.contentView?.addSubview(text)
    window.orderFrontRegardless()
  }

  @objc func clicked() {
    clicks += 1
    button.title = "Counter: \(clicks)"
    report()
  }
  func controlTextDidChange(_ notification: Notification) { edits += 1; report() }
  func report() {
    emit(["event": "state", "label": label, "pid": ProcessInfo.processInfo.processIdentifier,
      "windowId": window.windowNumber, "title": window.title, "clicks": clicks,
      "edits": edits, "text": text.stringValue, "key": window.isKeyWindow,
      "visible": window.isVisible, "minimized": window.isMiniaturized,
      "mouseEvents": mouseEvents])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let fixtures = [Controls(label: "A", offset: 0), Controls(label: "B", offset: 620)]
let mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { event in
  if let fixture = fixtures.first(where: { $0.window.windowNumber == event.windowNumber }) {
    let point = event.locationInWindow
    fixture.mouseEvents.append(["type": event.type == .leftMouseDown ? "down" : "up",
      "x": point.x, "y": point.y, "windowId": event.windowNumber,
      "buttonContains": fixture.button.frame.contains(point)])
    fixture.mouseEvents = Array(fixture.mouseEvents.suffix(16))
  }
  return event
}
app.finishLaunching()
fixtures.forEach { $0.report() }
emit(["ready": true, "pid": ProcessInfo.processInfo.processIdentifier])
// Commands mutate only the fixture's own state, to establish independent test
// preconditions. Closing stdin also closes the fixture, even after a runner dies.
DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async {
      switch line {
      case "state": fixtures.forEach { $0.report() }
      case "select-a": fixtures[0].window.makeFirstResponder(fixtures[0].text); fixtures[0].text.selectText(nil)
      case "move-a": fixtures[0].window.setFrameOrigin(NSPoint(x: 160, y: 240))
      case "minimize-a": fixtures[0].window.miniaturize(nil)
      case "restore-a": fixtures[0].window.deminiaturize(nil)
      case "close-a": fixtures[0].window.close()
      case "close-b": fixtures[1].window.close()
      case "quit": app.terminate(nil)
      default: break
      }
    }
  }
  DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
