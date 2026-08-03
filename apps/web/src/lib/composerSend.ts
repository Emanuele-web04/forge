// FILE: composerSend.ts
// Purpose: Shared composer send helpers for attachment intake, prompt formatting, and upload payloads.
// Layer: Web composer utility
// Depends on: provider/model contracts plus composer draft attachment shapes.

import {
  type ChatFileAttachment,
  type ChatImageAttachment,
  MessageId,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type ClaudeCodeEffort,
  type ProviderKind,
  type UploadChatAttachment,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { applyClaudePromptEffortPrefix, getModelCapabilities } from "@synara/shared/model";

import {
  cloneComposerImageAttachment,
  type ComposerAssistantSelectionAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type PersistedComposerImageAttachment,
} from "../composerDraftDomain";
import { readComposerImageBlob } from "./composerImageBlobStore";
import {
  ComposerImagePreparationError,
  prepareComposerImageFile,
} from "./composerImagePreparation";
import { normalizeComposerImageSource } from "./composerImageSource";
import { randomUUID } from "./utils";
import { resolveWsHttpUrl } from "./wsHttpUrl";

const ATTACHMENT_CANCEL_CONCURRENCY = 2;
const ATTACHMENT_CANCEL_BODY_MAX_BYTES = 512;

export { cloneComposerImageAttachment };
export { effectiveComposerAttachmentCount } from "./composerAttachmentCapacity";

export const FILE_SIZE_LIMIT_LABEL = `${Math.round(
  PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024),
)}MB`;

export interface ComposerImageBuildResult {
  images: ComposerImageAttachment[];
  error: string | null;
}

export interface ComposerFileBuildResult {
  files: ComposerFileAttachment[];
  error: string | null;
}

function composerImageAttachmentFromFile(file: File): ComposerImageAttachment {
  return {
    type: "image",
    id: randomUUID(),
    name: file.name || "image",
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  };
}

// Centralizes the shared file/count/size guard while each attachment type maps its own draft shape.
function collectComposerAttachmentFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
  maxBytes: number;
  sizeLimitLabel: string;
  acceptsFile: (file: File) => boolean;
  unsupportedFileError?: (file: File) => string | null;
}): { files: File[]; error: string | null } {
  const files: File[] = [];
  let nextAttachmentCount = input.existingAttachmentCount;
  let error: string | null = null;

  for (const file of input.files) {
    if (!input.acceptsFile(file)) {
      error = input.unsupportedFileError?.(file) ?? error;
      continue;
    }
    if (file.size > input.maxBytes) {
      error = `'${file.name}' exceeds the ${input.sizeLimitLabel} attachment limit.`;
      continue;
    }
    if (nextAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`;
      break;
    }

    files.push(file);
    nextAttachmentCount += 1;
  }

  return { files, error };
}

/**
 * Asynchronous image intake for every user-facing composer entry point. Count
 * checks happen before decoding, and accepted files are optimized one at a time
 * to avoid concurrent full-resolution canvas allocations.
 */
export async function prepareComposerImageAttachmentsFromFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
}): Promise<ComposerImageBuildResult> {
  const images: ComposerImageAttachment[] = [];
  let error: string | null = null;

  for (const file of input.files) {
    if (!file.type.startsWith("image/")) {
      error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
      continue;
    }
    if (input.existingAttachmentCount + images.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`;
      break;
    }
    try {
      images.push(composerImageAttachmentFromFile(await prepareComposerImageFile(file)));
    } catch (cause) {
      error =
        cause instanceof ComposerImagePreparationError
          ? cause.message
          : `Synara could not prepare '${file.name || "image"}'.`;
    }
  }

  return { images, error };
}

