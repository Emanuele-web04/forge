import type { CanonicalItemType, RuntimeItemStatus } from "@synara/contracts";

import { isCodexGeneratedImageItemType } from "../codexGeneratedImages.ts";

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeItemType(raw: unknown): string {
  const type = asString(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: unknown): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (isCodexGeneratedImageItemType(raw)) return "image_generation";
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered") || type.includes("entered review")) return "review_entered";
  if (type.includes("review exited") || type.includes("exited review")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

export function codexItemStatus(
  lifecycle: "item.started" | "item.updated" | "item.completed",
  rawStatus: unknown,
): RuntimeItemStatus | undefined {
  if (lifecycle === "item.started") {
    return "inProgress";
  }
  if (lifecycle === "item.updated") {
    return undefined;
  }
  return rawStatus === "failed" || rawStatus === "declined" ? rawStatus : "completed";
}

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_generation":
      return "Generated image";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function joinedTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const object = asObject(entry);
      return asString(object?.text) ?? asString(object?.summary);
    })
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function reasoningSummaryDetail(item: Record<string, unknown>): string | undefined {
  return asString(item.summary)?.trim() || joinedTextParts(item.summary);
}

export function itemDetail(
  item: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | undefined {
  const nestedResult = asObject(item.result);
  const candidates = [
    asString(item.command),
    asString(item.title),
    asString(item.summary),
    joinedTextParts(item.summary),
    joinedTextParts(item.content),
    asString(item.review),
    asString(item.text),
    asString(item.saved_path),
    asString(item.savedPath),
    asString(item.path),
    asString(item.file_path),
    asString(item.prompt),
    asString(nestedResult?.command),
    asString(payload.command),
    asString(payload.message),
    asString(payload.prompt),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    return trimmed;
  }
  return undefined;
}
