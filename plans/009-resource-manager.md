# 009 — Resource Manager (Orca parity)

## 0. Context & decisions

- Goal: replicate Orca's "Administrador de recursos" in Synara with full parity:
  header (`total CPU %` + `Σ RSS`), grouped table (`Name | CPU | RSS` + sparkline),
  per-session kill, workspace cleanup, disk-usage scan ("Space Beta"), live summary.
- Worktree: `/Users/usuario/orca/workspaces/synara/resource-manager`
  (branch `synara/resource-manager`, base `nacho/integration` @ `0a0e12dd3`).
- Operator decisions (2026-09-03):
  - Scope = full Orca parity (monitor + kill + workspace cleanup + disk scan).
  - Grouping = Orca-style: project > workspace/worktree > session/pid.
  - UI home = Environment panel (`apps/web/src/components/chat/environment/`),
    new `EnvironmentResourcesSection.tsx` following `EnvironmentLocalServersSection.tsx`.
  - Sampling = always-on background sampler (adaptive cadence, see §4).
- Source findings: Orca ships the feature compiled in
  `/Applications/Orca.app/Contents/Resources/app.asar`
  (`ResourceUsageStatusSegment`, `SessionRow`, `WorktreeRow`,
  `WorkspaceSpaceCompactPanel`, `fetchMemorySnapshot`, `pty.listSessions`);
  nothing equivalent exists in `/Users/usuario/projects/claudex` (only
  worktree-cleanup + `process.kill`, no UI). Synara already has ~70% of the
  server primitives (see §1).

## 1. What already exists (reuse, don't rebuild)

| Need                                     | Existing anchor                                                                                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Child-process snapshot (one `ps`)        | `apps/server/src/terminal/subprocessActivity.ts:100-134` (`inspectSubprocessActivity`, `captureProcessChildrenMap`)                                                                                                                                       |
| Tree kill + PID-reuse guard              | `apps/server/src/terminal/processTreeKiller.ts:62,91,116-181,183-253` (`ps -eo pid,ppid,command` + `tree-kill`); escalation in `terminal/Layers/Manager.ts:1713-1743` (`killProcessWithEscalation`)                                                       |
| Terminal identity (pid/process)          | `apps/server/src/terminal/Services/Manager.ts:32-48`                                                                                                                                                                                                      |
| List/stop pattern (closest UI precedent) | `apps/server/src/localServerMonitor.ts:968-980,996-1038` (`lsof+ps`, `SIGTERM+450ms`, pid/port revalidation)                                                                                                                                              |
| RSS sampler + WS dispatch slot           | `apps/server/src/wsRpc.ts:215-287` (`ps -axo pid,ppid,rss,vsz,comm,args`, `MAX_DIAGNOSTIC_CHILD_PROCESSES:169`), dispatch `wsRpc.ts:1761-1816`, diagnostics `wsRpc.ts:1791-1810`                                                                          |
| Server memory diagnostics (log only)     | `apps/server/src/memoryDiagnostics.ts:45-58,89-117`                                                                                                                                                                                                       |
| Workspace prune (auto, retention 15)     | `apps/server/src/managedWorktrees.ts:332-378`, `scratchWorkspaces.ts:32-54`                                                                                                                                                                               |
| Contracts to extend                      | `packages/contracts/src/server.ts:190-261` (`ServerLocalServerProcess`, `ServerDiagnostics`), `ws.ts:258-265` (server methods), `ws.ts:234-240` (terminal), `ws.ts:305-319,473-480,543-662` (push/bodies), `terminal.ts:96-107,153-171`, `ipc.ts:666-685` |
| Web client plumbing                      | `apps/web/src/wsNativeApi.ts:541-544,713-719,761-812`, `wsTransport.ts:1453-1511`, `lib/serverReactQuery.ts:192-284` (query + stop-mutation pattern)                                                                                                      |
| UI skin to clone                         | `components/chat/environment/EnvironmentLocalServersSection.tsx:133-209` + `EnvironmentRow.tsx`; section registry in `EnvironmentPanel.tsx`                                                                                                               |
| Byte formatting                          | `packages/shared/src/formatBytes.ts:11`                                                                                                                                                                                                                   |

Missing in Synara: CPU % per process, disk-usage scan, manual workspace cleanup
UI, sparklines/history, "orphan/unattributed" grouping.

## 2. Data model (mirrors Orca)

