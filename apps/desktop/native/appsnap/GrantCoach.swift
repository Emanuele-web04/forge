import AppKit
import Carbon

/// Copied from the Cue overlay (GrantCoach.swift, AppDragView.swift, Overlay.swift,
/// CueTokens.swift) and refactored for the Synara helper: only the app name, app
/// bundle path, and permission pane are parameterized. The drag
/// session follows zats/permiso's AppDragSourceView (proven against the System
/// Settings privacy lists). The panel stays movable by its background like Cue,
/// while the chip opts out of window movement so dragging it moves only the
/// dragged copy, never the coach itself.

func cuePaintFill(_ view: NSView, fill: NSColor, stroke: NSColor, width: CGFloat = 0.5) {
    view.wantsLayer = true
    view.effectiveAppearance.performAsCurrentDrawingAppearance {
        view.layer?.backgroundColor = fill.cgColor
        view.layer?.borderColor = stroke.cgColor
    }
    view.layer?.borderWidth = width
}

enum CueTokens {
    static let radiusChrome: CGFloat = 12

    static let hairline: CGFloat = 0.5

    static let shadowAmbient1Alpha: CGFloat = 0.08
    static let shadowAmbient1Y: CGFloat = 1
    static let shadowAmbient1Blur: CGFloat = 6
    static let shadowAmbient2Alpha: CGFloat = 0.12
    static let shadowAmbient2Y: CGFloat = 3
    static let shadowAmbient2Blur: CGFloat = 16

    static let fillCardDark = NSColor(
        srgbRed: 0x14 / 255.0,
        green: 0x14 / 255.0,
        blue: 0x17 / 255.0,
        alpha: 1.0
    )
    static let fillCardLight = NSColor(
        srgbRed: 0xF6 / 255.0,
        green: 0xF7 / 255.0,
        blue: 0xF9 / 255.0,
        alpha: 1.0
    )
}

final class CueChromeView: NSView {
    private let ambient1 = CALayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = CueTokens.radiusChrome
        layer?.cornerCurve = .continuous
        layer?.borderWidth = CueTokens.hairline
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = Float(CueTokens.shadowAmbient2Alpha)
        layer?.shadowOffset = CGSize(width: 0, height: CueTokens.shadowAmbient2Y)
        layer?.shadowRadius = CueTokens.shadowAmbient2Blur
        ambient1.shadowColor = NSColor.black.cgColor
        ambient1.shadowOpacity = Float(CueTokens.shadowAmbient1Alpha)
        ambient1.shadowOffset = CGSize(width: 0, height: CueTokens.shadowAmbient1Y)
        ambient1.shadowRadius = CueTokens.shadowAmbient1Blur
        layer?.insertSublayer(ambient1, at: 0)
        paint()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        ambient1.frame = bounds
        let pathBounds = CGRect(origin: .zero, size: bounds.size)
        ambient1.shadowPath = CGPath(
            roundedRect: pathBounds,
            cornerWidth: CueTokens.radiusChrome,
            cornerHeight: CueTokens.radiusChrome,
            transform: nil
        )
    }

    override func viewDidChangeEffectiveAppearance() {
        paint()
    }

    func paint() {
        let appearance = effectiveAppearance
        appearance.performAsCurrentDrawingAppearance {
            let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let fill = dark ? CueTokens.fillCardDark : CueTokens.fillCardLight
            layer?.backgroundColor = fill.cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
        }
    }
}

final class AppDragView: NSView, NSPasteboardItemDataProvider, NSDraggingSource {
    var onDragBegan: (() -> Void)?

    private let dragURL: URL
    private let titleField: NSTextField
    private let iconView = NSImageView()
    private let gripView = NSImageView()

    init(frame frameRect: NSRect, appName: String, appPath: String, toolTipText: String) {
        dragURL = URL(fileURLWithPath: appPath)
        titleField = NSTextField(labelWithString: appName)
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.cornerCurve = .continuous
        cuePaintFill(self, fill: .controlBackgroundColor, stroke: .separatorColor)
        gripView.image = NSImage(systemSymbolName: "line.3.horizontal", accessibilityDescription: nil)
        gripView.contentTintColor = .tertiaryLabelColor
        gripView.imageScaling = .scaleProportionallyUpOrDown
        addSubview(gripView)
        if let icon = NSWorkspace.shared.icon(forFile: appPath) as NSImage?,
           !icon.isTemplate, icon.size.width > 1 {
            iconView.image = icon
        } else if let symbol = NSImage(systemSymbolName: "app.fill", accessibilityDescription: nil) {
            iconView.image = symbol
            iconView.contentTintColor = .labelColor
        }
        iconView.imageScaling = .scaleProportionallyUpOrDown
        addSubview(iconView)
        titleField.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        titleField.textColor = .labelColor
        titleField.alignment = .left
        addSubview(titleField)
        toolTip = toolTipText
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        cuePaintFill(self, fill: .controlBackgroundColor, stroke: .separatorColor)
    }

