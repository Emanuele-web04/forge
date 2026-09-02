// FILE: localServers.ts
// Purpose: Shared presentation helpers for detected local dev servers.
// Layer: Shared runtime utility (consumed by web UI surfaces).
// Depends on: ServerLocalServerProcess contract shape.

import type { ServerLocalServerProcess } from "@synara/contracts";

import { isWorkspaceRootWithin, normalizeWorkspaceRootForComparison } from "./threadWorkspace";

export interface LocalServerRunIdentity {
  readonly pid: number | null;
  readonly cwd: string;
}

/**
 * Human-facing address for a detected local dev server.
 *
 * Every entry the monitor reports is a localhost port, so we always present it
 * as a full "localhost:<port>" rather than echoing back the raw bind host
 * (127.0.0.1, ::1, 0.0.0.0) or — worse — a bare ":<port>". The port is taken
 * from the reliable ports list, falling back to the first usable address port.
 */
export function localServerAddressLabel(server: ServerLocalServerProcess): string {
  const ports = server.ports.length > 0 ? server.ports : firstAddressPort(server);
  if (ports.length === 0) {
    return "localhost";
  }
  return ports.map((port) => `localhost:${port}`).join(", ");
}

/**
 * Primary human-facing label for a detected local dev server: the live page
 * title when one was resolved, otherwise the detected tool/display name.
 */
export function localServerPrimaryLabel(server: ServerLocalServerProcess): string {
  return server.pageTitle ?? server.displayName;
}

/**
 * Short folder label for a local dev server — the final segment of its working
 * directory (e.g. "synara-website" for ".../Developer/synara-website"), or null
 * when the cwd is unknown. The monitor only resolves a cwd on POSIX hosts, but
 * the split tolerates either separator defensively.
 */
export function localServerFolderLabel(server: ServerLocalServerProcess): string | null {
  const cwd = server.cwd?.trim();
  if (!cwd) {
    return null;
  }
  const segments = cwd.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

// Single ownership rule for linking a detected listener to a tracked project run.
// Prefer exact PTY/process lineage, then fall back to cwd containment for tools
// whose listening child obscures the original process id.
export function localServerMatchesRun(
  server: ServerLocalServerProcess,
  run: LocalServerRunIdentity,
): boolean {
  if (run.pid !== null && (server.pid === run.pid || server.ppid === run.pid)) {
    return true;
  }
  return Boolean(server.cwd && isWorkspaceRootWithin(server.cwd, run.cwd));
}

function firstAddressPort(server: ServerLocalServerProcess): readonly number[] {
  for (const address of server.addresses) {
    if (address.port > 0) {
      return [address.port];
    }
  }
  return [];
}

/**
 * Raw bind address for a single port row, Orca-style ("127.0.0.1:53456",
 * "localhost:3000", "[::1]:3000", "*:8000"). Unlike localServerAddressLabel
 * this preserves the bind host because it matters (loopback vs wildcard).
 */
export function formatPortAddress(host: string, port: number): string {
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed === "*") {
    return `*:${port}`;
  }
  if (trimmed.includes(":")) {
    const bare = trimmed.replace(/^\[|\]$/g, "");
    return `[${bare}]:${port}`;
  }
  return `${trimmed}:${port}`;
}

export interface PortProjectSource {
  readonly id: string;
  readonly title: string;
  readonly roots: readonly string[];
}

export interface PortProjectInput {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  // Absent on upstream bases that predate multi-source projects.
  readonly sources?: readonly { readonly path: string }[];
}

/**
 * Maps app projects to attribution sources for port grouping. Roots equal to
 * the server's home directory are dropped: a home-rooted catch-all project
 * (e.g. "Home" ~) would otherwise swallow every user process, while Orca-style
 * semantics only attribute ports under real project folders — the rest is
 * external.
 */
