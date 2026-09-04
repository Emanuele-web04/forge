// FILE: resourceMonitor.ts
// Purpose: Orca-parity resource sampler: per-process CPU/RSS attributed to
// terminal sessions, grouped project > worktree, plus kill/disk-scan actions.
// Layer: Server infrastructure (no Effect services; promise API wrapped by wsRpc).

import { availableParallelism } from "node:os";
import path from "node:path";

import type {
  ResourceDiskUsageReport,
  ResourceProcessSnapshot,
  ResourceProjectNode,
  ResourceSnapshot,
  ServerManagedWorktree,
  ThreadId,
} from "@synara/contracts";

import { runProcess } from "./processRunner";
import { redactSensitiveProcessArgs } from "./processArgumentRedaction";
import { defaultProcessTreeKiller } from "./terminal/processTreeKiller";
import type { TerminalActiveSessionDescriptor } from "./terminal/Services/Manager";
import { dropProviderProcess, noteProviderProcessCommand } from "./providerProcessRegistry";

export const RESOURCE_HISTORY_POINTS = 30;
const RESOURCE_SAMPLE_THROTTLE_MS = 5_000;
const RESOURCE_PS_TIMEOUT_MS = 3_000;
const RESOURCE_PS_MAX_BUFFER_BYTES = 8_388_608;
const RESOURCE_MAX_UNATTRIBUTED_PROCESSES = 200;
const RESOURCE_DESCENDANT_WALK_LIMIT = 2_048;
const RESOURCE_KILL_TERM_WAIT_MS = 1_200;
const RESOURCE_KILL_KILL_WAIT_MS = 800;
const RESOURCE_DU_TIMEOUT_MS = 60_000;
const RESOURCE_MAX_SCAN_PATHS = 64;

// ── Sampling ─────────────────────────────────────────────────────────────

export interface ResourceSampledProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly cpuSeconds: number;
  readonly command: string;
  readonly args: string;
}

export interface ResourceSample {
  readonly at: number;
  readonly processes: ResourceSampledProcess[];
}

/**
 * Parse `ps` cumulative CPU time (`[[dd-]hh:]mm:ss[.frac]`) to seconds.
 * Exported for tests.
 */
export function parseCpuTimeSeconds(raw: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!match) return null;
  // Groups are positional: [days, hours, minutes, seconds]. The optional
  // days/hours groups backtrack away for shorter shapes (`mm:ss`), so every
  // present value always lands in the same slot.
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (![days, hours, minutes, seconds].every((value) => Number.isFinite(value) && value >= 0)) {
    return null;
  }
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

/**
 * macOS `comm` truncates argv[0] to 16 chars (`/System/Library/`), so when the
 * full command line starts with the truncated executable the argv token wins.
 * Otherwise `comm` is authoritative (args may hold only flags, e.g. `-l`).
 */
function displayCommand(comm: string, args: string): string {
  const firstToken = /^\s*"([^"]+)"/.exec(args)?.[1] ?? args.trim().split(/\s+/g)[0] ?? "";
  if (comm.length > 0 && firstToken.startsWith(comm)) {
    return firstToken.slice(0, 256);
  }
  return comm.slice(0, 256);
}

/**
 * Parse one full-system `ps -axo pid=,ppid=,rss=,time=,comm=,args=` capture.
 * (`etimes` is intentionally absent: macOS `ps` rejects it, and wall time
 * comes from the capture timestamp instead.) Pure and exported for tests.
 */
export function parseResourceSampleOutput(output: string, at: number): ResourceSample {
  const processes: ResourceSampledProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const rssKb = Number(match[3]);
    const cpuSeconds = parseCpuTimeSeconds(match[4] ?? "");
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rssKb)) continue;
    if (cpuSeconds === null) continue;
    processes.push({
      pid,
      ppid,
      rssBytes: Math.max(0, Math.round(rssKb * 1024)),
      cpuSeconds,
      command: displayCommand(match[5] ?? "", match[6] ?? ""),
      args: redactSensitiveProcessArgs(match[6] ?? "", {
        truncateSensitiveEnvironmentRemainder: true,
      }).slice(0, 1_000),
    });
  }
  return { at, processes };
}

