import AppKit
import Foundation

func report(_ value: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: value) {
    FileHandle.standardOutput.write(data + Data([10]))
  }
}
final class TestView: NSView {
  let label: String
  init(label: String) { self.label = label; super.init(frame: NSRect(x: 0, y: 0, width: 420, height: 260)) }
  required init?(coder: NSCoder) { fatalError() }
  override var acceptsFirstResponder: Bool { true }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for area in trackingAreas { removeTrackingArea(area) }
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways], owner: self))
  }
  override func mouseMoved(with event: NSEvent) { report(["event": "move", "window": label]) }
  override func mouseDown(with event: NSEvent) { report(["event": "down", "window": label]); window?.makeFirstResponder(self) }
  override func mouseDragged(with event: NSEvent) { report(["event": "drag", "window": label]) }
  override func mouseUp(with event: NSEvent) { report(["event": "up", "window": label]) }
  override func keyDown(with event: NSEvent) { report(["event": "key", "window": label, "text": event.characters ?? ""]) }
  override func draw(_ dirtyRect: NSRect) {
    NSColor.windowBackgroundColor.setFill(); bounds.fill()
    ("Synara input test: " + label as NSString).draw(at: NSPoint(x: 20, y: 100), withAttributes: [.font: NSFont.systemFont(ofSize: 24)])
  }
}
final class FixtureApplication: NSApplication {
  override func sendEvent(_ event: NSEvent) {
    if [.keyDown, .leftMouseDown, .leftMouseUp].contains(event.type) {
      report(["event": "received", "type": event.type.rawValue, "window": event.window?.title ?? "nil", "number": event.windowNumber])
    }
    super.sendEvent(event)
  }
}
let app = FixtureApplication.shared
app.setActivationPolicy(.regular)
var windows: [NSWindow] = []
for (index, name) in ["A", "B"].enumerated() {
  let window = NSWindow(contentRect: NSRect(x: 200 + index * 80, y: 240 + index * 60, width: 420, height: 260), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
  window.title = "Synara Input Fixture " + name
  window.contentView = TestView(label: name)
  window.acceptsMouseMovedEvents = true
  window.makeFirstResponder(window.contentView)
  window.orderFrontRegardless()
  windows.append(window)
}
final class MenuActions: NSObject {
  @objc func performFixtureAction() { report(["event": "menu-action"]) }
}
let menuActions = MenuActions()
let menu = NSMenu()
let applicationMenu = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
let submenu = NSMenu(title: "Fixture")
let action = NSMenuItem(title: "Fixture Action", action: #selector(MenuActions.performFixtureAction), keyEquivalent: "")
action.target = menuActions
submenu.addItem(action)
applicationMenu.submenu = submenu
menu.addItem(applicationMenu)
app.mainMenu = menu
app.finishLaunching()
report(["ready": true, "pid": ProcessInfo.processInfo.processIdentifier])
DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async {
      if line == "state" { report(["state": windows.map { ["title": $0.title, "key": $0.isKeyWindow, "main": $0.isMainWindow] }]) }
      if line.hasPrefix("overlay "), let pid = Int(line.dropFirst(8)) {
        let entries = CGWindowListCopyWindowInfo(
          [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] ?? []
        let ownPID = ProcessInfo.processInfo.processIdentifier
        let stack = entries.filter {
          let owner = ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
          return owner == ownPID || owner == Int32(pid)
        }.map { entry -> [String: Any] in
          ["pid": entry[kCGWindowOwnerPID as String] ?? 0,
           "id": String((entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value ?? 0)]
        }
        report(["event": "overlay", "pid": pid, "visible": entries.contains {
          ($0[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == pid
        }, "stack": stack])
      }
      if line == "raiseA" { windows[0].orderFrontRegardless() }
      if line == "raiseB" { windows[1].orderFrontRegardless() }
      if line == "minimizeA" { windows[0].miniaturize(nil) }
      if line == "restoreA" { windows[0].deminiaturize(nil); windows[0].orderFrontRegardless() }
      if line == "focusA" { windows[0].makeKey() }
      if line == "quit" { app.terminate(nil) }
      if line == "activate" { app.activate(ignoringOtherApps: true) }
    }
  }
  DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