    override func layout() {
        super.layout()
        let icon: CGFloat = 16
        let inset: CGFloat = 8
        let gap: CGFloat = 4
        gripView.frame = NSRect(
            x: inset,
            y: (bounds.height - 12) / 2,
            width: 12,
            height: 12
        )
        let iconX = inset + 14 + gap
        iconView.frame = NSRect(
            x: iconX,
            y: (bounds.height - icon) / 2,
            width: icon,
            height: icon
        )
        let titleX = iconX + icon + gap
        titleField.frame = NSRect(
            x: titleX,
            y: (bounds.height - 20) / 2,
            width: max(0, bounds.width - titleX - inset),
            height: 20
        )
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override var mouseDownCanMoveWindow: Bool {
        false
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard bounds.contains(point) else { return nil }
        return self
    }

    override func mouseDown(with event: NSEvent) {
        onDragBegan?()
        let pasteboardItem = NSPasteboardItem()
        pasteboardItem.setDataProvider(self, forTypes: [.fileURL])
        let fileItem = NSDraggingItem(pasteboardWriter: pasteboardItem)
        fileItem.setDraggingFrame(bounds, contents: dragImage())
        let session = beginDraggingSession(with: [fileItem], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
    }

    func pasteboard(
        _ pasteboard: NSPasteboard?,
        item: NSPasteboardItem,
        provideDataForType type: NSPasteboard.PasteboardType
    ) {
        guard type == .fileURL else { return }
        item.setData(dragURL.dataRepresentation, forType: .fileURL)
    }

    func draggingSession(_ session: NSDraggingSession, willBeginAt screenPoint: NSPoint) {
        isHidden = true
    }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        isHidden = false
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }

    private func dragImage() -> NSImage {
        let image = NSImage(size: bounds.size)
        image.lockFocus()
        displayIgnoringOpacity(bounds, in: NSGraphicsContext.current!)
        image.unlockFocus()
        return image
    }
}

@MainActor
final class GrantCoach {
    private let appName: String
    private let appPath: String
    private let pane: String
    private var isPresented = false
    private var panel: NSPanel?
    private var followTimer: Timer?
    private var grantTimer: Timer?
    private var onGranted: (() -> Void)?
    private var onDismissed: (() -> Void)?
    private var escapeHotKey: EventHotKeyRef?
    private var escapeHandler: EventHandlerRef?
    private var titleField: NSTextField?
    private var lastFollow = CGRect.null

    init(appName: String, appPath: String, pane: String) {
        self.appName = appName
        self.appPath = appPath
        self.pane = pane
    }

    private var paneTitle: String {
        pane == "screen-recording" ? "Screen Recording" : "Input Monitoring"
    }