async function captureResourceSample(): Promise<ResourceSample | null> {
  if (process.platform === "win32") return null;
  try {
    const result = await runProcess("ps", ["-axo", "pid=,ppid=,rss=,time=,comm=,args="], {
      timeoutMs: RESOURCE_PS_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: RESOURCE_PS_MAX_BUFFER_BYTES,
      outputMode: "truncate",
    });
    if (result.code !== 0 || result.stdoutTruncated) return null;
    return parseResourceSampleOutput(result.stdout, Date.now());
  } catch {
    return null;
  }
}

/**
 * Delta-based CPU % per pid between two samples over wall-clock elapsed time.
 * Values above 100 indicate multicore usage (same convention as Orca).
 * Exported for tests.
 */
export function computeCpuDeltas(
  previous: ResourceSample | null,
  current: ResourceSample,
): Map<number, number> {
  const deltas = new Map<number, number>();
  if (!previous) return deltas;
  const wallSeconds = (current.at - previous.at) / 1_000;
  if (!(wallSeconds > 0)) return deltas;
  const previousByPid = new Map(previous.processes.map((row) => [row.pid, row.cpuSeconds]));
  for (const row of current.processes) {
    const previousCpu = previousByPid.get(row.pid);
    if (previousCpu === undefined) continue;
    const delta = row.cpuSeconds - previousCpu;
    if (!(delta >= 0)) continue;
    deltas.set(row.pid, Math.round((delta / wallSeconds) * 100 * 10) / 10);
  }
  return deltas;
}

function pushHistoryPoint(histories: Map<string, number[]>, key: string, value: number): number[] {
  const history = histories.get(key) ?? [];
  history.push(Math.round(value * 10) / 10);
  while (history.length > RESOURCE_HISTORY_POINTS) history.shift();
  histories.set(key, history);
  return [...history];
}

// ── Snapshot building (pure) ─────────────────────────────────────────────

export interface ResourceSnapshotAttribution {
  readonly terminals: ReadonlyArray<TerminalActiveSessionDescriptor>;
  readonly worktrees: ReadonlyArray<ServerManagedWorktree>;
  /** Verified provider runtime roots (codex app-server, opencode serve, …). */
  readonly providers?: ReadonlyArray<ResourceProviderAttribution>;
  /** threadId -> worktree path, for provider rows owned by a single thread. */
  readonly threadWorktrees?: ReadonlyMap<string, string>;
}

export interface ResourceProviderAttribution {
  readonly pid: number;
  readonly provider: string;
  readonly threadIds: ReadonlyArray<string>;
  readonly commandBaseline: string | null;
}

/**
 * Keep only roots whose live command still matches the spawn baseline,
 * dropping dead or pid-reused entries from the registry. The first sighting
 * trusts the live command as the baseline (spawn and first sample are seconds
 * apart, so reuse in that window is implausible).
 */
export async function verifyProviderProcessRoots(
  roots: ReadonlyArray<ResourceProviderAttribution>,
): Promise<ResourceProviderAttribution[]> {
  const verified = await Promise.all(
    roots.map(async (root) => {
      const current = await readProcessCommand(root.pid);
      if (current === null) {
        dropProviderProcess(root.pid);
        return null;
      }
      if (root.commandBaseline === null) {
        noteProviderProcessCommand(root.pid, current);
        return root;
      }
      if (current !== root.commandBaseline) {
        dropProviderProcess(root.pid);
        return null;
      }
      return root;
    }),
  );
  return verified.filter((root): root is ResourceProviderAttribution => root !== null);
}

function collectDescendantPids(
  rootPid: number,
  childrenByParent: Map<number, number[]>,
): Set<number> {
  const collected = new Set<number>([rootPid]);
  const stack = [...(childrenByParent.get(rootPid) ?? [])];
  while (stack.length > 0 && collected.size < RESOURCE_DESCENDANT_WALK_LIMIT) {
    const pid = stack.pop()!;
    if (collected.has(pid)) continue;
    collected.add(pid);
    stack.push(...(childrenByParent.get(pid) ?? []));
  }
  return collected;
}

function longestWorktreeMatch(
  cwd: string,
  worktrees: ReadonlyArray<ServerManagedWorktree>,
): ServerManagedWorktree | null {
  let best: ServerManagedWorktree | null = null;
  for (const worktree of worktrees) {
    if (cwd !== worktree.path && !cwd.startsWith(`${worktree.path}/`)) continue;
    if (!best || worktree.path.length > best.path.length) best = worktree;
  }
  return best;
}

