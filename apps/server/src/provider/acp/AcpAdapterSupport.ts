/**
 * ACP adapter support - maps protocol errors and approval decisions into DP runtime shapes.
 *
 * @module AcpAdapterSupport
 */
import {
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@synara/contracts";
import { Schema } from "effect";
import * as AcpErrors from "./AcpErrors.ts";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";

export function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "fetch":
      return "web_search";
    case "search":
    default:
      return "dynamic_tool_call";
  }
}

function acpRequestErrorDetail(error: AcpErrors.AcpRequestError): string {
  const message = error.message.trim();
  const data =
    typeof error.data === "object" && error.data !== null
      ? (error.data as Record<string, unknown>)
      : undefined;
  const rawDataDetail = data?.detail ?? data?.details;
  const dataDetail =
    typeof error.data === "string"
      ? error.data.trim()
      : typeof rawDataDetail === "string"
        ? rawDataDetail.trim()
        : "";

  if (dataDetail && /^(?:internal error(?:: agent error)?|agent error)$/iu.test(message)) {
    return dataDetail;
  }
  if (dataDetail && typeof data?.code === "string" && data.code.startsWith("FS_")) {
    return message ? `${message} ${dataDetail}` : dataDetail;
  }
  return message || dataDetail || "ACP request failed.";
}

export function mapAcpToAdapterError(
  provider: ProviderKind,
  _threadId: ThreadId,
  method: string,
  error: AcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(AcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: acpRequestErrorDetail(error),
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

type AcpPermissionOptionLike = {
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  readonly optionId: string;
};

export type AcpPermissionPolicyOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

export function selectAcpPermissionOptionId(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<AcpPermissionOptionLike>,
): string | undefined {
  if (decision === "cancel") {
    return undefined;
  }

  const preferredKinds =
    decision === "acceptForSession"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once", "allow_always"] as const)
        : (["reject_once", "reject_always"] as const);

  for (const kind of preferredKinds) {
    const optionId = options.find((option) => option.kind === kind)?.optionId.trim();
    if (optionId) {
      return optionId;
    }
  }
  return undefined;
}

export function selectAcpFullAccessPermissionOptionId(
  options: ReadonlyArray<AcpPermissionOptionLike>,
): string | undefined {
  // Prefer a request-scoped grant, but Full Access must remain operational for
  // ACP agents that expose only the protocol's persistent allow option. Every
  // supported adapter re-applies its native interaction mode before a turn, and
  // Plan-mode reverse requests are still rejected by resolveAcpPermissionPolicy.
  return selectAcpPermissionOptionId("accept", options);
}

/** Full access never blocks on a human prompt, even if an agent offers no allow option. */
export function resolveAcpFullAccessPermissionOutcome(
  options: ReadonlyArray<AcpPermissionOptionLike>,
): AcpPermissionPolicyOutcome {
  const optionId = selectAcpFullAccessPermissionOptionId(options);
  return optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId };
}

const ACP_PLAN_MODE_INSPECTION_KINDS = new Set(["read", "search", "fetch", "think"]);
const ACP_PLAN_MODE_MUTATING_KINDS = new Set(["execute", "edit", "delete", "move"]);
const ACP_PLAN_MODE_MCP_WRAPPER_NAMES = new Set(["use_tool", "call_mcp_tool", "mcp_tool", "mcp"]);
const ACP_PLAN_MODE_SYNARA_READ_TOOLS = new Set([
  "synara_context",
  "synara_capabilities",
  "synara_overview",
  "synara_list_allowed_projects",
  "synara_list_projects",
  "synara_list_threads",
  "synara_read_thread",
  "synara_read_thread_activity",
  "synara_read_thread_events",
  "synara_read_thread_runtime_events",
  "synara_diagnose_thread",
  "synara_wait_for_threads",
  "synara_wait_for_task",
  "synara_read_task",
  "synara_list_automations",
  "synara_view_automation",
]);
const ACP_PLAN_MODE_SYNARA_WRITE_TOOLS = new Set([
  "synara_create_thread",
  "synara_create_threads",
  "synara_create_task",
  "synara_send_message",
  "synara_interrupt_thread",
  "synara_set_thread_title",
  "synara_set_thread_archived",
  "synara_set_thread_goal",
  "synara_create_automation",
  "synara_update_automation",
  "synara_update_automation_memory",
  "synara_cancel_automation",
  "synara_report_automation_result",
]);

function normalizeAcpPlanToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function canonicalizeAcpPlanToolName(value: string): string {
  let normalized = normalizeAcpPlanToolName(value);
  if (normalized.startsWith("mcp_synara_")) {
    normalized = `synara_${normalized.slice("mcp_synara_".length)}`;
  }
  // Grok MCP exposes Synara tools as `synara__synara_context`.
  while (normalized.startsWith("synara_synara_")) {
    normalized = `synara_${normalized.slice("synara_synara_".length)}`;
  }
  return normalized;
}

function collectAcpPlanToolNameCandidates(value: unknown, depth = 0, into: string[] = []): string[] {
  if (depth > 4 || into.length >= 16 || value == null) {
    return into;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && trimmed.length < 200) into.push(canonicalizeAcpPlanToolName(trimmed));
    return into;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAcpPlanToolNameCandidates(entry, depth + 1, into);
    return into;
  }
  if (typeof value !== "object") {
    return into;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["toolName", "tool_name", "name", "tool", "title"]) {
    if (typeof record[key] === "string") {
      into.push(canonicalizeAcpPlanToolName(record[key]));
    }
  }
  for (const nested of ["input", "rawInput", "arguments", "params", "toolCall", "call"]) {
    if (nested in record) collectAcpPlanToolNameCandidates(record[nested], depth + 1, into);
  }
  return into;
}

