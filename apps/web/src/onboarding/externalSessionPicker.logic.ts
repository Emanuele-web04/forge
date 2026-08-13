import type { ProjectId, ServerExternalSessionSummary } from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

export interface SessionProjectTarget {
  readonly id: ProjectId;
  readonly cwd: string;
}

export function filterExternalSessions(
  sessions: ReadonlyArray<ServerExternalSessionSummary>,
  query: string,
): ReadonlyArray<ServerExternalSessionSummary> {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return sessions;
  }
  return sessions.filter((session) => {
    const haystack =
      `${session.title} ${session.firstPrompt ?? ""} ${session.cwd ?? ""} ${session.gitBranch ?? ""}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export function sortExternalSessions(
  sessions: ReadonlyArray<ServerExternalSessionSummary>,
): ReadonlyArray<ServerExternalSessionSummary> {
  return sessions.toSorted(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

export function resolveSessionProjectId(
  session: Pick<ServerExternalSessionSummary, "cwd">,
  projects: ReadonlyArray<SessionProjectTarget>,
): ProjectId | null {
  const cwd = session.cwd?.trim();
  if (!cwd) {
    return null;
  }
  return projects.find((project) => workspaceRootsEqual(project.cwd, cwd))?.id ?? null;
}

export function shortenSessionCwd(cwd: string, homeDir: string | null): string {
  const trimmed = cwd.trim();
  if (!homeDir) {
    return trimmed;
  }
  const normalizedHome = homeDir.replace(/\/+$/u, "");
  if (trimmed === normalizedHome) {
    return "~";
  }
  return trimmed.startsWith(`${normalizedHome}/`)
    ? `~${trimmed.slice(normalizedHome.length)}`
    : trimmed;
}
