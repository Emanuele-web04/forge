// FILE: useKanbanTaskComposerEditor.ts
// Purpose: Handles kanban task composer insertion, cursor, and menu key behavior.
// Layer: Kanban UI hook
// Exports: useKanbanTaskComposerEditor

import type {
  ModelSlug,
  ProviderInteractionMode,
  ProviderKind,
  ProviderMentionReference,
  ProviderSkillReference,
  ThreadId,
} from "@synara/contracts";
import { type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";

import type { ComposerPromptEditorHandle } from "~/components/ComposerPromptEditor";
import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";
import type { ComposerLocalDirectoryMenuHandle } from "~/components/chat/ComposerLocalDirectoryMenu";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  type ComposerTrigger,
} from "~/composer-logic";
import {
  ensureLeadingSpaceForReplacement,
  extendReplacementRangeForTrailingSpace,
} from "~/composerTriggerInsertion";
import {
  composerMentionPathNeedsQuoting,
  formatComposerMentionToken,
  skillMentionPrefix,
} from "~/lib/composerMentions";
import {
  syncTerminalContextsByIds,
  terminalContextIdListsEqual,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { useComposerDraftStore } from "../../composerDraftStore";

interface UseKanbanTaskComposerEditorInput {
  readonly promptRef: MutableRefObject<string>;
  readonly setPrompt: (nextPrompt: string) => void;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly localDirectoryMenuRef: RefObject<ComposerLocalDirectoryMenuHandle | null>;
  readonly composerCursor: number;
  readonly setComposerCursor: Dispatch<SetStateAction<number>>;
  readonly setComposerTrigger: Dispatch<SetStateAction<ComposerTrigger | null>>;
  readonly composerHighlightedItemId: string | null;
  readonly setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  readonly composerMenuItems: readonly ComposerCommandItem[];
  readonly activeComposerMenuItem: ComposerCommandItem | null;
  readonly isLocalFolderBrowserOpen: boolean;
  readonly localFolderBrowseRootPath: string | null;
  readonly composerTerminalContexts: readonly TerminalContextDraft[];
  readonly composerSkills: readonly ProviderSkillReference[];
  readonly composerMentions: readonly ProviderMentionReference[];
  readonly scratchThreadId: ThreadId;
  readonly selectedProvider: ProviderKind;
  readonly handleProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  readonly setInteractionMode: Dispatch<SetStateAction<ProviderInteractionMode>>;
  readonly onCreate: () => void;
}

export function useKanbanTaskComposerEditor(input: UseKanbanTaskComposerEditorInput) {
  const {
    promptRef,
    setPrompt,
    composerEditorRef,
    localDirectoryMenuRef,
    composerCursor,
    setComposerCursor,
    setComposerTrigger,
    composerHighlightedItemId,
    setComposerHighlightedItemId,
    composerMenuItems,
    activeComposerMenuItem,
    isLocalFolderBrowserOpen,
    localFolderBrowseRootPath,
    composerTerminalContexts,
    composerSkills,
    composerMentions,
    scratchThreadId,
    selectedProvider,
    handleProviderModelChange,
    setInteractionMode,
    onCreate,
  } = input;

  const scheduleComposerFocus = () => {
    window.requestAnimationFrame(() => {
      composerEditorRef.current?.focusAtEnd();
    });
  };

  const applyPromptReplacement = (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options?: { expectedText?: string; cursorOffset?: number },
  ): number | false => {
    const currentText = promptRef.current;
    const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
    const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
    if (
      options?.expectedText !== undefined &&
      currentText.slice(safeStart, safeEnd) !== options.expectedText
    ) {
      return false;
    }
    const next = replaceTextRange(currentText, rangeStart, rangeEnd, replacement);
    let nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    if (options?.cursorOffset !== undefined) {
      nextCursor = Math.max(0, nextCursor + options.cursorOffset);
    }
    promptRef.current = next.text;
    setPrompt(next.text);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
    );
    window.requestAnimationFrame(() => {
      composerEditorRef.current?.focusAt(nextCursor);
    });
    return nextCursor;
  };

  const readComposerSnapshot = () => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      selectionCollapsed: true,
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  };

  const resolveActiveComposerTrigger = (): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  };

  const applyComposerTriggerReplacement = (params: {
    snapshot: { value: string };
    trigger: ComposerTrigger;
    base: string;
    cursorOffset?: number;
    onApplied?: () => void;
  }): number | false => {
    const { snapshot, trigger, base, cursorOffset, onApplied } = params;
    const replacement = ensureLeadingSpaceForReplacement(snapshot.value, trigger.rangeStart, base);
    const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
      snapshot.value,
      trigger.rangeEnd,
      replacement,
    );
    const options: { expectedText: string; cursorOffset?: number } = {
      expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
    };
    if (cursorOffset !== undefined) {
      options.cursorOffset = cursorOffset;
    }
    const applied = applyPromptReplacement(
      trigger.rangeStart,
      replacementRangeEnd,
      replacement,
      options,
    );
    if (applied !== false) {
      onApplied?.();
      setComposerHighlightedItemId(null);
    }
    return applied;
  };

  const handleSelectLocalDirectoryMention = (absolutePath: string) => {
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    applyComposerTriggerReplacement({
      snapshot,
      trigger,
      base: `${formatComposerMentionToken(absolutePath)} `,
    });
  };

  const handleNavigateLocalFolder = (absolutePath: string) => {
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    const separator = absolutePath.includes("\\") ? "\\" : "/";
    const withTrailingSeparator = absolutePath.endsWith(separator)
      ? absolutePath
      : `${absolutePath}${separator}`;
    const base = composerMentionPathNeedsQuoting(withTrailingSeparator)
      ? `@"${withTrailingSeparator}`
      : `@${withTrailingSeparator}`;
    applyComposerTriggerReplacement({ snapshot, trigger, base });
  };

  const setPromptAtEnd = (nextPrompt: string) => {
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  };

  const appendComposerPromptText = (text: string) => {
    const current = promptRef.current;
    const needsSeparator = current.length > 0 && !/\s$/.test(current);
    setPromptAtEnd(`${current}${needsSeparator ? " " : ""}${text} `);
  };

  const onSelectComposerItem = (item: ComposerCommandItem) => {
    const { snapshot, trigger } = resolveActiveComposerTrigger();
    if (!trigger) return;
    if (item.type === "path") {
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${formatComposerMentionToken(item.path)} `,
      });
      return;
    }
    if (item.type === "local-root") {
      handleNavigateLocalFolder(localFolderBrowseRootPath ?? "/");
      return;
    }
    if (item.type === "provider-native-command") {
      applyComposerTriggerReplacement({ snapshot, trigger, base: `/${item.command} ` });
      return;
    }
    if (item.type === "skill") {
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${skillMentionPrefix(selectedProvider)}${item.skill.name} `,
        onApplied: () => {
          const nextSkill = {
            name: item.skill.name,
            path: item.skill.path,
          } satisfies ProviderSkillReference;
          const exists = composerSkills.some(
            (skill) => skill.name === nextSkill.name && skill.path === nextSkill.path,
          );
          if (!exists) {
            useComposerDraftStore
              .getState()
              .setSkills(scratchThreadId, [...composerSkills, nextSkill]);
          }
        },
      });
      return;
    }
    if (item.type === "plugin" || item.type === "thread") {
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${formatComposerMentionToken(item.mention.name)} `,
        onApplied: () => {
          const nextWithoutSameName = composerMentions.filter(
            (mention) => mention.name !== item.mention.name,
          );
          useComposerDraftStore
            .getState()
            .setMentions(scratchThreadId, [...nextWithoutSameName, item.mention]);
        },
      });
      return;
    }
    if (item.type === "model") {
      handleProviderModelChange(item.provider, item.model);
      applyComposerTriggerReplacement({ snapshot, trigger, base: "" });
      return;
    }
    if (item.type === "agent") {
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `@${item.alias}()`,
        cursorOffset: -1,
      });
      return;
    }
    if (item.type === "slash-command") {
      if (item.command === "clear") {
        useComposerDraftStore.getState().clearComposerContent(scratchThreadId);
        setComposerCursor(0);
        setComposerTrigger(null);
        return;
      }
      if (item.command === "plan" || item.command === "debug" || item.command === "default") {
        setInteractionMode(item.command);
        applyComposerTriggerReplacement({ snapshot, trigger, base: "" });
      }
    }
  };

  const onPromptChange = (
    nextPrompt: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => {
    promptRef.current = nextPrompt;
    setPrompt(nextPrompt);
    if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
      useComposerDraftStore
        .getState()
        .setTerminalContexts(
          scratchThreadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
    }
    setComposerCursor(nextCursor);
    setComposerTrigger(
      cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
    );
  };

  const nudgeComposerMenuHighlight = (key: "ArrowDown" | "ArrowUp") => {
    if (composerMenuItems.length === 0) {
      return;
    }
    const highlightedIndex = composerMenuItems.findIndex(
      (item) => item.id === composerHighlightedItemId,
    );
    const normalizedIndex = highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
    const offset = key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
    setComposerHighlightedItemId(composerMenuItems[nextIndex]?.id ?? null);
  };

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      setInteractionMode((current) => (current === "plan" ? "default" : "plan"));
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = trigger !== null;

    if (menuIsActive && isLocalFolderBrowserOpen) {
      if (key === "ArrowDown") {
        localDirectoryMenuRef.current?.moveHighlight("down");
        return true;
      }
      if (key === "ArrowUp") {
        localDirectoryMenuRef.current?.moveHighlight("up");
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        localDirectoryMenuRef.current?.activateHighlighted();
        return true;
      }
    }

    if (menuIsActive) {
      if (key === "ArrowDown" && composerMenuItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && composerMenuItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItem ?? composerMenuItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      onCreate();
      return true;
    }
    return false;
  };

  return {
    scheduleComposerFocus,
    setPromptAtEnd,
    appendComposerPromptText,
    handleSelectLocalDirectoryMention,
    handleNavigateLocalFolder,
    onSelectComposerItem,
    onPromptChange,
    onComposerCommandKey,
  };
}
