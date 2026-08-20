import { describe, expect, it } from "vitest";

import {
  isRunningChatForQuit,
  listRunningChatsFromDesktopStore,
  quitResumeContinuationPrompt,
  runningChatDisplayTitle,
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
      resumeLabel: "Resume chat automatically",
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
      resumeLabel: "Resume chats automatically",
      stayLabel: "Cancel",
      quitLabel: "Quit",
    });
  });

  it("builds the continuation prompt from the app name", () => {
    expect(quitResumeContinuationPrompt()).toBe(
      "Synara was closed while this chat was still running. Continue where you left off.",
    );
    expect(quitResumeContinuationPrompt("Synara Canary")).toBe(
      "Synara Canary was closed while this chat was still running. Continue where you left off.",
    );
  });

  it("interrupts running chats without waiting for them to settle", async () => {
    const interrupted: string[] = [];
    let settleInterrupt: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => {
      settleInterrupt = resolve;
    });

    const stopping = stopRunningChatsForQuit({
      chats: [{ id: "a" }, { id: "b" }],
      dispatchInterrupt: async (threadId) => {
        interrupted.push(threadId);
        if (threadId === "b") {
          await hanging;
        }
      },
    });

    expect(interrupted).toEqual(["a", "b"]);
    settleInterrupt?.();
    await stopping;
  });

  it("still returns if interrupt dispatch fails", async () => {
    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: async () => {
          throw new Error("rpc failed");
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });
  });

  it("lets the server record and interrupt when resume is requested", async () => {
    const prepared: ReadonlyArray<string>[] = [];
    const interrupted: string[] = [];

    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }, { id: "b" }],
        dispatchInterrupt: (threadId) => {
          interrupted.push(threadId);
        },
        resume: {
          prepare: async (threadIds) => {
            prepared.push(threadIds);
          },
        },
      }),
    ).resolves.toEqual({ resumeRecorded: true });

    expect(prepared).toEqual([["a", "b"]]);
    expect(interrupted).toEqual([]);
  });

  it("falls back to plain interrupts when recording fails", async () => {
    const interrupted: string[] = [];

    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: (threadId) => {
          interrupted.push(threadId);
        },
        resume: {
          prepare: async () => {
            throw new Error("rpc failed");
          },
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });

    expect(interrupted).toEqual(["a"]);
  });

  it("falls back to plain interrupts when recording does not ack in time, without waiting on them", async () => {
    const interrupted: string[] = [];

    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: (threadId) => {
          interrupted.push(threadId);
          // A hanging interrupt (unresponsive server) must not hold the quit.
          return new Promise(() => {});
        },
        resume: {
          prepare: () => new Promise(() => {}),
          timeoutMs: 5,
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });

    expect(interrupted).toEqual(["a"]);
  });

  it("survives an interrupt dispatcher that throws synchronously", async () => {
    await expect(
      stopRunningChatsForQuit({
        chats: [{ id: "a" }],
        dispatchInterrupt: () => {
          throw new Error("sync failure");
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });
  });

  it("skips recording entirely when there is nothing running", async () => {
    let prepared = false;
    await expect(
      stopRunningChatsForQuit({
        chats: [],
        dispatchInterrupt: () => {},
        resume: {
          prepare: async () => {
            prepared = true;
          },
        },
      }),
    ).resolves.toEqual({ resumeRecorded: false });
    expect(prepared).toBe(false);
  });
});
