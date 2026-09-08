/*
    SPDX-FileCopyrightText: 2026 Synara

    SPDX-License-Identifier: GPL-2.0-or-later
*/

// The Hyprland twin of the KWin computer-use plugin.
//
// Same D-Bus surface — `org.synara.ComputerUse` at `/org/synara/ComputerUse`,
// interface `org.synara.ComputerUse1`, the same sixteen methods and the same
// `sessionStopped` signal — so the entire server-side driving path built for
// the KWin plugin works unchanged; only how the plugin gets loaded differs
// (`hyprctl plugin load` here, `org.kde.KWin.Plugins` there).
//
// This plugin only ever runs on the human's live compositor, so it is always
// the `!ownsCompositor` shape of the KWin plugin: the agent gets a drawn ghost
// cursor and per-client direct injection, and never a real seat or the human's
// pointer. See the KWin plugin for the full design discussion; comments here
// cover only what Hyprland does differently.
//
// Threading: everything runs on the compositor thread. The D-Bus connection is
// driven by Hyprland's own Wayland event loop (its fds are registered as event
// sources), so method handlers may touch compositor state directly, exactly
// like the KWin plugin's QDBus slots.

#include <hyprland/src/plugins/PluginAPI.hpp>
#include <hyprland/src/plugins/PluginSystem.hpp>
#include <hyprland/src/Compositor.hpp>
#include <hyprland/src/SharedDefs.hpp>
#include <hyprland/src/event/EventBus.hpp>
#include <hyprland/src/render/OpenGL.hpp>
#include <hyprland/src/render/Renderer.hpp>
#include <hyprland/src/render/Texture.hpp>
#include <hyprland/src/render/pass/TexPassElement.hpp>
#include <hyprland/src/render/pass/ClearPassElement.hpp>
#include <hyprland/src/render/Framebuffer.hpp>
#include <hyprland/src/render/gl/GLFramebuffer.hpp>
#include <hyprland/src/helpers/time/Time.hpp>
#include <hyprland/src/desktop/state/WindowState.hpp>
#include <hyprland/src/desktop/state/FocusState.hpp>
#include <hyprland/src/desktop/state/ViewState.hpp>
#include <hyprland/src/desktop/state/ViewStateTracker.hpp>
#include <hyprland/src/desktop/state/ViewHitTester.hpp>
#include <hyprland/src/desktop/view/Window.hpp>
#include <hyprland/src/desktop/Workspace.hpp>
#include <hyprland/src/state/MonitorState.hpp>
#include <hyprland/src/output/Monitor.hpp>
#include <hyprland/src/managers/input/InputManager.hpp>
#include <hyprland/src/managers/SeatManager.hpp>
#include <hyprland/src/devices/IKeyboard.hpp>
#include <hyprland/src/protocols/core/Seat.hpp>
#include <hyprland/src/protocols/core/Compositor.hpp>

#include <cairo/cairo.h>
#include <sdbus-c++/sdbus-c++.h>
#include <wayland-server-core.h>
#include <wayland-server-protocol.h>
#include <xkbcommon/xkbcommon.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <format>
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#ifndef SYNARA_CU_BUILD_ID
#define SYNARA_CU_BUILD_ID "dev"
#endif
#ifndef SYNARA_CU_GIT_HASH
#define SYNARA_CU_GIT_HASH "unknown"
#endif
#ifndef SYNARA_CU_BUILD_TS
#define SYNARA_CU_BUILD_TS ""
#endif

inline HANDLE PHANDLE = nullptr;

namespace {

// ---------------------------------------------------------------------------
// Constants shared with the KWin plugin. Names and values must stay in lock
// step with synaracomputeruseplugin.cpp: the server treats both plugins as the
// same service.
// ---------------------------------------------------------------------------

constexpr const char* SERVICE_NAME   = "org.synara.ComputerUse";
constexpr const char* OBJECT_PATH    = "/org/synara/ComputerUse";
constexpr const char* INTERFACE_NAME = "org.synara.ComputerUse1";

constexpr const char* ERR_CAPTURE          = "org.synara.ComputerUse.Error.CaptureFailed";
constexpr const char* ERR_RELEASED         = "org.synara.ComputerUse.Error.ControlReleased";
constexpr const char* ERR_SEAT_UNSUPPORTED = "org.synara.ComputerUse.Error.SeatUnsupported";
constexpr const char* ERR_HUMAN_ACTIVE     = "org.synara.ComputerUse.Error.HumanActive";

constexpr uint32_t MIN_IDLE_TIMEOUT_MS     = 1000;
constexpr uint32_t MAX_IDLE_TIMEOUT_MS     = 60 * 60 * 1000;
constexpr uint32_t DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

constexpr uint32_t MIN_HUMAN_ACTIVE_GUARD_MS     = 100;
constexpr uint32_t MAX_HUMAN_ACTIVE_GUARD_MS     = 60 * 1000;
constexpr uint32_t DEFAULT_HUMAN_ACTIVE_GUARD_MS = 2000;

constexpr const char* AGENT_FALLBACK_NAME = "Agent";
// The same chord as the KWin plugin, spelled the way the availability card
// shows it. Hyprland has no global-shortcut registry a plugin can use, so the
// chord is recognized from raw key events in the input spy below.
constexpr const char* RELEASE_SHORTCUT_LABEL = "Meta+Shift+Esc";

// evdev keycodes, straight from IKeyboard::SKeyEvent (no xkb +8 offset).
constexpr uint32_t KEYCODE_ESC        = 1;
constexpr uint32_t KEYCODE_LEFTSHIFT  = 42;
constexpr uint32_t KEYCODE_RIGHTSHIFT = 54;
constexpr uint32_t KEYCODE_LEFTMETA   = 125;
constexpr uint32_t KEYCODE_RIGHTMETA  = 126;

// Ghost cursor artwork, identical to the KWin plugin's: Synara violet fill,
// white rim, dark translucent ink outline, and a name badge below-right of the
// hotspot. The silhouette is the same tip-at-origin arrow, in fractions of the
// cursor size.
constexpr struct {
    double x, y;
} CURSOR_OUTLINE[] = {
    {0.00, 0.00}, {0.00, 0.76}, {0.19, 0.58}, {0.30, 0.88}, {0.44, 0.82}, {0.32, 0.54}, {0.56, 0.54},
};

struct SColor {
    double r, g, b, a;
};
constexpr SColor ACCENT_COLOR = {0x7c / 255.0, 0x3a / 255.0, 0xed / 255.0, 1.0};
constexpr SColor RIM_COLOR    = {1.0, 1.0, 1.0, 1.0};
constexpr SColor INK_COLOR    = {0x14 / 255.0, 0x0a / 255.0, 0x2e / 255.0, 0x99 / 255.0};

constexpr double INK_STROKE_RATIO     = 0.085;
constexpr double RIM_STROKE_RATIO     = 0.045;
constexpr double MIN_INK_STROKE_WIDTH = 1.8;
constexpr double MIN_RIM_STROKE_WIDTH = 1.0;
constexpr int    BADGE_MIN_TEXT_PIXELS      = 11;
constexpr double BADGE_MAX_TEXT_WIDTH_RATIO = 8;
constexpr int64_t BADGE_HOLD_MS = 2000;
constexpr int64_t BADGE_FADE_MS = 320;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

double inkStrokeWidth(double size) {
    return std::max(MIN_INK_STROKE_WIDTH, size * INK_STROKE_RATIO);
}

double rimStrokeWidth(double size) {
    return std::max(MIN_RIM_STROKE_WIDTH, size * RIM_STROKE_RATIO);
}

// Transparent room for the strokes, which extend outward past the silhouette on
// every side including the tip. In logical pixels, and therefore also the
// offset from the drawn image's corner to the hotspot.
double strokeMargin(double size) {
    return inkStrokeWidth(size) / 2 + 1;
}

// ---------------------------------------------------------------------------
// JSON building. The KWin plugin has Qt's JSON classes; here a minimal builder
// keeps the payloads byte-compatible without pulling a JSON library into the
// compositor.
// ---------------------------------------------------------------------------

std::string jsonEscape(std::string_view s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (const char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20)
                    out += std::format("\\u{:04x}", static_cast<unsigned char>(c));
                else
                    out += c;
        }
    }
    return out;
}

std::string jsonNumber(double v) {
    if (!std::isfinite(v))
        return "0";
    // Integral values print without a fraction, like Qt's JSON writer.
    if (v == std::floor(v) && std::abs(v) < 1e15)
        return std::format("{}", static_cast<int64_t>(v));
    return std::format("{}", v);
}

class JsonObj {
  public:
    JsonObj& raw(std::string_view key, std::string_view rawValue) {
        m_out += m_first ? "\"" : ",\"";
        m_first = false;
        m_out += jsonEscape(key);
        m_out += "\":";
        m_out += rawValue;
        return *this;
    }
    JsonObj& str(std::string_view key, std::string_view value) {
        return raw(key, "\"" + jsonEscape(value) + "\"");
    }
    JsonObj& num(std::string_view key, double value) {
        return raw(key, jsonNumber(value));
    }
    JsonObj& boolean(std::string_view key, bool value) {
        return raw(key, value ? "true" : "false");
    }
    std::string build() const {
        return "{" + m_out + "}";
    }

  private:
    std::string m_out;
    bool        m_first = true;
};

class JsonArr {
  public:
    JsonArr& raw(std::string_view rawValue) {
        if (!m_out.empty())
            m_out += ",";
        m_out += rawValue;
        return *this;
    }
    JsonArr& str(std::string_view value) {
        return raw("\"" + jsonEscape(value) + "\"");
    }
    std::string build() const {
        return "[" + m_out + "]";
    }

  private:
    std::string m_out;
};

std::string rectJson(const CBox& box) {
    return JsonObj{}.num("x", box.x).num("y", box.y).num("width", box.w).num("height", box.h).build();
}

std::string pointJson(const Vector2D& p) {
    return JsonObj{}.num("x", p.x).num("y", p.y).build();
}

// ---------------------------------------------------------------------------
// Plugin state
// ---------------------------------------------------------------------------

struct SListeners {
    CHyprSignalListener renderStage;
    CHyprSignalListener mouseMove;
    CHyprSignalListener mouseButton;
    CHyprSignalListener mouseAxis;
    CHyprSignalListener keyboardKey;
    CHyprSignalListener pointerFocusChange;
};

enum class StopReason : uint8_t {
    Request,
    IdleTimeout,
    UserRelease,
};

struct SState {
    bool     running        = false;
    bool     releasedByUser = false;
    uint32_t idleTimeoutMs      = DEFAULT_IDLE_TIMEOUT_MS;
    uint32_t humanActiveGuardMs = DEFAULT_HUMAN_ACTIVE_GUARD_MS;

    std::string agentName;
    std::string stopReason;

    Vector2D pos;

    // Wall-clock bookkeeping, all in steady-clock milliseconds.
    int64_t lastActivityMs   = 0;
    int64_t lastHumanInputMs = -1;

    PHLWINDOWREF pointerWindow;
    PHLWINDOWREF keyboardWindow;
    PHLWINDOWREF targetWindow;
    // Distinct from targetWindow being expired: the ref clears itself when the
    // window dies, and the agent still needs to know it asked for that window
    // so the input path can refuse rather than retarget.
    bool targetRequested = false;