```ts
// packages/contracts/src/server.ts (new)
ResourceProcessSnapshot { pid, ppid, command, cpuPct, rssBytes,
  terminalId?: string, threadId?: string, worktreePath?: string, projectId?: string }
ResourceWorktreeNode { path, name, cpuPct, rssBytes, history: number[], processes: ResourceProcessSnapshot[] }
ResourceProjectNode { id, name, cpuPct, rssBytes, history: number[], worktrees: ResourceWorktreeNode[] }
ResourceSnapshot { totalCpuPct, totalRssBytes, sessionCount, orphanCount,
  projects: ResourceProjectNode[], unattributed: ResourceProcessSnapshot[],
  scannedAt: string }
DiskUsageReport { path, totalBytes, reclaimableBytes, scannedAt, entries: {path, bytes}[] }
```

New WS methods (`packages/contracts/src/ws.ts`, server dispatch in `wsRpc.ts`
next to `serverGetDiagnostics` @ `wsRpc.ts:1784`):
`resource.getSnapshot`, `resource.killSession` (terminalId|pid + confirm client-side),
`resource.cleanWorkspaces` (dry-run returns reclaimable list, then execute),
`resource.killAllSessions` + `resource.restartDaemon` (Orca footer parity, decided 2026-09-03),
`resource.scanDisk` / `resource.cancelDiskScan` (cancelable, see §4).

## 3. Sampling strategy

- **CPU % requires deltas**: sample `ps` twice (or keep previous sample server-side
  and compute delta). Single-shot `ps` gives RSS but not CPU. Keep a server-side
  ring buffer: `prevSample: Map<pid, {utime,stime,at}>`, compute
  `cpuPct = Δticks / Δt / numCpus`. macOS/Linux first via `ps`; Windows later via
  CIM/`windows-process-tree` with 3 s timeout + fallback (see
  `terminal/windowsProcessSnapshot.ts:10`).
- **RSS Σ overcounts** shared pages (same caveat Orca documents: RSS vs WS vs
  Private). Show `Σ RSS` like Orca but footnote it; do not present as exact.
- **Adaptive always-on** (operator chose always-on; repo guardrail forbids a hot
  global loop — `plans/README.md:33-41`): server serves the cached snapshot and
  captures at most every **5 s while demanded** (client polls every **2 s** with
  the section mounted; `RESOURCE_SAMPLE_THROTTLE_MS` in `resourceMonitor.ts`).
  History ring (last 30 points) lives server-side so sparklines survive remount.
- Sampling uses `ps -axo pid=,ppid=,rss=,time=,comm=,args=` + cumulative-`time`
  deltas over wall time. **`etimes` is deliberately absent: macOS `ps` rejects
  it** (verified 2026-09-03 — the whole table misparses otherwise). Display
  command prefers the argv token when it starts with `comm`, because macOS
  truncates `comm` to 16 chars.
- **Disk scan is on-demand only** (never background): bounded `du` per worktree,
  cancelable via AbortController, result cached with `scannedAt`. Scanning disk
  on a timer is an I/O hazard — explicit STOP condition (§6).

## 4. Implementation phases

### Phase A — Contracts (small, no runtime)

1. Add types from §2 to `packages/contracts/src/server.ts` (extend, don't move,
   the `208-261` block).
2. Add method names + zod bodies to `packages/contracts/src/ws.ts:259-265,473-480`;
   extend `terminal.ts:96-107` snapshot with optional `cpuPct/rssBytes`.
3. Tests: `packages/contracts` schema round-trip (`bun run test`).

### Phase B — Server sampler (new `apps/server/src/resourceMonitor.ts`)

1. Reuse `subprocessActivity.ts:119` single-`ps` capture; add delta-based CPU
   (private `prevSample` map) and join with terminal registry
   (`Services/Manager.ts:32-48`) to attribute `terminalId/threadId`.
