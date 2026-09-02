# Devin CLI bug report: exec session_manager wedges leave the agent alive but silent

**Reporter:** Kartik (via Devin debugging session, 2026-09-02)
**CLI version:** 3000.6.11 (38b3cbd2), macOS arm64 — installed ~2h before the incidents; not a stale-version artifact
**Impact:** agent process stays alive but stops emitting all events; ACP hosts see a turn hang indefinitely with a tool call stuck inProgress. Observed twice in one night on one machine.

## Failure shape 1 — sandbox_manager lock acquisition hang

Timeline (all UTC, 2026-09-02, Synara thread `cdfc2c36-60db-4554-b199-6142a5241213`, turn `da774825`):

- 04:01:30 — exec session `a7dd87` created (`python3 .local/share/mind/mind.py recall "agent weights"`); at 04:01:30.662 the previous session's stop begins: `toolbox_core::tools::context: Waiting for stop token c872bc02-... to stop`
- 04:01:50 — next exec (`wc -w chunk1.md && wc -w chunk1_raw.txt`, session `8d75e9`): `acquiring additional_env lock` → acquired → `acquiring sandbox_manager lock` → **never acquired**
- 04:01:53 — runtime still alive (skills discovery logs)
- 04:02:26 — `WARN affogato::stall_watch: waited_secs=30 what=emit(Subagent) to agent event channel Agent pipeline await still pending`
- then total silence for 23 minutes until the host interrupted (04:24:47)

Evidence: `~/.local/share/devin/cli/logs/devin_20260902-092507_73998.log` — the log contains 24 `acquiring sandbox_manager lock` lines vs 23 `acquired` — exactly one acquisition never completed. The prior exec session's teardown ("Waiting for stop token") overlapped the next create_session, suggesting a teardown/create lock-ordering race.

## Failure shape 2 — PTY/RawExec spawn hang (no stall warning)

Timeline (same thread, turn `d333bfce`):

- 04:43:25 — exec session `d43766` created for `ssh vps 'machinist run --help; ...'`, completed normally at 04:43:28
- 04:43:31 — next exec (`ssh vps 'ls -la /home/kartik/cx; ...'`, session `2625c3`): locks acquired normally (`acquired sandbox_manager lock` at 04:43:31.297528), `creating PTY session` → `creating RawExec session` → **no `waiting for shell ready`, no output, nothing**
- 04:43:36 + 04:44:00 — unrelated background lines (skills discovery, windsurf remote-config warning), then silence for 21 minutes until the host interrupted (05:05:33)

Evidence: `~/.local/share/devin/cli/logs/devin_20260902-100836_95905.log` (lines ~804-812). Note: NO `stall_watch` warning in this shape — the agent pipeline wasn't blocked; only the exec session never materialized.

## Trigger pattern

Both wedges occurred during rapid successive exec tool calls where the previous exec session was still alive or mid-teardown. A sweep of all 3,015 local CLI logs found the shape-1 signature in exactly one file (the incident). Bigger working sessions (more tool calls per turn, long-running commands) widen the collision window — the affected workload was a transcript-processing task with many rapid exec/read calls.

## Host-side corroboration (Synara)

- The host's transport was healthy at both onsets: the child's last `tool.started` notification reached the host's event log within ~10ms of the CLI's create_session log lines (04:01:50.228 vs 04:01:50.227; 04:43:31.308 vs 04:43:31.297). Not a host backpressure issue.
- The host now detects both shapes via the child's mirrored stderr (shape 1 directly; shape 2 via the missing `waiting for shell ready` within 30s) and auto-recovers by killing + resuming the session + sending "continue", which works: a controlled experiment (SIGKILL mid-turn → `session/load` → "continue") showed the CLI persists partial turn state and the resumed agent completes the remaining work correctly.

## Requested fix

Investigate `toolbox::tools::exec::session_manager` for (a) the `sandbox_manager` lock ordering between session teardown (stop-token path) and create_session, and (b) the PTY/RawExec spawn path that can block indefinitely after locks are acquired. A lock-acquisition timeout + bounded spawn startup would convert both wedges into fast tool failures the agent can retry.

## Reproduction hints

Rapid alternating exec calls with short-lived sessions (the incidents had ~5s gaps between exec calls, with the prior session's stop still in flight). A stress harness that fires N short exec calls back-to-back through `devin acp` may reproduce; both observed wedges happened within 42 minutes of each other on the same workload.

## Synthetic ACP validation (2026-09-02)

Because the live SWE 1.7 ACP sessions exhausted their daily usage quota, a dependency-free mock ACP child was built to exercise Synara's real adapter/runtime recovery.

- Mock: `/tmp/synara-pr912/mock/acp-devin-wedge-mock.mjs`.
- Mock acceptance harness: 41/41 checks, covering `stall-watch`, `spawn-stall`, healthy `none`, `unwedge` (progress clears spawn stall), and wire logging.
- Integration script: `/tmp/synara-pr912/integration/run-adapter-recovery.mjs`.
- Integration result (real timers, real `DevinAdapter`, real `makeDevinAcpRuntime`):
  - `stall-watch`: wedged turn cancelled → session restarted with `session/resume` → `"continue"` turn completed, warning emitted.
  - `spawn-stall`: same cancellation/resume/continue flow completed.
  - Exit code 0, `recovery success: true`, session `ready` after recovery.
- One synthetic race was mitigated in the fixture: the mock emits `affogato::stall_watch` ~1 ms after progress events, and the adapter's notification loop clears stall state on turn progress. The real Devin stall warning is emitted only after 30 s of silence, so this ordering does not occur in production; the fixture delays stderr by 0.4 s to preserve the natural "progress first, warning later" ordering.
- Full-stack browser test: 5 independent wedge/recovery cycles through the real Synara web UI using the `stall-watch` mock. Each cycle produced `devin.acp.wedge_recovery_started`, a resumed session, and a completed `continue` turn. The UI showed the persisted runtime-warning row "Devin stopped responding; restarting this session automatically and continuing the task." and a non-alarmingly continued conversation (assistant message `starting work`). Screenshot: `/tmp/synara-pr912/browser/screenshot.png`.
- Live SWE 1.7 stress: three clean sequential iterations (180 exec sessions, no wedge signatures) and four useful parallel iterations before the daily quota (`-32011 resource_exhausted`) halted further reproduction. The original deadlock was not reproduced.
