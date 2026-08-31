# Thread runtime and ChatView performance audit

Date: 2026-08-08/09  
Machine: MacBook Pro (Mac17,2), Apple M5 (4 performance + 6 efficiency cores), 32 GB RAM  
OS: macOS 26.6 (25G72)  
Runtime: Bun 1.3.12, Node 24.13.0, Electron 40.10.6, React 19, Vite 8.1.5

Temperature was observed only as context. CPU, RSS/physical footprint, JavaScript
heap, process count, frame timing, long tasks, DOM size, and durable poll frequency
are the benchmark signals.

## Architecture and attribution boundary

- Electron owns one main process, one primary browser renderer, Chromium GPU/utility
  processes, and one Synara backend child. These are application infrastructure,
  not one process per thread.
- A provider session normally owns an external provider process tree. Codex uses one
  `codex app-server` tree per provider session; Claude and ACP providers have similar
  per-session ownership. OpenCode may share a ref-counted local server.
- Provider events cross the boundary through stdio, are durably journaled before
  publication, projected into orchestration events, and delivered through
  thread-scoped WebSocket streams.
- PTYs are created only when a terminal is opened. Their output is bounded and
  coalesced; a shared process-tree monitor polls every second while active and every
  eight seconds while idle, and stops when no PTY remains.
- Normal completion deliberately keeps a provider runtime warm for ten minutes.
  Cancellation, archive, delete, and application shutdown use immediate teardown.
  Switching threads does not stop a background provider or PTY.
- The web client retains up to 32 recently used thread details for 15 minutes, with
  no more than eight server detail leases. Inactive views are not all mounted, but
  those bounded warm leases still filter the shared event stream.

CPU and RSS reported for `codex`, `claude`, `opencode`, or another provider child
belong to that provider. Synara's additional cost is its Electron/backend process
set, process-retention policy, provider event parsing/journaling/projection,
WebSocket fanout, renderer work, PTY monitoring, and persistence.

## Reproduction

The transcript harness renders the real `ChatTranscriptPane` with representative
Markdown, code blocks, tool rows, and a streaming final message:

```sh
cd apps/web
bunx vite --host 127.0.0.1
# Open /perf/?messages=1000&working=1

# Production harness (output is written under the OS temporary directory)
bunx vite build --config perf/vite.config.ts
bunx vite preview --config perf/vite.config.ts --host 127.0.0.1 --port 63912
# Open /perf/?messages=1000&working=1
```

The page exposes `window.__synaraPerf.snapshot()`, `resetMetrics()`,
`scrollCycle(count)`, and `appendStreamingChunks(count)`. A cycle performs a
scripted bottom-to-top-to-bottom stress pass aligned to animation frames.

An isolated development instance used a separate database and ports:

```sh
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=4117 SYNARA_NO_BROWSER=1 \
  bun run dev -- --home-dir ./.synara-perf-audit --port 59231
```

The direct/provider-through comparison used this equivalent task:

```text
Run sleep 15 in the shell, then respond with exactly PONG.
```

The journal SQL-shape comparison is self-contained:

```sh
cd apps/server
bun run perf/providerRuntimeJournalAppend.bench.ts
```

Process readings use `ps`; native samples use macOS `sample` and `vmmap`.
Development-mode numbers include React diagnostics, Vite/HMR, source transforms,
and Bun, and must not be substituted for packaged-build measurements.

## Baseline runtime matrix