/**
 * Build an Orca-shaped snapshot from one sample. Only Synara-owned processes
 * are surfaced: terminal trees plus other descendants of the server process.
 * The server process itself is excluded from display (its RSS is host overhead,
 * already covered by `server.getDiagnostics`). Pure and exported for tests.
 */
export function buildResourceSnapshot(input: {
  readonly sample: ResourceSample;
  readonly cpuDeltas: Map<number, number>;
  readonly attribution: ResourceSnapshotAttribution;
  readonly histories: Map<string, number[]>;
  readonly serverPid: number;
}): ResourceSnapshot {
  const { sample, cpuDeltas, attribution, histories, serverPid } = input;
  const childrenByParent = new Map<number, number[]>();
  for (const row of sample.processes) {
    const siblings = childrenByParent.get(row.ppid) ?? [];
    siblings.push(row.pid);
    childrenByParent.set(row.ppid, siblings);
  }

  const terminalByPid = new Map<number, TerminalActiveSessionDescriptor>();
  for (const terminal of attribution.terminals) {
    if (terminal.pid !== null) terminalByPid.set(terminal.pid, terminal);
  }

  const terminalPids = new Map<number, TerminalActiveSessionDescriptor>();
  for (const terminal of attribution.terminals) {
    if (terminal.pid === null) continue;
    for (const pid of collectDescendantPids(terminal.pid, childrenByParent)) {
      if (!terminalPids.has(pid)) terminalPids.set(pid, terminal);
    }
  }

  // Provider runtime roots (codex app-server, opencode serve, …): claim the
  // root plus its descendant subtree. Terminals win overlaps; the root itself
  // is claimed even when reparented outside the server tree.
  const providerEntries = attribution.providers ?? [];
  const providerClaim = new Map<number, ResourceProviderAttribution>();
  for (const entry of providerEntries) {
    for (const pid of collectDescendantPids(entry.pid, childrenByParent)) {
      if (terminalPids.has(pid)) continue;
      if (!providerClaim.has(pid)) providerClaim.set(pid, entry);
    }
  }

  // Every sampled process owned by Synara: terminal roots, provider roots, and
  // other server descendants.
  const serverTree = collectDescendantPids(serverPid, childrenByParent);
  const owned = sample.processes.filter((row) => {
    if (row.pid === serverPid) return false;
    if (terminalByPid.has(row.pid)) return true;
    if (providerClaim.has(row.pid)) return true;
    return serverTree.has(row.pid);
  });

  const toSnapshot = (
    row: ResourceSampledProcess,
    terminal: TerminalActiveSessionDescriptor | null,
  ): ResourceProcessSnapshot => ({
    pid: row.pid,
    ppid: row.ppid,
    command: row.command.slice(0, 256),
    args: row.args,
    cpuPct: cpuDeltas.get(row.pid) ?? 0,
    rssBytes: row.rssBytes,
    ...(terminal
      ? { terminalId: terminal.terminalId, threadId: terminal.threadId as ThreadId }
      : {}),
  });

  // Mutable builders: Effect Schema output types are deeply readonly, so
  // aggregation happens on these twins and the result is assigned (mutable is
  // assignable to readonly) to the contract types at the end.
  interface ResourceWorktreeBuild {
    path: string;
    name: string;
    cpuPct: number;
    rssBytes: number;
    sessionCount: number;
    history: number[];
    processes: ResourceProcessSnapshot[];
  }
  interface ResourceProjectBuild {
    id: string;
    name: string;
    cpuPct: number;
    rssBytes: number;
    sessionCount: number;
    history: number[];
    worktrees: ResourceWorktreeBuild[];
  }

  const projectById = new Map<string, ResourceProjectBuild>();
  const worktreeNodeByPath = new Map<string, ResourceWorktreeBuild>();
  const getProject = (id: string, name: string): ResourceProjectBuild => {
    let node = projectById.get(id);
    if (!node) {
      node = { id, name, cpuPct: 0, rssBytes: 0, sessionCount: 0, history: [], worktrees: [] };
      projectById.set(id, node);
    }
    return node;
  };
  const getWorktreeNode = (
    project: ResourceProjectBuild,
    wtPath: string,
    wtName: string,
  ): ResourceWorktreeBuild => {
    let node = worktreeNodeByPath.get(`${project.id}${wtPath}`);
    if (!node) {
      node = {
        path: wtPath,
        name: wtName,
        cpuPct: 0,
        rssBytes: 0,
        sessionCount: 0,
        history: [],
        processes: [],
      };
      worktreeNodeByPath.set(`${project.id}${wtPath}`, node);
      project.worktrees.push(node);
    }
    return node;
  };

  const EXTERNAL_PROJECT_ID = "external";
  const PROVIDERS_PROJECT_ID = "providers";
  const threadWorktrees = attribution.threadWorktrees ?? new Map<string, string>();
  let totalCpuPct = 0;
  let totalRssBytes = 0;
  const unattributed: ResourceProcessSnapshot[] = [];

  const placeProviderRow = (
    row: ResourceSampledProcess,
    base: ResourceProcessSnapshot,
    entry: ResourceProviderAttribution,
  ): void => {
    const snapshot: ResourceProcessSnapshot = {
      ...base,
      provider: entry.provider,
      ...(entry.threadIds.length === 1 && entry.threadIds[0]
        ? { threadId: entry.threadIds[0] as ThreadId }
        : {}),
    };
    // Single-owner provider runtimes (one codex app-server per thread) join
    // that thread's worktree; shared/pooled servers land in Providers/Shared.
    const ownerPaths = [
      ...new Set(
        entry.threadIds.flatMap((threadId) => {
          const worktreePath = threadWorktrees.get(threadId);
          return worktreePath ? [worktreePath] : [];
        }),
      ),
    ];
    const match =
      ownerPaths.length === 1 && ownerPaths[0]
        ? longestWorktreeMatch(ownerPaths[0], attribution.worktrees)
        : null;
    const project = match
      ? getProject(match.workspaceRoot, path.basename(match.workspaceRoot) || match.workspaceRoot)
      : getProject(PROVIDERS_PROJECT_ID, "Providers");
    const node = match
      ? getWorktreeNode(project, match.path, path.basename(match.path) || match.path)
      : getWorktreeNode(project, "providers:shared", "Shared");
    node.processes.push(snapshot);
  };

  for (const row of owned) {
    const terminal = terminalPids.get(row.pid) ?? null;
    const snapshot = toSnapshot(row, terminal);
    totalCpuPct += snapshot.cpuPct;
    totalRssBytes += snapshot.rssBytes;
    const providerEntry = terminal ? null : providerClaim.get(row.pid);
    if (providerEntry) {
      placeProviderRow(row, snapshot, providerEntry);
      continue;
    }
    if (!terminal) {
      unattributed.push(snapshot);
      continue;
    }
    const match = longestWorktreeMatch(terminal.cwd, attribution.worktrees);
    const project = match
      ? getProject(match.workspaceRoot, path.basename(match.workspaceRoot) || match.workspaceRoot)
      : getProject(EXTERNAL_PROJECT_ID, "External");
    const node = match
      ? getWorktreeNode(project, match.path, path.basename(match.path) || match.path)
      : getWorktreeNode(project, EXTERNAL_PROJECT_ID, "External");
    node.processes.push(snapshot);
  }

  const unattributedSorted = unattributed
    .toSorted((left, right) => right.rssBytes - left.rssBytes)
    .slice(0, RESOURCE_MAX_UNATTRIBUTED_PROCESSES);

  const builds = [...projectById.values()];
  for (const project of builds) {
    for (const node of project.worktrees) {
      node.processes = node.processes.toSorted((left, right) => right.rssBytes - left.rssBytes);
      node.cpuPct = Math.round(node.processes.reduce((sum, row) => sum + row.cpuPct, 0) * 10) / 10;
      node.rssBytes = node.processes.reduce((sum, row) => sum + row.rssBytes, 0);
      node.sessionCount = new Set(node.processes.map((row) => row.terminalId ?? row.pid)).size;
      node.history = pushHistoryPoint(histories, `worktree:${node.path}`, node.cpuPct);
    }
    project.worktrees = project.worktrees.toSorted((left, right) => right.rssBytes - left.rssBytes);
    project.cpuPct =
      Math.round(project.worktrees.reduce((sum, node) => sum + node.cpuPct, 0) * 10) / 10;
    project.rssBytes = project.worktrees.reduce((sum, node) => sum + node.rssBytes, 0);
    project.sessionCount = project.worktrees.reduce((sum, node) => sum + node.sessionCount, 0);
    project.history = pushHistoryPoint(histories, `project:${project.id}`, project.cpuPct);
  }
  const projects: ResourceProjectNode[] = builds.toSorted(
    (left, right) => right.rssBytes - left.rssBytes,
  );

  const sessionCount = new Set(
    owned.flatMap((row) => {
      const terminal = terminalPids.get(row.pid);
      return terminal ? [terminal.terminalId] : [];
    }),
  ).size;

  return {
    generatedAt: new Date(sample.at).toISOString(),
    totalCpuPct: Math.round(totalCpuPct * 10) / 10,
    totalRssBytes: Math.max(0, Math.round(totalRssBytes)),
    sessionCount,
    orphanCount: unattributedSorted.length,
    projects,
    unattributed: unattributedSorted,
  };
}

