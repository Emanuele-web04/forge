// FILE: subagentPresentation.ts
// Purpose: Normalizes subagent identity, nickname colors, and status labels for sidebar/chat UI.
// Exports: Shared presentation helpers consumed by sidebar rows, chat cards, and thread hydration.

import {
  buildSubagentIdentityDirectory,
  extractSubagentIdentityHints as extractParsedSubagentIdentityHints,
  isWorkerTierSubagentRole,
  resolveSubagentIdentityFromDirectory,
} from "@synara/shared/subagents";
import { formatModelDisplayName } from "@synara/shared/model";

const SUBAGENT_ACCENT_PALETTE = [
  "#b84e44",
  "#2f7a5d",
  "#345fa8",
  "#a86834",
  "#7352a8",
  "#2f7480",
  "#a84d71",
  "#6a8531",
] as const;

const GENERIC_SUBAGENT_TITLES = new Set([
  "",
  "agent",
  "chat",
  "child thread",
  "conversation",
  "new chat",
  "new conversation",
  "new thread",
  "subagent",
  "thread",
]);

export type SubagentStatusKind = "running" | "completed" | "failed" | "stopped" | "queued" | "idle";

export interface SubagentPresentation {
  primaryLabel: string;
  nickname: string | null;
  role: string | null;
  title: string | null;
  fullLabel: string;
  accentColor: string;
}

type SubagentThreadActivityLike = {
  payload?: unknown;
};

type SubagentThreadLike = {
  id: string;
  title?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  subagentAgentId?: string | null | undefined;
  subagentNickname?: string | null | undefined;
  subagentRole?: string | null | undefined;
  activities?: ReadonlyArray<SubagentThreadActivityLike> | undefined;
};

const subagentIdentityDirectoryByActivities = new WeakMap<
  ReadonlyArray<SubagentThreadActivityLike>,
  ReturnType<typeof buildSubagentIdentityDirectory>
>();

function basename(value: string): string {
  const slashIndex = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return slashIndex >= 0 ? value.slice(slashIndex + 1) : value;
}

function fallbackSubagentLabel(value: string | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith("subagent:")) {
    const segments = normalized.split(":").filter((segment) => segment.length > 0);
    return segments.at(-1) ?? normalized;
  }

  return basename(normalized);
}

function normalizeWhitespace(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeRole(role: string | null | undefined): string | null {
  const normalized = normalizeWhitespace(role);
  return normalized ? normalized.toLowerCase() : null;
}

// Worker-tier agent types are internal effort carriers; never surface them as a
// role even when persisted thread metadata or titles still contain them.
function suppressWorkerTierRole(role: string | null): string | null {
  return role !== null && isWorkerTierSubagentRole(role) ? null : role;
}

function isGenericSubagentTitle(title: string | null): boolean {
  if (!title) {
    return true;
  }
  const normalized = title.trim().toLowerCase();
  return GENERIC_SUBAGENT_TITLES.has(normalized) || normalized.startsWith("subagent ");
}

function parseBracketedSubagentLabel(label: string | null): {
  nickname: string | null;
  role: string | null;
} {
  if (!label) {
    return { nickname: null, role: null };
  }

  const match = /^(.*?)\s*\[([^\]]+)\]$/.exec(label.trim());
  if (!match) {
    return { nickname: null, role: null };
  }

  return {
    nickname: normalizeWhitespace(match[1]),
    role: normalizeRole(match[2]),
  };
}