    // Direct injection state: the surfaces the agent has told about its pointer
    // and keyboard (its enter/leave bookkeeping, independent of the seat's),
    // and everything it is currently holding down there.
    WP<CWLSurfaceResource> directPointerSurface;
    bool directPointerNeedsEnter = true;
    WP<CWLSurfaceResource> directKeyboardSurface;
    std::set<uint32_t>     pressedButtons;
    // The seat's pointer focus as of its last change signal. The signal carries
    // no payload, so the surface the seat just left is remembered here: a leave
    // from a sibling surface of the agent's target invalidates the target's
    // enter just as an enter into one does (see onSeatPointerFocusChange).
    WP<CWLSurfaceResource> seatPointerFocus;
    // Ordered, because wl_keyboard.enter carries the held keys as an array and
    // the press order is the honest one to replay.
    std::vector<uint32_t> pressedKeys;
    // Sub-notch scroll owed to clients too old for axis_value120.
    double axisRemainderH = 0;
    double axisRemainderV = 0;
    // The agent's own xkb modifier state, built from the seat keyboard's keymap
    // and fed only the agent's keys, so its Ctrl is never the human's Ctrl.
    xkb_state*  xkbState       = nullptr;
    xkb_keymap* xkbStateKeymap = nullptr;

    // Physical keycodes currently held on the human's keyboard, kept only to
    // recognize the release chord.
    std::set<uint32_t> humanHeldKeys;

    // Ghost cursor render state. Textures are (re)built inside the render hook
    // where a GL context is current, whenever `cursorArtDirty` or the output
    // scale changed.
    bool                    cursorVisible = false;
    bool                    cursorArtDirty = true;
    double                  cursorArtScale = 0;
    double                  cursorSize     = 0;
    SP<Render::ITexture>    cursorTex;
    SP<Render::ITexture>    badgeTex;
    Vector2D                cursorTexLogicalSize;
    Vector2D                badgeTexLogicalSize;
    double                  lastBadgeAlpha = 0;

    // D-Bus plumbing, driven from the compositor's event loop.
    std::unique_ptr<sdbus::IConnection> dbus;
    std::unique_ptr<sdbus::IObject>     dbusObject;
    wl_event_source*                    dbusFdSource    = nullptr;
    wl_event_source*                    dbusEvtFdSource = nullptr;
    wl_event_source*                    idleTimerSource = nullptr;

    SListeners listeners;

    std::string hyprlandVersion;
};

SState g;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

std::string windowId(const PHLWINDOW& w) {
    return std::format("{:x}", reinterpret_cast<uintptr_t>(w.get()));
}

PHLWINDOW findWindowById(const std::string& id) {
    std::string hex = id;
    if (hex.starts_with("0x") || hex.starts_with("0X"))
        hex = hex.substr(2);
    uintptr_t address = 0;
    try {
        address = static_cast<uintptr_t>(std::stoull(hex, nullptr, 16));
    } catch (...) {
        return nullptr;
    }
    for (const auto& w : Desktop::windowState()->windows()) {
        if (reinterpret_cast<uintptr_t>(w.get()) == address)
            return w;
    }
    return nullptr;
}

// Every requirement of a window that can be aimed at: mapped, not hidden, and
// on a workspace that is actually on screen.
bool usableWindow(const PHLWINDOW& w) {
    if (!w || !w->m_isMapped || w->isHidden())
        return false;
    if (w->m_workspace && !w->m_workspace->isVisible())
        return false;
    return true;
}

CBox windowBounds(const PHLWINDOW& w) {
    if (const auto box = w->logicalBox(); box.has_value())
        return *box;
    return w->getFullWindowBoundingBox();
}

// The union of every monitor, which is what the KWin plugin reports as the
// workspace geometry. Hyprland has no single-call equivalent, so fold.
CBox workspaceGeometry() {
    bool   any = false;
    double x1 = 0, y1 = 0, x2 = 0, y2 = 0;
    for (const auto& mon : State::monitorState()->monitors()) {
        if (!mon)
            continue;
        const CBox box = mon->logicalBox();
        if (!any) {
            x1 = box.x;
            y1 = box.y;
            x2 = box.x + box.w;
            y2 = box.y + box.h;
            any = true;
        } else {
            x1 = std::min(x1, box.x);
            y1 = std::min(y1, box.y);
            x2 = std::max(x2, box.x + box.w);
            y2 = std::max(y2, box.y + box.h);
        }
    }
    if (!any)
        return CBox{0, 0, 0, 0};
    return CBox{x1, y1, x2 - x1, y2 - y1};
}

PHLWINDOW windowAtPoint(const Vector2D& pos) {
    return Desktop::viewState()->hitTest().windowAt(pos, Desktop::View::RESERVED_EXTENTS | Desktop::View::INPUT_EXTENTS | Desktop::View::ALLOW_FLOATING);
}

// ---------------------------------------------------------------------------
// Ghost cursor drawing (cairo). Layout mirrors the KWin item pixel for pixel:
// the arrow image's corner sits at hotspot - margin, the badge below-right of
// the hotspot, clear of the arrow.
// ---------------------------------------------------------------------------

double agentCursorSize() {
    // The human's own cursor size, so the ghost is the same physical size as
    // the pointer it sits beside. Hyprland publishes it through XCURSOR_SIZE.
    if (const char* env = std::getenv("XCURSOR_SIZE")) {
        const int size = std::atoi(env);
        if (size > 0)
            return size;
    }
    return 24;
}

void cursorPath(cairo_t* cr, double size) {
    cairo_new_path(cr);
    cairo_move_to(cr, CURSOR_OUTLINE[0].x * size, CURSOR_OUTLINE[0].y * size);
    for (size_t i = 1; i < std::size(CURSOR_OUTLINE); ++i)
        cairo_line_to(cr, CURSOR_OUTLINE[i].x * size, CURSOR_OUTLINE[i].y * size);
    cairo_close_path(cr);
}

void setColor(cairo_t* cr, const SColor& c) {
    cairo_set_source_rgba(cr, c.r, c.g, c.b, c.a);
}

void roundedRectPath(cairo_t* cr, double x, double y, double w, double h, double r) {
    cairo_new_path(cr);
    cairo_arc(cr, x + r, y + r, r, M_PI / 2 * 2, M_PI / 2 * 3);
    cairo_arc(cr, x + w - r, y + r, r, M_PI / 2 * 3, M_PI / 2 * 4);
    cairo_arc(cr, x + w - r, y + h - r, r, 0, M_PI / 2);
    cairo_arc(cr, x + r, y + h - r, r, M_PI / 2, M_PI);
    cairo_close_path(cr);
}

struct SRenderedImage {
    cairo_surface_t* surface = nullptr;
    Vector2D         logicalSize;
};

SRenderedImage renderImage(const Vector2D& logicalSize, double scale, auto&& paint) {
    const int pw = std::max(1, static_cast<int>(std::ceil(logicalSize.x * scale)));
    const int ph = std::max(1, static_cast<int>(std::ceil(logicalSize.y * scale)));
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, pw, ph);
    cairo_t*         cr      = cairo_create(surface);
    cairo_scale(cr, scale, scale);
    paint(cr);
    cairo_destroy(cr);
    cairo_surface_flush(surface);
    return {surface, logicalSize};
}

SRenderedImage renderCursorImage(double size, double scale) {
    const double margin  = strokeMargin(size);
    const double boundsW = 0.56 * size; // rightmost outline point
    const double boundsH = 0.88 * size; // lowest outline point
    return renderImage({boundsW + 2 * margin, boundsH + 2 * margin}, scale, [&](cairo_t* cr) {
        cairo_translate(cr, margin, margin);
        cairo_set_line_join(cr, CAIRO_LINE_JOIN_ROUND);
        cursorPath(cr, size);
        setColor(cr, INK_COLOR);
        cairo_set_line_width(cr, inkStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, RIM_COLOR);
        cairo_set_line_width(cr, rimStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, ACCENT_COLOR);
        cairo_fill(cr);
    });
}

void selectBadgeFont(cairo_t* cr, double size) {
    cairo_select_font_face(cr, "sans-serif", CAIRO_FONT_SLANT_NORMAL, CAIRO_FONT_WEIGHT_BOLD);
    cairo_set_font_size(cr, std::max(double(BADGE_MIN_TEXT_PIXELS), std::round(size * 0.5)));
}

// Drops whole UTF-8 code points from the end, for the badge's eliding.
void utf8PopBack(std::string& s) {
    while (!s.empty() && (static_cast<unsigned char>(s.back()) & 0xC0) == 0x80)
        s.pop_back();
    if (!s.empty())
        s.pop_back();
}

SRenderedImage renderBadgeImage(const std::string& name, double size, double scale) {
    const double margin = strokeMargin(size);

    // Measure with a scratch context so the real surface can be allocated at
    // the right size before any drawing happens.
    cairo_surface_t* scratchSurface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 1, 1);
    cairo_t*         scratch        = cairo_create(scratchSurface);
    selectBadgeFont(scratch, size);

    std::string text     = name;
    const double maxWidth = size * BADGE_MAX_TEXT_WIDTH_RATIO;
    cairo_text_extents_t textExtents;
    cairo_text_extents(scratch, text.c_str(), &textExtents);
    if (textExtents.x_advance > maxWidth) {
        while (!text.empty()) {
            cairo_text_extents(scratch, (text + "…").c_str(), &textExtents);
            if (textExtents.x_advance <= maxWidth)
                break;
            utf8PopBack(text);
        }
        text += "…";
        cairo_text_extents(scratch, text.c_str(), &textExtents);
    }
    cairo_font_extents_t fontExtents;
    cairo_font_extents(scratch, &fontExtents);
    cairo_destroy(scratch);
    cairo_surface_destroy(scratchSurface);

    const double paddingX = std::round(size * 0.30);
    const double paddingY = std::round(size * 0.14);
    const double bodyW    = std::ceil(textExtents.x_advance + 2 * paddingX);
    const double bodyH    = std::ceil(fontExtents.ascent + fontExtents.descent + 2 * paddingY);

    return renderImage({bodyW + 2 * margin, bodyH + 2 * margin}, scale, [&](cairo_t* cr) {
        const double radius = bodyH / 2;
        roundedRectPath(cr, margin, margin, bodyW, bodyH, radius);
        setColor(cr, INK_COLOR);
        cairo_set_line_width(cr, inkStrokeWidth(size));
        cairo_stroke_preserve(cr);
        setColor(cr, ACCENT_COLOR);
        cairo_fill_preserve(cr);
        setColor(cr, RIM_COLOR);
        cairo_set_line_width(cr, rimStrokeWidth(size));
        cairo_stroke(cr);

        selectBadgeFont(cr, size);
        cairo_text_extents_t te;
        cairo_text_extents(cr, text.c_str(), &te);
        cairo_font_extents_t fe;
        cairo_font_extents(cr, &fe);
        setColor(cr, RIM_COLOR);
        cairo_move_to(cr, margin + (bodyW - te.x_advance) / 2, margin + (bodyH - (fe.ascent + fe.descent)) / 2 + fe.ascent);
        cairo_show_text(cr, text.c_str());
    });
}

// The on-screen footprint of the arrow, in global logical coordinates.
CBox cursorBox() {
    const double size   = g.cursorSize > 0 ? g.cursorSize : agentCursorSize();
    const double margin = strokeMargin(size);
    const Vector2D texSize = g.cursorTexLogicalSize.x > 0 ? g.cursorTexLogicalSize : Vector2D{0.56 * size + 2 * margin, 0.88 * size + 2 * margin};
    return CBox{g.pos.x - margin, g.pos.y - margin, texSize.x, texSize.y};
}

