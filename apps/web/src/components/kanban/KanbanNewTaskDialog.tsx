// FILE: KanbanNewTaskDialog.tsx
// Purpose: Linear-style "New task" dialog — a compact composer that drafts a task
//          (prompt + provider/model/effort + permissions + mode + environment + voice)
//          and drops it into the board's Draft column. Model state is driven through
//          a scratch composer-draft-store thread so the split model + effort/options
//          pickers work exactly like a fresh chat composer; the project's regular
//          composer draft is untouched.
// Layer: Kanban UI component
// Exports: KanbanNewTaskDialog

import type {
  ProjectId,
  ProviderInteractionMode,
  ProviderKind,
  RuntimeMode,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getProviderStartOptions,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "~/appSettings";
import { RuntimeUsageControls } from "~/components/BranchToolbar";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "~/components/ComposerPromptEditor";
import { ComposerCommandMenu } from "~/components/chat/ComposerCommandMenu";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "~/components/chat/ComposerLocalDirectoryMenu";
import { ComposerReferenceAttachments } from "~/components/chat/ComposerReferenceAttachments";
import { ComposerVoiceButton } from "~/components/chat/ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "~/components/chat/ComposerVoiceRecorderBar";
import { useComposerVoiceController } from "~/components/chat/useComposerVoiceController";
import { resolveRuntimeModelDescriptor } from "~/components/chat/runtimeModelCapabilities";
import {
  COMPOSER_COMMAND_MENU_INLINE_WRAPPER_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Switch } from "~/components/ui/switch";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useComposerDropzone } from "~/hooks/useComposerDropzone";