| Scenario                                             | Synara CPU / memory                                                                           | Provider CPU / memory                                                              | Processes                                                               | Renderer/frame evidence                                                    | Observation                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged app, existing workload                      | Main 0.4% / 77 MB; server transient 7.9% / 178 MB; renderer 26.7% / 284 MB; GPU 25.8% / 48 MB | Two retained Claude children: 152 MB and 230 MB; 0.1-0.2% each                     | Electron main + server + renderer/GPU/helpers + provider trees          | Five-second renderer sample showed about 14% main-thread activity          | Uncontrolled snapshot; it shows renderer/GPU work can dominate while provider CPU is low.                                                                                                                                                                                                             |
| Packaged backend, five-second sample                 | 269 MB physical, 387 MB peak; 4,110/4,211 main-thread samples in `kevent`                     | Not included                                                                       | One Synara backend                                                      | n/a                                                                        | The observed 7.9% was transient, not sustained backend CPU.                                                                                                                                                                                                                                           |
| Isolated dev, idle before changes                    | 0.3% / 93 MB server RSS after warm-up                                                         | One retained provider tree at 24 MB at the sampled instant                         | Backend + one warm provider pair; Vite/contracts are dev-only           | n/a                                                                        | Fixed journal fallback still performed four SQLite safety polls per second.                                                                                                                                                                                                                           |
| One provider directly, during `sleep 15`             | none                                                                                          | Approximately 160 MB RSS, approximately 0% CPU                                     | Four including wrapper, native provider, code-mode host, and `sleep`    | n/a                                                                        | Provider-side reference cost.                                                                                                                                                                                                                                                                         |
| Equivalent task through Synara                       | About 93 MB dev backend at the sampled instant                                                | Approximately 156 MB for the provider pair, approximately 0% CPU after completion  | Synara backend/browser plus provider tree                               | Response completed in 23 seconds                                           | The provider RSS was essentially the same as direct; Synara adds its own backend/browser processes and event pipeline. Model differed (GPT-5.5 through Synara versus GPT-5.6 direct), so wall time is not a valid latency comparison.                                                                 |
| Three concurrent dev sessions                        | 1.89 GB backend RSS and 6.8% sampled CPU                                                      | 299 MB total RSS across three provider pairs, approximately 0% CPU at the snapshot | One backend + six core provider processes, before optional MCP children | Separate dev browser pages                                                 | `server.getDiagnostics` with two sessions showed only 78 MB JS heap versus 1.03 GB RSS and 195 MB provider-child RSS. The excess was Bun/native memory, not transcript heap or provider RSS. This did not reproduce in the packaged backend sample and is classified as development-runtime overhead. |
| Completed sessions left open                         | Backend remains; provider trees remain warm for up to ten minutes                             | Idle provider processes remain by policy                                           | One pair per warm provider session (provider dependent)                 | Inactive thread details are bounded to 32 client entries / 8 server leases | Bounded warm-resume tradeoff, not an orphan leak.                                                                                                                                                                                                                                                     |
| Application shutdown after active/recovered sessions | Server exited                                                                                 | All observed provider descendants exited                                           | Zero descendants from the isolated tree                                 | n/a                                                                        | Explicit PID checks verified cleanup after SIGTERM.                                                                                                                                                                                                                                                   |

The live cancellation/restart loop was partially exercised during controlled task
runs, and the repository's provider lifecycle suites cover stop/restart/idle cleanup,
process-tree TERM/KILL escalation, archive, and shutdown ordering. A provider-wide
real-process soak test remains a gap because executing it for every installed
provider would be environment- and credential-dependent.

## Baseline ChatView matrix (development build)

| Transcript     | Mount/idle                                          | Two rapid scroll cycles                                                                           | 60 streaming chunks                    |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 100 messages   | 236 DOM nodes; 248 MB dev heap; one 60 ms long task | 0/364 dropped frames; 8.38 ms mean, 9.1 ms p95, 17.1 ms max; 1.73 s task time                     | 0/60 dropped; 9.73 ms mean, 17 ms max  |
| 500 messages   | 436 DOM nodes; 194 MB dev heap; one 65 ms long task | 50/364 dropped; 14.54 ms mean, 25.1 ms p95, 41.6 ms max; 4.65 s task time                         | 0/60 dropped; 8.33 ms mean, 9.1 ms max |
| 1,000 messages | 724 DOM nodes; 196 MB dev heap; one 89 ms long task | 250/364 dropped; 25.53 ms mean, 41.6 ms p95, 75 ms max; 8.11 s task time; six long tasks / 376 ms | 0/60 dropped; 12.36 ms mean, 17 ms max |

The DOM grows sublinearly (236 to 724 nodes while messages grow 10x), confirming
that the transcript is already windowed. The harsh scripted scroll loop stresses
dynamic measurement and React development instrumentation; it is not a packaged
user-scroll FPS claim.

With an active infinite text shimmer at rest, ten process samples averaged 5.26%
renderer CPU and 0.98% GPU. Disabling only shimmer reduced the settled page to
approximately zero CPU/GPU, confirming the animation as an independent idle cost.

