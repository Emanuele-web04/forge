import {
  DEFAULT_PROVIDER_PROFILE_ID,
  ThreadId,
  type ModelSelection,
  type ProviderModelOptions,
} from "@synara/contracts";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type QueuedComposerTurn,
} from "./composerDraftStore";
import type { TerminalContextDraft } from "./lib/terminalContext";
import type { BrowserAnnotationDraft } from "./lib/browserAnnotations";

export function makeBrowserAnnotation(
  input: Partial<BrowserAnnotationDraft> & { id: string },
): BrowserAnnotationDraft {
  return {
    id: input.id,
    ordinal: input.ordinal ?? 1,
    tabId: input.tabId ?? "tab-1",
    documentKey: input.documentKey ?? `sha256:${"0".repeat(64)}`,
    source: input.source ?? {
      url: "https://example.test/docs",
      pageTitle: "Docs",
    },
    selector: input.selector ?? "#save",
    tagName: input.tagName ?? "button",
    role: input.role ?? "button",
    name: input.name ?? "Save",
    text: input.text ?? "Save",
    fingerprint: input.fingerprint ?? "button|save",
    comment: input.comment ?? "",
    capturedAt: input.capturedAt ?? "2026-07-23T10:00:00.000Z",
  };
}

export function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

export function makeFile(input: {
  id: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerFileAttachment {
  const name = input.name ?? "notes.txt";
  const mimeType = input.mimeType ?? "text/plain";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(2)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "file",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    file,
  };
}

export function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.makeUnsafe("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

export function makeQueuedTurn(id: string): QueuedComposerTurn {
  return {
    id,
    kind: "plan-follow-up",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: `queued ${id}`,
    text: `queued ${id}`,
    interactionMode: "plan",
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5",
    },
    runtimeMode: "full-access",
  };
}

export function makeQueuedChatTurn(
  id: string,
  image?: ComposerImageAttachment,
): QueuedComposerTurn {
  return {
    id,
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: `queued chat ${id}`,
    prompt: "queued chat prompt",
    images: image ? [image] : [],
    files: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [makeTerminalContext({ id: `ctx-${id}` })],
    fileComments: [],
    pastedTexts: [],
    skills: [{ name: "check-code", path: "/skills/check-code" }],
    mentions: [{ name: "repo", path: "/mentions/repo" }],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5",
    },
    sourceProposedPlan: {
      threadId: ThreadId.makeUnsafe("thread-source-plan"),
      planId: "plan-1",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

export function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

export function modelSelection(
  provider: ModelSelection["provider"],
  model: string,
  options?: ModelSelection["options"],
): ModelSelection {
  return {
    provider,
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model,
    ...(options ? { options } : {}),
  } as ModelSelection;
}

export function providerModelOptions(options: ProviderModelOptions): ProviderModelOptions {
  return options;
}