// Converts non-image File objects into in-memory file attachment drafts.
export function buildComposerFileAttachmentsFromFiles(input: {
  files: readonly File[];
  existingAttachmentCount: number;
}): ComposerFileBuildResult {
  const result = collectComposerAttachmentFiles({
    files: input.files,
    existingAttachmentCount: input.existingAttachmentCount,
    maxBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    sizeLimitLabel: FILE_SIZE_LIMIT_LABEL,
    acceptsFile: (file) => !file.type.startsWith("image/"),
  });

  const files = result.files.map<ComposerFileAttachment>((file) => ({
    type: "file",
    id: randomUUID(),
    name: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    file,
  }));

  return { files, error: result.error };
}

// Draft persistence and previews still need a local data URL. Network sends use
// the bounded binary upload path below and never place this value on RPC.
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read attachment data."));
    });
    reader.addEventListener("error", () => {
      const nativeMessage =
        reader.error instanceof Error && reader.error.message.trim().length > 0
          ? reader.error.message
          : null;
      if (
        nativeMessage &&
        /could not be found at the time an operation was processed/i.test(nativeMessage)
      ) {
        reject(
          new Error(
            `Could not read '${file.name || "item"}'. Paths with spaces or special characters may need a path mention (@\"…\") instead of a file attachment.`,
          ),
        );
        return;
      }
      reject(reader.error ?? new Error("Failed to read attachment."));
    });
    reader.readAsDataURL(file);
  });
}

// Provider-specific prompt massaging. Claude prompt-injected efforts must be
// applied before filtering skill/mention references and before dispatch.
export function formatOutgoingComposerPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  effort: string | null;
  text: string;
}): string {
  const caps = getModelCapabilities(params.provider, params.model);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}

export function resolvePromptEffortFromModelSelection(
  modelSelection: ModelSelection,
): string | null {
  switch (modelSelection.provider) {
    case "antigravity":
      return null;
    case "codex":
      return modelSelection.options?.reasoningEffort ?? null;
    case "claudeAgent":
      return modelSelection.options?.effort ?? null;
    case "cursor":
      return modelSelection.options?.reasoningEffort ?? null;
    case "grok":
    case "droid":
      return modelSelection.options?.reasoningEffort ?? null;
    case "pi":
      return modelSelection.options?.thinkingLevel ?? null;
    case "kilo":
    case "opencode":
      return null;
  }
}

export interface StagedComposerAttachments {
  readonly attachments: UploadChatAttachment[];
  /** Marks an accepted dispatch as authoritative. Cleanup becomes a no-op. */
  readonly commit: () => void;
  /** Best-effort compensation for a rejected/abandoned dispatch. Never rejects. */
  readonly cleanup: () => Promise<void>;
  /** Runs dispatch with commit-on-success and cleanup-on-failure semantics. */
  readonly runWithDispatch: <A>(
    dispatch: (attachments: UploadChatAttachment[]) => Promise<A>,
  ) => Promise<A>;
}

function isManagedAttachmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z0-9_-]+$/i.test(value)
  );
}

async function cancelManagedAttachments(attachmentIds: readonly string[]): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < attachmentIds.length) {
      const attachmentId = attachmentIds[nextIndex];
      nextIndex += 1;
      if (!attachmentId) continue;
      const body = JSON.stringify({ attachmentId });
      if (new TextEncoder().encode(body).byteLength > ATTACHMENT_CANCEL_BODY_MAX_BYTES) continue;
      try {
        await fetch(resolveWsHttpUrl(ATTACHMENT_CANCEL_ROUTE_PATH), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body,
        });
      } catch {
        // Staged attachments also have a server-owned expiry. Compensation is
        // deliberately best-effort and must never replace the dispatch/upload error.
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(ATTACHMENT_CANCEL_CONCURRENCY, attachmentIds.length) }, () =>
      worker(),
    ),
  );
}

