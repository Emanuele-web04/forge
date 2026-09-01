# Lane 01 — PR 857 refresh onto main + server acceptance proof

Branch: `handoff/plan-01` (worktree `/Users/user/synara-handoff-wt/plan-01`)
Base: PR 857 head `08101c181d`; merged `refs/remotes/upstream/main` at `182208581e` (32 commits, includes Devin ACP provider + v0.8.0).
Merge commit: `71e77c058` — zero conflicts; auto-merged overlap files audited (both sides' semantics verified present).
Protected Devin files (`DevinAdapter.ts`/`.test.ts`, `AcpSessionRuntime.ts`, `DevinAcpSupport.ts`/`.test.ts`): byte-identical to upstream after merge (`git diff refs/remotes/upstream/main HEAD -- <files>` is empty); never edited.

## Gate table

| #   | Gate                                    | Result                                    | Method / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Truthful status ordering with live Pi   | PASS (server) + PASS (web logic tests)    | Reactor test `shows the starting status before a slow provider session resolves and then runs the turn` passes (`bun run test` from apps/server; 1 passed / 158 skipped). The test gates `startSession` on a release promise and asserts the thread observable reports `status === "starting"` while `startSession` is still pending — a deterministic (stronger-than-timer) proof that the starting observable fires before startSession resolves. Note: the test uses a manual release gate, not a literal 5 s stub. Web side: `resolveWorkingLabel` "Starting provider…" tests and `keeps the settled duration stable after the active turn leaves running` (collapsedWorkElapsed `"1m"` byte-identical at settle and after recompute) pass in apps/web vitest (233 tests, 2 files). |
| 2   | Pi SDK 0.84.4 server suite + live proof | PASS (with named environment workarounds) | Full apps/server suite on 0.84.4: 4392 passed / 1 failed / 16 skipped; the single failure (`ProviderHealth.test.ts:2352`, Devin authStatus) is environment-dependent — this machine has real `~/.local/share/devin/credentials.toml`; the test passes with `HOME=/tmp/lane01-empty-home`. Live: real 3-turn Pi session + stop/resume 4th turn against mode-0700 temp copy `/tmp/lane01-pi-agent2` of `~/.pi/agent`; `grep -c "Handoff generation failed"` = 0 across server log, driver log, stdout; model discovery listed 596 models; all turns settled (`TURN-1-OK`…`TURN-4-OK`). See "Pi session log" below and named gaps for the two environment workarounds required (Bun SIGABRT from global npm tree; turbo env stripping).                                                    |
| 3   | Backend memory investigation            | PASS (doc restored + trace captured)      | `plans/2026-08-30/recon/memory-findings.md` restored into the branch (commit `f9f57e6ae`): names the second-bootstrap trigger (`OrchestrationEngine.runProjectionRepair` via `orchestration.repairState`, same pid 75174, quoted preceding log lines incl. title-generation failure) and heap-retainer suspects. 30-minute trace captured against the isolated dev instance (see below). Mitigation (projector 512 KB in-memory text cap, commit `b91117ea3`): 172 insertions total incl. its focused projector test (within ~200 budget). `ProjectionPipeline.test.ts:4414` (`restores pending turn-start metadata across projection pipeline restart`) green in the 39-test ProjectionPipeline suite.                                                                                 |
| 4   | Noise wins                              | PASS                                      | Git refresh backoff: `GitCore.ts` 48 changed lines (per-remote consecutive-failure count, exponential backoff capped 300 s) + `gitUpstreamRefreshPolicy.test.ts` 6 tests pass. Provider event sanitization: `providerRuntimeEventPump.ts` 31 lines (`sanitizeRuntimeEvent` trims blank `detail` on `request.opened`/`event.unmapped`) + `providerRuntimeEventPump.test.ts` 5 tests pass.                                                                                                                                                                                                                                                                                                                                                                                                |
| 5   | Focused server suites for PR files      | PASS                                      | `ProviderCommandReactor.test.ts` (159) + `ProjectionPipeline.test.ts` (39): 198 passed. `projector.test.ts` (28) + `gitUpstreamRefreshPolicy.test.ts` (6) + `providerRuntimeEventPump.test.ts` (5): 39 passed. All via `bun run test` (never `bun test`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Web gates (PROOF-ONLY this wave — no web files modified)

| Gate                                                                                                             | Result                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No blank home flash (300 ms delayed-echo fixture)                                                                | PASS                                                      | `ChatView.browser.tsx` "does not flash the empty home landing while the first send is in flight": renders home landing, sends, polls 300 ms in 16 ms frames asserting `"What should we work on?"` never enters `document.body` while in flight, then delivers the delayed echo. Passed in the headless chromium run.                                                                                                                 |
| One-frame scroll detachment (16 ms stream + one wheel, scrollTop decreases next frame, no re-snap for 60 frames) | PASS (on quiet-machine rerun) | `MessagesTimeline.scrollOwnership.browser.tsx` "lets a single wheel up detach auto-follow and never re-snaps for 60 frames" failed once in SETUP under machine load average 16–25 (concurrent lanes' suites), then PASSED standalone (988 ms). File is byte-identical to PR head (upstream never touched it). |
| Transcript guard tests preserved                                                                                 | PASS                                                      | `MessagesTimeline.logic.test.ts` (70 tests) + `ChatView.logic.test.ts` (163 tests) all pass, incl. fold/guard tests ("folds a settled turn's narration…", "keeps the settled duration stable…").                                                                                                                                                                                                                                     |

Headless browser harness run (playwright chromium, `bun run test:browser` with `VITEST_BROWSER_API_PORT=51301`): 105 passed / 4 failed (109 total) under machine load average 16–25 (concurrent lanes' suites); two different runs produced different failure assertions (flake signature). All 4 then PASSED in standalone reruns on a quieter machine: "lets a single wheel up detach auto-follow and never re-snaps for 60 frames" (988 ms), "anchors a sent message below the top inset, pins it while streaming, keeps the reserve at turn end, follows overflow, and collapses only when cleared" (2.1 s), "moves a sent message to its anchor once and holds it across the turn lifecycle" (12.9 s), "keeps near-cap composer work bounded while live activities arrive" (18.9 s). Effective browser result: 109/109, with the caveat that the last 4 passed in isolated runs rather than one batch.

## Pi session log (gate 2 live proof)

Driver: `/tmp/lane01-pi-driver.ts` (WS negotiate → `/ws` upgrade → orchestration RPC), server pid 22411 started with `PI_CODING_AGENT_DIR=/tmp/lane01-pi-agent2`.

```
[16:52:46] model discovery: 596 models: deepseek/deepseek-v4-flash, …, opencode-go/minimax-m3, …
[16:52:46] project created: prj-lane01-1788281566362
[16:52:46] thread created: thr-lane01-1788281566362
[16:52:46] turn 1: dispatching (messages before: 0)
[16:52:54] turn 1: settled. session=ready assistantText="TURN-1-OK"
[16:52:56] turn 2: settled. session=ready assistantText="TURN-1-OK | TURN-2-OK"
[16:52:58] turn 3: settled. session=ready assistantText="TURN-1-OK | TURN-2-OK | TURN-3-OK"
[16:52:59] session stopped
[16:53:02] turn 4 (resume): settled. assistantText="… | TURN-4-OK" — resume works
[16:53:02] diagnostics: pid=22411 rssMb=1264 heapUsedMb=197
```

Handoff grep: `grep -rc "Handoff generation failed"` → server.log 0, driver log 0, server stdout 0 (total 0). Server log has 0 error-level lines in the 16:5x successful window.

## 30-minute memory trace (gate 3)

Command (dry-run first, then live): `env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3101 SYNARA_NO_BROWSER=1 bun run dev -- --home-dir ./.synara-h01 --port 58101`
Sampler: `server.getDiagnostics` over WS every 30 s for 31 minutes → `/tmp/lane01-memory-trace.log`.

62 samples over 30.9 minutes (raw log: `evidence/lane-01-memory-trace.log`):

| metric (MB) | start | min | max | end |
|---|---|---|---|---|
| rss | 99 | 49 | 99 | 68 |
| heapUsed | 46 | 46 | 64 | 51 |
| external | 9 | — | 23 | 13 |
| arrayBuffers | 0 | — | 6 | 1 |

No monotonic growth in any series; RSS declined 99 → 68 MB over the window. Steady-state
heapUsed holds at ~50 MB. Findings doc updated with the same table
(`plans/2026-08-30/recon/memory-findings.md` §6). Byte-level retainer ranking still needs a
heap snapshot (Bun has no runtime inspector trigger; SIGUSR1 terminates the process — named
gap 5); the external/arrayBuffers series are the measured byte sizes of those retainer
classes in steady state.

## Named gaps / environment findings

1. **Bun SIGABRT when the Pi SDK loads the machine's global npm tree** (not a PR bug): the SDK scans `npm root -g` (`/opt/homebrew/lib/node_modules`) for pi packages; global package `@cortexkit/pi-magic-context` depends on `better-sqlite3`, whose Node-ABI prebuild (`prebuilds/darwin-arm64.node`) calls `Napi::Error::Fatal` during registration under Bun → SIGABRT (macOS report `bun-2026-09-01-220050.ips`, faulting frame `InitAll` → `Napi::Error::Fatal`). Worked around inside /tmp only: temp agent copy excludes `@osolmaz/pi-workflows` (in-copy better-sqlite3) and sets `npmCommand` to a fake npm reporting an empty global root. The user's real environment may hit the same abort in any Bun-hosted Pi session that scans global roots.
2. **turbo `globalEnv` strips `PI_CODING_AGENT_DIR`** (dev-infra observation): `scripts/dev-runner.ts` forwards full env to turbo, but turbo's strict env mode drops everything not in `turbo.json globalEnv`, so the Pi SDK inside the dev server resolves `getAgentDir()` to the real `~/.pi/agent`. For the live proof the server was started directly (`bun run src/index.ts --home-dir …/.synara-h01 --port 58101`) with the same isolation flags plus `PI_CODING_AGENT_DIR`. The gate-3 trace uses the exact gate command (no Pi involved). If dev instances need Pi isolation later, add `PI_CODING_AGENT_DIR` to turbo `globalEnv` (one line, other lanes' call).
3. **`ProviderHealth.test.ts:2352` reads real `~/.local/share/devin/credentials.toml`** — environment-dependent test from upstream's Devin commit (not this PR's file set); passes with isolated HOME. Upstream may want a reader stub like the adjacent test.
4. **Browser batch run is load-sensitive**: the 4 frame-timing tests failed in a batch run under load average 16–25 and all passed standalone afterwards. If CI or other lanes run browser suites concurrently, expect batch flakes in scroll-settling/hydration timeouts; consider per-file serialization or looser setup tolerances (test files only, wave-2 candidates).
5. **No heap snapshot possible for the dev instance**: Bun exposes no runtime inspector trigger (SIGUSR1 terminates the process rather than opening the inspector), and the gate-exact dev command does not include `--inspect`. The trace therefore reports process-level series (heapUsed/external/arrayBuffers byte sizes) instead of per-retainer rankings.

## Fixes made this wave (server lane)

| Commit      | Change                                                                                                                            | Diffstat                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `71e77c058` | Merge upstream/main (32 commits) into PR 857 branch                                                                               | 210 files, +14757/−1151 (upstream's own changes; zero conflicts) |
| `f9f57e6ae` | Restore `plans/2026-08-30/recon/memory-findings.md` (required in-branch by gate 3; was stripped as review scratch in `dae84b3f9`) | 1 file, +118                                                     |
| `0d8016067` | Findings doc §6 (trace measurements) + evidence report + raw trace/pi-session logs                                                | 2 files, +114                                                    |

No server code fixes were needed: the PR's code survived the merge semantically intact (audited overlap files: `apps/server/package.json` Pi SDK 0.84.4 kept, reactor test both sides present, `rateLimits.ts` both changes present, `bun.lock` consistent — `bun install` reports no changes).

## Web-fix needs for wave 2 (report only; no web files touched)

1. None required for correctness of the merge — all web logic tests pass; blank-flash fixture passes; all 4 load-flaky browser tests passed standalone reruns.
2. Optional hardening (test files only): the browser batch run flakes under concurrent load (scroll-settling tolerance 120 px / 5 s in `startStreamingAndFollow`; estimator-parity hydration timeouts). Files: `MessagesTimeline.scrollOwnership.browser.tsx`, `MessagesTimeline.tailAnchor.browser.tsx`, `ChatView.browser.tsx`.
