import fs from "node:fs/promises";
import nodePath from "node:path";

import type {
  ExternalSessionProvider,
  ProjectId,
  ServerExternalProjectCandidate,
  ServerExternalSessionSummary,
  ServerListExternalProjectCandidatesResult,
  ServerListExternalSessionsInput,
  ServerListExternalSessionsResult,
} from "@synara/contracts";
import { EXTERNAL_SESSIONS_DEFAULT_LIMIT } from "@synara/contracts";
import {
  isScratchWorkspacePath,
  isWorkspaceRootWithin,
  normalizeWorkspaceRootForComparison,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";
import { Effect } from "effect";

import { resolveBaseCodexHomePath } from "./codexHomePaths";
import { ServerConfig } from "./config";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk";
import { listRecentCodexSessionFiles, mapWithConcurrency, safeStat } from "./providerUsageSnapshot";
import { ServerSettingsService } from "./serverSettings";

const EXTERNAL_SESSIONS_CACHE_TTL_MS = 30_000;
const EXTERNAL_SESSIONS_SCAN_LIMIT = 500;
const EXTERNAL_SESSION_HEAD_BYTES = 131_072;
const EXTERNAL_SESSION_FIRST_PROMPT_MAX_LENGTH = 500;
const EXTERNAL_SESSION_READ_CONCURRENCY = 16;
const EXTERNAL_PROJECT_CANDIDATES_MAX = 100;

interface CachedExternalSessions {
  expiresAtMs: number;
  value: ReadonlyArray<ServerExternalSessionSummary>;
  pending: Promise<ReadonlyArray<ServerExternalSessionSummary>> | null;
}

const externalSessionsCache = new Map<string, CachedExternalSessions>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return undefined;
}

function truncateFirstPrompt(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > EXTERNAL_SESSION_FIRST_PROMPT_MAX_LENGTH
    ? collapsed.slice(0, EXTERNAL_SESSION_FIRST_PROMPT_MAX_LENGTH)
    : collapsed;
}

function isExcludedSessionCwd(cwd: string | undefined, worktreesDir: string): boolean {
  if (!cwd) {
    return false;
  }
  return (
    isWorkspaceRootWithin(cwd, worktreesDir, { platform: process.platform }) ||
    isScratchWorkspacePath(cwd)
  );
}