export function toPortProjectSources(
  projects: readonly PortProjectInput[],
  homeDir?: string | null,
): PortProjectSource[] {
  const normalizedHome = homeDir?.trim() ? normalizeWorkspaceRootForComparison(homeDir) : null;
  return projects.map((project) => ({
    id: project.id,
    title: project.title,
    roots: [project.cwd, ...(project.sources ?? []).map((source) => source.path)].filter(
      (root) =>
        root.trim().length > 0 &&
        (normalizedHome === null || normalizeWorkspaceRootForComparison(root) !== normalizedHome),
    ),
  }));
}

export interface ListeningPortRow {
  readonly port: number;
  readonly pid: number;
  readonly displayName: string;
  readonly address: string;
  readonly url: string | null;
  readonly cwd: string | null;
}

export interface ListeningPortGroup {
  readonly projectId: string;
  readonly projectTitle: string;
  readonly rows: readonly ListeningPortRow[];
}

export interface GroupedListeningPorts {
  readonly groups: readonly ListeningPortGroup[];
  readonly external: readonly ListeningPortRow[];
  readonly workspaceCount: number;
  readonly externalCount: number;
  readonly totalCount: number;
}

function portRowAddress(
  server: ServerLocalServerProcess,
  port: number,
): { address: string; url: string | null } {
  const match = server.addresses.find((address) => address.port === port);
  if (!match) {
    return { address: `localhost:${port}`, url: `http://localhost:${port}` };
  }
  return { address: formatPortAddress(match.host, match.port), url: match.url };
}

function findOwningProject(
  cwd: string | null,
  projects: readonly PortProjectSource[],
): PortProjectSource | null {
  if (!cwd) {
    return null;
  }
  // Longest matching root wins so a home-rooted catch-all project never
  // shadows a nested project (e.g. ~/projects/demo beats ~).
  let best: PortProjectSource | null = null;
  let bestLength = -1;
  for (const project of projects) {
    for (const root of project.roots) {
      if (!isWorkspaceRootWithin(cwd, root)) {
        continue;
      }
      const length = normalizeWorkspaceRootForComparison(root).length;
      if (length > bestLength) {
        best = project;
        bestLength = length;
      }
    }
  }
  return best;
}

function comparePortRows(left: ListeningPortRow, right: ListeningPortRow): number {
  return left.port - right.port || left.pid - right.pid;
}

/**
 * Flattens detected servers into one row per port and splits them into
 * workspace groups (by process cwd containment) vs external, Orca-style.
 * Row order follows the monitor's server order; ports within a group sort
 * numerically.
 */
export function groupListeningPorts(
  servers: readonly ServerLocalServerProcess[],
  projects: readonly PortProjectSource[],
): GroupedListeningPorts {
  const groups = new Map<string, { project: PortProjectSource; rows: ListeningPortRow[] }>();
  const external: ListeningPortRow[] = [];

  for (const server of servers) {
    const cwd = server.cwd?.trim() ? (server.cwd as string) : null;
    const owner = findOwningProject(cwd, projects);
    for (const port of server.ports) {
      const { address, url } = portRowAddress(server, port);
      const row: ListeningPortRow = {
        port,
        pid: server.pid,
        displayName: localServerPrimaryLabel(server),
        address,
        url,
        cwd,
      };
      if (owner) {
        const group = groups.get(owner.id) ?? { project: owner, rows: [] };
        group.rows.push(row);
        groups.set(owner.id, group);
      } else {
        external.push(row);
      }
    }
  }

  const grouped: ListeningPortGroup[] = [...groups.values()].map(({ project, rows }) => ({
    projectId: project.id,
    projectTitle: project.title,
    rows: [...rows].toSorted(comparePortRows),
  }));
  const sortedExternal = [...external].toSorted(comparePortRows);
  const workspaceCount = grouped.reduce((total, group) => total + group.rows.length, 0);
  return {
    groups: grouped,
    external: sortedExternal,
    workspaceCount,
    externalCount: sortedExternal.length,
    totalCount: workspaceCount + sortedExternal.length,
  };
}
