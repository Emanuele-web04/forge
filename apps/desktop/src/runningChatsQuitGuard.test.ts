import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeRunningChatsQuitGuard,
  parseQuitConfirmationResponse,
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

  it("rejects malformed renderer replies", () => {
    expect(parseQuitConfirmationResponse(null)).toBeNull();
    expect(parseQuitConfirmationResponse({ phase: "decision", allow: true })).toBeNull();
    expect(
      parseQuitConfirmationResponse({ requestId: "q1", phase: "ready", runningCount: "2" }),
    ).toBeNull();
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

    expect(send).toHaveBeenCalledWith({ requestId: "q1" });
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
});