// Below and right of the hotspot, clear of the arrow, so the badge never covers
// the pixel the agent is about to click.
CBox badgeBox() {
    const double size   = g.cursorSize > 0 ? g.cursorSize : agentCursorSize();
    const double margin = strokeMargin(size);
    const Vector2D texSize = g.badgeTexLogicalSize.x > 0 ? g.badgeTexLogicalSize : Vector2D{size * 4, size};
    return CBox{g.pos.x + std::round(size * 0.55) - margin, g.pos.y + std::round(size * 0.90) - margin, texSize.x, texSize.y};
}

void damageCursorArea() {
    if (!g_pHyprRenderer)
        return;
    g_pHyprRenderer->damageBox(cursorBox());
    g_pHyprRenderer->damageBox(badgeBox());
}

double easeInOutQuad(double t) {
    return t < 0.5 ? 2 * t * t : 1 - std::pow(-2 * t + 2, 2) / 2;
}

// 1 while held after activity, easing to 0 over the fade window — the KWin
// badge's hold-then-fade, computed per frame instead of with an animation
// object.
double badgeAlpha() {
    const int64_t elapsed = nowMs() - g.lastActivityMs;
    if (elapsed < BADGE_HOLD_MS)
        return 1;
    if (elapsed < BADGE_HOLD_MS + BADGE_FADE_MS)
        return 1 - easeInOutQuad(double(elapsed - BADGE_HOLD_MS) / BADGE_FADE_MS);
    return 0;
}

void ensureCursorTextures(double scale) {
    const double size = agentCursorSize();
    if (!g.cursorArtDirty && g.cursorArtScale == scale && g.cursorSize == size && g.cursorTex)
        return;

    SRenderedImage cursor = renderCursorImage(size, scale);
    SRenderedImage badge  = renderBadgeImage(g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName, size, scale);

    g.cursorTex            = g_pHyprRenderer->createTexture(cursor.surface);
    g.badgeTex             = g_pHyprRenderer->createTexture(badge.surface);
    g.cursorTexLogicalSize = cursor.logicalSize;
    g.badgeTexLogicalSize  = badge.logicalSize;
    cairo_surface_destroy(cursor.surface);
    cairo_surface_destroy(badge.surface);

    g.cursorArtDirty = false;
    g.cursorArtScale = scale;
    g.cursorSize     = size;
}

void onRenderLastMoment() {
    if (!g.running || !g.cursorVisible || !g_pHyprRenderer)
        return;
    const auto monitor = g_pHyprRenderer->m_renderData.pMonitor.lock();
    if (!monitor)
        return;

    const CBox monitorBox = monitor->logicalBox();
    const CBox arrow      = cursorBox();
    const CBox badge      = badgeBox();
    const double alpha    = badgeAlpha();

    const auto overlaps = [&](const CBox& box) {
        return box.x < monitorBox.x + monitorBox.w && box.x + box.w > monitorBox.x && box.y < monitorBox.y + monitorBox.h && box.y + box.h > monitorBox.y;
    };
    if (!overlaps(arrow) && !(alpha > 0 && overlaps(badge)))
        return;

    ensureCursorTextures(monitor->m_scale);
    if (!g.cursorTex)
        return;

    // Pass element boxes are monitor-local pixels, like every box the core
    // renderer queues.
    const auto toLocal = [&](CBox box) {
        return box.translate(-monitor->m_position).scale(monitor->m_scale).round();
    };

    if (alpha > 0 && g.badgeTex && overlaps(badge)) {
        CTexPassElement::SRenderData data;
        data.tex = g.badgeTex;
        data.box = toLocal(badge);
        data.a   = static_cast<float>(alpha);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }
    if (overlaps(arrow)) {
        CTexPassElement::SRenderData data;
        data.tex = g.cursorTex;
        data.box = toLocal(arrow);
        g_pHyprRenderer->m_renderPass.add(makeUnique<CTexPassElement>(std::move(data)));
    }
}

