// FILE: runningChatsQuitConfirmation.ts
// Purpose: Lists in-progress chats and builds the desktop quit confirmation copy.
// Layer: UI logic helper
// Depends on: Sidebar-equivalent "working" signals (running/connecting/live tail).

export interface RunningChatQuitCandidate {
  readonly id: string;
  readonly title: string;
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: { readonly status?: string | null } | null | undefined;
}

export interface RunningChatQuitSummary {
  readonly id: string;
  readonly title: string;
}

export interface RunningChatsQuitCopy {
  readonly title: string;
  readonly description: string;
  readonly stayLabel: string;
  readonly quitLabel: string;
}

export interface RunningChatsQuitStoreSlice {
  readonly sidebarThreadSummaryById: Readonly<Record<string, RunningChatQuitCandidate>>;
  readonly threadSessionById?: Readonly<
    Record<string, { readonly status?: string | null } | null | undefined>
  >;
  readonly threadShellById?: Readonly<Record<string, { readonly title?: string } | undefined>>;
}

const UNTITLED_CHAT_TITLE = "Untitled thread";

export function runningChatDisplayTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNTITLED_CHAT_TITLE;
}

export function isRunningChatForQuit(thread: {
  readonly hasLiveTailWork?: boolean | undefined;
  readonly session?: { readonly status?: string | null } | null | undefined;
}): boolean {
  if (thread.hasLiveTailWork === true) {
    return true;
  }
  const status = thread.session?.status;
  return status === "running" || status === "connecting";
}

export function listRunningChatsForQuit(
  threads: ReadonlyArray<RunningChatQuitCandidate>,
): ReadonlyArray<RunningChatQuitSummary> {
  const seen = new Set<string>();
  const chats: RunningChatQuitSummary[] = [];
  for (const thread of threads) {
    if (seen.has(thread.id) || !isRunningChatForQuit(thread)) {
      continue;
    }
    seen.add(thread.id);
    chats.push({ id: thread.id, title: runningChatDisplayTitle(thread.title) });
  }
  return chats.sort(compareRunningChatSummaries);
}

export function listRunningChatsFromDesktopStore(
  state: RunningChatsQuitStoreSlice,
): ReadonlyArray<RunningChatQuitSummary> {
  const candidates: RunningChatQuitCandidate[] = Object.values(state.sidebarThreadSummaryById);
  const listedIds = new Set(candidates.map((thread) => thread.id));

  for (const [id, session] of Object.entries(state.threadSessionById ?? {})) {
    if (listedIds.has(id)) {
      continue;
    }
    candidates.push({
      id,
      title: state.threadShellById?.[id]?.title ?? "",
      session,
    });
  }

  return listRunningChatsForQuit(candidates);
}

export function runningChatsQuitCopy(
  chats: ReadonlyArray<RunningChatQuitSummary>,
  appName = "Synara",
): RunningChatsQuitCopy {
  return {
    title: chats.length === 1 ? "A chat is still running" : "Chats are still running",
    description: `Work in progress will stop when ${appName} is closed.`,
    stayLabel: "Cancel",
    quitLabel: "Quit",
  };
}

export async function stopRunningChatsForQuit(input: {
  readonly chats: ReadonlyArray<Pick<RunningChatQuitSummary, "id">>;
  readonly dispatchInterrupt: (threadId: string) => Promise<unknown> | unknown;
}): Promise<void> {
  if (input.chats.length === 0) {
    return;
  }

  await Promise.allSettled(
    input.chats.map((chat) => Promise.resolve(input.dispatchInterrupt(chat.id))),
  );
}

function compareRunningChatSummaries(
  left: RunningChatQuitSummary,
  right: RunningChatQuitSummary,
): number {
  const byTitle = left.title.localeCompare(right.title);
  if (byTitle !== 0) {
    return byTitle;
  }
  return left.id.localeCompare(right.id);
}
