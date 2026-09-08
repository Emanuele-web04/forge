// FILE: codexGeneratedImages.ts
// Purpose: Normalizes Codex generated-image events into durable local-file references.
// Layer: Server provider utilities
// Exports: Codex image path, payload sanitization, and markdown helpers
// Depends on: node path/os, image MIME allowlist, provider runtime artifact contract

import path from "node:path";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
  CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
  type CodexGeneratedImageArtifact,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@synara/contracts";
import { isSupportedLocalImagePath as isSupportedLocalImagePathShared } from "@synara/shared/localPreviewFiles";

import {
  resolveActiveCodexHomeWritePath,
  resolveCodexHomeAllowlistCandidates,
} from "./codexHomePaths.ts";

export { CODEX_GENERATED_IMAGE_ARTIFACT_KIND, CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN };

const CODEX_GENERATED_IMAGE_ITEM_TYPES = new Set([
  "imagegeneration",
  "imagegenerationcall",
  "imagegenerationend",
]);

const CODEX_GENERATED_IMAGE_EVENT_METHODS = new Set([
  "codex/event/image_generation_end",
  "image_generation_end",
]);

const IMAGE_PATH_KEYS = ["saved_path", "savedPath", "path", "file_path"] as const;
const IMAGE_CALL_ID_KEYS = ["call_id", "callId", "itemId", "item_id", "id"] as const;