export function isAcpPlanModeInspectionToolCall(toolCall: {
  readonly kind?: string | undefined;
  readonly title?: string | null | undefined;
  readonly rawInput?: unknown;
}): boolean {
  const kind = toolCall.kind?.trim().toLowerCase();
  const names = collectAcpPlanToolNameCandidates({
    kind: toolCall.kind,
    title: toolCall.title,
    rawInput: toolCall.rawInput,
  });
  if (names.some((name) => ACP_PLAN_MODE_SYNARA_WRITE_TOOLS.has(name))) {
    return false;
  }
  if (names.some((name) => ACP_PLAN_MODE_SYNARA_READ_TOOLS.has(name))) {
    return true;
  }
  if (names.length > 0 && names.every((name) => ACP_PLAN_MODE_MCP_WRAPPER_NAMES.has(name))) {
    return true;
  }
  if (kind && ACP_PLAN_MODE_INSPECTION_KINDS.has(kind)) {
    return true;
  }
  if (kind && ACP_PLAN_MODE_MUTATING_KINDS.has(kind)) {
    return false;
  }
  return false;
}

/**
 * Applies Synara's turn-scoped permission precedence to ACP reverse requests.
 *
 * `interactionMode: undefined` means that no turn owns the request. Those
 * requests are cancelled so replay or late provider activity cannot inherit a
 * previous Plan turn or a future Full Access turn. Active adapters normalize
 * an omitted turn mode to `default` before dispatching the prompt.
 *
 * Plan mode stays fail-closed for mutating tools. Inspection tools (read,
 * search, fetch, Synara context/MCP reads, and Grok's `use_tool` wrapper)
 * may auto-allow so a Plan turn can look around without treating that as a
 * user rejection.
 */
export function resolveAcpPermissionPolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly options: ReadonlyArray<AcpPermissionOptionLike>;
  readonly toolCall?: {
    readonly kind?: string | undefined;
    readonly title?: string | null | undefined;
    readonly rawInput?: unknown;
  };
}): AcpPermissionPolicyOutcome | undefined {
  if (input.interactionMode === "plan") {
    if (input.toolCall && isAcpPlanModeInspectionToolCall(input.toolCall)) {
      return resolveAcpFullAccessPermissionOutcome(input.options);
    }
    const optionId = selectAcpPermissionOptionId("decline", input.options);
    return optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId };
  }

  if (input.interactionMode === undefined) {
    return { outcome: "cancelled" };
  }

  return input.runtimeMode === "full-access"
    ? resolveAcpFullAccessPermissionOutcome(input.options)
    : undefined;
}

type AcpToolCallLike = {
  readonly status?: string;
  readonly detail?: string | null;
  readonly title?: string | null;
};

// Converts provider-specific failed tool payloads into a stable turn failure message.
export function readAcpFailedToolDetail(toolCall: AcpToolCallLike): string | undefined {
  if (toolCall.status !== "failed") {
    return undefined;
  }

  return toolCall.detail?.trim() || toolCall.title?.trim() || "Tool call failed.";
}

export function classifyAcpPromptTurnCompletion(input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}): { readonly state: "completed" | "cancelled" | "failed"; readonly errorMessage?: string } {
  if (input.stopReason !== "cancelled") {
    return { state: "completed" };
  }

  const failedToolDetail = input.failedToolDetail?.trim();
  if (failedToolDetail) {
    return {
      state: "failed",
      errorMessage: failedToolDetail,
    };
  }

  return { state: "cancelled" };
}