// ── Stateful sampler (throttled, idle-sleeping) ───────────────────────────

interface ResourceSamplerState {
  previous: ResourceSample | null;
  histories: Map<string, number[]>;
  lastServed: { at: number; snapshot: ResourceSnapshot } | null;
  lastDemandAt: number;
  inFlight: Promise<ResourceSnapshot> | null;
}

const samplerState: ResourceSamplerState = {
  previous: null,
  histories: new Map(),
  lastServed: null,
  lastDemandAt: 0,
  inFlight: null,
};

/** Test-only reset for the module-level sampler cache. */
export function resetResourceSamplerForTesting(): void {
  samplerState.previous = null;
  samplerState.histories.clear();
  samplerState.lastServed = null;
  samplerState.lastDemandAt = 0;
  samplerState.inFlight = null;
}

const EMPTY_SNAPSHOT: ResourceSnapshot = {
  generatedAt: new Date(0).toISOString(),
  totalCpuPct: 0,
  totalRssBytes: 0,
  sessionCount: 0,
  orphanCount: 0,
  projects: [],
  unattributed: [],
};

/**
 * Serve a snapshot, capturing at most every RESOURCE_SAMPLE_THROTTLE_MS while
 * demanded. CPU deltas need consecutive samples, so the very first capture
 * reports cpuPct 0 and the second (≥5 s later) fills in real values.
 */