// Keeps the badge fade animating: while its alpha is changing, each rendered
// frame damages the badge so the next one gets scheduled.
void onRenderPre() {
    if (!g.running || !g.cursorVisible)
        return;
    const double alpha = badgeAlpha();
    if (alpha != g.lastBadgeAlpha) {
        g.lastBadgeAlpha = alpha;
        if (g_pHyprRenderer)
            g_pHyprRenderer->damageBox(badgeBox());
    }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

const char* stopReasonName(StopReason reason) {
    switch (reason) {
        case StopReason::IdleTimeout: return "idle-timeout";
        case StopReason::UserRelease: return "user-release";
        case StopReason::Request: break;
    }
    return "request";
}

void armIdleTimer() {
    if (!g.idleTimerSource)
        return;
    if (g.running && g.idleTimeoutMs > 0) {
        const int64_t remaining = int64_t(g.idleTimeoutMs) - (nowMs() - g.lastActivityMs);
        wl_event_source_timer_update(g.idleTimerSource, static_cast<int>(std::max<int64_t>(1, remaining)));
    } else {
        wl_event_source_timer_update(g.idleTimerSource, 0);
    }
}

void noteActivity() {
    g.lastActivityMs = nowMs();
    armIdleTimer();
    if (g.running && g.cursorVisible && g_pHyprRenderer)
        g_pHyprRenderer->damageBox(badgeBox());
}

int64_t idleMilliseconds() {
    return nowMs() - g.lastActivityMs;
}

int64_t humanInputAgeMilliseconds() {
    if (g.lastHumanInputMs < 0)
        return -1;
    return nowMs() - g.lastHumanInputMs;
}

// ---------------------------------------------------------------------------
// Direct per-client input injection.
//
// The KWin plugin's direct path, on Hyprland: events are written straight to
// the target client's own wl_pointer/wl_keyboard resources, never through the
// compositor's input pipeline. The human's seat state is untouched — Hyprland's
// CSeatManager and CWLPointerResource focus bookkeeping never see these events,
// which is exactly the point: the compositor keeps routing the human's devices
// as if the agent did not exist. The only compositor state used is the serial
// counter, so that a client quoting an agent click's serial back (for a popup
// grab or a drag) passes Hyprland's serial validation.
// ---------------------------------------------------------------------------

std::vector<wl_resource*> clientInputResources(wl_client* client, const char* interfaceName) {
    struct SFilter {
        const char*               name;
        std::vector<wl_resource*> out;
    } filter{interfaceName, {}};
    wl_client_for_each_resource(
        client,
        [](wl_resource* resource, void* data) {
            auto* f = static_cast<SFilter*>(data);
            if (std::string_view{wl_resource_get_class(resource)} == f->name)
                f->out.push_back(resource);
            return WL_ITERATOR_CONTINUE;
        },
        &filter);
    return filter.out;
}

SP<CWLSurfaceResource> windowMainSurface(const PHLWINDOW& w) {
    return w ? w->resource() : nullptr;
}

uint32_t directTimestampMs() {
    // Same steady clock as the compositor's own input timestamps, so deltas
    // (double-click detection, kinetic scroll) stay meaningful across the two.
    return static_cast<uint32_t>(nowMs());
}

// A serial the client can quote back: allocated through the seat manager so it
// lands in the client's seat-resource serial list that Hyprland validates
// grab/drag requests against. The display counter is only a fallback for a
// client that somehow holds input resources without a seat resource.
uint32_t directSerial(const SP<CWLSurfaceResource>& surface, bool enter = false) {
    if (surface && g_pSeatManager) {
        if (const auto seatResource = g_pSeatManager->seatResourceForClient(surface->client()))
            return g_pSeatManager->nextSerial(seatResource, enter);
    }
    return wl_display_next_serial(g_pCompositor->m_wlDisplay);
}

void directPointerButtonEvent(const SP<CWLSurfaceResource>& surface, uint32_t code, bool pressed) {
    const auto seatResource = g_pSeatManager ? g_pSeatManager->seatResourceForClient(surface->client()) : nullptr;
    if (!pressed && seatResource)
        g_pSeatManager->clearPointerButtonSerials(seatResource, surface, code);
    const uint32_t serial = seatResource ? g_pSeatManager->nextSerial(seatResource) : wl_display_next_serial(g_pCompositor->m_wlDisplay);
    if (pressed && seatResource)
        g_pSeatManager->recordPointerButtonSerial(seatResource, serial, surface, code);
    const uint32_t time = directTimestampMs();
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_pointer")) {
        wl_pointer_send_button(resource, serial, time, code, pressed ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

// Everything still held is released on the surface that saw the press, because
// nothing else will ever release it: a button left down while the pointer
// migrates stays down in the client being left forever.
void releasePressedButtons() {
    if (const auto surface = g.directPointerSurface.lock()) {
        for (const uint32_t code : std::vector<uint32_t>(g.pressedButtons.begin(), g.pressedButtons.end()))
            directPointerButtonEvent(surface, code, false);
    }
    g.pressedButtons.clear();
}

// Where the human's pointer is, in the coordinates of the surface the seat
// has entered: the position the seat itself would quote in an enter.
Vector2D seatPointerLocal(const SP<CWLSurfaceResource>& surface) {
    if (!g_pInputManager)
        return {};
    const auto global = g_pInputManager->getMouseCoordsInternal();
    if (const auto hlSurface = surface->m_hlSurface.lock()) {
        if (const auto box = hlSurface->getSurfaceBoxGlobal())
            return global - box->pos();
    }
    return {};
}

// Re-sends the seat's own wl_pointer.enter for the surface the human's pointer
// is on, if that surface belongs to `client`. The agent's enter above took the
// client's shared wl_pointer away from the seat; this gives it back, so the
// human's next motion, scroll, or click is routed to their window again.
void restoreSeatPointerEnter(wl_client* client) {
    if (!g_pSeatManager)
        return;
    const auto seatSurface = g_pSeatManager->m_state.pointerFocus.lock();
    if (!seatSurface || seatSurface->client() != client)
        return;
    const auto     local  = seatPointerLocal(seatSurface);
    const uint32_t serial = directSerial(seatSurface, true);
    for (wl_resource* resource : clientInputResources(client, "wl_pointer")) {
        wl_pointer_send_enter(resource, serial, seatSurface->getResource()->resource(), wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

void directPointerLeave(bool forgetSurface = true) {
    const auto surface = g.directPointerSurface.lock();
    const bool entered = !g.directPointerNeedsEnter;
    g.directPointerNeedsEnter = true;
    if (forgetSurface) {
        g.directPointerSurface.reset();
        // Owed sub-notch clicks belong to the surface that was being scrolled.
        g.axisRemainderH = 0;
        g.axisRemainderV = 0;
    }
    if (!surface || !entered)
        return;
    // Never revoke a focus the human is holding: if their pointer sits on this
    // surface, the enter the client believes in is the seat's, not ours.
    if (g_pSeatManager && g_pSeatManager->m_state.pointerFocus.lock() == surface)
        return;
    const uint32_t serial = directSerial(surface);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_pointer")) {
        wl_pointer_send_leave(resource, serial, surface->getResource()->resource());
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
    // A leave from our surface leaves the client with no entered surface at
    // all, even when the human's pointer is on a sibling window of it.
    restoreSeatPointerEnter(surface->client());
}

// The hand-back, the other half of the shared-object problem. While the human's
// pointer is on another surface of the client the agent is entered on, the
// client's one wl_pointer belongs to whichever of us entered last, and the
// human's motion, scroll, and clicks name no surface: after the agent's enter
// they would all land in the agent's window until the seat happened to send a
// fresh enter of its own. So every agent burst ends by returning the pointer to
// the seat's surface. The logical target and fractional scroll remain, but the
// next agent event re-enters its target first (see directPointerMotion), so the two
// take turns and the human always ends up in possession. Hover state on the
// agent's target does not survive this, which is the right trade: the human is
// using that application right now. A held button is the one exception — a
// drag cannot change surfaces mid-way — so the hand-back waits for its release.
void returnPointerToSeat() {
    if (!g_pSeatManager || !g.pressedButtons.empty())
        return;
    const auto agentSurface = g.directPointerSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.pointerFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface == agentSurface || seatSurface->client() != agentSurface->client())
        return;
    // Keep the logical target and its fractional scroll while returning the
    // protocol object. The next motion must enter again before sending input.
    directPointerLeave(false);
}

// Enter-if-needed plus motion, aimed by the ghost cursor's position. The hit
// test descends into the window's popups and subsurfaces, so an open dropdown
// of the target receives the events meant for the pixel it covers.
void directPointerMotion(const PHLWINDOW& window) {
    Vector2D   local;
    const auto surface = Desktop::viewState()->hitTest().windowSurfaceAt(g.pos, window, local);
    if (!surface) {
        releasePressedButtons();
        directPointerLeave();
        return;
    }
    if (!g.directPointerSurface.expired() && g.directPointerSurface.lock() != surface) {
        releasePressedButtons();
        directPointerLeave();
    }
    const auto resources = clientInputResources(surface->client(), "wl_pointer");
    if (resources.empty()) {
        // A client holding no wl_pointer cannot be told about an enter, and
        // claiming the surface as entered anyway would swallow the enter it
        // still needs if it binds a pointer later (a client binds one the
        // moment the seat first advertises the capability). Left unclaimed,
        // the next motion retries the enter against whatever it holds then.
        releasePressedButtons();
        directPointerLeave();
        return;
    }
    const bool reenter    = g.directPointerNeedsEnter || g.directPointerSurface.lock() != surface;
    g.directPointerSurface = surface;
    g.directPointerNeedsEnter = false;
    const uint32_t time   = directTimestampMs();
    const uint32_t serial = reenter ? directSerial(surface, true) : 0;
    for (wl_resource* resource : resources) {
        if (reenter)
            wl_pointer_send_enter(resource, serial, surface->getResource()->resource(), wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        wl_pointer_send_motion(resource, time, wl_fixed_from_double(local.x), wl_fixed_from_double(local.y));
        if (wl_resource_get_version(resource) >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
}

void clearPointerDelivery() {
    releasePressedButtons();
    directPointerLeave();
    g.pointerWindow.reset();
}

// Maintains the pointer's enter/leave state to match the ghost cursor, and
// says whether there is a surface to deliver to. An explicit target owns the
// pointer: a point it does not claim is refused rather than delivered to
// whatever covers it, because the caller can recover from a refusal and cannot
// recover from a click it never made.
bool updatePointerFocus() {
    PHLWINDOW window;
    if (g.targetRequested) {
        const auto target = g.targetWindow.lock();
        if (!usableWindow(target)) {
            clearPointerDelivery();
            return false;
        }
        window = target;
    } else {
        window = windowAtPoint(g.pos);
    }
    if (!usableWindow(window)) {
        clearPointerDelivery();
        return false;
    }
    g.pointerWindow = window;
    directPointerMotion(window);
    return !g.directPointerSurface.expired();
}

// The shared-object focus invalidation, the pointer twin of the keyboard's
// enter re-stamp below. A client's wl_pointer is one object, shared between the
// human's seat and the agent's direct injection, and the client keeps exactly
// one "entered" surface on it: whichever enter it heard last, from either of
// us. wl_pointer.motion and .button name no surface, so once the seat has
// entered another surface of the same client — the human moving into the
// second window of the same browser — every agent event still aimed at its
// target is routed by the client to the human's window instead, and once the
// seat leaves that window, to nothing. The agent's own bookkeeping cannot see
// any of that; only this signal can. So whenever the seat's focus moves into or
// out of a surface of the client the agent is entered on, the agent forgets its
// enter (without a leave: the enter the client now believes in is the seat's,
// not ours to revoke — the same rule directPointerLeave already follows for a
// surface the human sits on), and the next motion re-enters the target with a
// fresh serial before anything else is delivered. Buttons the agent is holding
// are released first: they were pressed on a surface the agent can no longer
// address, and a press nobody releases stays down in that client forever.
// Focus changes between other clients are left alone, so hover state on the
// target survives ordinary agent motion.
void onSeatPointerFocusChange() {
    const auto previous = g.seatPointerFocus.lock();
    const auto current  = g_pSeatManager ? g_pSeatManager->m_state.pointerFocus.lock() : nullptr;
    g.seatPointerFocus  = current;

    const auto agentSurface = g.directPointerSurface.lock();
    if (!agentSurface)
        return;
    wl_client* const agentClient = agentSurface->client();
    const bool       touchesAgentClient = (previous && previous->client() == agentClient) || (current && current->client() == agentClient);
    if (!touchesAgentClient)
        return;

    releasePressedButtons();
    g.directPointerSurface.reset();
    g.directPointerNeedsEnter = true;
    // Owed sub-notch clicks belonged to the enter just invalidated.
    g.axisRemainderH = 0;
    g.axisRemainderV = 0;
}

void ensureXkbState() {
    xkb_keymap* keymap = nullptr;
    if (g_pSeatManager) {
        if (const auto keyboard = g_pSeatManager->m_keyboard.lock())
            keymap = keyboard->m_xkbKeymap;
    }
    if (g.xkbState && g.xkbStateKeymap == keymap)
        return;
    if (g.xkbState) {
        xkb_state_unref(g.xkbState);
        g.xkbState = nullptr;
    }
    g.xkbStateKeymap = keymap;
    if (keymap)
        g.xkbState = xkb_state_new(keymap);
}

void directKeyboardModifiers() {
    const auto surface = g.directKeyboardSurface.lock();
    if (!surface || !g.xkbState)
        return;
    const uint32_t serial    = directSerial(surface);
    const uint32_t depressed = xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_DEPRESSED);
    const uint32_t latched   = xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_LATCHED);
    const uint32_t locked    = xkb_state_serialize_mods(g.xkbState, XKB_STATE_MODS_LOCKED);
    const uint32_t group     = xkb_state_serialize_layout(g.xkbState, XKB_STATE_LAYOUT_EFFECTIVE);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_modifiers(resource, serial, depressed, latched, locked, group);
}

// The enter re-stamp. A wl_keyboard.key event names no surface: the client
// routes it to whatever its keyboard last entered, and that keyboard object is
// shared with the human's seat — the human clicking another window mid-type
// would carry the agent's remaining keystrokes with it. Re-stamping the enter
// on the agent's target before every key reclaims focus for that key, whatever
// the human just did. No keymap is sent with it: the client bound the real
// seat and already has that seat's keymap, the same layout the agent's xkb
// state mirrors. The keys array carries the held state as it is *before* the
// event this re-stamp precedes, so a chord's modifiers survive it.
void sendKeyboardEnterEvent(const SP<CWLSurfaceResource>& surface) {
    wl_array keys;
    wl_array_init(&keys);
    for (const uint32_t key : g.pressedKeys) {
        if (auto* slot = static_cast<uint32_t*>(wl_array_add(&keys, sizeof(uint32_t))))
            *slot = key;
    }
    const uint32_t serial = directSerial(surface, true);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_enter(resource, serial, surface->getResource()->resource(), &keys);
    wl_array_release(&keys);
    directKeyboardModifiers();
}

void directKeyboardKeyEvent(const SP<CWLSurfaceResource>& surface, uint32_t keyCode, bool pressed) {
    const uint32_t serial = directSerial(surface);
    const uint32_t time   = directTimestampMs();
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_key(resource, serial, time, keyCode, pressed ? WL_KEYBOARD_KEY_STATE_PRESSED : WL_KEYBOARD_KEY_STATE_RELEASED);
}

// Same shape as the pointer's: releases land on the surface that saw the
// press, and the agent's xkb state unwinds with them so a half-finished chord
// cannot leak a held Ctrl into the next window.
void releasePressedKeys() {
    if (const auto surface = g.directKeyboardSurface.lock()) {
        for (const uint32_t key : std::vector<uint32_t>(g.pressedKeys))
            directKeyboardKeyEvent(surface, key, false);
    }
    if (g.xkbState) {
        for (const uint32_t key : g.pressedKeys)
            xkb_state_update_key(g.xkbState, key + 8, XKB_KEY_UP);
    }
    g.pressedKeys.clear();
    directKeyboardModifiers();
}

// The keyboard twin of restoreSeatPointerEnter: the seat's own enter for the
// surface the human's keyboard focus is on, if it belongs to `client`, carrying
// the keys the human is physically holding and the seat keyboard's modifier
// state, so a Shift the human has down survives the agent's turn.
void restoreSeatKeyboardEnter(wl_client* client) {
    if (!g_pSeatManager)
        return;
    const auto seatSurface = g_pSeatManager->m_state.keyboardFocus.lock();
    if (!seatSurface || seatSurface->client() != client)
        return;
    wl_array keys;
    wl_array_init(&keys);
    for (const uint32_t key : g.humanHeldKeys) {
        if (auto* slot = static_cast<uint32_t*>(wl_array_add(&keys, sizeof(uint32_t))))
            *slot = key;
    }
    const uint32_t serial   = directSerial(seatSurface, true);
    const auto     keyboard = g_pSeatManager->m_keyboard.lock();
    for (wl_resource* resource : clientInputResources(client, "wl_keyboard")) {
        wl_keyboard_send_enter(resource, serial, seatSurface->getResource()->resource(), &keys);
        if (keyboard) {
            const auto& mods = keyboard->m_modifiersState;
            wl_keyboard_send_modifiers(resource, serial, mods.depressed, mods.latched, mods.locked, mods.group);
        }
    }
    wl_array_release(&keys);
}

void directKeyboardLeave() {
    const auto surface = g.directKeyboardSurface.lock();
    g.directKeyboardSurface.reset();
    if (!surface)
        return;
    // As with the pointer: if the human's keyboard focus is here, the enter the
    // client believes in is the seat's, and it is not ours to revoke.
    if (g_pSeatManager && g_pSeatManager->m_state.keyboardFocus.lock() == surface)
        return;
    const uint32_t serial = directSerial(surface);
    for (wl_resource* resource : clientInputResources(surface->client(), "wl_keyboard"))
        wl_keyboard_send_leave(resource, serial, surface->getResource()->resource());
    restoreSeatKeyboardEnter(surface->client());
}

// The keyboard hand-back. The re-stamp before every agent key takes the
// client's shared wl_keyboard for that key; if the human is typing in another
// window of the same client, their next key would follow ours into the agent's
// window. After each agent key the seat's enter is put back, unless the agent
// is mid-chord: a Ctrl it still holds must stay where it was pressed.
void returnKeyboardToSeat() {
    if (!g_pSeatManager || !g.pressedKeys.empty())
        return;
    const auto agentSurface = g.directKeyboardSurface.lock();
    const auto seatSurface  = g_pSeatManager->m_state.keyboardFocus.lock();
    if (!agentSurface || !seatSurface || seatSurface == agentSurface || seatSurface->client() != agentSurface->client())
        return;
    const uint32_t serial = directSerial(agentSurface);
    for (wl_resource* resource : clientInputResources(agentSurface->client(), "wl_keyboard"))
        wl_keyboard_send_leave(resource, serial, agentSurface->getResource()->resource());
    restoreSeatKeyboardEnter(agentSurface->client());
}

void clearKeyboardDelivery() {
    releasePressedKeys();
    directKeyboardLeave();
    g.keyboardWindow.reset();
}

// Target if one was asked for — a target that has gone away fails loudly,
// because a Ctrl+Q aimed at a closing window must not quit whatever sits under
// the ghost cursor instead — else the window the pointer is in.
bool updateKeyboardFocus() {
    PHLWINDOW window;
    if (g.targetRequested) {
        const auto target = g.targetWindow.lock();
        if (!usableWindow(target)) {
            clearKeyboardDelivery();
            return false;
        }
        window = target;
    } else if (const auto pointerWindow = g.pointerWindow.lock(); usableWindow(pointerWindow)) {
        window = pointerWindow;
    } else {
        window = windowAtPoint(g.pos);
    }
    if (!usableWindow(window)) {
        clearKeyboardDelivery();
        return false;
    }
    const auto surface = windowMainSurface(window);
    if (!surface) {
        clearKeyboardDelivery();
        return false;
    }
    if (g.directKeyboardSurface.lock() != surface) {
        clearKeyboardDelivery();
        g.keyboardWindow       = window;
        g.directKeyboardSurface = surface;
        sendKeyboardEnterEvent(surface);
    } else {
        g.keyboardWindow = window;
    }
    return true;
}

// Refuse, out loud, rather than inject into a client that cannot hear us:
// Wayland delivers input per resource, and an event aimed at a client holding
// no matching resource is dropped silently at every layer while the caller
// believes it acted.
void requireReachableClient(const PHLWINDOW& window, const char* interfaceName) {
    const auto surface = windowMainSurface(window);
    if (!surface)
        return;
    if (!clientInputResources(surface->client(), interfaceName).empty())
        return;
    std::string name = window->m_class.empty() ? window->m_title : window->m_class;
    if (name.empty())
        name = "This window";
    throw sdbus::Error(sdbus::Error::Name{ERR_SEAT_UNSUPPORTED},
                       name + " holds no " + (std::string_view{interfaceName} == "wl_pointer" ? "pointer" : "keyboard") +
                           " on any seat, so input to it is dropped silently and the action would have no "
                           "effect. Nothing aimed at this window will work until it asks its seat for input.");
}

// Give way to the person at the keyboard, on their own window: while their
// devices were active within the guard window, the window holding their focus
// is off the table and every other window stays available. Refused rather than
// delayed, because a click queued until they pause would land in a window
// whose state has moved on. Their input never needs disentangling from the
// agent's here: injected events go straight to client resources and never pass
// the input spy, so everything it saw is the human's by construction.
void refuseIfHumanActive(const PHLWINDOW& window) {
    if (g.humanActiveGuardMs == 0 || !window)
        return;
    const int64_t age = humanInputAgeMilliseconds();
    if (age < 0 || age > int64_t(g.humanActiveGuardMs))
        return;
    const auto human = Desktop::focusState()->window();
    // Only window-to-window identity is compared: a Wayland popup is a surface
    // of the window that opened it, so a menu the human has open already *is*
    // their focused window as far as this comparison goes.
    if (!human || window != human)
        return;
    std::string title = human->m_title.empty() ? human->m_class : human->m_title;
    if (title.empty())
        title = "the focused window";
    throw sdbus::Error(sdbus::Error::Name{ERR_HUMAN_ACTIVE},
                       std::format("The human is using {} right now - their keyboard focus is on it and their own "
                                   "devices were active {} ms ago - so nothing was sent to it. Every other window "
                                   "is still available, and this action can be retried once they have been idle "
                                   "for {} ms.",
                                   title, age, g.humanActiveGuardMs));
}

void setCursorVisible(bool visible) {
    if (g.cursorVisible == visible)
        return;
    g.cursorVisible = visible;
    damageCursorArea();
}

void emitSessionStopped(const std::string& reason) {
    if (!g.dbusObject)
        return;
    try {
        g.dbusObject->emitSignal("sessionStopped").onInterface(INTERFACE_NAME).withArguments(reason);
    } catch (...) {
        // A failed diagnostic signal must never take the session logic down.
    }
}

void stopSession(StopReason reason) {
    const bool wasRunning = g.running;
    const bool latching   = reason == StopReason::UserRelease;
    const bool changed    = wasRunning || (latching && !g.releasedByUser);

    g.running = false;
    setCursorVisible(false);
    // Nothing stays held past the session: a stop that stranded a pressed
    // button or a half-typed chord would leave some client waiting for a
    // release only the agent could have sent.
    clearKeyboardDelivery();
    clearPointerDelivery();
    g.pointerWindow.reset();
    g.keyboardWindow.reset();
    g.targetWindow.reset();
    g.targetRequested = false;
    g.stopReason      = stopReasonName(reason);
    // Only the human's panic switch latches. An idle timeout is routine, and an
    // explicit server stop ends the session the server itself owns, so both
    // leave the next start() free to run.
    g.releasedByUser = latching;
    armIdleTimer();

    if (changed)
        emitSessionStopped(g.stopReason);
}

// Pressing the chord again hands control back without a trip through Synara,
// so a panic stop can never strand the feature.
void handleReleaseShortcut() {
    if (!g.running && g.releasedByUser) {
        g.releasedByUser = false;
        g.stopReason     = "user-resume";
        return;
    }
    stopSession(StopReason::UserRelease);
}

bool requireRunning() {
    if (!g.running)
        return false;
    noteActivity();
    return true;
}

std::string modulePath() {
    if (!g_pPluginSystem || !PHANDLE)
        return "";
    const auto* plugin = g_pPluginSystem->getPluginByHandle(PHANDLE);
    return plugin ? plugin->m_path : "";
}

// ---------------------------------------------------------------------------
// D-Bus methods
// ---------------------------------------------------------------------------

std::string healthJson() {
    JsonObj health;
    health
        // Direct injection needs nothing prepared beyond the seat manager the
        // serials come from, so readiness is its presence.
        .boolean("ok", g_pSeatManager != nullptr)
        .boolean("running", g.running)
        .str("service", SERVICE_NAME)
        .str("path", OBJECT_PATH)
        .str("interface", INTERFACE_NAME)
        .str("build", SYNARA_CU_BUILD_ID)
        .str("gitHash", SYNARA_CU_GIT_HASH)
        .str("buildTimestamp", SYNARA_CU_BUILD_TS)
        .str("compositor", "hyprland")
        .str("hyprlandVersion", g.hyprlandVersion)
        // The .so this instance was loaded from. `hyprctl plugin list` reports
        // only plugin names while load/unload address paths, so this is how the
        // server learns which installed build is the one answering the bus.
        .str("modulePath", modulePath())
        // Always the human's live compositor, so always the KWin plugin's
        // shared-desktop shape: no real agent seat, direct per-client
        // injection, ghost cursor drawn by the plugin.
        .str("seat", "synara-agent")
        .boolean("dedicatedSeat", true)
        .boolean("ownsCompositor", false)
        .boolean("directInjection", true)
        .boolean("overlay", true)
        .boolean("workspace", static_cast<bool>(Desktop::windowState()))
        .str("xDisplay", std::getenv("DISPLAY") ? std::getenv("DISPLAY") : "")
        .boolean("effects", true)
        .boolean("capture", g_pHyprRenderer != nullptr && Render::GL::g_pHyprOpenGL != nullptr)
        .num("idleTimeoutMs", g.idleTimeoutMs)
        .boolean("releasedByUser", g.releasedByUser)
        .str("releaseShortcut", RELEASE_SHORTCUT_LABEL)
        .raw("workspaceGeometry", rectJson(workspaceGeometry()));
    return health.build();
}

std::string stateJson() {
    JsonObj state;
    state.boolean("running", g.running)
        .str("seat", "synara-agent")
        .boolean("dedicatedSeat", true)
        .boolean("ownsCompositor", false)
        .boolean("directInjection", true)
        .raw("position", pointJson(g.pos))
        // The human's own cursor, reported next to the agent's because the one
        // property this whole design rests on is that these two move
        // independently.
        .raw("humanPosition", pointJson(g_pInputManager ? g_pInputManager->getMouseCoordsInternal() : Vector2D{}))
        .str("agentName", g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName)
        .num("pressedButtonCount", double(g.pressedButtons.size()))
        .num("pressedKeyCount", double(g.pressedKeys.size()))
        .num("idleTimeoutMs", g.idleTimeoutMs)
        .num("idleMs", double(idleMilliseconds()))
        .boolean("releasedByUser", g.releasedByUser)
        .str("releaseShortcut", RELEASE_SHORTCUT_LABEL);
    if (g.running && g.idleTimeoutMs > 0)
        state.num("idleRemainingMs", double(std::max<int64_t>(0, int64_t(g.idleTimeoutMs) - idleMilliseconds())));
    if (!g.stopReason.empty())
        state.str("stopReason", g.stopReason);
    if (const auto w = g.pointerWindow.lock()) {
        state.str("pointerWindowId", windowId(w));
        state.str("pointerWindowTitle", w->m_title);
    }
    if (const auto w = g.keyboardWindow.lock()) {
        state.str("keyboardWindowId", windowId(w));
        state.str("keyboardWindowTitle", w->m_title);
        state.boolean("keyboardWindowActive", Desktop::focusState()->isWindowActive(w));
    }
    state.boolean("borrowedActivation", false);
    const auto human = Desktop::focusState()->window();
    state.str("humanFocusWindowId", human ? windowId(human) : "");
    state.num("msSinceHumanInput", double(humanInputAgeMilliseconds()));
    state.num("humanActiveGuardMs", g.humanActiveGuardMs);
    if (g.targetRequested && !usableWindow(g.targetWindow.lock()))
        state.boolean("targetLost", true);
    if (const auto w = g.targetWindow.lock()) {
        state.str("targetWindowId", windowId(w));
        state.str("targetWindowTitle", w->m_title);
    }
    return state.build();
}

std::string windowsJson() {
    // Emitted topmost-first so `stackingIndex` reads as depth, and so each
    // window's occluders are exactly the windows already emitted.
    // windowState()->windows() is bottom-to-top, so walk it backwards.
    struct SStacked {
        std::string id;
        CBox        bounds;
    };
    std::vector<SStacked> covering;
    JsonArr               windows;

    const auto& stacking = Desktop::windowState()->windows();
    int         stackingIndex = 0;
    for (auto it = stacking.rbegin(); it != stacking.rend(); ++it) {
        const PHLWINDOW& w = *it;
        if (!w || !w->m_isMapped)
            continue;

        const std::string id      = windowId(w);
        const CBox        bounds  = windowBounds(w);
        const bool        visible = usableWindow(w);

        // Frame-rect overlap, not true pixel occlusion; overstating the risk
        // is the safe direction.
        JsonArr occludedBy;
        for (const SStacked& above : covering) {
            const bool intersects =
                above.bounds.x < bounds.x + bounds.w && above.bounds.x + above.bounds.w > bounds.x && above.bounds.y < bounds.y + bounds.h && above.bounds.y + above.bounds.h > bounds.y;
            if (intersects)
                occludedBy.str(above.id);
        }

        JsonObj object;
        object.str("id", id)
            .str("title", w->m_title)
            .str("appId", w->m_class)
            .str("resourceClass", w->m_class)
            .num("pid", double(w->getPID()))
            .raw("bounds", rectJson(bounds))
            .boolean("visible", visible)
            .boolean("focusable", !(w->m_ruleApplicator && w->m_ruleApplicator->noFocus().valueOrDefault()) && !w->m_X11ShouldntFocus)
            .boolean("normal", true)
            .boolean("desktop", false)
            .boolean("dock", false)
            // Hyprland has no minimize; a window parked on an invisible
            // workspace already reports `visible: false`.
            .boolean("minimized", false)
            .boolean("active", Desktop::focusState()->isWindowActive(w))
            .num("stackingIndex", stackingIndex)
            .raw("occludedBy", occludedBy.build());
        windows.raw(object.build());
        stackingIndex += 1;
        if (visible)
            covering.push_back({id, bounds});
    }
    return windows.build();
}

bool startSession() {
    if (g.releasedByUser)
        throw sdbus::Error(sdbus::Error::Name{ERR_RELEASED}, std::string("computer control was released with ") + RELEASE_SHORTCUT_LABEL);
    g.running = true;
    g.stopReason.clear();
    // Start where the ghost last was, clamped in case outputs changed.
    const CBox geo = workspaceGeometry();
    if (geo.w > 0 && geo.h > 0) {
        g.pos.x = std::clamp(g.pos.x, geo.x, geo.x + geo.w - 1);
        g.pos.y = std::clamp(g.pos.y, geo.y, geo.y + geo.h - 1);
    }
    setCursorVisible(true);
    g.pointerWindow = windowAtPoint(g.pos);
    noteActivity();
    damageCursorArea();
    return true;
}

bool setIdleTimeout(uint32_t milliseconds) {
    if (milliseconds != 0 && (milliseconds < MIN_IDLE_TIMEOUT_MS || milliseconds > MAX_IDLE_TIMEOUT_MS))
        return false;
    g.idleTimeoutMs = milliseconds;
    armIdleTimer();
    return true;
}

bool setHumanActiveGuardMs(uint32_t milliseconds) {
    if (milliseconds != 0 && (milliseconds < MIN_HUMAN_ACTIVE_GUARD_MS || milliseconds > MAX_HUMAN_ACTIVE_GUARD_MS))
        return false;
    g.humanActiveGuardMs = milliseconds;
    return true;
}

bool setAgentName(const std::string& name) {
    std::string trimmed = name;
    const auto  notSpace = [](unsigned char c) { return !std::isspace(c); };
    trimmed.erase(trimmed.begin(), std::find_if(trimmed.begin(), trimmed.end(), notSpace));
    trimmed.erase(std::find_if(trimmed.rbegin(), trimmed.rend(), notSpace).base(), trimmed.end());
    if (g.agentName == trimmed)
        return true;
    g.agentName      = trimmed;
    g.cursorArtDirty = true;
    if (g.running && g.cursorVisible)
        damageCursorArea();
    return true;
}

bool focusWindow(const std::string& id) {
    if (!requireRunning())
        return false;
    const PHLWINDOW w = findWindowById(id);
    if (!usableWindow(w))
        return false;
    g.targetWindow    = w;
    g.targetRequested = true;
    return true;
}

bool raiseWindow(const std::string& id) {
    if (!requireRunning())
        return false;
    const PHLWINDOW w = findWindowById(id);
    if (!usableWindow(w))
        return false;
    Desktop::windowState()->raise(w);
    return true;
}

bool clearFocusWindow() {
    g.targetWindow.reset();
    g.targetRequested = false;
    return true;
}

// Focus preparation is shared by motion, clicks, scrolls, and keys. Hand back
// only after the complete operation, including refusals and exceptions. Held
// buttons and modifiers retain their enter until the matching release.
struct InputFocusHandback {
    ~InputFocusHandback() {
        returnKeyboardToSeat();
        returnPointerToSeat();
    }
};

bool movePointer(double x, double y) {
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    const CBox geo = workspaceGeometry();
    Vector2D   next{x, y};
    if (geo.w > 0 && geo.h > 0) {
        next.x = std::clamp(next.x, geo.x, geo.x + geo.w - 1);
        next.y = std::clamp(next.y, geo.y, geo.y + geo.h - 1);
    }
    damageCursorArea();
    g.pos = next;
    damageCursorArea();
    // The move is the whole action even over empty desktop; focus maintenance
    // rides along so the surface under the ghost tracks it live.
    updatePointerFocus();
    return true;
}

bool injectButton(uint32_t button, bool pressed) {
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    // The reachability refusal outranks the plain focus failure: a pointer-less
    // client leaves updatePointerFocus without a surface too, and the caller
    // deserves the loud error, not a silent false.
    const bool focused = updatePointerFocus();
    const auto window  = g.pointerWindow.lock();
    if (window)
        requireReachableClient(window, "wl_pointer");
    if (!focused)
        return false;
    // The release half of a press the agent already delivered is never
    // refused: the client is holding that button down because of us, and
    // leaving it held is worse than the press was.
    const bool completingPress = !pressed && g.pressedButtons.contains(button);
    if (!completingPress)
        refuseIfHumanActive(window);
    // A click aims the keyboard too, the way a human's click does.
    updateKeyboardFocus();

    if (const auto surface = g.directPointerSurface.lock()) {
        if (pressed)
            g.pressedButtons.insert(button);
        else
            g.pressedButtons.erase(button);
        directPointerButtonEvent(surface, button, pressed);
    }
    return true;
}

// Whole wheel clicks owed to a client too old for wl_pointer.axis_value120:
// that event carries only whole clicks, so any delta under one click truncates
// to zero and a small scroll becomes a no-op there. The sub-click part is
// carried in the remainder so repeated small deltas still add up to a click.
int takeDiscreteSteps(double& remainder, double delta120) {
    if (delta120 == 0)
        return 0;
    remainder += delta120;
    const double steps = std::trunc(remainder / 120.0);
    remainder -= steps * 120.0;
    return static_cast<int>(steps);
}

// Pixels per wheel notch. The whole stack speaks pixels — the tool surface,
// the computer pane, and the `axis` D-Bus method — while a wheel speaks
// notches, so the conversion lives at the one place the two meet. These are
// content pixels, what a page moves per click (about 86 in Firefox on Wayland,
// 80 in Chromium), not the 15 wire units libinput reports per click: those are
// degrees, which every toolkit scales up, and taking them for pixels made each
// scroll several times longer than asked. Keep in sync with the KWin plugin and SCROLL_STEP_PX
// in apps/server/src/computer/scrollUnits.ts, which carries the full rationale.
constexpr double SCROLL_PIXELS_PER_NOTCH = 80.0;
// What one notch is worth in wl_pointer.axis: libinput's wheel unit is degrees
// of rotation, 15 per click, and that is the scale every client expects there.
constexpr double AXIS_UNITS_PER_NOTCH = 15.0;

// The continuous half of a wheel event for a scroll of `pixels`: the value a
// client reads from wl_pointer.axis, in the units a physical wheel uses.
double scrollAxisValue(double pixels) {
    if (!std::isfinite(pixels))
        return 0;
    return pixels * AXIS_UNITS_PER_NOTCH / SCROLL_PIXELS_PER_NOTCH;
}

int scrollValue120(double pixels) {
    if (!std::isfinite(pixels))
        return 0;
    const double units = std::round(pixels * 120.0 / SCROLL_PIXELS_PER_NOTCH);
    return static_cast<int>(std::clamp(units, double(std::numeric_limits<int>::min()), double(std::numeric_limits<int>::max())));
}

// Scrolls by desktop pixels, not wheel notches; positive is right and down,
// matching wl_pointer's axis directions.
bool injectAxis(double horizontal, double vertical) {
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    const bool focused = updatePointerFocus();
    const auto window  = g.pointerWindow.lock();
    if (window)
        requireReachableClient(window, "wl_pointer");
    if (!focused)
        return false;
    refuseIfHumanActive(window);

    const auto surface = g.directPointerSurface.lock();
    if (!surface)
        return false;
    const uint32_t time          = directTimestampMs();
    const auto     resources     = clientInputResources(surface->client(), "wl_pointer");
    const int      horizontalV120 = scrollValue120(horizontal);
    const int      verticalV120   = scrollValue120(vertical);

    // The remainder is only spent on resources that cannot be told about a
    // fraction of a click, so it is only taken when the client has one.
    const bool needsDiscrete = std::any_of(resources.cbegin(), resources.cend(), [](wl_resource* resource) {
        const int version = wl_resource_get_version(resource);
        return version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && version < WL_POINTER_AXIS_VALUE120_SINCE_VERSION;
    });
    const int horizontalSteps = needsDiscrete ? takeDiscreteSteps(g.axisRemainderH, horizontalV120) : 0;
    const int verticalSteps   = needsDiscrete ? takeDiscreteSteps(g.axisRemainderV, verticalV120) : 0;

    for (wl_resource* resource : resources) {
        const int version = wl_resource_get_version(resource);
        if (version >= WL_POINTER_AXIS_SOURCE_SINCE_VERSION)
            wl_pointer_send_axis_source(resource, WL_POINTER_AXIS_SOURCE_WHEEL);
        if (horizontal != 0) {
            wl_pointer_send_axis(resource, time, WL_POINTER_AXIS_HORIZONTAL_SCROLL, wl_fixed_from_double(scrollAxisValue(horizontal)));
            // value120 supersedes axis_discrete for the clients that have it,
            // and the two must not both be sent for one scroll.
            if (version >= WL_POINTER_AXIS_VALUE120_SINCE_VERSION)
                wl_pointer_send_axis_value120(resource, WL_POINTER_AXIS_HORIZONTAL_SCROLL, horizontalV120);
            else if (version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && horizontalSteps != 0)
                wl_pointer_send_axis_discrete(resource, WL_POINTER_AXIS_HORIZONTAL_SCROLL, horizontalSteps);
        }
        if (vertical != 0) {
            wl_pointer_send_axis(resource, time, WL_POINTER_AXIS_VERTICAL_SCROLL, wl_fixed_from_double(scrollAxisValue(vertical)));
            if (version >= WL_POINTER_AXIS_VALUE120_SINCE_VERSION)
                wl_pointer_send_axis_value120(resource, WL_POINTER_AXIS_VERTICAL_SCROLL, verticalV120);
            else if (version >= WL_POINTER_AXIS_DISCRETE_SINCE_VERSION && verticalSteps != 0)
                wl_pointer_send_axis_discrete(resource, WL_POINTER_AXIS_VERTICAL_SCROLL, verticalSteps);
        }
        if (version >= WL_POINTER_FRAME_SINCE_VERSION)
            wl_pointer_send_frame(resource);
    }
    return true;
}

bool injectKey(uint32_t keyCode, bool pressed) {
    if (!requireRunning())
        return false;
    const InputFocusHandback handback;
    if (!updateKeyboardFocus())
        return false;
    const auto window = g.keyboardWindow.lock();
    requireReachableClient(window, "wl_keyboard");
    // Same exemption the pointer makes, and it matters more here: refusing the
    // release of a held Ctrl leaves the client believing a modifier is down.
    const bool completingPress = !pressed && std::ranges::find(g.pressedKeys, keyCode) != g.pressedKeys.end();
    if (!completingPress)
        refuseIfHumanActive(window);

    const auto surface = g.directKeyboardSurface.lock();
    if (!surface)
        return false;
    // The re-stamp, with the held-key state as it is before this event.
    sendKeyboardEnterEvent(surface);
    if (pressed) {
        if (std::ranges::find(g.pressedKeys, keyCode) == g.pressedKeys.end())
            g.pressedKeys.push_back(keyCode);
    } else {
        std::erase(g.pressedKeys, keyCode);
    }
    directKeyboardKeyEvent(surface, keyCode, pressed);
    ensureXkbState();
    if (g.xkbState) {
        // evdev keycode -> xkb keycode offset is 8.
        xkb_state_update_key(g.xkbState, keyCode + 8, pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
        directKeyboardModifiers();
    }
    return true;
}

// ---------------------------------------------------------------------------
// Capture pipeline. The GL side is minimal — render offscreen at the
// monitor's own resolution, read the pixels back — and everything else
// (stitching monitors into a region, cropping a window, the ghost cursor
// overlay, downscaling, PNG) happens in cairo. Drawing the ghost in cairo
// instead of queueing its pass elements into the fake render keeps the
// capture path independent of the live render-stage hooks.
//
// The human's cursor never appears in a capture: Hyprland renders cursors
// outside renderAllClientsForWorkspace (hardware plane or a separate software
// pass), so an offscreen render simply doesn't contain it — the same
// exclusion the KWin plugin needs an explicit exclusive view for.
// ---------------------------------------------------------------------------

// Same limits as the KWin plugin, against absurd offscreen allocations.
constexpr int     CAPTURE_MAX_NATIVE_SIDE   = 16384;
constexpr int64_t CAPTURE_MAX_NATIVE_PIXELS = 64LL * 1024 * 1024;

using Render::GL::g_pHyprOpenGL;

// renderAllClientsForWorkspace is protected, reachable in core only by friend
// classes (screencopy, screenshare). A plugin is not on that list, but an
// explicit template instantiation is exempt from access control ([temp.spec]
// p12), which makes this the one standard-blessed way to take the member
// pointer — no #define private, no layout assumptions.
using RenderAllClientsFn = void (Render::IHyprRenderer::*)(PHLMONITOR, PHLWORKSPACE, const Time::steady_tp&, const Vector2D&, const float&);
RenderAllClientsFn renderAllClientsForWorkspacePtr();
template <RenderAllClientsFn P> struct SRenderAllClientsGrab {
    friend RenderAllClientsFn renderAllClientsForWorkspacePtr() {
        return P;
    }
};
template struct SRenderAllClientsGrab<&Render::IHyprRenderer::renderAllClientsForWorkspace>;

[[noreturn]] void captureFailed(const std::string& message) {
    throw sdbus::Error(sdbus::Error::Name{ERR_CAPTURE}, message);
}

struct SCapturePixels {
    std::vector<uint8_t> rgba; // tightly packed RGBA8, premultiplied
    int                  w = 0;
    int                  h = 0;
};

SCapturePixels readFramebufferPixels(const SP<Render::IFramebuffer>& fb) {
    SCapturePixels img;
    img.w = static_cast<int>(fb->m_size.x);
    img.h = static_cast<int>(fb->m_size.y);
    if (img.w <= 0 || img.h <= 0)
        captureFailed("offscreen framebuffer has no pixels");
    img.rgba.resize(size_t(img.w) * size_t(img.h) * 4);
    // glReadPixels reads GL_READ_FRAMEBUFFER; IFramebuffer::bind() only binds
    // the draw side, so bind the read side explicitly like core readPixels does.
    const auto glFb = dynamic_cast<Render::GL::CGLFramebuffer*>(fb.get());
    if (!glFb)
        captureFailed("capture requires the GL renderer");
    g_pHyprOpenGL->makeEGLCurrent();
    glBindFramebuffer(GL_READ_FRAMEBUFFER, glFb->getFBID());
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(0, 0, img.w, img.h, GL_RGBA, GL_UNSIGNED_BYTE, img.rgba.data());
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    return img;
}

// Premultiplied RGBA8 rows into a cairo ARGB32 (native-endian) surface. The
// caller owns the returned surface.
cairo_surface_t* pixelsToCairo(const SCapturePixels& img) {
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, img.w, img.h);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        captureFailed("capture image allocation failed");
    }
    unsigned char* data   = cairo_image_surface_get_data(surface);
    const int      stride = cairo_image_surface_get_stride(surface);
    for (int y = 0; y < img.h; ++y) {
        const uint8_t* src = img.rgba.data() + size_t(y) * img.w * 4;
        auto*          dst = reinterpret_cast<uint32_t*>(data + size_t(y) * stride);
        for (int x = 0; x < img.w; ++x, src += 4)
            dst[x] = (uint32_t(src[3]) << 24) | (uint32_t(src[0]) << 16) | (uint32_t(src[1]) << 8) | uint32_t(src[2]);
    }
    cairo_surface_mark_dirty(surface);
    return surface;
}

// Everything a monitor is showing — background, layers, windows, popups —
// rendered offscreen at the monitor's own resolution. Mirrors what
// makeSnapshotFB does for one window, with an opaque clear because a screen
// is opaque by definition (the KWin plugin's region captures do the same).
SCapturePixels renderMonitorPixels(const PHLMONITOR& monitor) {
    CRegion    fakeDamage{0, 0, monitor->m_transformedSize.x, monitor->m_transformedSize.y};
    const auto fb = g_pHyprRenderer->createFB("synara capture");
    fb->alloc(monitor->m_pixelSize.x, monitor->m_pixelSize.y, DRM_FORMAT_ABGR8888);
    fb->setImageDescription(monitor->workBufferImageDescription());
    if (!g_pHyprRenderer->beginFullFakeRender(monitor, fakeDamage, fb))
        captureFailed("offscreen render begin failed");
    g_pHyprRenderer->m_bRenderingSnapshot = true;
    g_pHyprRenderer->draw(CClearPassElement::SClearData{CHyprColor(0, 0, 0, 1)});
    g_pHyprRenderer->startRenderPass();
    (g_pHyprRenderer.get()->*renderAllClientsForWorkspacePtr())(monitor, monitor->m_activeWorkspace, Time::steadyNow(), Vector2D{0, 0}, 1.f);
    g_pHyprRenderer->endRender();
    g_pHyprRenderer->m_bRenderingSnapshot = false;
    return readFramebufferPixels(fb);
}

// The ghost cursor and badge, composited over a capture the same way the
// render pass composites them over the screen, so a capture shows the agent's
// pointer exactly where the human sees it. `region` is the captured rect in
// global logical coordinates, `scale` the capture's device pixels per logical
// unit. No-op when no session is running — a capture of a released desktop
// has no ghost on screen either.
void drawGhostCursorOverlay(cairo_t* cr, const CBox& region, double scale) {
    if (!g.running || !g.cursorVisible)
        return;
    const double size   = agentCursorSize();
    const double margin = strokeMargin(size);
    const double alpha  = badgeAlpha();

    cairo_save(cr);
    cairo_identity_matrix(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_OVER);

    if (alpha > 0) {
        SRenderedImage badge = renderBadgeImage(g.agentName.empty() ? AGENT_FALLBACK_NAME : g.agentName, size, scale);
        const double   bx    = (g.pos.x + std::round(size * 0.55) - margin - region.x) * scale;
        const double   by    = (g.pos.y + std::round(size * 0.90) - margin - region.y) * scale;
        cairo_set_source_surface(cr, badge.surface, bx, by);
        cairo_paint_with_alpha(cr, alpha);
        cairo_surface_destroy(badge.surface);
    }

    SRenderedImage arrow = renderCursorImage(size, scale);
    const double   ax    = (g.pos.x - margin - region.x) * scale;
    const double   ay    = (g.pos.y - margin - region.y) * scale;
    cairo_set_source_surface(cr, arrow.surface, ax, ay);
    cairo_paint(cr);
    cairo_surface_destroy(arrow.surface);

    cairo_restore(cr);
}

std::vector<uint8_t> encodePng(cairo_surface_t* surface) {
    std::vector<uint8_t>       png;
    const cairo_status_t status = cairo_surface_write_to_png_stream(
        surface,
        [](void* closure, const unsigned char* data, unsigned int length) {
            auto* out = static_cast<std::vector<uint8_t>*>(closure);
            out->insert(out->end(), data, data + length);
            return CAIRO_STATUS_SUCCESS;
        },
        &png);
    if (status != CAIRO_STATUS_SUCCESS || png.empty())
        captureFailed("PNG encoding failed");
    return png;
}

// Downscales so the longest side fits maxDimension (0 = uncapped), then
// encodes. Consumes the surface.
std::vector<uint8_t> finishCapture(cairo_surface_t* surface, uint32_t maxDimension) {
    const int w       = cairo_image_surface_get_width(surface);
    const int h       = cairo_image_surface_get_height(surface);
    const int largest = std::max(w, h);
    if (maxDimension > 0 && largest > static_cast<int>(maxDimension)) {
        const double     factor = double(maxDimension) / largest;
        const int        sw     = std::max(1, static_cast<int>(std::lround(w * factor)));
        const int        sh     = std::max(1, static_cast<int>(std::lround(h * factor)));
        cairo_surface_t* scaled = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, sw, sh);
        cairo_t*         cr     = cairo_create(scaled);
        cairo_scale(cr, double(sw) / w, double(sh) / h);
        cairo_set_source_surface(cr, surface, 0, 0);
        cairo_pattern_set_filter(cairo_get_source(cr), CAIRO_FILTER_GOOD);
        cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
        cairo_paint(cr);
        cairo_destroy(cr);
        cairo_surface_flush(scaled);
        cairo_surface_destroy(surface);
        surface = scaled;
    }
    std::vector<uint8_t> png;
    try {
        png = encodePng(surface);
    } catch (...) {
        cairo_surface_destroy(surface);
        throw;
    }
    cairo_surface_destroy(surface);
    return png;
}

// The capture target: `region` in global logical coordinates at `scale`
// device pixels per logical unit, within the same limits the KWin plugin
// enforces.
cairo_surface_t* captureTarget(const CBox& region, double scale, int& nativeW, int& nativeH) {
    nativeW = static_cast<int>(std::ceil(region.w * scale));
    nativeH = static_cast<int>(std::ceil(region.h * scale));
    if (nativeW < 1 || nativeH < 1)
        captureFailed("capture dimensions are invalid");
    if (nativeW > CAPTURE_MAX_NATIVE_SIDE || nativeH > CAPTURE_MAX_NATIVE_SIDE || int64_t(nativeW) * nativeH > CAPTURE_MAX_NATIVE_PIXELS)
        captureFailed("capture dimensions are too large");
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, nativeW, nativeH);
    if (cairo_surface_status(surface) != CAIRO_STATUS_SUCCESS) {
        cairo_surface_destroy(surface);
        captureFailed("capture image allocation failed");
    }
    return surface;
}

std::optional<CBox> intersectBoxes(const CBox& a, const CBox& b) {
    const double x1 = std::max(a.x, b.x);
    const double y1 = std::max(a.y, b.y);
    const double x2 = std::min(a.x + a.w, b.x + b.w);
    const double y2 = std::min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1)
        return std::nullopt;
    return CBox{x1, y1, x2 - x1, y2 - y1};
}

std::vector<uint8_t> captureWindow(const std::string& windowId, uint32_t maxDimension) {
    if (g.running)
        noteActivity();
    if (!g_pHyprRenderer || !g_pHyprOpenGL)
        captureFailed("render unavailable");
    const auto window = findWindowById(windowId);
    if (!window)
        captureFailed("unknown window");
    const auto monitor = window->m_monitor.lock();
    if (!monitor)
        captureFailed("window has no monitor");
    const auto region = intersectBoxes(windowBounds(window), workspaceGeometry());
    if (!region)
        captureFailed("window has nothing on screen to capture");

    // Hyprland's own single-window offscreen render: the window with its
    // decorations and popups at its real position on a transparent monitor-
    // sized canvas. The surround keeps its alpha in the encoded PNG — there
    // the "background" genuinely is "not this window".
    const auto fb = g_pHyprRenderer->makeSnapshotFB(window);
    if (!fb)
        captureFailed("window is not visible for capture");
    const SCapturePixels pixels     = readFramebufferPixels(fb);
    cairo_surface_t*     windowSurf = pixelsToCairo(pixels);

    const CBox monitorBox = monitor->logicalBox();
    const double scale    = monitor->m_scale;
    int          nativeW = 0, nativeH = 0;
    cairo_surface_t* target = captureTarget(*region, scale, nativeW, nativeH);
    cairo_t*         cr     = cairo_create(target);
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_surface(cr, windowSurf, -(region->x - monitorBox.x) * scale, -(region->y - monitorBox.y) * scale);
    cairo_paint(cr);
    drawGhostCursorOverlay(cr, *region, scale);
    cairo_destroy(cr);
    cairo_surface_flush(target);
    cairo_surface_destroy(windowSurf);
    return finishCapture(target, maxDimension);
}

std::vector<uint8_t> captureRegion(int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension) {
    if (g.running)
        noteActivity();
    if (!g_pHyprRenderer || !g_pHyprOpenGL)
        captureFailed("render unavailable");
    const auto region = intersectBoxes(CBox{double(x), double(y), double(width), double(height)}, workspaceGeometry());
    if (!region)
        captureFailed("region is outside the workspace");

    // Render every intersecting monitor at its own scale; stitch at the
    // sharpest one so no monitor's pixels get thrown away.
    std::vector<PHLMONITOR> monitors;
    double                  scale = 1;
    for (const auto& mon : State::monitorState()->monitors()) {
        if (!mon || !mon->m_output)
            continue;
        if (!intersectBoxes(mon->logicalBox(), *region))
            continue;
        monitors.push_back(mon);
        scale = std::max(scale, double(mon->m_scale));
    }
    if (monitors.empty())
        captureFailed("no monitor covers the region");

    int              nativeW = 0, nativeH = 0;
    cairo_surface_t* target = captureTarget(*region, scale, nativeW, nativeH);
    cairo_t*         cr     = cairo_create(target);
    // A screen is opaque: black under any monitor gap or transparent pixels,
    // like the KWin plugin's region captures.
    cairo_set_source_rgba(cr, 0, 0, 0, 1);
    cairo_paint(cr);
    for (const auto& mon : monitors) {
        SCapturePixels   pixels;
        try {
            pixels = renderMonitorPixels(mon);
        } catch (...) {
            cairo_destroy(cr);
            cairo_surface_destroy(target);
            throw;
        }
        cairo_surface_t* monSurf    = pixelsToCairo(pixels);
        const CBox       monitorBox = mon->logicalBox();
        cairo_save(cr);
        cairo_translate(cr, (monitorBox.x - region->x) * scale, (monitorBox.y - region->y) * scale);
        // Monitor pixels to target pixels; only exact on untransformed
        // outputs — a rotated monitor's capture is not yet unrotated.
        cairo_scale(cr, scale / mon->m_scale, scale / mon->m_scale);
        cairo_set_source_surface(cr, monSurf, 0, 0);
        cairo_pattern_set_filter(cairo_get_source(cr), CAIRO_FILTER_GOOD);
        cairo_paint(cr);
        cairo_restore(cr);
        cairo_surface_destroy(monSurf);
    }
    drawGhostCursorOverlay(cr, *region, scale);
    cairo_destroy(cr);
    cairo_surface_flush(target);
    return finishCapture(target, maxDimension);
}

// ---------------------------------------------------------------------------
// D-Bus plumbing: the connection's fds run on Hyprland's Wayland event loop,
// so handlers execute on the compositor thread with no locking.
// ---------------------------------------------------------------------------

int onDbusReadable(int /*fd*/, uint32_t /*mask*/, void* /*data*/) {
    if (!g.dbus)
        return 0;
    while (g.dbus->processPendingEvent())
        ;
    return 0;
}

int onIdleTimer(void* /*data*/) {
    if (!g.running || g.idleTimeoutMs == 0)
        return 0;
    if (idleMilliseconds() >= int64_t(g.idleTimeoutMs))
        stopSession(StopReason::IdleTimeout);
    else
        armIdleTimer();
    return 0;
}

void setupDbus() {
    g.dbus       = sdbus::createSessionBusConnection(sdbus::ServiceName{SERVICE_NAME});
    g.dbusObject = sdbus::createObject(*g.dbus, sdbus::ObjectPath{OBJECT_PATH});

    g.dbusObject
        ->addVTable(sdbus::registerMethod("healthJson").implementedAs([]() { return healthJson(); }),
                    sdbus::registerMethod("stateJson").implementedAs([]() { return stateJson(); }),
                    sdbus::registerMethod("windowsJson").implementedAs([]() { return windowsJson(); }),
                    sdbus::registerMethod("start").implementedAs([]() { return startSession(); }),
                    sdbus::registerMethod("stop").implementedAs([]() {
                        stopSession(StopReason::Request);
                        return true;
                    }),
                    sdbus::registerMethod("setIdleTimeout").implementedAs([](uint32_t ms) { return setIdleTimeout(ms); }),
                    sdbus::registerMethod("setHumanActiveGuardMs").implementedAs([](uint32_t ms) { return setHumanActiveGuardMs(ms); }),
                    sdbus::registerMethod("setAgentName").implementedAs([](const std::string& name) { return setAgentName(name); }),
                    sdbus::registerMethod("focusWindow").implementedAs([](const std::string& id) { return focusWindow(id); }),
                    sdbus::registerMethod("raiseWindow").implementedAs([](const std::string& id) { return raiseWindow(id); }),
                    sdbus::registerMethod("clearFocusWindow").implementedAs([]() { return clearFocusWindow(); }),
                    sdbus::registerMethod("movePointer").implementedAs([](double x, double y) { return movePointer(x, y); }),
                    sdbus::registerMethod("button").implementedAs([](uint32_t button, bool pressed) { return injectButton(button, pressed); }),
                    sdbus::registerMethod("axis").implementedAs([](double horizontal, double vertical) { return injectAxis(horizontal, vertical); }),
                    sdbus::registerMethod("key").implementedAs([](uint32_t keyCode, bool pressed) { return injectKey(keyCode, pressed); }),
                    sdbus::registerMethod("captureWindow").implementedAs([](const std::string& id, uint32_t maxDimension) { return captureWindow(id, maxDimension); }),
                    sdbus::registerMethod("captureRegion").implementedAs([](int32_t x, int32_t y, uint32_t width, uint32_t height, uint32_t maxDimension) {
                        return captureRegion(x, y, width, height, maxDimension);
                    }),
                    sdbus::registerSignal("sessionStopped").withParameters<std::string>("reason"))
        .forInterface(sdbus::InterfaceName{INTERFACE_NAME});

    const auto     poll = g.dbus->getEventLoopPollData();
    wl_event_loop* loop = g_pCompositor->m_wlEventLoop;
    g.dbusFdSource      = wl_event_loop_add_fd(loop, poll.fd, WL_EVENT_READABLE, onDbusReadable, nullptr);
    if (poll.eventFd >= 0)
        g.dbusEvtFdSource = wl_event_loop_add_fd(loop, poll.eventFd, WL_EVENT_READABLE, onDbusReadable, nullptr);
}

// ---------------------------------------------------------------------------
// Human input spy. These EventBus signals fire for the human's real devices;
// the agent's injected events (next milestone) go straight to client resources
// and never pass through the input manager, so the spy cannot see its own
// session's activity.
// ---------------------------------------------------------------------------

void noteHumanInput() {
    g.lastHumanInputMs = nowMs();
}

void setupListeners() {
    g.listeners.renderStage = Event::bus()->m_events.render.stage.listen([](eRenderStage stage) {
        if (stage == RENDER_PRE)
            onRenderPre();
        else if (stage == RENDER_LAST_MOMENT)
            onRenderLastMoment();
    });
    g.listeners.mouseMove = Event::bus()->m_events.input.mouse.move.listen([](const Vector2D&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.mouseButton = Event::bus()->m_events.input.mouse.button.listen([](const IPointer::SButtonEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.mouseAxis = Event::bus()->m_events.input.mouse.axis.listen([](const IPointer::SAxisEvent&, Event::SCallbackInfo&) { noteHumanInput(); });
    g.listeners.keyboardKey = Event::bus()->m_events.input.keyboard.key.listen([](const IKeyboard::SKeyEvent& event, Event::SCallbackInfo& info) {
        noteHumanInput();
        if (event.state == WL_KEYBOARD_KEY_STATE_PRESSED)
            g.humanHeldKeys.insert(event.keycode);
        else
            g.humanHeldKeys.erase(event.keycode);

        const bool metaHeld  = g.humanHeldKeys.contains(KEYCODE_LEFTMETA) || g.humanHeldKeys.contains(KEYCODE_RIGHTMETA);
        const bool shiftHeld = g.humanHeldKeys.contains(KEYCODE_LEFTSHIFT) || g.humanHeldKeys.contains(KEYCODE_RIGHTSHIFT);
        if (event.state == WL_KEYBOARD_KEY_STATE_PRESSED && event.keycode == KEYCODE_ESC && metaHeld && shiftHeld) {
            handleReleaseShortcut();
            info.cancelled = true;
        }
    });
    if (g_pSeatManager) {
        g.seatPointerFocus            = g_pSeatManager->m_state.pointerFocus;
        g.listeners.pointerFocusChange = g_pSeatManager->m_events.pointerFocusChange.listen([] { onSeatPointerFocusChange(); });
    }
}

void teardown() {
    stopSession(StopReason::Request);
    g.listeners.renderStage.reset();
    g.listeners.mouseMove.reset();
    g.listeners.mouseButton.reset();
    g.listeners.mouseAxis.reset();
    g.listeners.keyboardKey.reset();
    g.listeners.pointerFocusChange.reset();
    if (g.idleTimerSource) {
        wl_event_source_remove(g.idleTimerSource);
        g.idleTimerSource = nullptr;
    }
    if (g.dbusFdSource) {
        wl_event_source_remove(g.dbusFdSource);
        g.dbusFdSource = nullptr;
    }
    if (g.dbusEvtFdSource) {
        wl_event_source_remove(g.dbusEvtFdSource);
        g.dbusEvtFdSource = nullptr;
    }
    g.dbusObject.reset();
    g.dbus.reset();
    g.cursorTex.reset();
    g.badgeTex.reset();
    if (g.xkbState) {
        xkb_state_unref(g.xkbState);
        g.xkbState       = nullptr;
        g.xkbStateKeymap = nullptr;
    }
}

} // namespace

// ---------------------------------------------------------------------------
// Plugin entry points
// ---------------------------------------------------------------------------

APICALL EXPORT std::string PLUGIN_API_VERSION() {
    return HYPRLAND_API_VERSION;
}

APICALL EXPORT PLUGIN_DESCRIPTION_INFO PLUGIN_INIT(HANDLE handle) {
    PHANDLE = handle;

    const auto version = HyprlandAPI::getHyprlandVersion(handle);
    g.hyprlandVersion  = version.tag.empty() ? version.hash : version.tag;

    g.lastActivityMs = nowMs();
    // Start the ghost where the human's cursor is, like the KWin plugin does.
    if (g_pInputManager)
        g.pos = g_pInputManager->getMouseCoordsInternal();

    setupListeners();
    try {
        setupDbus();
    } catch (const std::exception& e) {
        // Most likely another Synara computer session owns the bus name. Fail
        // the load loudly rather than run a plugin the server cannot reach.
        teardown();
        throw std::runtime_error(std::string("[synara] D-Bus setup failed: ") + e.what());
    }
    g.idleTimerSource = wl_event_loop_add_timer(g_pCompositor->m_wlEventLoop, onIdleTimer, nullptr);

    return {"synara-computer-use", "Synara computer use (agent seat policy: ghost cursor + direct injection)", "Synara", "0.1"};
}

APICALL EXPORT void PLUGIN_EXIT() {
    teardown();
}