    func present(onGranted: @escaping () -> Void, onDismissed: (() -> Void)? = nil) {
        self.onGranted = onGranted
        self.onDismissed = onDismissed
        if panel == nil {
            build()
        }
        isPresented = true
        lastFollow = .null
        titleField?.stringValue = "Drop \(appName) on the list above."
        installEscapeHotKey()
        panel?.orderFrontRegardless()
        follow()
        followTimer?.invalidate()
        followTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.follow()
            }
        }
        grantTimer?.invalidate()
        grantTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkGranted()
            }
        }
    }

    func dismiss() {
        guard isPresented else { return }
        isPresented = false
        removeEscapeHotKey()
        followTimer?.invalidate()
        followTimer = nil
        grantTimer?.invalidate()
        grantTimer = nil
        panel?.orderOut(nil)
    }

    func dismissFromEscape() {
        guard isPresented else { return }
        dismiss()
        onDismissed?()
    }

    private func checkGranted() {
        let granted = pane == "screen-recording"
            ? CGPreflightScreenCaptureAccess()
            : CGPreflightListenEventAccess()
        if granted {
            onGranted?()
            dismiss()
        }
    }

    private func build() {
        let width: CGFloat = 360
        let pad: CGFloat = 16
        let gap: CGFloat = 12
        let row: CGFloat = 20
        let chipHeight: CGFloat = 36
        let height = pad + row + gap + chipHeight + pad
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isMovableByWindowBackground = true

        let card = CueChromeView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        card.layer?.shadowOpacity = 0.12
        card.layer?.shadowOffset = CGSize(width: 0, height: -3)
        card.layer?.shadowRadius = 16
        panel.contentView = card

        let arrowY = height - pad - row
        let arrow = NSImageView(frame: NSRect(x: pad, y: arrowY, width: row, height: row))
        arrow.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil)
        arrow.contentTintColor = .controlAccentColor
        arrow.imageScaling = .scaleProportionallyUpOrDown
        card.addSubview(arrow)

        let title = NSTextField(labelWithString: "Drop \(appName) on the list above.")
        title.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        title.textColor = .labelColor
        title.lineBreakMode = .byTruncatingTail
        title.frame = NSRect(x: pad + row + 8, y: arrowY, width: width - pad * 2 - row - 8 - 36, height: row)
        card.addSubview(title)
        self.titleField = title

        let escHint = NSTextField(labelWithString: "Esc")
        escHint.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        escHint.textColor = .tertiaryLabelColor
        escHint.alignment = .right
        escHint.frame = NSRect(x: width - pad - 36, y: arrowY, width: 36, height: row)
        card.addSubview(escHint)

        let chip = AppDragView(
            frame: NSRect(x: pad, y: pad, width: width - pad * 2, height: chipHeight),
            appName: appName,
            appPath: appPath,
            toolTipText: "Drag \(appName) onto the \(paneTitle) list"
        )
        chip.onDragBegan = { [weak self] in
            self?.titleField?.stringValue = "Turn \(self?.appName ?? "the app") on, then quit if asked."
        }
        card.addSubview(chip)
        self.panel = panel
    }

    private func follow() {
        guard isPresented, let panel else { return }
        let size = panel.frame.size
        let next: CGRect
        if let settings = settingsCocoaFrame() {
            next = attachedFrame(settings: settings, size: size)
        } else if let screen = NSScreen.main {
            let visible = screen.visibleFrame
            next = CGRect(
                x: visible.midX - size.width / 2,
                y: visible.minY + 80,
                width: size.width,
                height: size.height
            )
        } else {
            return
        }
        if !lastFollow.isNull {
            let dx = abs(next.midX - lastFollow.midX)
            let dy = abs(next.midY - lastFollow.midY)
            if dx < 3 && dy < 3 {
                return
            }
        }
        lastFollow = next
        panel.setFrame(next, display: true)
    }

    private func attachedFrame(settings: CGRect, size: CGSize) -> CGRect {
        let sidebar = min(280, max(200, floor(settings.width * 0.34)))
        let paneX = settings.minX + sidebar
        let paneW = max(size.width, settings.width - sidebar)
        var x = paneX + paneW / 2 - size.width / 2
        let overlap: CGFloat = 28
        var y = settings.minY - size.height + overlap
        if let screen = NSScreen.screens.first(where: { $0.frame.intersects(settings) }) ?? NSScreen.main {
            let visible = screen.visibleFrame
            x = min(max(x, visible.minX + 12), visible.maxX - size.width - 12)
            y = min(max(y, visible.minY + 8), settings.minY - 8)
        }
        return CGRect(x: x, y: y, width: size.width, height: size.height)
    }

    private func installEscapeHotKey() {
        removeEscapeHotKey()
        guard let dispatcher = GetEventDispatcherTarget() else { return }
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let userData = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            dispatcher,
            grantCoachEscapeHandler,
            1,
            &eventType,
            userData,
            &escapeHandler
        )
        RegisterEventHotKey(
            UInt32(kVK_Escape),
            0,
            EventHotKeyID(signature: OSType(0x53594E21), id: 2),
            dispatcher,
            0,
            &escapeHotKey
        )
    }

    private func removeEscapeHotKey() {
        if let escapeHotKey {
            UnregisterEventHotKey(escapeHotKey)
            self.escapeHotKey = nil
        }
        if let escapeHandler {
            RemoveEventHandler(escapeHandler)
            self.escapeHandler = nil
        }
    }

    nonisolated func handleEscapeHotKey() {
        Task { @MainActor in
            self.dismissFromEscape()
        }
    }

    private func settingsCocoaFrame() -> CGRect? {
        let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        var best: CGRect?
        var bestArea: CGFloat = 0
        for w in info {
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            guard owner == "System Settings" || owner == "System Preferences" else { continue }
            let layer = w[kCGWindowLayer as String] as? Int ?? 0
            guard layer == 0 else { continue }
            let raw = w[kCGWindowBounds as String] as? [String: CGFloat] ?? [:]
            let cg = CGRect(
                x: raw["X"] ?? 0,
                y: raw["Y"] ?? 0,
                width: raw["Width"] ?? 0,
                height: raw["Height"] ?? 0
            )
            let area = cg.width * cg.height
            if cg.width < 480 || cg.height < 360 {
                continue
            }
            if area > bestArea {
                bestArea = area
                best = cocoaRect(fromWindowBounds: cg)
            }
        }
        return best
    }

    private func cocoaRect(fromWindowBounds cg: CGRect) -> CGRect {
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main
        let maxY = primary?.frame.maxY ?? cg.maxY
        let y = maxY - cg.origin.y - cg.height
        return CGRect(x: cg.origin.x, y: y, width: cg.width, height: cg.height)
    }
}

private func grantCoachEscapeHandler(
    _: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event, let userData else { return OSStatus(eventNotHandledErr) }
    var hotKeyID = EventHotKeyID()
    let param = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    guard param == noErr, hotKeyID.id == 2 else {
        return OSStatus(eventNotHandledErr)
    }
    let coach = Unmanaged<GrantCoach>.fromOpaque(userData).takeUnretainedValue()
    coach.handleEscapeHotKey()
    return noErr
}
