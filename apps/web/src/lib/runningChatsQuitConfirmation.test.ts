import { describe, expect, it } from "vitest";

import {
  isRunningChatForQuit,
  listRunningChatsFromDesktopStore,
  runningChatDisplayTitle,
  runningChatIdsStillActive,
  runningChatsQuitCopy,
  stopRunningChatsForQuit,
} from "./runningChatsQuitConfirmation";

describe("running chats quit confirmation", () => {
  it("treats running, connecting, and live-tail chats as in progress", () => {
    expect(isRunningChatForQuit({ session: { status: "running" } })).toBe(true);
    expect(isRunningChatForQuit({ session: { status: "connecting" } })).toBe(true);
    expect(isRunningChatForQuit({ hasLiveTailWork: true, session: { status: "ready" } })).toBe(
      true,
    );
    expect(isRunningChatForQuit({ session: { status: "ready" } })).toBe(false);
    expect(isRunningChatForQuit({ session: null })).toBe(false);
  });

  it("falls back to Untitled thread for blank titles", () => {
    expect(runningChatDisplayTitle("  ")).toBe("Untitled thread");
    expect(runningChatDisplayTitle("Fix the tray")).toBe("Fix the tray");
  });

  it("lists sidebar and session-only running chats without duplicates", () => {
    const chats = listRunningChatsFromDesktopStore({
      sidebarThreadSummaryById: {
        a: { id: "a", title: "Sidebar running", session: { status: "running" } },
        idle: { id: "idle", title: "Idle", session: { status: "ready" } },
      },
      threadSessionById: {
        a: { status: "running" },
        b: { status: "connecting" },
        idle: { status: "ready" },
      },
      threadShellById: {
        b: { title: "Session-only connecting" },
      },
    });

    expect(chats).toEqual([
      { id: "b", title: "Session-only connecting" },
      { id: "a", title: "Sidebar running" },
    ]);
  });

  it("builds singular and plural English copy", () => {
    expect(runningChatsQuitCopy([{ id: "a", title: "Fix the tray" }])).toEqual({
      title: "A chat is still running",
      description: "Work in progress will stop when Synara is closed.",
      stayLabel: "Cancel",
      quitLabel: "Quit",
    });
    expect(
      runningChatsQuitCopy(
        [
          { id: "a", title: "One" },
          { id: "b", title: "Two" },
        ],
        "Synara Canary",
      ),
    ).toEqual({
      title: "Chats are still running",
      description: "Work in progress will stop when Synara Canary is closed.",
      stayLabel: "Cancel",
      quitLabel: "Quit",
    });
  });

  it("reports whether listed chats are still running", () => {
    const state = {
      sidebarThreadSummaryById: {
        a: { id: "a", title: "Sidebar running", session: { status: "running" } },
        idle: { id: "idle", title: "Idle", session: { status: "ready" } },
      },
    };
    expect(runningChatIdsStillActive(state, ["a"])).toBe(true);
    expect(runningChatIdsStillActive(state, ["idle"])).toBe(false);
    expect(runningChatIdsStillActive(state, [])).toBe(false);
  });

  it("interrupts running chats and waits until they settle", async () => {
    const interrupted: string[] = [];
    let stillRunning = true;
    const sleepCalls: number[] = [];

    const stopping = stopRunningChatsForQuit({
      chats: [
        { id: "a", title: "One" },
        { id: "b", title: "Two" },
      ],
      dispatchInterrupt: async (threadId) => {
        interrupted.push(threadId);
      },
      isStillRunning: () => stillRunning,
      nowMs: () => 0,
      sleep: async (ms) => {
        sleepCalls.push(ms);
        stillRunning = false;
      },
      timeoutMs: 200,
    });

    await stopping;
    expect(interrupted).toEqual(["a", "b"]);
    expect(sleepCalls).toEqual([50]);
  });

  it("still quits if interrupt dispatch fails or the wait times out", async () => {
    let now = 0;
    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a", title: "One" }],
        dispatchInterrupt: async () => {
          throw new Error("rpc failed");
        },
        isStillRunning: () => true,
        nowMs: () => now,
        sleep: async () => {
          now += 50;
        },
        timeoutMs: 80,
      }),
    ).resolves.toBeUndefined();
    expect(now).toBeGreaterThanOrEqual(80);
  });
});
