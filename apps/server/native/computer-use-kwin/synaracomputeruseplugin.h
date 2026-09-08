/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

#pragma once

#include "plugin.h"
#include "scene/item.h"

#include <QDBusContext>
#include <QByteArray>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QMetaObject>
#include <QPointer>
#include <QPointF>
#include <QSet>
#include <QString>
#include <QThreadPool>
#include <QTimer>
#include <QVariantAnimation>

#include <memory>

class QAction;
struct xkb_state;

namespace KWin
{

class ImageItem;
class LogicalOutput;
class SynaraHumanInputSpy;
class SynaraVirtualInputDevice;
class RenderLoop;
class SeatInterface;
class SurfaceInterface;
class Window;

/**
 * The ghost cursor: the agent's drawn pointer, identical on every backend.
 *
 * On the human's compositor it is a second pointer beside theirs; on a
 * compositor the agent owns it stands in for KWin's native cursor, which is
 * hidden while a session runs. Captures paint it, so the agent sees its own
 * pointer the way a person sees theirs.
 */
class SynaraAgentCursorItem : public Item
{
    Q_OBJECT

public:
    explicit SynaraAgentCursorItem(Item *parent);

    /** The name shown on the badge. Empty falls back to a generic label. */
    void setAgentName(const QString &name);
    /** Positions the item by its hotspot, redrawing if the output scale changed. */
    void setHotspot(const QPointF &position);
    /** Shows the badge and restarts its fade, for every pointer move and action. */
    void noteActivity();

private:
    void refresh();
    qreal targetDevicePixelRatio() const;

    QString m_agentName;
    // What the current images were drawn for. The arrow and the badge are
    // rasterized at one output's scale, so a move onto a differently scaled
    // output has to redraw them rather than let the renderer resample.
    qreal m_devicePixelRatio = 0;
    qreal m_cursorSize = 0;
    std::unique_ptr<ImageItem> m_imageItem;
    std::unique_ptr<ImageItem> m_badgeItem;
    QTimer m_badgeHoldTimer;
    QVariantAnimation m_badgeFade;
};

class SynaraComputerUsePlugin : public Plugin, public QDBusContext
{
    Q_OBJECT

public:
    explicit SynaraComputerUsePlugin();
    ~SynaraComputerUsePlugin() override;

    Q_INVOKABLE QString healthJson() const;
    Q_INVOKABLE QString stateJson() const;
    Q_INVOKABLE QString windowsJson() const;
    Q_INVOKABLE bool start();
    Q_INVOKABLE bool stop();
    Q_INVOKABLE bool setIdleTimeout(uint milliseconds);
    Q_INVOKABLE bool setHumanActiveGuardMs(uint milliseconds);
    Q_INVOKABLE bool setAgentName(const QString &name);
    Q_INVOKABLE bool focusWindow(const QString &windowId);
    Q_INVOKABLE bool raiseWindow(const QString &windowId);
    Q_INVOKABLE bool clearFocusWindow();
    Q_INVOKABLE bool movePointer(double x, double y);
    Q_INVOKABLE bool button(uint button, bool pressed);
    /** Deltas are desktop pixels, not wheel notches. Positive is right and down. */
    Q_INVOKABLE bool axis(double horizontal, double vertical);
    Q_INVOKABLE bool key(uint keyCode, bool pressed);
    Q_INVOKABLE QByteArray captureWindow(const QString &windowId, uint maxDimension);
    Q_INVOKABLE QByteArray captureRegion(int x, int y, uint width, uint height, uint maxDimension);

Q_SIGNALS:
    /**
     * Emitted whenever the session ends without the server asking for it, so a
     * live compositor can be diagnosed with `busctl --user monitor`. Reasons:
     * `request`, `idle-timeout`, `user-release`.
     */
    Q_SCRIPTABLE void sessionStopped(const QString &reason);

private:
    struct CaptureRequest;

    enum class StopReason {
        Request,
        IdleTimeout,
        UserRelease,
    };