function capitalizeRoleLabel(role: string | null): string | null {
  if (!role) {
    return null;
  }
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerThreadIdForThread(input: {
  threadId: string;
  parentThreadId: string | null;
}): string {
  const threadId = normalizeWhitespace(input.threadId) ?? input.threadId;
  const parentThreadId = normalizeWhitespace(input.parentThreadId);
  if (!parentThreadId) {
    return threadId;
  }
  const prefix = `subagent:${parentThreadId}:`;
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : threadId;
}

function resolveSubagentIdentityFromParentActivity(input: {
  thread: Pick<SubagentThreadLike, "id" | "parentThreadId" | "subagentAgentId">;
  threads: ReadonlyArray<SubagentThreadLike>;
}): {
  nickname: string | null;
  role: string | null;
} | null {
  const parentThreadId = normalizeWhitespace(input.thread.parentThreadId);
  if (!parentThreadId) {
    return null;
  }

  const parentThread = input.threads.find((thread) => thread.id === parentThreadId);
  if (!parentThread) {
    return null;
  }

  const activities = parentThread.activities ?? [];
  const identityDirectory =
    subagentIdentityDirectoryByActivities.get(activities) ??
    (() => {
      const nextDirectory = buildSubagentIdentityDirectory(
        activities.flatMap((activity) => {
          const root = asRecord(activity?.payload);
          const data = asRecord(root?.data);
          const item = asRecord(data?.item) ?? data ?? root;
          return item ? extractParsedSubagentIdentityHints(item) : [];
        }),
      );
      subagentIdentityDirectoryByActivities.set(activities, nextDirectory);
      return nextDirectory;
    })();
  const resolved = resolveSubagentIdentityFromDirectory(identityDirectory, {
    providerThreadId: providerThreadIdForThread({
      threadId: input.thread.id,
      parentThreadId,
    }),
    agentId: input.thread.subagentAgentId ?? null,
  });

  if (!resolved) {
    return null;
  }

  return {
    nickname: normalizeWhitespace(resolved.nickname),
    role: normalizeRole(resolved.role),
  };
}

function hashLabelSeed(seed: string): number {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function subagentAccentColor(seed: string | null | undefined): string {
  const normalized = normalizeWhitespace(seed)?.toLowerCase() ?? "subagent";
  const index = hashLabelSeed(normalized) % SUBAGENT_ACCENT_PALETTE.length;
  return SUBAGENT_ACCENT_PALETTE[index] ?? SUBAGENT_ACCENT_PALETTE[0];
}

export function resolveSubagentPresentation(input: {
  nickname?: string | null | undefined;
  role?: string | null | undefined;
  title?: string | null | undefined;
  fallbackId?: string | null | undefined;
}): SubagentPresentation {
  const explicitNickname = normalizeWhitespace(input.nickname);
  const explicitRole = suppressWorkerTierRole(normalizeRole(input.role));
  const normalizedTitle = normalizeWhitespace(input.title);
  const parsedTitle = parseBracketedSubagentLabel(normalizedTitle);
  const parsedTitleRole = suppressWorkerTierRole(parsedTitle.role);
  // Titles persisted as "Nickname [worker-low]" drop the worker-tier suffix.
  const titleWithoutWorkerRole =
    parsedTitle.role !== null && parsedTitleRole === null ? parsedTitle.nickname : normalizedTitle;
  const parsedTitleNickname = isGenericSubagentTitle(parsedTitle.nickname)
    ? null
    : parsedTitle.nickname;
  const titleLabel = isGenericSubagentTitle(titleWithoutWorkerRole) ? null : titleWithoutWorkerRole;
  const nickname = explicitNickname ?? parsedTitleNickname;
  const role = explicitRole ?? parsedTitleRole;
  const resolvedTitle = parsedTitleNickname ? null : titleLabel;
  const normalizedFallbackId = normalizeWhitespace(input.fallbackId);
  const fallbackLabel = fallbackSubagentLabel(normalizedFallbackId) ?? "Subagent";
  const primaryLabel = nickname ?? resolvedTitle ?? capitalizeRoleLabel(role) ?? fallbackLabel;
  const fullLabel = role && nickname ? `${nickname} [${role}]` : primaryLabel;

  return {
    primaryLabel,
    nickname,
    role,
    title: resolvedTitle,
    fullLabel,
    accentColor: subagentAccentColor(nickname ?? primaryLabel),
  };
}

export function resolveSubagentPresentationForThread(input: {
  thread: Pick<
    SubagentThreadLike,
    "id" | "title" | "parentThreadId" | "subagentAgentId" | "subagentNickname" | "subagentRole"
  >;
  threads?: ReadonlyArray<SubagentThreadLike> | undefined;
}): SubagentPresentation {
  const derivedIdentity =
    input.threads && input.thread.parentThreadId
      ? resolveSubagentIdentityFromParentActivity({
          thread: input.thread,
          threads: input.threads,
        })
      : null;

  return resolveSubagentPresentation({
    nickname: input.thread.subagentNickname ?? derivedIdentity?.nickname,
    role: input.thread.subagentRole ?? derivedIdentity?.role,
    title: input.thread.title,
    fallbackId: input.thread.id,
  });
}

export function normalizeSubagentStatusKind(
  status: string | null | undefined,
  isActive = false,
): SubagentStatusKind | null {
  if (isActive) {
    return "running";
  }

  const normalized = status?.trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
  if (!normalized || normalized === "unknown") {
    return null;
  }

  if (
    normalized === "running" ||
    normalized === "working" ||
    normalized === "in progress" ||
    normalized === "inprogress" ||
    normalized === "active"
  ) {
    return "running";
  }
  if (
    normalized === "completed" ||
    normalized === "done" ||
    normalized === "finished" ||
    normalized === "success" ||
    normalized === "succeeded"
  ) {
    return "completed";
  }
  if (
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "errored" ||
    normalized === "failure"
  ) {
    return "failed";
  }
  if (
    normalized === "stopped" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "interrupted" ||
    normalized === "aborted"
  ) {
    return "stopped";
  }
  if (
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "waiting" ||
    normalized === "starting"
  ) {
    return "queued";
  }
  if (normalized === "idle") {
    return "idle";
  }

  return null;
}

export function humanizeSubagentStatus(
  status: string | null | undefined,
  isActive = false,
): string | undefined {
  const normalized = normalizeSubagentStatusKind(status, isActive);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    case "queued":
      return "Queued";
    case "idle":
      return "Idle";
  }
}

// Short form for agent rows: the "Claude " prefix is redundant next to a
// model name ("Haiku 4.5" reads as well as "Claude Haiku 4.5" and halves the
// label), and non-Claude names pass through unchanged.
export function formatSubagentModelLabel(model: string | null | undefined): string | undefined {
  const displayName = formatModelDisplayName(normalizeWhitespace(model));
  return displayName?.startsWith("Claude ") ? displayName.slice("Claude ".length) : displayName;
}

// Status is the only hue in the agent panels: the dot always carries it, the
// text echoes it only while live (running) or when something went wrong
// (failed); terminal/neutral states read as plain muted text.
export function subagentStatusTextToneClassName(
  statusKind: SubagentStatusKind | null | undefined,
): string {
  switch (statusKind) {
    case "running":
      return "text-sky-300/85";
    case "failed":
      return "text-rose-300/85";
    default:
      return "text-muted-foreground/55";
  }
}

export function subagentStatusDotClassName(
  statusKind: SubagentStatusKind | null | undefined,
): string {
  switch (statusKind) {
    case "running":
      return "bg-sky-300/95";
    case "completed":
      return "bg-emerald-300/80";
    case "failed":
      return "bg-rose-300/90";
    case "stopped":
      return "bg-amber-300/85";
    case "queued":
      return "bg-violet-300/80";
    default:
      return "bg-muted-foreground/25";
  }
}