async function scanClaudeExternalSessions(input: {
  worktreesDir: string;
  cwd?: string;
}): Promise<ReadonlyArray<ServerExternalSessionSummary>> {
  const { listSessions } = await loadClaudeAgentSdk();
  const sessions = await listSessions({
    ...(input.cwd ? { dir: input.cwd } : {}),
    limit: EXTERNAL_SESSIONS_SCAN_LIMIT,
    includeProgrammatic: false,
  });

  const summaries: ServerExternalSessionSummary[] = [];
  for (const session of sessions) {
    const sessionId = asTrimmedString(session.sessionId);
    if (!sessionId) {
      continue;
    }
    const cwd = asTrimmedString(session.cwd);
    if (isExcludedSessionCwd(cwd, input.worktreesDir)) {
      continue;
    }
    const firstPrompt = asTrimmedString(session.firstPrompt);
    const title =
      asTrimmedString(session.customTitle) ??
      asTrimmedString(session.summary) ??
      firstPrompt ??
      sessionId;
    const createdAt = toIsoTimestamp(session.createdAt);
    const updatedAt = toIsoTimestamp(session.lastModified);
    if (!updatedAt) {
      continue;
    }
    summaries.push({
      provider: "claudeAgent",
      sessionId,
      title: truncateFirstPrompt(title),
      ...(firstPrompt ? { firstPrompt: truncateFirstPrompt(firstPrompt) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(asTrimmedString(session.gitBranch)
        ? { gitBranch: asTrimmedString(session.gitBranch) }
        : {}),
      ...(createdAt ? { createdAt } : {}),
      updatedAt,
      ...(typeof session.fileSize === "number" && session.fileSize >= 0
        ? { fileSizeBytes: Math.round(session.fileSize) }
        : {}),
    });
  }
  return summaries;
}

export async function readCodexSessionHead(
  path: string,
): Promise<ServerExternalSessionSummary | null> {
  const stats = await safeStat(path);
  if (!stats) {
    return null;
  }

  let head: string;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path, "r");
    const buffer = Buffer.alloc(Math.min(EXTERNAL_SESSION_HEAD_BYTES, stats.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const lines = head.split(/\r?\n/u);
  if (stats.size > EXTERNAL_SESSION_HEAD_BYTES && lines.length > 1) {
    lines.pop();
  }

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let firstPrompt: string | undefined;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) {
      continue;
    }
    const payload = asRecord(record.payload);
    if (record.type === "session_meta" && payload) {
      sessionId = asTrimmedString(payload.id) ?? sessionId;
      cwd = asTrimmedString(payload.cwd) ?? cwd;
      createdAt = toIsoTimestamp(payload.timestamp ?? record.timestamp) ?? createdAt;
      continue;
    }
    if (
      firstPrompt === undefined &&
      record.type === "event_msg" &&
      payload?.type === "user_message"
    ) {
      const message = asTrimmedString(payload.message);
      if (message) {
        firstPrompt = truncateFirstPrompt(message);
      }
    }
    if (sessionId && firstPrompt) {
      break;
    }
  }

  if (!sessionId) {
    return null;
  }

  return {
    provider: "codex",
    sessionId,
    title: firstPrompt ?? sessionId,
    ...(firstPrompt ? { firstPrompt } : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAt ? { createdAt } : {}),
    updatedAt: new Date(stats.mtimeMs).toISOString(),
    fileSizeBytes: Math.max(0, Math.round(stats.size)),
  };
}

export async function scanCodexExternalSessions(input: {
  worktreesDir: string;
  homePath?: string;
}): Promise<ReadonlyArray<ServerExternalSessionSummary>> {
  const sessionsRoot = nodePath.join(
    resolveBaseCodexHomePath(process.env, input.homePath),
    "sessions",
  );
  const files = await listRecentCodexSessionFiles(sessionsRoot);
  const heads = await mapWithConcurrency(
    files,
    EXTERNAL_SESSION_READ_CONCURRENCY,
    readCodexSessionHead,
  );
  return heads.filter(
    (head): head is ServerExternalSessionSummary =>
      head !== null && !isExcludedSessionCwd(head.cwd, input.worktreesDir),
  );
}

async function scanExternalSessions(input: {
  provider: ExternalSessionProvider;
  worktreesDir: string;
  cwd?: string;
  homePath?: string;
}): Promise<ReadonlyArray<ServerExternalSessionSummary>> {
  const scan =
    input.provider === "claudeAgent"
      ? scanClaudeExternalSessions({
          worktreesDir: input.worktreesDir,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        })
      : scanCodexExternalSessions({
          worktreesDir: input.worktreesDir,
          ...(input.homePath ? { homePath: input.homePath } : {}),
        });
  const sessions = await scan.catch(() => [] as ReadonlyArray<ServerExternalSessionSummary>);
  return sessions.toSorted(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

async function getCachedExternalSessions(input: {
  provider: ExternalSessionProvider;
  worktreesDir: string;
  cwd?: string;
  homePath?: string;
  forceRefresh?: boolean;
}): Promise<ReadonlyArray<ServerExternalSessionSummary>> {
  const cacheKey = [
    input.provider,
    input.worktreesDir,
    input.cwd?.trim() ?? "",
    input.homePath?.trim() ?? "",
    process.env.CLAUDE_CONFIG_DIR?.trim() ?? "",
  ].join(":");
  const nowMs = Date.now();
  const existing = externalSessionsCache.get(cacheKey);

  if (existing && !input.forceRefresh && existing.expiresAtMs > nowMs) {
    return existing.value;
  }
  if (existing?.pending) {
    return existing.pending;
  }

  const pending = scanExternalSessions(input).then((value) => {
    externalSessionsCache.set(cacheKey, {
      expiresAtMs: Date.now() + EXTERNAL_SESSIONS_CACHE_TTL_MS,
      value,
      pending: null,
    });
    return value;
  });

  externalSessionsCache.set(cacheKey, {
    expiresAtMs: existing?.expiresAtMs ?? 0,
    value: existing?.value ?? [],
    pending,
  });

  return pending;
}

async function listExternalSessionsPage(input: {
  request: ServerListExternalSessionsInput;
  worktreesDir: string;
}): Promise<ServerListExternalSessionsResult> {
  const sessions = await getCachedExternalSessions({
    provider: input.request.provider,
    worktreesDir: input.worktreesDir,
    ...(input.request.cwd ? { cwd: input.request.cwd } : {}),
    ...(input.request.homePath ? { homePath: input.request.homePath } : {}),
    ...(input.request.forceRefresh !== undefined
      ? { forceRefresh: input.request.forceRefresh }
      : {}),
  });
  const offset = input.request.offset ?? 0;
  const limit = input.request.limit ?? EXTERNAL_SESSIONS_DEFAULT_LIMIT;
  return {
    sessions: sessions.slice(offset, offset + limit),
    hasMore: sessions.length > offset + limit,
  };
}

export async function buildProjectCandidates(input: {
  sessions: ReadonlyArray<ServerExternalSessionSummary>;
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  directoryExists: (path: string) => Promise<boolean>;
}): Promise<ServerListExternalProjectCandidatesResult> {
  interface CandidateGroup {
    workspaceRoot: string;
    providers: Set<ExternalSessionProvider>;
    sessionCount: number;
    lastActiveAtMs: number;
  }

  const groups = new Map<string, CandidateGroup>();
  for (const session of input.sessions) {
    if (!session.cwd) {
      continue;
    }
    const key = normalizeWorkspaceRootForComparison(session.cwd, {
      platform: process.platform,
    });
    if (!key) {
      continue;
    }
    const updatedAtMs = Date.parse(session.updatedAt);
    const activeAtMs = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
    const existing = groups.get(key);
    if (existing) {
      existing.providers.add(session.provider);
      existing.sessionCount += 1;
      if (activeAtMs > existing.lastActiveAtMs) {
        existing.lastActiveAtMs = activeAtMs;
        existing.workspaceRoot = session.cwd;
      }
      continue;
    }
    groups.set(key, {
      workspaceRoot: session.cwd,
      providers: new Set([session.provider]),
      sessionCount: 1,
      lastActiveAtMs: activeAtMs,
    });
  }

  const orderedGroups = [...groups.values()].toSorted(
    (left, right) => right.lastActiveAtMs - left.lastActiveAtMs,
  );

  const candidates: ServerExternalProjectCandidate[] = [];
  for (const group of orderedGroups) {
    if (candidates.length >= EXTERNAL_PROJECT_CANDIDATES_MAX) {
      break;
    }
    if (!(await input.directoryExists(group.workspaceRoot))) {
      continue;
    }
    const existingProject = input.projects.find((project) =>
      workspaceRootsEqual(project.workspaceRoot, group.workspaceRoot, {
        platform: process.platform,
      }),
    );
    candidates.push({
      workspaceRoot: group.workspaceRoot,
      providers: [...group.providers],
      sessionCount: group.sessionCount,
      lastActiveAt: new Date(group.lastActiveAtMs).toISOString(),
      existingProjectId: existingProject?.id ?? null,
    });
  }

  return { candidates };
}

async function aggregateProjectCandidates(input: {
  worktreesDir: string;
  codexHomePath?: string;
  forceRefresh?: boolean;
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
}): Promise<ServerListExternalProjectCandidatesResult> {
  const [claudeSessions, codexSessions] = await Promise.all([
    getCachedExternalSessions({
      provider: "claudeAgent",
      worktreesDir: input.worktreesDir,
      ...(input.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
    }),
    getCachedExternalSessions({
      provider: "codex",
      worktreesDir: input.worktreesDir,
      ...(input.codexHomePath ? { homePath: input.codexHomePath } : {}),
      ...(input.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
    }),
  ]);

  return buildProjectCandidates({
    sessions: [...claudeSessions, ...codexSessions],
    projects: input.projects,
    directoryExists: async (path) => (await safeStat(path))?.isDirectory() === true,
  });
}

export const listExternalSessions = Effect.fn(function* (input: ServerListExternalSessionsInput) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const homePath =
    input.provider === "codex" ? (input.homePath ?? settings.providers.codex.homePath) : undefined;
  return yield* Effect.promise(() =>
    listExternalSessionsPage({
      request: homePath ? { ...input, homePath } : input,
      worktreesDir: serverConfig.worktreesDir,
    }).catch((): ServerListExternalSessionsResult => ({ sessions: [], hasMore: false })),
  );
});

export const listExternalProjectCandidates = Effect.fn(function* (input: {
  readonly forceRefresh?: boolean;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
}) {
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const codexHomePath = settings.providers.codex.homePath;
  return yield* Effect.promise(() =>
    aggregateProjectCandidates({
      worktreesDir: serverConfig.worktreesDir,
      ...(codexHomePath ? { codexHomePath } : {}),
      ...(input.forceRefresh !== undefined ? { forceRefresh: input.forceRefresh } : {}),
      projects: input.projects,
    }).catch((): ServerListExternalProjectCandidatesResult => ({ candidates: [] })),
  );
});