## Confirmed findings and implementation decisions

### 1. Durable journal safety polling (medium/high idle impact, Synara-owned)

`ProviderRuntimeIngestion` used a fixed 250 ms fallback poll. Even when caught up,
every tick read the journal high-water sequence and consumer cursor. The live
persisted-event stream already performs an immediate drain for normal events.

The fallback now backs off 250 ms → 500 ms → 1 s → 2 s → 4 s → 5 s while caught
up, and resets to 250 ms after backlog or a failed drain. The long-lived loop is a
constant-size generator fiber; an intermediate recursive Effect chain was rejected
after re-profiling exposed runaway CPU/RSS in Bun.

- Old steady state: 4 safety polls/second.
- New steady state: 0.2 safety polls/second.
- Reduction: 95% fewer idle safety-poll wakeups and associated SQLite reads.
- Live event latency is unchanged. A genuinely missed notification can now take up
  to five seconds to recover, while normal publication remains immediate.

### 2. Unrelated streaming updates scanned retained thread entries (medium under concurrency, Synara renderer-owned)

The global retention subscriber reconciled as many as 32 entries on every Zustand
mutation, including every message/token update. It also reconstructed thread detail
only to read lifecycle fields. The root event router selected a full derived thread
array, so message changes could invalidate it even when thread IDs were unchanged.

Retention reconciliation now runs only when shell, sidebar summary, session, or turn
lifecycle map identities change, and it reads those narrow lifecycle maps directly.
The root event router subscribes to the stable `threadIds` slice and memoizes its set.
For 100 message-only mutations with 32 retained entries, the avoidable lifecycle
inspection upper bound falls from 3,200 to zero. Provider behavior is irrelevant to
this path.

### 3. Infinite ChatView working shimmer (medium steady renderer impact, Synara-owned; retained by design)

Both the worktree-setup and generic working labels originally used an infinite
text-mask animation. The working status is often present while the provider is
thinking, so the renderer and GPU continue repainting despite no new transcript
content.

An experiment changed both labels to the shared `shimmer-once` utility. After the
two-second cue, the experiment had no steady animation:

| Metric                            | Before | After | Change |
| --------------------------------- | -----: | ----: | -----: |
| Renderer CPU, ten settled samples |  5.26% | 0.23% | -95.6% |
| GPU CPU, ten settled samples      |  0.98% | 0.32% | -67.3% |

Both the generic `Working` shimmer and the separate `Preparing worktree...` shimmer
are intentionally continuous in the final code because that persistent animation is
part of the desired product feedback. The table therefore records a measured
tradeoff rather than a shipped CPU reduction. No streaming, event ordering, or
auto-scroll behavior was changed.

### 4. Claude lifecycle lock map retained every historical thread (low per thread, unbounded, Synara-owned)

`ClaudeAdapter` stored one semaphore per thread ID and never removed keys. A shared
ref-counted keyed lock now counts holders plus waiters and deletes a key after the
last user exits, including failure paths. `ProviderService` uses the same helper for
its binding write lock, so the provider-specific fix reuses shared lifecycle logic.

### 5. Per-event durable journal cost (medium/high while streaming, Synara-owned; measured but not changed)

Every canonical provider event, including `content.delta`, is durably appended
before UI publication. The current append performs an event-id read and an insert in
a transaction. This maps provider chunk frequency directly to Synara SQLite work.

A single `INSERT ... ON CONFLICT` alternative was compared with the current lookup
plus transactional insert. The revised microbenchmark uses file-backed SQLite with
WAL and `synchronous=NORMAL`, alternates which strategy runs first, and measures both
unique events and a workload with 10% idempotent retries. Three balanced eight-sample runs of
10,000 append attempts produced:

| Workload            | Existing median range | `ON CONFLICT` median range | Observation                        |
| ------------------- | --------------------: | -------------------------: | ---------------------------------- |
| Unique events       |            317-363 ms |                 298-329 ms | `ON CONFLICT` 5.9-9.4% faster      |
| 10% repeated events |            286-304 ms |                 291-299 ms | 3.4% slower to 1.4% faster; parity |