import { toastManager } from "~/components/ui/toast";
import { useTheme } from "~/hooks/useTheme";
import { ChevronRightIcon, LoaderCircleIcon, PaperclipIcon } from "~/lib/icons";
import { formatComposerMentionToken } from "~/lib/composerMentions";
import { findProviderStatus } from "~/lib/providerAvailability";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
} from "~/lib/runtimeMode";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  type ComposerFileAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { buildModelSelection } from "../../providerModelOptions";
import { type ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { ExpandedImageOverlay } from "../chat/ExpandedImageOverlay";
import { useStore } from "../../store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../../types";
import { appendKanbanTaskTranscript, buildKanbanTaskPreview } from "./KanbanNewTaskDialog.logic";
import { KanbanTaskExtrasMenu } from "./KanbanTaskExtrasMenu";
import { KanbanTaskProjectPicker } from "./KanbanTaskProjectPicker";
import { useKanbanTaskComposerMenu } from "./useKanbanTaskComposerMenu";
import { useKanbanTaskScratchDraft } from "./useKanbanTaskScratchDraft";
import { useKanbanTaskSubmit } from "./useKanbanTaskSubmit";

const EMPTY_COMPOSER_FILES: ReadonlyArray<ComposerFileAttachment> = [];

function ignoreComposerFileRemoval(_fileId: string): void {}

export interface KanbanNewTaskProjectOption {
  id: ProjectId;
  name: string;
}

export interface KanbanNewTaskDialogProps {
  onOpenChange: (open: boolean) => void;
  /** Boards available as task destinations, in board display order. */
  projectOptions: ReadonlyArray<KanbanNewTaskProjectOption>;
  initialProjectId: ProjectId | null;
  /** Seeds the "Send as draft" toggle — true when opened from the Draft column's "+". */
  initialSendAsDraft?: boolean;
}

/**
 * Mount with a fresh `key` per open so all draft state initializes lazily; closing
 * is signalled through onOpenChange(false) and the parent unmounts the dialog.
 */
export function KanbanNewTaskDialog({
  onOpenChange,
  projectOptions,
  initialProjectId,
  initialSendAsDraft: initialSendAsDraftProp,
}: KanbanNewTaskDialogProps) {
  const initialSendAsDraft = initialSendAsDraftProp ?? false;
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const projects = useStore((state) => state.projects);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);

  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(
    () => initialProjectId ?? projectOptions[0]?.id ?? null,
  );
  const {
    scratchThreadId,
    prompt,
    composerImages,
    composerAssistantSelections,
    composerFileComments,
    composerTerminalContexts,
    composerSkills,
    composerMentions,
    nonPersistedComposerImageIdSet,
    isPreparingImages,
    pendingImageCount,
    waitForPendingImages,
    selectedProvider,
    selectedModel,
    selectedModelSupportsAutoMode,
    selectedProviderModelOptions,
    setPrompt,
    handleProviderModelChange: setScratchProviderModel,
    addComposerImages,
    removeComposerImage,
    clearComposerAssistantSelections,
    clearComposerFileComments,
    removeComposerTerminalContext,
  } = useKanbanTaskScratchDraft({ defaultProvider: settings.defaultProvider });
  const promptRef = useRef(prompt);

  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [interactionMode, setInteractionMode] =
    useState<ProviderInteractionMode>(DEFAULT_INTERACTION_MODE);
  const [envMode, setEnvMode] = useState<DraftThreadEnvMode>("local");
  // Off by default: a new task is sent straight to In Progress (like starting a
  // fresh chat). The Draft column's "+" opens the dialog with the toggle on, so
  // the task parks in Draft — matching where the user clicked.
  const [sendAsDraft, setSendAsDraft] = useState(initialSendAsDraft);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: selectedProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });

  // Voice transcription always rides on the Codex ChatGPT session, regardless of
  // which provider the task targets — gate the mic on the Codex status.
  const voiceProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, "codex"),
    [providerStatuses],
  );
  const selectedProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, selectedProvider),
    [providerStatuses, selectedProvider],
  );

  const modelHintByProvider = useMemo<Partial<Record<ProviderKind, string | null>>>(
    () => ({ [selectedProvider]: selectedModel }),
    [selectedProvider, selectedModel],
  );
  const {
    modelOptionsByProvider,
    loadingModelProviders,
    runtimeModelsByProvider,
    selectedRuntimeModel,
    selectedRuntimeAgents,
  } = useProviderModelCatalog({
    selectedProvider,
    // Keep discovery warm whenever either picker can open so cursor/codex effort
    // and fast-mode controls are populated, not just the model list.
    discoveryEnabled: isModelPickerOpen || isTraitsPickerOpen,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider,
  });
  const selectedRuntimeModelForCapabilities = useMemo(
    () =>
      selectedRuntimeModel ??
      (selectedProvider === "claudeAgent" && typeof selectedModelSupportsAutoMode === "boolean"
        ? {
            slug: selectedModel ?? "default",
            name: selectedModel ?? "default",
            supportsAutoMode: selectedModelSupportsAutoMode,
          }
        : undefined),
    [selectedModel, selectedModelSupportsAutoMode, selectedProvider, selectedRuntimeModel],
  );
  const handleProviderModelChange = useCallback(
    (provider: ProviderKind, model: Parameters<typeof setScratchProviderModel>[1]) => {
      const runtimeModel = resolveRuntimeModelDescriptor({
        provider,
        model,
        runtimeModels: runtimeModelsByProvider[provider],
      });
      setRuntimeMode((current) => normalizeRuntimeModeForProvider(current, provider));
      setScratchProviderModel(provider, model, runtimeModel?.supportsAutoMode);
    },
    [runtimeModelsByProvider, setScratchProviderModel],
  );
  useEffect(() => {
    if (
      runtimeMode === "auto" &&
      !providerModelSupportsAutoRuntimeMode(
        selectedProvider,
        selectedRuntimeModelForCapabilities,
        selectedProviderStatus,
      )
    ) {
      setRuntimeMode("approval-required");
    }
  }, [runtimeMode, selectedProvider, selectedProviderStatus, selectedRuntimeModelForCapabilities]);
  const trimmedPrompt = prompt.trim();
  const hasSendableContent =
    trimmedPrompt.length > 0 ||
    composerImages.length > 0 ||
    composerAssistantSelections.length > 0 ||
    composerFileComments.length > 0 ||
    composerTerminalContexts.some((context) => context.text.trim().length > 0);
  const taskPreview = buildKanbanTaskPreview({
    trimmedPrompt,
    firstImageName: composerImages[0]?.name,
    assistantSelectionCount: composerAssistantSelections.length,
  });
  const { canCreate, isCreating, handleCreate } = useKanbanTaskSubmit({
    selectedProjectId,
    hasSendableContent,
    selectedProvider,
    selectedModel,
    selectedModelSupportsAutoMode: selectedRuntimeModelForCapabilities?.supportsAutoMode,
    taskPreview,
    trimmedPrompt,
    scratchThreadId,
    runtimeMode,
    interactionMode,
    envMode,
    sendAsDraft,
    defaultProvider: settings.defaultProvider,
    assistantDeliveryMode,
    providerOptionsForDispatch,
    providerStatuses,
    isPreparingImages,
    waitForPendingImages,
    onOpenChange,
  });
  const handleCreateRequest = useCallback(() => {
    void handleCreate();
  }, [handleCreate]);
  const {
    composerCursor,
    composerTrigger,
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    localFolderBrowseRootPath,
    composerMenuItems,
    activeComposerMenuItem,
    isComposerMenuLoading,
    setComposerHighlightedItemId,
    scheduleComposerFocus,
    setPromptAtEnd,
    appendComposerPromptText,
    handleSelectLocalDirectoryMention,
    handleNavigateLocalFolder,
    onSelectComposerItem,
    onPromptChange,
    onComposerCommandKey,
  } = useKanbanTaskComposerMenu({
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
    modelOptionsByProvider,
    selectedRuntimeAgents,
    selectedProjectCwd: selectedProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
    serverHomeDir: serverConfigQuery.data?.homeDir ?? null,
    providerOptionsForDispatch,
    hiddenProviders: settings.hiddenProviders,
    providerOrder: settings.providerOrder,
    piAgentDir: settings.piAgentDir || null,
    handleProviderModelChange,
    setInteractionMode,
    onCreate: handleCreateRequest,
  });

  // Providers without a static default (e.g. Pi) resolve their model once
  // discovery delivers the catalog.
  useEffect(() => {
    if (selectedModel !== null) {
      return;
    }
    const firstOption = modelOptionsByProvider[selectedProvider][0];
    if (firstOption) {
      useComposerDraftStore.getState().setModelSelection(
        scratchThreadId,
        buildModelSelection(
          selectedProvider,
          firstOption.slug,
          undefined,
          resolveRuntimeModelDescriptor({
            provider: selectedProvider,
            model: firstOption.slug,
            runtimeModels: runtimeModelsByProvider[selectedProvider],
          })?.supportsAutoMode,
        ),
      );
    }
  }, [
    modelOptionsByProvider,
    runtimeModelsByProvider,
    scratchThreadId,
    selectedModel,
    selectedProvider,
  ]);

  const handleTranscriptReady = useCallback(
    (transcript: string) => {
      const nextPrompt = appendKanbanTaskTranscript(promptRef.current, transcript);
      setPromptAtEnd(nextPrompt);
    },
    [setPromptAtEnd],
  );
  const voice = useComposerVoiceController({
    activeProject: selectedProject ?? undefined,
    activeThreadId: null,
    threadId: scratchThreadId,
    selectedProvider,
    activeProviderStatus: voiceProviderStatus,
    pendingUserInputCount: 0,
    onTranscriptReady: handleTranscriptReady,
    refreshVoiceStatus: refreshProviderStatuses,
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      composerEditorRef.current?.focusAtEnd();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  const isVoiceActive = voice.isVoiceRecording || voice.isVoiceTranscribing;

  // Cmd/Ctrl+Enter submits from anywhere in the dialog, not just the textarea —
  // the focus is often on a picker (model/effort/project) when the user commits.
  const handleSubmitShortcut = useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        handleCreateRequest();
      }
    },
    [handleCreateRequest],
  );

  const {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = useComposerDropzone({
    addImages: addComposerImages,
    fileSupport: {
      genericFiles: "reject",
      onUnsupportedFiles: (files) => {
        toastManager.add({
          type: "warning",
          title: "Only images can be attached to new tasks.",
          description:
            files.length === 1
              ? "That file was not added."
              : `${files.length} files were not added.`,
        });
      },
    },
    appendReferenceText: appendComposerPromptText,
    appendPathMentions: (paths) => {
      for (const absolutePath of paths) {
        appendComposerPromptText(formatComposerMentionToken(absolutePath));
      }
    },
    dragDepthRef,
    focusComposer: scheduleComposerFocus,
    setIsDragOverComposer,
  });

  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      addComposerImages(Array.from(event.currentTarget.files ?? []));
      event.currentTarget.value = "";
      scheduleComposerFocus();
    },
    [addComposerImages, scheduleComposerFocus],
  );
  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
    setExpandedImage((existing) => {
      if (!existing || existing.images.length <= 1) {
        return existing;
      }
      return {
        ...existing,
        index: (existing.index + direction + existing.images.length) % existing.images.length,
      };
    });
  }, []);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl rounded-3xl" onKeyDown={handleSubmitShortcut}>
        {/* Linear-style breadcrumb header: project chip › title, same type size. */}
        <DialogHeader className="px-4 pt-3.5 pb-0">
          <div className="flex min-w-0 items-center gap-2">
            <KanbanTaskProjectPicker
              projectOptions={projectOptions}
              selectedProjectId={selectedProjectId}
              onProjectIdChange={setSelectedProjectId}
            />
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
            <DialogTitle className="font-system-ui truncate font-medium text-[length:var(--app-font-size-ui,12px)] leading-none">
              New task
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Draft a prompt and place it in the board&apos;s Draft column. Drag it to In Progress to
            send it.
          </DialogDescription>
        </DialogHeader>
        {/* Flush, borderless composer body: same Lexical prompt editor and attachment row as chat. */}
        <DialogPanel
          className="px-4 pt-2 pb-2"
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <div
            className={cn(
              "relative min-h-28 rounded-lg border border-transparent px-0 py-1 transition-colors",
              isDragOverComposer && "border-sky-400/40 bg-sky-500/5",
            )}
          >
            {composerTrigger ? (
              <div className={COMPOSER_COMMAND_MENU_INLINE_WRAPPER_CLASS_NAME}>
                {isLocalFolderBrowserOpen ? (
                  <ComposerLocalDirectoryMenu
                    mentionQuery={mentionTriggerQuery}
                    rootLabel={localFolderBrowseRootPath ?? "Local folders unavailable"}
                    homeDir={serverConfigQuery.data?.homeDir ?? null}
                    onSelectEntry={(absolutePath) =>
                      handleSelectLocalDirectoryMention(absolutePath)
                    }
                    onNavigateFolder={handleNavigateLocalFolder}
                    handleRef={localDirectoryMenuRef}
                  />
                ) : (
                  <ComposerCommandMenu
                    items={composerMenuItems}
                    resolvedTheme={resolvedTheme}
                    isLoading={isComposerMenuLoading}
                    triggerKind={composerTrigger.kind}
                    activeItemId={activeComposerMenuItem?.id ?? null}
                    onHighlightedItemChange={setComposerHighlightedItemId}
                    onSelect={onSelectComposerItem}
                  />
                )}
              </div>
            ) : null}
            <ComposerReferenceAttachments
              assistantSelections={composerAssistantSelections}
              fileComments={composerFileComments}
              files={EMPTY_COMPOSER_FILES}
              images={composerImages}
              nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
              onExpandImage={setExpandedImage}
              onRemoveAssistantSelections={clearComposerAssistantSelections}
              onRemoveFileComments={clearComposerFileComments}
              onRemoveFile={ignoreComposerFileRemoval}
              onRemoveImage={removeComposerImage}
            />
            {isPreparingImages ? (
              <div
                className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
                role="status"
              >
                <LoaderCircleIcon className="size-3.5 animate-spin" />
                Optimizing {pendingImageCount === 1 ? "image" : "images"}…
              </div>
            ) : null}
            <ComposerPromptEditor
              ref={composerEditorRef}
              value={prompt}
              cursor={composerCursor}
              terminalContexts={composerTerminalContexts}
              mentionReferences={composerMentions}
              disabled={voice.isVoiceTranscribing}
              placeholder="Describe the task, @tag files/folders, paste images, or use / for skills"
              className={cn(
                COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
                COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                "px-0 py-0 text-sm",
              )}
              onRemoveTerminalContext={removeComposerTerminalContext}
              onChange={onPromptChange}
              onCommandKeyDown={onComposerCommandKey}
              onPaste={onComposerPaste}
            />
          </div>
        </DialogPanel>
        {/* Linear-style footer (not DialogFooter, whose !important button overrides
            would deform the chips): a chips row mirroring the chat composer
            (`+` extras + permissions left, model + effort right), then a hairline
            separator and a compact bottom bar with voice on the left and the
            create controls on the right. */}
        <div className="flex w-full flex-col">
          <div className="px-4 pb-2.5">
            {isVoiceActive ? (
              <ComposerVoiceRecorderBar
                durationLabel={voice.voiceRecordingDurationLabel}
                isRecording={voice.isVoiceRecording}
                isTranscribing={voice.isVoiceTranscribing}
                waveformLevels={voice.voiceWaveformLevels}
                onCancel={voice.cancelComposerVoiceRecording}
                onSubmit={() => void voice.submitComposerVoiceRecording()}
              />
            ) : (
              <div className="flex w-full items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1">
                  <KanbanTaskExtrasMenu
                    interactionMode={interactionMode}
                    onInteractionModeChange={setInteractionMode}
                    envMode={envMode}
                    onEnvModeChange={setEnvMode}
                  />
                  <RuntimeUsageControls
                    provider={selectedProvider}
                    runtimeModel={selectedRuntimeModelForCapabilities}
                    providerStatus={selectedProviderStatus}
                    runtimeMode={runtimeMode}
                    onRuntimeModeChange={setRuntimeMode}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Same split controls as a fresh chat composer: model picker plus
                      the separate effort/thinking/speed picker. */}
                  <ProviderModelPicker
                    compact
                    provider={selectedProvider}
                    model={selectedModel ?? ""}
                    lockedProvider={null}
                    providers={providerStatuses}
                    modelOptionsByProvider={modelOptionsByProvider}
                    loadingModelProviders={loadingModelProviders}
                    hiddenProviders={settings.hiddenProviders}
                    providerOrder={settings.providerOrder}
                    onProviderModelChange={handleProviderModelChange}
                    open={isModelPickerOpen}
                    onOpenChange={setIsModelPickerOpen}
                  />
                  <TraitsPicker
                    provider={selectedProvider}
                    threadId={scratchThreadId}
                    model={selectedModel}
                    runtimeModel={selectedRuntimeModel}
                    runtimeModels={runtimeModelsByProvider[selectedProvider]}
                    runtimeAgents={selectedRuntimeAgents}
                    modelOptions={selectedProviderModelOptions}
                    prompt={prompt}
                    onPromptChange={setPrompt}
                    open={isTraitsPickerOpen}
                    onOpenChange={setIsTraitsPickerOpen}
                  />
                </div>
              </div>
            )}
          </div>
          <div className="flex w-full items-center justify-between gap-2 border-t border-[color:var(--color-border-light)] px-4 py-2.5">
            <div className="flex min-w-0 items-center">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={onFileInputChange}
              />
              {!isVoiceActive ? (
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="mr-1 shrink-0 text-muted-foreground/70 hover:text-foreground"
                  aria-label="Attach images"
                  title="Attach images"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon className="size-4" />
                </Button>
              ) : null}
              {!isVoiceActive && voice.showVoiceNotesControl ? (
                <ComposerVoiceButton
                  disabled={!selectedProject}
                  isRecording={voice.isVoiceRecording}
                  isTranscribing={voice.isVoiceTranscribing}
                  durationLabel={voice.voiceRecordingDurationLabel}
                  onClick={() => void voice.startComposerVoiceRecording()}
                />
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={sendAsDraft}
                  onCheckedChange={(checked) => setSendAsDraft(checked === true)}
                />
                Send as draft
              </label>
              <Button size="sm" onClick={handleCreateRequest} disabled={!canCreate}>
                {isCreating ? "Creating..." : isPreparingImages ? "Optimizing..." : "Create task"}
              </Button>
            </div>
          </div>
        </div>
        <ExpandedImageOverlay
          expandedImage={expandedImage}
          onClose={closeExpandedImage}
          onNavigate={navigateExpandedImage}
        />
      </DialogPopup>
    </Dialog>
  );
}
