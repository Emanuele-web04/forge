import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeRunningChatsQuitGuard,
  parseQuitConfirmationRequest,
  parseQuitConfirmationResponse,
  quitConfirmationPresentationForPlatform,
  shouldPromptForRunningChatsBeforeQuit,
} from "./runningChatsQuitGuard";

describe("running chats quit guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prompts only for user-initiated window close and before-quit", () => {
    expect(shouldPromptForRunningChatsBeforeQuit("window-close")).toBe(true);
    expect(shouldPromptForRunningChatsBeforeQuit("before-quit")).toBe(true);
    expect(shouldPromptForRunningChatsBeforeQuit("SIGINT")).toBe(false);
    expect(shouldPromptForRunningChatsBeforeQuit("fatal startup (bootstrap)")).toBe(false);
    expect(shouldPromptForRunningChatsBeforeQuit("custom-title-bar-relaunch")).toBe(false);
  });

  it("uses the in-app dialog on every desktop platform", () => {
    expect(quitConfirmationPresentationForPlatform()).toBe("in-app");
  });

  it("parses quit requests and defaults unknown presentation to in-app", () => {
    expect(parseQuitConfirmationRequest(null)).toBeNull();
    expect(parseQuitConfirmationRequest({ requestId: "q1", presentation: "native" })).toEqual({
      requestId: "q1",
      presentation: "native",
    });
    expect(parseQuitConfirmationRequest({ requestId: "q1" })).toEqual({
      requestId: "q1",
      presentation: "in-app",
    });
  });

  it("rejects malformed renderer replies", () => {
    expect(parseQuitConfirmationResponse(null)).toBeNull();
    expect(parseQuitConfirmationResponse({ phase: "decision", allow: true })).toBeNull();
    expect(
      parseQuitConfirmationResponse({ requestId: "q1", phase: "ready", runningCount: "2" }),
    ).toBeNull();
  });

  it("parses ready replies with the running chat list", () => {
    expect(
      parseQuitConfirmationResponse({
        requestId: "q1",
        phase: "ready",
        runningCount: 1,
        chats: [{ id: "a", title: "Fix the tray" }, { id: 2 }],
      }),
    ).toEqual({
      requestId: "q1",
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "a", title: "Fix the tray" }],
    });
  });

  it("allows quit immediately when the renderer is unavailable", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const send = vi.fn();

    await expect(
      guard.askRenderer({
        send,
        isRendererAvailable: () => false,
      }),
    ).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("allows quit when the renderer reports no running chats", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const send = vi.fn();
    const decision = guard.askRenderer({
      send,
      isRendererAvailable: () => true,
    });

    expect(send).toHaveBeenCalledWith({ requestId: "q1", presentation: "in-app" });
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(decision).resolves.toBe(true);
    expect(guard.hasAllowedQuit()).toBe(true);
  });

  it("stays when the user declines, then can prompt again", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const first = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 2 });
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(first).resolves.toBe(false);
    expect(guard.hasAllowedQuit()).toBe(false);

    const second = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("coalesces overlapping quit asks onto one renderer request", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const send = vi.fn();
    const first = guard.askRenderer({
      send,
      isRendererAvailable: () => true,
    });
    const second = guard.askRenderer({
      send,
      isRendererAvailable: () => true,
    });

    expect(send).toHaveBeenCalledOnce();
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("fails open if the renderer never acknowledges the request", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      readyTimeoutMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    await expect(decision).resolves.toBe(true);
  });

  it("does not time out after the renderer says chats are running", async () => {
    vi.useFakeTimers();
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      readyTimeoutMs: 50,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    await vi.advanceTimersByTimeAsync(200);
    guard.receiveResponse({ requestId: "q1", phase: "decision", allow: false });
    await expect(decision).resolves.toBe(false);
  });

  it("cancels a pending decision when the renderer is replaced and can prompt again", async () => {
    const requestIds = ["q1", "q2"];
    const guard = makeRunningChatsQuitGuard(() => requestIds.shift() ?? "unexpected");
    const first = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
    });
    guard.receiveResponse({ requestId: "q1", phase: "ready", runningCount: 1 });

    guard.cancelPending();

    await expect(first).resolves.toBe(false);
    const send = vi.fn();
    const second = guard.askRenderer({ send, isRendererAvailable: () => true });
    expect(send).toHaveBeenCalledWith({ requestId: "q2", presentation: "in-app" });
    guard.receiveResponse({ requestId: "q2", phase: "decision", allow: true });
    await expect(second).resolves.toBe(true);
  });

  it("shows the native sheet after the renderer reports running chats", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const presentNativeConfirmation = vi.fn(async () => false);
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      presentation: "native",
      presentNativeConfirmation,
    });

    guard.receiveResponse({
      requestId: "q1",
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "a", title: "Fix the tray" }],
    });

    await expect(decision).resolves.toBe(false);
    expect(presentNativeConfirmation).toHaveBeenCalledWith([{ id: "a", title: "Fix the tray" }]);
    expect(guard.hasAllowedQuit()).toBe(false);
  });

  it("fails open if the native sheet presenter throws", async () => {
    const guard = makeRunningChatsQuitGuard(() => "q1");
    const decision = guard.askRenderer({
      send: vi.fn(),
      isRendererAvailable: () => true,
      presentation: "native",
      presentNativeConfirmation: () => {
        throw new Error("sheet failed");
      },
    });

    guard.receiveResponse({
      requestId: "q1",
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "a", title: "Fix the tray" }],
    });

    await expect(decision).resolves.toBe(true);
  });
});