    /**
     * Which of the two focus rules a window has to satisfy.
     *
     * They differ over popups: a menu is a legitimate pointer target and never a
     * keyboard one.
     */
    enum class InputKind {
        Pointer,
        Keyboard,
    };

    static QString toJson(const QJsonObject &object);
    static QString toJson(const QJsonArray &array);
    static QString stopReasonName(StopReason reason);

    void stopSession(StopReason reason);
    void registerReleaseShortcut();
    void handleReleaseShortcut();
    bool requireRunning();
    void noteActivity();
    void armIdleTimer();
    qint64 idleMilliseconds() const;
    void sendButton(quint32 code, bool pressed);
    void sendKey(quint32 keyCode, bool pressed);
    void ensureSeat();
    /** Whether whichever input path this compositor uses is actually usable. */
    bool inputReady() const;
    void ensureInputDevice();
    void attachInputDevice();
    void detachInputDevice();
    void ensureCursorItem();
    void setCursorVisible(bool visible);
    void setNativeCursorHidden(bool hidden);
    QPointF confinedPoint(const QPointF &point) const;
    Window *windowAt(const QPointF &point, InputKind kind) const;
    Window *findWindowById(const QString &windowId) const;
    // Every requirement of a window that can be aimed at except taking input.
    bool presentWindow(const Window *window) const;
    // Aimable and focusable: the rule for the keyboard, for an explicit target,
    // and for anything the agent is told it may focus.
    bool usableWindow(const Window *window) const;
    // Aimable and clickable, which includes popups. KWin's popups answer
    // `wantsInput` false by construction, so the keyboard's rule would refuse
    // every menu the pointer has to be able to reach.
    bool pointerUsableWindow(const Window *window) const;
    // The deepest popup transient of this window covering this point, so a menu
    // the target opened is clickable while the target still owns the pointer.
    Window *popupTransientAt(const Window *ancestor, const QPointF &point) const;
    // Whether this window is a popup somewhere below that window in the transient
    // tree, which is how a menu counts as the window that opened it.
    bool popupInTransientTree(const Window *ancestor, const Window *candidate) const;
    // How long ago the human last touched their own devices, or -1 when nothing
    // has been observed yet.
    qint64 humanInputAgeMilliseconds() const;
    // The window seat0 currently has keyboard focus on: the one window on this
    // desktop the agent has no business typing into while its owner is there.
    Window *humanFocusWindow() const;
    // Refuses a mutating action aimed at the window the human is working in,
    // sending the D-Bus error the server turns into a retryable refusal.
    bool refuseIfHumanActive(const Window *window);
    // Whether the client created a wl_pointer object on the agent seat (not just
    // bound the seat). This, not seat binding, decides whether the agent-seat
    // pointer path can reach the client; see usePointerDirectInjection.
    bool clientHasAgentSeatPointer(const SurfaceInterface *surface) const;
    // Whether this client's pointer and keyboard are driven by writing to their
    // own resources rather than through the agent seat: true when the client did
    // not create a pointer object on the agent seat. Keyboard uses the same
    // decision as the pointer; a client whose pointer is on seat0 has its
    // keyboard there too. Crossover on the direct keyboard path is prevented by
    // re-stamping focus per key (reassertDirectKeyboardFocus), not by routing.
    bool usePointerDirectInjection(const Window *window) const;
    bool requireReachableClient(const Window *window, bool directInjection);
    void directPointerEnter(Window *window);
    void directPointerMotion(Window *window);
    void directPointerLeave();
    void directPointerButton(quint32 code, bool pressed);
    void directPointerAxis(double horizontal, double vertical);
    void directKeyboardEnter(Window *window);
    // Re-sends the target's keyboard enter before each key, so a key never
    // follows the human's focus off the agent's target on the shared seat0
    // keyboard object.
    void reassertDirectKeyboardFocus();
    void directKeyboardLeave();
    void directKeyboardKey(quint32 keyCode, bool pressed);
    void directKeyboardModifiers();
    void clearPointerDelivery();
    void clearKeyboardDelivery();
    bool updatePointerFocus();
    bool updateKeyboardFocus();
    void clearKeyboardFocus();
    void updateWindowActivation(Window *window);
    void clearWindowActivation();
    void releasePressedButtons();
    void releasePressedKeys();
    void forgetPressedKeys();
    void releasePressedState();
    void setTimestampNow();
    void syncModifiers();
    void watchRenderLoop(LogicalOutput *output);
    void queueCapture(std::shared_ptr<CaptureRequest> request);
    void scheduleCapture(std::shared_ptr<CaptureRequest> request);
    void handleFrameRequested(RenderLoop *loop);
    void captureAtRenderOpportunity(std::shared_ptr<CaptureRequest> request);
    void finishCapture(std::shared_ptr<CaptureRequest> request, const QByteArray &png, const QString &error);
    void failCapture(std::shared_ptr<CaptureRequest> request, const QString &reason);