2. Attribute worktree/project by cwd prefix match against managed worktrees
   (`managedWorktrees.ts`) — non-matching Synara children go to `unattributed`
   (Orca's "Orphan" section).
3. 10 s interval, lazy-start on first subscriber, stop when idle 60 s; keep
   30-point history per node for sparklines.
4. Wire `resource.getSnapshot` in `wsRpc.ts` next to `serverGetDiagnostics`.

### Phase C — Actions (server)

1. `resource.killSession`: route to existing `killProcessWithEscalation`
   (`Layers/Manager.ts:1713-1743`) / `processTreeKiller.ts`; SIGKILL, no undo —
   client must confirm (Orca uses a confirm dialog).
2. `resource.cleanWorkspaces`: dry-run list via `managedWorktrees.ts:332-378` +
   `scratchWorkspaces.ts:32-54` (reclaimable bytes), then delete; protect the
   main worktree (Orca protects `main`).
3. `resource.scanDisk`/`cancelDiskScan`: bounded, cancelable `du` per worktree;
   cache result; enforce timeout + ownership check before delete actions.
4. `resource.killAllSessions`: iterate live sessions, confirm dialog with count
   client-side, reuse the same killer + PID-reuse revalidation as (1).
5. `resource.restartDaemon`: tear down + respawn provider app-servers via the
   existing supervised teardown path (`provider/supervisedProcessTeardown.ts:83-159`);
   double-confirm client-side; never touches the Synara server process itself.
   Executor resolves the exact supervisor boundary against `providerManager.ts` /
   `codexAppServerManager.ts` before implementing.

### Phase D — Web UI (Environment panel)

1. New `EnvironmentResourcesSection.tsx` (+ `.browser.tsx` if the panel requires
   the browser split — check `EnvironmentPanel.tsx` registry first):
   header row (total CPU + Σ RSS + session count, `formatBytes`), grouped
   collapsible rows project > worktree > session with SVG sparkline polyline
   (48×14 like Orca), per-session kill `X`, sort toggle (name/cpu/rss).
2. Footer: "Clean up workspaces" (dry-run modal → confirm), orphan row
   ("End N orphan terminals", "Kill all sessions" with count + confirm),
   "Restart daemon" (double-confirm, danger styling).
3. "Space Beta" sub-panel: Scan / Refresh / Cancel + Review (opens the
   dry-run/detail modal, same pattern as the cleanup modal — decided 2026-09-03),
   shows Scanned / Freeable / Updated + `reclaimableBytes`.
4. Data via `lib/serverReactQuery.ts` (new `resourceSnapshotQueryOptions` +
   kill/clean/scan mutations, cloned from `serverLocalServersQueryOptions`
   @ `serverReactQuery.ts:192-284`); reuse `EnvironmentRow` skin and the
   disclosure motion module for all toggles (repo UI convention).
5. Reuse `LocalServerIdentity`-style labeling for session rows; kill button is
   the only red accent (match `LocalServersSection` row discipline).

### Phase E — Verification

- `bun run test` per touched package (never bare `bun test`).
- Focused suites: contracts schema, `resourceMonitor` sampler math (delta CPU
  with fake `ps` fixtures), killer dry-run, React Query options.
- Final pass only if requested: `bun fmt && bun lint && bun typecheck`
  (heavyweight; per `AGENTS.md` run once at the end, not per phase).
- Manual: open Environment panel, verify 2 s refresh, kill a disposable
  terminal, dry-run workspace cleanup, start + cancel a disk scan.

## 5. Risks

- RSS Σ double-counts shared memory (display caveat, same as Orca).
- CPU % is imprecise at 2 s sampling; deltas smooth but lag on short spikes.
- `ps`/`lsof` cost under many processes — single capture per tick, cap rows
  (`MAX_DIAGNOSTIC_CHILD_PROCESSES` precedent @ `wsRpc.ts:169`).
- Kill is destructive without undo; confirmations + main-worktree protection.
- Disk scan I/O load: on-demand, bounded, cancelable; never on the hot loop.
- Windows support deferred: `ps`-based sampler first, CIM path later.

## 6. STOP conditions

- Do not run disk scan on a timer or at startup — on-demand only.
- Do not add a ≤1 s global sampler loop (repo perf guardrail).
- Do not kill without client-side confirmation or without PID-reuse revalidation
  (`processTreeKiller.ts:160-181`).
- Do not put runtime logic in `packages/contracts` (schema-only package).

## 7. Decided (2026-09-03)

- "Kill all sessions" + "Restart daemon" are IN scope (full Orca footer parity).
- "Review" (Space Beta) opens the dry-run/detail modal, same pattern as the
  workspace-cleanup modal.
- Sort default: by RSS desc (Orca sorts by memory).
- Provider attribution (follow-up): write-only `providerProcessRegistry`
  (pid → provider + threadIds + command baseline, lazy liveness prune, no
  lifecycle hooks). Codex app-servers register per-thread in
  `attachProcessListeners` → join their thread's worktree. Pooled opencode
  servers register without owners (`OpenCodeServerProcess.pid`) → land in a
  `Providers/Shared` bucket, never orphan. Other adapters stay orphaned
  (status quo, no regression).
