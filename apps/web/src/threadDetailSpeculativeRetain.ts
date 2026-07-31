// FILE: threadDetailSpeculativeRetain.ts
// Purpose: Cursor-gated speculative thread-detail retains that fall with their cursor.
// Layer: Web subscription utility
// Exports: retainSpeculativeThreadDetail plus its injectable dependencies.

import type { ThreadId } from "@synara/contracts";

import { localThreadDetailResumeCursors } from "./threadDetailResumeCursors";
import { retainThreadDetailSubscription } from "./threadDetailSubscriptionRetention";

/** Placeholder unsubscribe used only until the real listener is registered. */
function noop(): void {}

export interface SpeculativeThreadDetailRetainOptions {
  readonly retainThreadDetailSubscription?: ((threadId: ThreadId) => () => void) | undefined;
  readonly canRetainThreadDetail?: ((threadId: ThreadId) => boolean) | undefined;
  readonly subscribeResumeCursorReset?: ((listener: () => void) => () => void) | undefined;
  /**
   * Fired when the cursor reset released this retain on its own, so a caller
   * tracking live retains can drop its bookkeeping in the same step rather than
   * keeping a second view of the truth that has to be reconciled later.
   */
  readonly onAutoRelease?: ((threadId: ThreadId) => void) | undefined;
}

/**
 * Retains a thread's detail speculatively — for scroll position or navigation
 * intent, not because anything is rendering it.
 *
 * A speculative retain is only cheap while the thread has a resume cursor: its
 * stream resumes from cached detail instead of opening a full-history snapshot.
 * When the cursors are reset (a server-generation change), that premise is gone,
 * so the retain releases itself immediately. Eligibility is therefore never
 * trusted from the render that admitted it: React does not re-run on the cursor
 * map, so a stale render would otherwise leave every prewarmed thread retained
 * and registered, and the reconnect would rebuild each one as a full-snapshot
 * stream — the burst this gate exists to prevent.
 *
 * Cursors and their reset notice are environment-scoped; this reads the local
 * environment because sidebar prewarm is not environment-aware yet. Injecting
 * both hooks keeps the seam explicit for when it becomes so.
 *
 * Returns null when the thread is not eligible, so callers cannot accidentally
 * hold a retain they never took.
 */
export function retainSpeculativeThreadDetail(
  threadId: ThreadId,
  options: SpeculativeThreadDetailRetainOptions = {},
): (() => void) | null {
  const canRetain =
    options.canRetainThreadDetail ?? ((id: ThreadId) => localThreadDetailResumeCursors().has(id));
  if (!canRetain(threadId)) {
    return null;
  }

  const retain =
    options.retainThreadDetailSubscription ??
    ((id: ThreadId) => retainThreadDetailSubscription(id, { speculative: true }));
  const subscribeReset =
    options.subscribeResumeCursorReset ??
    ((listener: () => void) => localThreadDetailResumeCursors().subscribeReset(listener));

  const releaseRetain = retain(threadId);
  let released = false;
  // Declared before `release` closes over it: the reset listener is registered
  // below, but `release` may run before that assignment lands (a reset fired
  // during registration), and a `const` here would be in its temporal dead zone
  // — a ReferenceError that the reset notifier's own `catch` would swallow,
  // leaving the retain held and the lease never given back.
  let unsubscribeReset: () => void = noop;
  const release = () => {
    if (released) return;
    released = true;
    unsubscribeReset();
    releaseRetain();
  };
  unsubscribeReset = subscribeReset(() => {
    if (released) return;
    release();
    options.onAutoRelease?.(threadId);
  });

  return release;
}