    bool m_running = false;
    bool m_releasedByUser = false;
    uint m_idleTimeoutMs;
    // How recently seat0 must have seen the human for the agent to give way on
    // their focused window. 0 disables the guard entirely.
    uint m_humanActiveGuardMs;
    // Where "the human just did something" comes from. Only ever installed on
    // the human's own compositor; see the class comment in the .cpp.
    std::unique_ptr<SynaraHumanInputSpy> m_humanInputSpy;
    QString m_stopReason;
    QTimer m_idleTimer;
    QElapsedTimer m_lastActivity;
    QAction *m_releaseAction = nullptr;
    QPointF m_pos;
    QPointer<Window> m_pointerWindow;
    QPointer<Window> m_keyboardWindow;
    QPointer<Window> m_targetWindow;
    // Distinct from m_targetWindow being non-null: the QPointer clears itself when
    // the window dies, and the agent still needs to know it asked for that window
    // so the input path can refuse rather than retarget.
    bool m_targetRequested = false;
    QPointer<Window> m_activatedWindow;
    // Whether this compositor belongs to the agent alone, which is true of a
    // nested session and never of the human's desktop. Fixed for the plugin's
    // lifetime: it decides which of the two input paths below exists at all.
    const bool m_ownsCompositor;
    SeatInterface *m_seat = nullptr;
    xkb_state *m_xkbState = nullptr;
    std::unique_ptr<SynaraVirtualInputDevice> m_inputDevice;
    bool m_deviceAttached = false;
    // The surfaces currently holding a direct-injection enter, which is the only
    // record of it: nothing in KWin knows these events were sent, so the leave
    // has to be driven from here or the client keeps believing it has focus.
    QPointer<SurfaceInterface> m_directPointerSurface;
    QPointer<SurfaceInterface> m_directKeyboardSurface;
    // Which path the current pointer and keyboard windows are being driven by,
    // decided when the pointer or the keyboard arrived on them. Only meaningful
    // alongside the window it was taken for, and reset with it.
    bool m_pointerDirect = false;
    bool m_keyboardDirect = false;
    // Scroll owed to a client whose wl_pointer predates axis_value120 and can only
    // be told about whole wheel clicks. In value120 units, and belonging to the
    // surface currently holding the direct-injection pointer enter.
    double m_directAxisRemainderH = 0;
    double m_directAxisRemainderV = 0;
    std::unique_ptr<SynaraAgentCursorItem> m_cursorItem;
    // Cursors::hideCursor() is refcounted, so an unbalanced call would blank the
    // compositor's cursor forever; this tracks the one hide this plugin may owe.
    bool m_nativeCursorHidden = false;
    // Held here and not only on the cursor item, because the server names the
    // session before the first start() and the item is built lazily.
    QString m_agentName;
    QList<quint32> m_pressedKeys;
    QSet<quint32> m_pressedButtons;
    QSet<RenderLoop *> m_renderLoops;
    QSet<RenderLoop *> m_captureFrameLoops;
    QTimer m_captureRenderWatchdog;
    QTimer m_captureEncodeWatchdog;
    std::shared_ptr<CaptureRequest> m_captureRequest;
    QThreadPool m_encodePool;
};

} // namespace KWin