export interface CodexGeneratedImageReference {
  readonly path: string;
  readonly callId?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeNonEmptyString(value: unknown): string | undefined {
  const trimmed = asString(value)?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCodexGeneratedImageItemType(raw: unknown): string {
  const type = normalizeNonEmptyString(raw);
  if (!type) return "";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1$2")
    .replace(/[._\s/-]+/g, "")
    .trim()
    .toLowerCase();
}

export function isCodexGeneratedImageItemType(raw: unknown): boolean {
  return CODEX_GENERATED_IMAGE_ITEM_TYPES.has(normalizeCodexGeneratedImageItemType(raw));
}

export const isSupportedLocalImagePath = isSupportedLocalImagePathShared;

/**
 * Resolves the home directory the codex app-server child process actually
 * writes images under for the current process env. Synara uses its isolated
 * Codex overlay, not the user's source `~/.codex` directory.
 */
export function resolveCodexHomePath(homePath?: string): string {
  return resolveActiveCodexHomeWritePath(homePath?.trim() ? { homePath } : {});
}

/** The single generated-images directory we predict against (overlay-aware). */
export function resolveCodexGeneratedImagesRoot(homePath?: string): string {
  return path.join(resolveCodexHomePath(homePath), "generated_images");
}

/**
 * All generated-images directories the local-image route should treat as
 * legitimate. Includes both the source `~/.codex/generated_images` and the
 * overlay `<SYNARA_HOME>/codex-home-overlay/generated_images` so we serve
 * images regardless of which home Codex wrote them under.
 */
export function resolveCodexGeneratedImagesRoots(homePath?: string): readonly string[] {
  const homes = resolveCodexHomeAllowlistCandidates(homePath?.trim() ? { homePath } : {});
  return homes.map((home) => path.join(home, "generated_images"));
}

export function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = normalizeNonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

export function extractCodexGeneratedImagePath(
  record: Record<string, unknown> | undefined,
): string | undefined {
  return firstStringValue(record, IMAGE_PATH_KEYS);
}

export function extractCodexGeneratedImageCallId(
  record: Record<string, unknown> | undefined,
): string | undefined {
  return firstStringValue(record, IMAGE_CALL_ID_KEYS);
}

export function predictedCodexGeneratedImagePath(input: {
  readonly item: Record<string, unknown>;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHomePath?: string;
}): string | undefined {
  const threadId = normalizeNonEmptyString(input.threadId);
  const callId = extractCodexGeneratedImageCallId(input.item);
  if (!threadId || !callId) {
    return undefined;
  }
  return path.join(resolveCodexGeneratedImagesRoot(input.codexHomePath), threadId, `${callId}.png`);
}

// Mirrors Remodex relay behavior: keep metadata, drop bulky inline image data.
export function annotateCodexGeneratedImagePayload(input: {
  readonly value: unknown;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHomePath?: string;
}): unknown {
  const item = asObject(input.value);
  if (!item || !isCodexGeneratedImageItemType(item.type ?? item.kind)) {
    return input.value;
  }

  let nextItem = item;
  let didChange = false;
  const existingPath = extractCodexGeneratedImagePath(item);
  const generatedPath =
    existingPath ??
    predictedCodexGeneratedImagePath({
      item,
      threadId: input.threadId,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
    });

  if (generatedPath && !existingPath) {
    nextItem = { ...nextItem, saved_path: generatedPath };
    didChange = true;
  }

  if (typeof nextItem.result === "string" && nextItem.result.length > 0) {
    const { result: _result, ...withoutResult } = nextItem;
    nextItem = { ...withoutResult, result_elided_for_relay: true };
    didChange = true;
  }

  return didChange ? nextItem : input.value;
}

export function sanitizeNestedCodexGeneratedImagePayloads(input: {
  readonly value: unknown;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHomePath?: string;
}): unknown {
  const annotated = annotateCodexGeneratedImagePayload(input);
  const record = asObject(annotated);
  if (!record) {
    return annotated;
  }

  // Collect any nested replacements first, then build the result with a single
  // Object.assign to avoid the O(n^2) spread-in-loop pattern oxlint flags.
  const overrides: Record<string, unknown> = {};
  let hasOverrides = false;
  for (const key of NESTED_PAYLOAD_KEYS) {
    const nested = record[key];
    if (!asObject(nested)) {
      continue;
    }
    const sanitized = sanitizeNestedCodexGeneratedImagePayloads({
      value: nested,
      threadId: input.threadId,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
    });
    if (sanitized !== nested) {
      overrides[key] = sanitized;
      hasOverrides = true;
    }
  }

  if (hasOverrides) {
    return Object.assign({}, record, overrides);
  }
  return annotated !== input.value ? record : input.value;
}

const NESTED_PAYLOAD_KEYS = ["item", "payload", "data", "event"] as const;

export function extractCodexGeneratedImageReference(input: {
  readonly value: unknown;
  readonly threadId: ThreadId | string | undefined;
  readonly codexHomePath?: string;
}): CodexGeneratedImageReference | undefined {
  const item = asObject(input.value);
  if (!item || !isCodexGeneratedImageItemType(item.type ?? item.kind)) {
    return undefined;
  }
  const imagePath =
    extractCodexGeneratedImagePath(item) ??
    predictedCodexGeneratedImagePath({
      item,
      threadId: input.threadId,
      ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
    });
  if (!imagePath || !isSupportedLocalImagePath(imagePath)) {
    return undefined;
  }
  const callId = extractCodexGeneratedImageCallId(item);
  return {
    path: imagePath,
    ...(callId ? { callId } : {}),
  };
}

export function codexGeneratedImageArtifact(
  reference: CodexGeneratedImageReference,
): CodexGeneratedImageArtifact {
  return {
    kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
    origin: CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
    path: reference.path,
    ...(reference.callId ? { callId: reference.callId } : {}),
  };
}

export function isCodexGeneratedImageArtifact(
  value: unknown,
): value is CodexGeneratedImageArtifact {
  const record = asObject(value);
  return (
    record?.kind === CODEX_GENERATED_IMAGE_ARTIFACT_KIND &&
    typeof record.path === "string" &&
    record.path.trim().length > 0
  );
}

export function isTrustedCodexGeneratedImageArtifact(
  value: unknown,
): value is CodexGeneratedImageArtifact & {
  readonly origin: typeof CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN;
} {
  return (
    isCodexGeneratedImageArtifact(value) && value.origin === CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN
  );
}

function legacyRuntimeEventProvesExplicitImageGeneration(event: ProviderRuntimeEvent): boolean {
  if (CODEX_GENERATED_IMAGE_EVENT_METHODS.has(event.raw?.method ?? "")) {
    return true;
  }

  const payload = asObject(event.raw?.payload);
  const candidates = [
    payload,
    asObject(payload?.item),
    asObject(payload?.msg),
    asObject(payload?.event),
    asObject(payload?.payload),
    asObject(payload?.data),
  ];
  return candidates.some(
    (candidate) =>
      candidate !== undefined && isCodexGeneratedImageItemType(candidate.type ?? candidate.kind),
  );
}

/**
 * Adds durable provenance to a legacy image-generation event when its raw
 * Codex payload still proves that the provider emitted an explicit generation
 * item. Unmarked events without that evidence stay untrusted.
 */
export function markTrustedCodexGeneratedImageRuntimeEvent(
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent {
  if (
    event.provider !== "codex" ||
    event.type !== "item.completed" ||
    event.payload.itemType !== "image_generation" ||
    !isCodexGeneratedImageArtifact(event.payload.data) ||
    isTrustedCodexGeneratedImageArtifact(event.payload.data) ||
    !legacyRuntimeEventProvesExplicitImageGeneration(event)
  ) {
    return event;
  }

  return {
    ...event,
    payload: {
      ...event.payload,
      data: {
        ...event.payload.data,
        origin: CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
      },
    },
  };
}

export function markdownImagePath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.includes(")") || trimmed.includes(" ") || trimmed.includes("%")) {
    const escaped = trimmed.replaceAll("%", "%25").replaceAll(">", "%3E").replaceAll(")", "%29");
    return `<${escaped}>`;
  }
  return trimmed;
}

export function generatedImageMarkdown(filePath: string): string {
  return `![Generated image](${markdownImagePath(filePath)})`;
}

/**
 * Returns the local file path of a Codex-generated image carried by an
 * `item.completed` runtime event, or `undefined` for any other event shape.
 */
export function generatedImagePathFromRuntimeEvent(
  event: ProviderRuntimeEvent,
): string | undefined {
  if (
    event.provider !== "codex" ||
    event.type !== "item.completed" ||
    event.payload.itemType !== "image_generation"
  ) {
    return undefined;
  }
  const normalizedEvent = markTrustedCodexGeneratedImageRuntimeEvent(event);
  if (normalizedEvent.type !== "item.completed") {
    return undefined;
  }
  const artifact = isTrustedCodexGeneratedImageArtifact(normalizedEvent.payload.data)
    ? normalizedEvent.payload.data
    : undefined;
  return artifact?.path;
}
