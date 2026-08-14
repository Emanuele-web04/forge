// FILE: automationInlineDraft.ts
// Purpose: Commit-on-blur draft state for inline-editable automation fields.
// Layer: Web lib (React hook)
// Exports: useCommitDraft — powers the detail page's name/prompt fields and the inline
// commit text inputs so every commit/revert/rebase behavior stays identical.

import { useEffect, useRef, useState } from "react";

export interface CommitDraftOptions {
  /** The saved value the draft is seeded from (and rebased onto when it changes). */
  readonly value: string;
  /** Called with the (normalized) draft when it differs from `value` and passes validation. */
  readonly onCommit: (value: string) => void;
  /** Error message for an invalid draft, or null. Invalid drafts revert instead of committing. */
  readonly validate?: ((value: string) => string | null) | undefined;
  /**
   * Canonical form of a draft before comparing and committing (e.g. trim). Keeps a
   * whitespace-only edit from firing a no-op server update.
   */
  readonly normalize?: ((value: string) => string) | undefined;
  /**
   * Flush a valid pending draft when the field unmounts (default true). Turn OFF for fields
   * whose commit payload depends on sibling state (the schedule rows): their unmount usually
   * means that state changed, and flushing through the stale closure would resurrect it.
   */
  readonly flushOnUnmount?: boolean | undefined;
}

export interface CommitDraft {
  readonly draft: string;
  readonly setDraft: (next: string) => void;
  /** Commit the pending draft (blur/Enter). Invalid drafts silently revert. */
  readonly commit: () => void;
  /** Discard the pending draft (Escape). */
  readonly revert: () => void;
  /** Validation error for the current draft, or null. */
  readonly error: string | null;
}

/**
 * Draft keyed to the value it was seeded from: an external change (stream update, rollback
 * after a failed save) derives straight back to the fresh value with no state-syncing effect.
 * A valid pending draft is flushed on unmount so navigating away never loses an edit.
 */
export function useCommitDraft({
  value,
  onCommit,
  validate,
  normalize,
  flushOnUnmount = true,
}: CommitDraftOptions): CommitDraft {
  const [draftState, setDraftState] = useState<{ base: string; value: string } | null>(null);
  const draft = draftState !== null && draftState.base === value ? draftState.value : value;
  const setDraft = (next: string) => setDraftState({ base: value, value: next });

  const normalized = normalize ? normalize(draft) : draft;
  const isCommittable = normalized !== value && (!validate || validate(normalized) === null);
  const latest = useRef({ isCommittable, normalized, onCommit, flushOnUnmount });

  const clearPendingFlush = () => {
    latest.current = { ...latest.current, isCommittable: false };
  };

  const commit = () => {
    clearPendingFlush();
    if (isCommittable) {
      onCommit(normalized);
    }
    setDraftState(null);
  };
  const revert = () => {
    clearPendingFlush();
    setDraftState(null);
  };

  // Flush a valid pending draft on unmount. The ref is written in an effect — never during
  // render — so a render React discards (StrictMode, interrupted concurrent render) can't
  // leak its values into the cleanup; the flush always sees the last *committed* draft.
  useEffect(() => {
    latest.current = { isCommittable, normalized, onCommit, flushOnUnmount };
  });
  useEffect(
    () => () => {
      const current = latest.current;
      if (current.flushOnUnmount && current.isCommittable) {
        current.onCommit(current.normalized);
      }
    },
    [],
  );

  return { draft, setDraft, commit, revert, error: validate ? validate(normalized) : null };
}

/**
 * Blur/keyboard wiring for a commit-on-blur field. Escape must revert, but calling
 * `element.blur()` fires the blur handler synchronously with the pre-revert draft still in
 * scope — so revert is requested through a ref the blur handler checks before committing.
 */
export function useCommitDraftBlurHandlers(draft: Pick<CommitDraft, "commit" | "revert">): {
  /** Blur handler: commits, unless the blur was caused by {@link revertAndBlur}. */
  readonly onBlur: () => void;
  /** Escape handler: discards the draft and drops focus without committing. */
  readonly revertAndBlur: (element: { blur(): void }) => void;
} {
  const revertingRef = useRef(false);
  return {
    onBlur: () => {
      if (revertingRef.current) {
        revertingRef.current = false;
        draft.revert();
        return;
      }
      draft.commit();
    },
    revertAndBlur: (element) => {
      revertingRef.current = true;
      element.blur();
    },
  };
}
