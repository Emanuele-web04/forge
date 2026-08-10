// FILE: useKanbanTaskComposerMenu.ts
// Purpose: Wires kanban composer menu discovery to editor insertion/key handling.
// Layer: Kanban UI hook
// Exports: useKanbanTaskComposerMenu

import type {
  ModelSlug,
  ProviderAgentDescriptor,
  ProviderInteractionMode,
  ProviderKind,
  ProviderMentionReference,
  ProviderSkillReference,
  ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import {
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import type { ComposerPromptEditorHandle } from "~/components/ComposerPromptEditor";
import type { ComposerLocalDirectoryMenuHandle } from "~/components/chat/ComposerLocalDirectoryMenu";
import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  type ComposerTrigger,
} from "~/composer-logic";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import type { ProviderModelOption } from "../../providerModelOptions";
import { useKanbanTaskComposerDiscovery } from "./useKanbanTaskComposerDiscovery";
import { useKanbanTaskComposerEditor } from "./useKanbanTaskComposerEditor";

interface UseKanbanTaskComposerMenuInput {
  readonly prompt: string;
  readonly promptRef: MutableRefObject<string>;
  readonly setPrompt: (nextPrompt: string) => void;
  readonly composerEditorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly localDirectoryMenuRef: RefObject<ComposerLocalDirectoryMenuHandle | null>;
  readonly composerTerminalContexts: readonly TerminalContextDraft[];
  readonly composerSkills: readonly ProviderSkillReference[];
  readonly composerMentions: readonly ProviderMentionReference[];
  readonly scratchThreadId: ThreadId;
  readonly selectedProvider: ProviderKind;
  readonly targetExecutable: boolean;
  readonly modelOptionsByProvider: Record<
    ProviderKind,
    ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
  >;
  readonly selectedRuntimeAgents: readonly ProviderAgentDescriptor[];
  readonly selectedProjectCwd: string | null;
  readonly serverCwd: string | null;
  readonly serverHomeDir: string | null;
  readonly providerOptionsForDispatch: ProviderStartOptions | undefined;
  readonly hiddenProviders: readonly ProviderKind[];
  readonly providerOrder: readonly ProviderKind[];
  readonly piAgentDir: string | null;
  readonly handleProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  readonly setInteractionMode: Dispatch<SetStateAction<ProviderInteractionMode>>;
  readonly onCreate: () => void;
}

export function useKanbanTaskComposerMenu(input: UseKanbanTaskComposerMenuInput) {
  const {
    prompt,
    promptRef,
    setPrompt,
    composerEditorRef,
    localDirectoryMenuRef,
    composerTerminalContexts,
    composerSkills,
    composerMentions,
    scratchThreadId,
    selectedProvider,
    targetExecutable,
    modelOptionsByProvider,
    selectedRuntimeAgents,
    selectedProjectCwd,
    serverCwd,
    serverHomeDir,
    providerOptionsForDispatch,
    hiddenProviders,
    providerOrder,
    piAgentDir,
    handleProviderModelChange,
    setInteractionMode,
    onCreate,
  } = input;
  const [composerCursorState, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  // Clamped at read time so a prompt change never needs a state-syncing effect.
  const composerCursor = clampCollapsedComposerCursor(prompt, composerCursorState);
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);

  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt, promptRef]);

  const {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    localFolderBrowseRootPath,
    composerMenuItems,
    isComposerMenuLoading,
  } = useKanbanTaskComposerDiscovery({
    composerTrigger,
    selectedProvider,
    targetExecutable,
    modelOptionsByProvider,
    selectedRuntimeAgents,
    selectedProjectCwd,
    serverCwd,
    serverHomeDir,
    scratchThreadId,
    providerOptionsForDispatch,
    hiddenProviders,
    providerOrder,
    piAgentDir,
  });
  const activeComposerMenuItem =
    composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
    composerMenuItems[0] ??
    null;
  const editor = useKanbanTaskComposerEditor({
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
  });

  return {
    composerCursor,
    composerTrigger,
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    localFolderBrowseRootPath,
    composerMenuItems,
    activeComposerMenuItem,
    isComposerMenuLoading,
    setComposerHighlightedItemId,
    ...editor,
  };
}
