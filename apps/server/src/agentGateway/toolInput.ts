import {
  DEFAULT_MODEL_BY_PROVIDER,
  SynaraCreateThreadsInput,
  SynaraWaitForThreadsInput,
  type ModelSelection,
  type ProviderKind,
} from "@synara/contracts";
import { Schema } from "effect";

import { AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION } from "./targetResolver.ts";

export const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "opencode",
  "pi",
];

export const MODEL_SELECTION_INPUT_SCHEMA = {
  type: "object",
  description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  properties: {
    provider: { type: "string", enum: [...PROVIDER_KINDS] },
    model: {
      type: "string",
      description: "Exact model slug from synara_capabilities providers[].models[].slug.",
    },
    options: {
      type: "object",
      description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
    },
  },
  required: ["provider", "model"],
  additionalProperties: false,
} as const;

export class ToolInputError extends Error {}

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options?.required) throw new ToolInputError(`Missing required argument "${name}".`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`Argument "${name}" must be a non-empty string.`);
  }
  return value.trim();
}

export function readNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`Argument "${name}" must be a number.`);
  }
  return value;
}

export function readBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolInputError(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

export function readIsoTimestampArg(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = readStringArg(args, name);
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ToolInputError(`Argument "${name}" must be a valid ISO timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

export function readRecordArg(
  args: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function readStringArrayArg(
  args: Record<string, unknown>,
  name: string,
): ReadonlyArray<string> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new ToolInputError(`Argument "${name}" must be an array of non-empty strings.`);
  }
  return value.map((entry) => (entry as string).trim());
}

export function parseProviderKind(raw: string): ProviderKind {
  if ((PROVIDER_KINDS as ReadonlyArray<string>).includes(raw)) {
    return raw as ProviderKind;
  }
  throw new ToolInputError(
    `Unknown provider "${raw}". Supported providers: ${PROVIDER_KINDS.join(", ")}.`,
  );
}

export function buildModelSelection(
  provider: ProviderKind,
  model: string | undefined,
): ModelSelection {
  const effectiveModel =
    model ??
    (provider === "pi"
      ? undefined
      : DEFAULT_MODEL_BY_PROVIDER[provider as Exclude<ProviderKind, "pi">]);
  if (!effectiveModel) {
    throw new ToolInputError(
      `Provider "${provider}" has no default model; pass an explicit "model" argument.`,
    );
  }
  return { provider, model: effectiveModel } as ModelSelection;
}

export function decodeCreateThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(SynaraCreateThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Synara creation plan: ${errorText(error)}`);
  }
}

export function decodeWaitForThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(SynaraWaitForThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Synara wait request: ${errorText(error)}`);
  }
}