export async function stageUploadComposerAttachments(input: {
  threadId: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files?: ReadonlyArray<ComposerFileAttachment>;
  assistantSelections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
}): Promise<StagedComposerAttachments> {
  const attachments: UploadChatAttachment[] = input.assistantSelections.map((selection) => ({
    type: "assistant-selection" as const,
    assistantMessageId: MessageId.makeUnsafe(selection.assistantMessageId),
    text: selection.text,
  }));

  // Upload sequentially so selecting several maximum-size files never creates a
  // burst of concurrent body buffers. The RPC turn then carries only short ids.
  const managedAttachmentIds: string[] = [];
  try {
    for (const attachment of [...input.images, ...(input.files ?? [])]) {
      const params = new URLSearchParams({
        threadId: input.threadId,
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
      });
      const response = await fetch(
        resolveWsHttpUrl(`${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`),
        {
          method: "POST",
          credentials: "include",
          body: attachment.file,
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | ChatImageAttachment
        | ChatFileAttachment
        | { readonly error?: unknown }
        | null;
      if (!response.ok || !payload || !("id" in payload) || !isManagedAttachmentId(payload.id)) {
        const message =
          payload && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `Attachment upload failed with status ${response.status}.`;
        throw new Error(message);
      }
      managedAttachmentIds.push(payload.id);
      attachments.push(payload);
    }
  } catch (error) {
    await cancelManagedAttachments(managedAttachmentIds);
    throw error;
  }

  let disposition: "pending" | "committed" | "cleaned" = "pending";
  const cleanup = async () => {
    if (disposition !== "pending") return;
    disposition = "cleaned";
    await cancelManagedAttachments(managedAttachmentIds);
  };
  const commit = () => {
    if (disposition === "pending") disposition = "committed";
  };
  const runWithDispatch = async <A>(
    dispatch: (dispatchAttachments: UploadChatAttachment[]) => Promise<A>,
  ): Promise<A> => {
    try {
      const result = await dispatch(attachments);
      commit();
      return result;
    } catch (error) {
      await cleanup();
      throw error;
    }
  };

  return { attachments, commit, cleanup, runWithDispatch };
}

// Compatibility wrapper for callers that have not yet adopted the explicit
// commit/cleanup lifecycle. Sequential upload failure compensation still applies.
export async function buildUploadComposerAttachments(input: {
  threadId: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  files?: ReadonlyArray<ComposerFileAttachment>;
  assistantSelections: ReadonlyArray<ComposerAssistantSelectionAttachment>;
}): Promise<UploadChatAttachment[]> {
  return (await stageUploadComposerAttachments(input)).attachments;
}

/**
 * Persisted image attachments that still back a blob (AppSnap captures) but
 * have not yet hydrated into the live `images` array. Right after a reload,
 * `AppSnapCoordinator` hydrates these asynchronously from IndexedDB; sending
 * before that finishes must not silently drop them.
 */
export function findPendingBlobComposerAttachments(input: {
  persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
}): PersistedComposerImageAttachment[] {
  const hydratedImageIds = new Set(input.images.map((image) => image.id));
  return input.persistedAttachments.filter(
    (attachment) => Boolean(attachment.blobKey) && !hydratedImageIds.has(attachment.id),
  );
}

/**
 * Reads pending blob-backed persisted attachments (see
 * `findPendingBlobComposerAttachments`) from IndexedDB and reconstructs them
 * as live `ComposerImageAttachment`s so a send in flight can include them.
 * An attachment whose blob is missing or fails to read is skipped rather than
 * failing the whole send — the caller keeps sending whatever did hydrate.
 */
export async function hydratePendingBlobComposerAttachments(
  pending: ReadonlyArray<PersistedComposerImageAttachment>,
): Promise<ComposerImageAttachment[]> {
  const hydrated = await Promise.all(
    pending.map(async (attachment): Promise<ComposerImageAttachment | null> => {
      if (!attachment.blobKey) return null;
      try {
        const file = await readComposerImageBlob(attachment.blobKey);
        if (!file) return null;
        const source = normalizeComposerImageSource(attachment.source);
        return {
          type: "image",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          previewUrl: URL.createObjectURL(file),
          file,
          ...(source ? { source } : {}),
        };
      } catch (error) {
        console.warn("[composer-send] Could not hydrate a pending attachment before send", error);
        return null;
      }
    }),
  );
  return hydrated.filter((image): image is ComposerImageAttachment => image !== null);
}
