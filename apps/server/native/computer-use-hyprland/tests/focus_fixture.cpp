#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <set>
#include <stdexcept>
#include <vector>

template<typename T> using SP = std::shared_ptr<T>;
struct wl_client {};
struct CWLSurfaceResource;
struct wl_resource { CWLSurfaceResource* surface = nullptr; };
struct Resource { wl_resource value; wl_resource* resource() { return &value; } };
struct CWLSurfaceResource {
    wl_client* c;
    Resource resource{{this}};
    wl_client* client() { return c; }
    Resource* getResource() { return &resource; }
};
struct Vector2D { double x = 0, y = 0; };
struct CBox { double x = 0, y = 0, w = 1920, h = 1080; };
struct Window {};
using PHLWINDOW = SP<Window>;
struct Seat { struct { std::weak_ptr<CWLSurfaceResource> pointerFocus, keyboardFocus; } m_state; } seat;
Seat* g_pSeatManager = &seat;
struct {
    std::weak_ptr<CWLSurfaceResource> directPointerSurface, directKeyboardSurface, seatPointerFocus;
    bool directPointerNeedsEnter = true;
    std::weak_ptr<Window> pointerWindow, targetWindow, keyboardWindow;
    std::set<uint32_t> pressedButtons;
    std::vector<uint32_t> pressedKeys;
    bool targetRequested = false;
    double axisRemainderH = 0, axisRemainderV = 0;
    Vector2D pos;
    void* xkbState = nullptr;
} g;
SP<CWLSurfaceResource> hitSurface;
PHLWINDOW hitWindow = std::make_shared<Window>();
CWLSurfaceResource* pointerEntered = nullptr;
CWLSurfaceResource* keyboardEntered = nullptr;
int buttonEvents = 0, axisEvents = 0, discreteSteps = 0, keyEvents = 0;
int pointerVersion = 9;
bool refuse = false, reachable = true;
struct HitTest { SP<CWLSurfaceResource> windowSurfaceAt(Vector2D, PHLWINDOW, Vector2D&) { return hitSurface; } };
struct ViewState { HitTest& hitTest() { static HitTest h; return h; } };
namespace Desktop { ViewState* viewState() { static ViewState v; return &v; } }
bool usableWindow(PHLWINDOW w) { return bool(w); }
PHLWINDOW windowAtPoint(Vector2D) { return hitWindow; }
std::vector<wl_resource*> clientInputResources(wl_client*, const char*) { static wl_resource r; return {&r}; }
uint32_t directSerial(SP<CWLSurfaceResource>, bool = false) { return 1; }
uint32_t directTimestampMs() { return 1; }
int wl_fixed_from_double(double d) { return int(d); }
int wl_resource_get_version(wl_resource*) { return pointerVersion; }
constexpr int WL_POINTER_FRAME_SINCE_VERSION = 5, WL_POINTER_AXIS_SOURCE_SINCE_VERSION = 5;
constexpr int WL_POINTER_AXIS_DISCRETE_SINCE_VERSION = 5, WL_POINTER_AXIS_VALUE120_SINCE_VERSION = 8;
constexpr int WL_POINTER_AXIS_SOURCE_WHEEL = 0, WL_POINTER_AXIS_HORIZONTAL_SCROLL = 1, WL_POINTER_AXIS_VERTICAL_SCROLL = 0;
constexpr double SCROLL_PIXELS_PER_NOTCH = 80, AXIS_UNITS_PER_NOTCH = 15;
void check(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
void wl_pointer_send_leave(wl_resource*, uint32_t, wl_resource* surface) {
    if (pointerEntered == surface->surface) pointerEntered = nullptr;
}
void wl_pointer_send_enter(wl_resource*, uint32_t, wl_resource* surface, int, int) { pointerEntered = surface->surface; }
void wl_pointer_send_motion(wl_resource*, uint32_t, int, int) { check(pointerEntered == hitSurface.get(), "motion misdirected"); }
void wl_pointer_send_frame(wl_resource*) {}
void wl_pointer_send_axis_source(wl_resource*, int) {}
void wl_pointer_send_axis(wl_resource*, uint32_t, int, int) {
    check(pointerEntered == hitSurface.get(), "axis misdirected"); ++axisEvents;
}
void wl_pointer_send_axis_value120(wl_resource*, int, int) {}
void wl_pointer_send_axis_discrete(wl_resource*, int, int steps) { discreteSteps += steps; }
void restoreSeatPointerEnter(wl_client* client) {
    if (auto surface = seat.m_state.pointerFocus.lock(); surface && surface->client() == client) pointerEntered = surface.get();
}
void wl_keyboard_send_leave(wl_resource*, uint32_t, wl_resource* surface) {
    if (keyboardEntered == surface->surface) keyboardEntered = nullptr;
}
void restoreSeatKeyboardEnter(wl_client* client) {
    if (auto surface = seat.m_state.keyboardFocus.lock(); surface && surface->client() == client) keyboardEntered = surface.get();
}
void releasePressedButtons() { g.pressedButtons.clear(); }
bool requireRunning() { return true; }
void requireReachableClient(PHLWINDOW, const char*) { if (!reachable) throw std::runtime_error("unreachable"); }
void refuseIfHumanActive(PHLWINDOW) { if (refuse) throw std::runtime_error("human active"); }
SP<CWLSurfaceResource> windowMainSurface(PHLWINDOW) { return hitSurface; }
void clearKeyboardDelivery() { g.directKeyboardSurface.reset(); g.keyboardWindow.reset(); }
void sendKeyboardEnterEvent(SP<CWLSurfaceResource> surface) { keyboardEntered = surface.get(); }
void directPointerButtonEvent(SP<CWLSurfaceResource> surface, uint32_t, bool) {
    check(pointerEntered == surface.get(), "button misdirected"); ++buttonEvents;
}
void directKeyboardKeyEvent(SP<CWLSurfaceResource> surface, uint32_t, bool) {
    check(keyboardEntered == surface.get(), "key misdirected"); ++keyEvents;
}
void ensureXkbState() {}
constexpr int XKB_KEY_DOWN = 1, XKB_KEY_UP = 0;
void xkb_state_update_key(void*, uint32_t, int) {}
void directKeyboardModifiers() {}
CBox workspaceGeometry() { return {}; }
void damageCursorArea() {}

// PRODUCTION_DEFINITIONS

int main() {
    wl_client browser, other;
    auto agent = std::make_shared<CWLSurfaceResource>(); agent->c = &browser;
    auto human = std::make_shared<CWLSurfaceResource>(); human->c = &browser;
    auto outsider = std::make_shared<CWLSurfaceResource>(); outsider->c = &other;
    hitSurface = agent;
    seat.m_state.pointerFocus = human;
    seat.m_state.keyboardFocus = human;
    pointerEntered = keyboardEntered = human.get();
    check(movePointer(100, 100), "standalone move refused");
    check(pointerEntered == human.get(), "motion did not return pointer");
    check(injectButton(272, true), "sibling click refused");
    check(pointerEntered == agent.get(), "held button lost pointer");
    check(keyboardEntered == human.get(), "click stole keyboard");
    check(movePointer(200, 200), "drag motion refused");
    check(pointerEntered == agent.get(), "drag lost pointer");
    check(injectButton(272, false), "release refused");
    check(pointerEntered == human.get(), "release did not return pointer");
    check(buttonEvents == 2, "click not delivered");
    check(injectAxis(0, 80), "sibling scroll refused");
    check(axisEvents == 1 && pointerEntered == human.get(), "scroll not returned");
    pointerVersion = 6;
    for (int i = 0; i < 8; ++i) check(injectAxis(0, 10), "fractional scroll refused");
    check(discreteSteps == 1, "handback discarded fractional scrolling");
    refuse = true;
    bool refused = false;
    try { injectButton(272, true); } catch (const std::runtime_error&) { refused = true; }
    check(refused, "expected refusal");
    check(pointerEntered == human.get(), "refusal stole pointer");
    refuse = false;
    seat.m_state.pointerFocus = outsider;
    pointerEntered = outsider.get();
    g.directKeyboardSurface.reset();
    check(injectButton(272, true) && injectButton(272, false), "different-client click refused");
    check(keyboardEntered == human.get(), "pointer action stole sibling keyboard");
    check(injectKey(29, true), "modifier refused");
    check(keyboardEntered == agent.get(), "held modifier lost keyboard");
    check(injectKey(30, true) && injectKey(30, false) && injectKey(29, false), "chord refused");
    check(keyboardEntered == human.get() && keyEvents == 4, "chord failed to restore keyboard");
    g.directKeyboardSurface.reset();
    reachable = false;
    refused = false;
    try { injectKey(30, true); } catch (const std::runtime_error&) { refused = true; }
    check(refused, "expected unreachable refusal");
    check(keyboardEntered == human.get(), "failed key stole keyboard");
    reachable = true;
    seat.m_state.pointerFocus = human;
    onSeatPointerFocusChange();
    check(injectButton(272, true) && injectButton(272, false), "seat-focus change broke next click");
    std::cout << "Focus delivery, drag, scroll, refusal cleanup, and keyboard handback passed.\n";
}