export async function sampleResourceSnapshot(
  attribution: ResourceSnapshotAttribution,
): Promise<ResourceSnapshot> {
  const now = Date.now();
  samplerState.lastDemandAt = now;
  if (samplerState.inFlight) return samplerState.inFlight;
  const cached = samplerState.lastServed;
  if (cached && now - cached.at < RESOURCE_SAMPLE_THROTTLE_MS) return cached.snapshot;

  const capture = (async (): Promise<ResourceSnapshot> => {
    const sample = await captureResourceSample();
    if (!sample) {
      // Unsupported platform or failed capture: keep serving the last good
      // snapshot rather than flashing an empty table.
      if (cached) return cached.snapshot;
      return { ...EMPTY_SNAPSHOT, generatedAt: new Date(now).toISOString() };
    }
    const cpuDeltas = computeCpuDeltas(samplerState.previous, sample);
    samplerState.previous = sample;
    const providers = await verifyProviderProcessRoots(attribution.providers ?? []);
    const snapshot = buildResourceSnapshot({
      sample,
      cpuDeltas,
      attribution: { ...attribution, providers },
      histories: samplerState.histories,
      serverPid: process.pid,
    });
    samplerState.lastServed = { at: Date.now(), snapshot };
    return snapshot;
  })();

  samplerState.inFlight = capture;
  try {
    return await capture;
  } finally {
    if (samplerState.inFlight === capture) samplerState.inFlight = null;
  }
}

export function cpuCount(): number {
  try {
    return Math.max(1, availableParallelism());
  } catch {
    return 1;
  }
}

// ── Kill ─────────────────────────────────────────────────────────────────

