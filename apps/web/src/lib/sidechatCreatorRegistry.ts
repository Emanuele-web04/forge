// FILE: sidechatCreatorRegistry.ts
// Purpose: Bridge the composer's /side creation logic to the right-dock "+" button.
// Layer: Chat capability registry
// Exports: register/get for a per-host-thread sidechat creator.
//
// The composer (inside ChatView) owns the full sidechat-creation flow, including the
// user's currently selected model. The right dock lives outside ChatView, so instead
// of duplicating that flow we let the composer publish its creator keyed by host
// thread id and have the dock invoke it. Only threads that can offer /side register.

import type { ThreadId } from "@synara/contracts";

export type SidechatCreator = (options?: { initialPrompt?: string }) => Promise<unknown>;

const creatorsByThreadId = new Map<ThreadId, SidechatCreator>();
const waitersByThreadId = new Map<ThreadId, Set<(creator: SidechatCreator | undefined) => void>>();

function notifyCreatorWaiters(threadId: ThreadId, creator: SidechatCreator | undefined): void {
  const waiters = waitersByThreadId.get(threadId);
  if (!waiters) return;
  waitersByThreadId.delete(threadId);
  for (const resolve of waiters) resolve(creator);
}

export function registerSidechatCreator(threadId: ThreadId, creator: SidechatCreator): () => void {
  creatorsByThreadId.set(threadId, creator);
  notifyCreatorWaiters(threadId, creator);
  return () => {
    if (creatorsByThreadId.get(threadId) === creator) {
      creatorsByThreadId.delete(threadId);
    }
  };
}

export function getSidechatCreator(threadId: ThreadId): SidechatCreator | undefined {
  return creatorsByThreadId.get(threadId);
}

// The dock can render one commit before its nested composer publishes the
// creator. Wait briefly for that normal mount ordering instead of presenting a
// flaky "unavailable" action to the user.
export function waitForSidechatCreator(
  threadId: ThreadId,
  timeoutMs = 500,
): Promise<SidechatCreator | undefined> {
  const creator = getSidechatCreator(threadId);
  if (creator) return Promise.resolve(creator);

  return new Promise((resolve) => {
    const waiters = waitersByThreadId.get(threadId) ?? new Set();
    const finish = (nextCreator: SidechatCreator | undefined) => {
      globalThis.clearTimeout(timeoutId);
      resolve(nextCreator);
    };
    waiters.add(finish);
    waitersByThreadId.set(threadId, waiters);
    const timeoutId = globalThis.setTimeout(() => {
      const pending = waitersByThreadId.get(threadId);
      pending?.delete(finish);
      if (pending?.size === 0) waitersByThreadId.delete(threadId);
      resolve(undefined);
    }, timeoutMs);
  });
}
