// FILE: providerProcessRegistry.ts
// Purpose: Write-only registry mapping provider runtime pids (codex app-server,
// opencode serve) to the threads that own them, so the resource manager can
// attribute provider processes to project > worktree nodes instead of orphan.
// Layer: Server infrastructure (plain singleton; no Effect services).
//
// Entries are never explicitly unregistered: dead pids are pruned lazily by
// liveness checks, and pid reuse is guarded by command-identity baselines
// verified in resourceMonitor before attribution.

export interface RegisteredProviderProcess {
  readonly pid: number;
  /** Display label for the provider runtime (e.g. "codex", "OpenCode"). */
  readonly provider: string;
  /** Owning thread ids. Empty for shared/pooled servers with unknown owners. */
  readonly threadIds: ReadonlyArray<string>;
  /** Full command captured at spawn or first sight; null until observed. */
  readonly commandBaseline: string | null;
  readonly registeredAt: number;
}

interface MutableRegisteredProviderProcess {
  pid: number;
  provider: string;
  threadIds: string[];
  commandBaseline: string | null;
  registeredAt: number;
}

const MAX_REGISTERED_PROVIDER_PROCESSES = 64;

const entries = new Map<number, MutableRegisteredProviderProcess>();

export function registerProviderProcess(input: {
  readonly pid: number;
  readonly provider: string;
  readonly threadIds?: ReadonlyArray<string>;
  readonly commandBaseline?: string | null;
}): void {
  if (!Number.isInteger(input.pid) || input.pid <= 1) return;
  if (input.provider.trim().length === 0) return;
  entries.set(input.pid, {
    pid: input.pid,
    provider: input.provider,
    threadIds: [...(input.threadIds ?? [])],
    commandBaseline: input.commandBaseline ?? null,
    registeredAt: Date.now(),
  });
  while (entries.size > MAX_REGISTERED_PROVIDER_PROCESSES) {
    const oldest = [...entries.values()].reduce((left, right) =>
      left.registeredAt <= right.registeredAt ? left : right,
    );
    entries.delete(oldest.pid);
  }
}

export function dropProviderProcess(pid: number): void {
  entries.delete(pid);
}

/** Test-only seam for recording the first-sight command baseline. */
export function noteProviderProcessCommand(pid: number, command: string): void {
  const entry = entries.get(pid);
  if (entry && entry.commandBaseline === null && command.length > 0) {
    entry.commandBaseline = command;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs existence/permission checks without signalling.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process. EPERM = exists but not signallable: alive.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

/** List entries, lazily dropping dead pids. */
export function listRegisteredProviderProcesses(): RegisteredProviderProcess[] {
  const live: RegisteredProviderProcess[] = [];
  for (const entry of entries.values()) {
    if (!isPidAlive(entry.pid)) {
      entries.delete(entry.pid);
      continue;
    }
    live.push({
      pid: entry.pid,
      provider: entry.provider,
      threadIds: [...entry.threadIds],
      commandBaseline: entry.commandBaseline,
      registeredAt: entry.registeredAt,
    });
  }
  return live;
}

/** Test-only reset. */
export function resetProviderProcessRegistryForTesting(): void {
  entries.clear();
}