This SQL-shape microbenchmark now favors `ON CONFLICT`, but it does not include the
Effect SQL layer, concurrent provider streams, durable publication latency, or
failure/replay behavior. The production experiment therefore remains reverted until
an end-to-end journal benchmark confirms a meaningful win without weakening the
journal-before-publish ordering, replay, cancellation, and durability guarantees.

## Post-change ChatView production profile

The same harness was built with the production Vite/React configuration. React
development overhead explains much of the alarming dev-only memory and scroll cost:

| Transcript | Settled DOM / JS heap | Two scroll cycles                                     | 60 streaming chunks at 1,000 messages                |
| ---------- | --------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| 100        | 223 nodes / 18 MB     | 0/364 dropped; 8.33 ms mean; 9.3 ms max               | —                                                    |
| 500        | 423 nodes / 15 MB     | 0/364 dropped; 8.49 ms mean; 9.2 ms p95; 17.6 ms max  | —                                                    |
| 1,000      | 680 nodes / 42 MB     | 4/364 dropped; 9.73 ms mean; 16.7 ms p95; 25.5 ms max | 1/60 dropped; 9.86 ms mean; 17.4 ms p95; 41.6 ms max |

The production table is a mode-control and final profile, not a numerical comparison
against the React development table. Both working shimmers remain continuous by
product choice.

## Rejected changes and remaining opportunities

- **LegendList row recycling**: low/medium possible impact, medium risk. At 500 and
  1,000 messages it was neutral or slower and increased heap growth (for example,
  about +103 MB versus +41 MB in one 500-message dev run). Reverted.
- **Larger render window / effectively full rendering**: high regression risk. At
  100 messages it created 1,429 DOM nodes, a 1.45 s mount long-task total, and 59/60
  dropped streaming frames. Reverted.
- **Scroll-fade removal**: low confidence. One SwiftShader run reduced GPU activity
  slightly but did not change renderer CPU or frame timing reliably. No change.
- **Long-history virtualization tuning**: medium potential impact, high interaction
  risk. Dynamic tool rows, images, selection, scroll anchoring, and streaming make a
  deeper change unsafe without a dedicated production trace and regression suite.
- **Bun development backend native footprint with concurrent provider sessions**:
  high development-only impact, medium/high migration risk. JS heap stayed small
  while native RSS grew sharply; packaged samples did not reproduce it. Investigate
  Bun/JSC native allocation or run the dev backend under the same Node runtime as the
  packaged server before changing provider lifecycle code.
- **Five-second runtime reconciliation query**: low/medium potential impact at large
  history sizes. It joins runtime/session/turn state and orders by a computed time.
  Capture `EXPLAIN QUERY PLAN` against a large real database before adding indexes or
  changing cadence.
- **Provider warm-retention policy**: medium process/RSS impact, product tradeoff.
  Reducing ten minutes would reclaim provider memory sooner but can increase restart
  latency and lose warm context. It was not changed without a latency study.

## Verification

- `ProviderRuntimeIngestion.test.ts` and `keyedLock.test.ts`: 95 tests passed.
- `threadDetailSubscriptionRetention.test.ts`: 17 tests passed.
- `MessagesTimeline.worktreeSetup.browser.tsx`: 7 browser tests passed.
- `ClaudeAdapter.test.ts`: 143 tests passed.
- `ProviderService.test.ts`: 79 tests passed.
- Production transcript harness build completed.
- Shutdown PID audit found zero remaining descendants from the isolated Synara tree.
- `bun fmt`: passed.
- `bun lint`: passed with 0 errors and 401 existing warnings.
- `bun typecheck`: 7/7 packages passed.
- `bun run test`: 3,371 tests passed, 7 skipped; all 8 workspace tasks passed.
- `bun run build`: all 5 workspace build tasks passed.
- `bun run test:browser:stable`: 268 tests passed, 12 skipped.
- The affected transcript browser file also passed independently (3/3). The
  all-in-one browser run initially timed out under simultaneous unit/build load;
  its stable serial rerun passed.
- `bun run test:browser:geometry` on macOS: 4 passed and 8 tests explicitly named
  `[geometry:linux]` failed because their target row did not enter the expected
  Linux-calibrated virtualized region. These failures reproduce in the isolated
  serial geometry suite, no virtualization logic was changed, and the production
  transcript profiles above were captured with the macOS browser geometry actually
  used by this machine.
