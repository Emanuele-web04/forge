import { describe, expect, it } from "vitest";

import {
  isRunningChatForQuit,
  listRunningChatsFromDesktopStore,
  runningChatDisplayTitle,
  runningChatsQuitCopy,
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
});