async function readProcessCommand(pid: number): Promise<string | null> {
  try {
    const result = await runProcess("ps", ["-p", String(pid), "-o", "command="], {
      timeoutMs: 1_000,
      allowNonZeroExit: true,
      maxBufferBytes: 65_536,
      outputMode: "truncate",
    });
    if (result.code !== 0) return null;
    const command = result.stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SIGTERM → verify → SIGKILL a foreign process tree. PID reuse is guarded by
 * command-identity checks (root) and the killer's inspect() (descendants).
 * Refuses the server's own pid and pid ≤ 1.
 */
export async function killResourceProcessTree(
  pid: number,
): Promise<{ pid: number; killed: boolean; message?: string }> {
  if (!Number.isInteger(pid) || pid <= 1) {
    return { pid, killed: false, message: `Refusing to kill pid ${pid}.` };
  }
  if (pid === process.pid) {
    return { pid, killed: false, message: "Refusing to kill the Synara server itself." };
  }
  if (process.platform === "win32") {
    return { pid, killed: false, message: "Process kill is not supported on Windows yet." };
  }
  const rootCommand = await readProcessCommand(pid);
  if (rootCommand === null) {
    return { pid, killed: false, message: "Process already exited." };
  }
  const tree = defaultProcessTreeKiller.capture(pid);
  const errors: Error[] = [];
  defaultProcessTreeKiller.signal({
    rootPid: pid,
    signal: "SIGTERM",
    tree,
    includeRootTree: true,
    onError: (error) => errors.push(error),
  });
  await sleep(RESOURCE_KILL_TERM_WAIT_MS);

  const rootAlive = (await readProcessCommand(pid)) === rootCommand;
  const inspection = defaultProcessTreeKiller.inspect?.(tree) ?? {
    verified: false,
    survivors: tree.descendants,
  };
  let survivors = rootAlive ? [...inspection.survivors] : inspection.survivors;

  if ((rootAlive || survivors.length > 0) && inspection.verified) {
    defaultProcessTreeKiller.signal({
      rootPid: pid,
      signal: "SIGKILL",
      // Re-capture so a reparented tree is signalled by identity, not stale pids.
      tree: defaultProcessTreeKiller.capture(pid),
      includeRootTree: rootAlive,
      onError: (error) => errors.push(error),
    });
    await sleep(RESOURCE_KILL_KILL_WAIT_MS);
    const stillAlive = (await readProcessCommand(pid)) === rootCommand;
    const reinspection = defaultProcessTreeKiller.inspect?.(tree) ?? {
      verified: false,
      survivors: [],
    };
    survivors = stillAlive ? reinspection.survivors : reinspection.survivors;
    if (!stillAlive && reinspection.verified && reinspection.survivors.length === 0) {
      return { pid, killed: true };
    }
    if (!reinspection.verified) {
      return { pid, killed: false, message: "Could not verify process exit." };
    }
    return {
      pid,
      killed: false,
      message:
        survivors.length > 0 || stillAlive
          ? "Some processes survived SIGKILL."
          : "Process exit could not be verified.",
    };
  }

  if (!inspection.verified) {
    return { pid, killed: false, message: "Could not verify process exit." };
  }
  return rootAlive
    ? { pid, killed: false, message: "Process survived SIGTERM." }
    : { pid, killed: true };
}

// ── Disk usage ───────────────────────────────────────────────────────────

export async function measureDirectoryBytes(
  dir: string,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<number | null> {
  if (process.platform === "win32") return null;
  try {
    const result = await runProcess("du", ["-sk", dir], {
      timeoutMs: options?.timeoutMs ?? RESOURCE_DU_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: 65_536,
      outputMode: "truncate",
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    if (result.code !== 0) return null;
    const match = /^(\d+)\s/m.exec(result.stdout);
    if (!match) return null;
    return Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

let activeDiskScan: AbortController | null = null;

/**
 * Bounded, cancelable `du` scan. Latest call wins: a new scan aborts the
 * previous one. Never runs on a timer — on-demand only.
 */
export async function scanResourceDiskUsage(
  paths: readonly string[],
): Promise<ResourceDiskUsageReport> {
  activeDiskScan?.abort();
  const controller = new AbortController();
  activeDiskScan = controller;
  try {
    const unique = [...new Set(paths.filter((value) => value.length > 0))].slice(
      0,
      RESOURCE_MAX_SCAN_PATHS,
    );
    const entries: Array<{ path: string; bytes: number }> = [];
    let totalBytes = 0;
    for (const dir of unique) {
      if (controller.signal.aborted) break;
      const bytes = await measureDirectoryBytes(dir, { signal: controller.signal });
      if (bytes === null) continue;
      entries.push({ path: dir, bytes });
      totalBytes += bytes;
    }
    const sortedEntries = entries.toSorted((left, right) => right.bytes - left.bytes);
    return {
      generatedAt: new Date().toISOString(),
      totalBytes,
      reclaimableBytes: 0,
      entries: sortedEntries,
    };
  } finally {
    if (activeDiskScan === controller) activeDiskScan = null;
  }
}

export function cancelResourceDiskScan(): { cancelled: boolean } {
  if (!activeDiskScan) return { cancelled: false };
  activeDiskScan.abort();
  activeDiskScan = null;
  return { cancelled: true };
}
