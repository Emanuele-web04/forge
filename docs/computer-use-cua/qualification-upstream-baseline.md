# Qualification record — 7 September 2026

## Decision

Keep the repaired Synara authority/provider/transport/UI stack and one pinned Cua native backend. The implementation demonstrates feasibility for a GUI-hosted macOS integration. **It is not qualified for general release.** Required native cancellation guarantees, simultaneous human-input behavior, a signed production host and broader target coverage remain open.

The selection order is correctness and permission attribution, required application/mode coverage, maintainability, then measured cost. This work does not establish that Cua is faster than the Swift proposal. It also does not retain Swift as a silent fallback.

## What was implemented and exercised

| Boundary                 | Evidence                                                                                                                       | Practical limit                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Driver provenance        | Release archive checksum, executable version, copied license/provenance; pinned source inspected                               | No independently reproduced Rust build                                                      |
| GUI ownership            | Real Electron fixture launching embedded native child; native permission source identifies the host and responsible parent     | Ad-hoc fixture, not production Synara signing/notarization                                  |
| Desktop startup          | Desktop bundle build; actual isolated server startup after fixing the desktop identity export                                  | Isolated web server cannot confer native GUI authority                                      |
| Provider authority       | Focused gateway, registry, manager and provider approval tests; real gateway-handler-to-native fixture                         | Caller context is controlled; no paid provider end-to-end turn against the desktop was sent |
| Off / queued input       | Revocation captured at submission; off/on and archive/restore regression cases                                                 | Native in-flight held-input cleanup is still unproven                                       |
| Child retirement         | Fake executable records native dispatch, delayed effect and exit; host waits for exit before replacement                       | Proves process supervision, not OS key/button state                                         |
| Socket authority / UTF-8 | Real private Unix sockets reject missing authority and preserve a split multibyte character                                    | Same-user process compromise is outside this boundary                                       |
| Still transport          | Drain without another frame; independent-image/video recovery regression cases                                                 | No long-duration production memory/capture profile                                          |
| UI                       | 193 focused web tests; actual isolated Settings page renders Computer use, unavailable-host explanation and default switch off | Full provider-to-live-pane production interaction remains unqualified                       |

## Real native runs

Only owned fixtures were eligible input targets. The runner required exact PID, window title and native window ID. Permission setup was explicitly authorized by the user, and authentication remained with the user.

The initial successful Electron run used host PID 64563, driver PID 64580, window A 3046 and sibling B 3047. A background click produced exactly one application-owned counter increment. The returned driver verification was insufficient, so Synara correctly reported an uncertain delivery rather than asserting success from dispatch alone. The fixture's independent counter established the observed effect.

With both same-PID windows open, Cua refused keyboard input with `same_pid_keyboard_ambiguity`. After target close, Cua refused with `off_space_or_ax_unresolved`. Inspection of the actual replies established the native refusal discriminator (`structuredContent.effect === "refused"`); the adapter was corrected to map these to `not-dispatched`. The original run's old adapter had conservatively returned `dispatched-unknown`, so its report is not evidence of the corrected mapping. Focused regression cases cover that mapping.

The next runner revision produced before/after window screenshots but exited when its last Electron window closed, before saving the report. Those screenshots alone do not prove its unrecorded assertions. Revision 3 prevented that automatic quit and added the AppKit target; revision 4 waits for its identity to appear in WindowServer before admission and records the native action projection.

### Reference fixture run

[Raw report](evidence/native-fixture-report.json), [Electron before](evidence/fixture-before.png), [Electron after](evidence/fixture-after.png), [AppKit before](evidence/native-before.png), [AppKit after](evidence/native-after.png). Captures contain only owned fixture windows and were visually inspected.

Run 8 (fixture revision 6) used GUI host PID 93949, driver PID 93954, Electron window 3743 and AppKit target PID 94196/window 3750. Both permission booleans were true; the embedded driver identified the GUI host as its responsible parent. The desktop was the existing primary display at 2× capture scale. One foreground text action had separate explicit user approval; all other actions used background delivery. The foreground case reset the owned field to a distinct seed before replacing it, so it was not a replay of an uncertain background action.

| Case                                          | Electron                                                                                                         | AppKit                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Exact target observation/capture              | Passed                                                                                                           | Passed after bounded observation-only readiness wait                                            |
| Single pixel click / counter                  | Passed: counter 1, one native click submission                                                                   | Passed: counter 1, one native click submission; Cua internally selected the AX route            |
| Keyboard with two eligible windows of one PID | Explicit `not-dispatched` refusal                                                                                | Explicit `not-dispatched` refusal                                                               |
| Select `abc`, then type `abc` with one window | Failed: DOM input-event count 0, selection still 0–3; native AX route remained `unverifiable`                    | Passed: application-owned edit count 1 and text `abc`; native value-readback evidence confirmed |
| Explicit foreground replacement               | Passed: independent DOM read-back was exactly `foreground-ok`; native global-input route remained `unverifiable` | Not run                                                                                         |
| AX set value to `fixture-value`               | Passed by DOM read-back; native correctly retained an unverified web-content effect                              | Passed by application-owned read-back; native confirmed with value evidence                     |
| Moved target                                  | Refused before dispatch; counter unchanged                                                                       | Not run                                                                                         |
| Closed target                                 | Refused before dispatch                                                                                          | Not run                                                                                         |
| Minimized target                              | Not run                                                                                                          | Refused before dispatch by geometry guard; this does not qualify every minimized-window path    |

The [earlier run 6 report](evidence/native-fixture-run6-report.json) records an AppKit pixel refusal by the geometry guard. Runs 7 and 8 passed that click without weakening the guard. Observation diagnostics also captured zero-area WindowServer placeholders at startup and changing bounds during minimization. This demonstrates geometry churn but does not conclusively explain the earlier discrepancy or qualify rapid transitions. Electron's background text failure demonstrates why an AX delivery count is not independent DOM evidence. Foreground text has now passed one separately approved case; it is never an automatic fallback.

The pinned public registry rewrites deprecated `type_text_chars` to `type_text` (`crates/cua-driver-core/src/tool.rs`, `invoke_authorized`). Its separately named platform source file is not evidence of an accessible key-event-only tool. A fixture run using the alias still returned the AX route and failed the same Electron assertion. The ineffective alias/chunking experiment was removed from the adapter and broker allowlist.

The final adapter consumes Cua's published `ActionResult.route`, delivery mode and evidence rather than the internal tool's legacy `path` field. A confirmed result without recognized value/window evidence remains uncertain; `effect: refused` is preserved even without an outer error flag. The native report exercises the public action shape. The current 20 backend tests also verify window capture identity and its preservation through the public schema.

### Gateway-to-native fixture and capture identity repair

Run 12 (revision 7, corrected fixture error parser) exercised real `makeAgentGatewayComputerTools` handlers, `ComputerManager`, `CuaComputerBackend`, the authenticated host broker and pinned native executable. Its provider/turn context was supplied by the fixture. It did not simulate a paid model turn or claim a real provider approval-card round trip.

The audit found that `computer_get_state(window_id, include_screenshot)` could deliver a window image without binding its screenshot ID to that window. Cua screenshots now carry the native window identity through `ComputerScreenshot`, and the common delivery function records that identity. Both native observation methods verify the returned PID/window ID before accepting a frame. Tests and the real fixture reject an action that combines that screenshot with a different window ID before any native mutation.

A follow-up audit extended this check to the fresh native capture used immediately before a pixel action. Even identical geometry cannot authorize a frame from a different PID or native window ID. Both mismatches now have regression tests proving zero click submissions. The macOS screenshot tool schema also omits unsupported rectangle arguments and describes exact-window capture. These final changes passed focused tests; the installed fixture remains build 10 and was not rebuilt or rerun for them.

[Run 12 report](evidence/gateway-native-report.json), [before](evidence/gateway-before.png), [after](evidence/gateway-after.png), [resources](evidence/gateway-native-resources.json). The two gateway images were visually inspected. All five gateway assertions passed:

- A frame naming another window was rejected without a native action.
- The allowed background tool click submitted exactly one native action, incremented the fixture counter once and returned a screenshot bound to its own window.
- The foreground authorization callback received the owning turn, denied the request and prevented native submission.
- Computer off prevented another click; the application counter did not change.
- After re-enabling, an ended caller turn still prevented native submission.

The fixture additionally rejects overview captures and accepts window captures only after independent fixture PID/title/window-ID checks. The initial revision-7 run stopped while decoding an expected plain-text MCP error as JSON; that fixture parser was corrected before run 12. No pass is inferred from that incomplete run.

Run 12 also exposed variability in the original Electron cases: its AX-routed click produced no counter change, while background text reached the DOM through synthetic events. This differs from run 8, where the click passed and AX-routed text failed. The background delivery problem therefore remains open for both click and text; neither case is declared universally fixed. AppKit cases passed in run 12. Agent tool descriptions and Settings copy now reflect explicit foreground approval, primary-display overview and exact-window state captures instead of promising automatic window activation or every-monitor capture.

### Permission findings

- Placing the ad-hoc bundle only in a temporary directory left LaunchServices unable to resolve its identity reliably. An installed copy in `~/Applications` and explicit registration resolved that test setup problem.
- A different ad-hoc code signature can leave a stale TCC grant. Only the fixture's Accessibility and ScreenCapture entries were reset/re-added, with explicit authorization; personal Synara grants were untouched.
- Launching `Contents/MacOS/Electron` directly from the shell caused Screen Recording to be attributed to the Codex responsibility chain and returned false. Launching the actual bundle through LaunchServices obtained the fixture's own grants.
- A bundle-ID environment variable is not a substitute for real GUI hosting. The native result and TCC diagnostic attribution were checked rather than trusting a settings switch alone.
- System Settings' AX modal can be reported even when the user does not see it on their current desktop. Authentication was confirmed by the user and subsequent state changes, not inferred from that AX result.

### Measurements

The initial successful run measured one window observation at **852.51 ms**, one click at **2626.91 ms**, and the refused two-window text action at **32.72 ms**. These are single samples under the current desktop load, not percentiles or a benchmark comparison. Click timing includes the adapter's frame validation and Cua's own work; it is not raw event-posting latency.

Electron main-process RSS was **203,227,136 bytes** in the initial run. This is neither driver-only memory nor incremental integration overhead. Equivalent Swift measurements were not collected. No speed or memory winner can be selected from these numbers.

Run 8's single samples were 838.98 ms for Electron observation, 2921.57 ms for its click, 1934.57 ms for its foreground text, 198.24 ms for AppKit observation, 219.91 ms for its click, 1072.56 ms for its confirmed identical-text replacement, and 2687.53 ms for AppKit AX set-value. Electron main-process RSS at report time was 218,742,784 bytes. These remain exploratory samples with no matched Swift baseline.

The [resource samples](evidence/native-fixture-resources.json) contain 31 `ps` observations over 16.11 seconds, restricted to the exact fixture host executable and its driver child. Driver RSS ranged from **327.23 MiB to 3304.23 MiB** and remained about 2002.84 MiB in the last sample. Its cumulative CPU time rose from 1.53 to 17.40 seconds. Electron main RSS ranged from 188.23 to 208.45 MiB. Sampling began after launch and did not isolate idle phases, capture cost, allocator retention or incremental overhead; OS `%CPU` is an estimate. Nevertheless, the multi-gigabyte driver peak is a concrete performance concern requiring diagnosis before release. The source's native cursor renderer allocates display-sized raster frames, which is a hypothesis to test, not an established cause. All three fixture PIDs were absent after teardown.

### Native cursor cost experiment

Runs 9 and 10 repeated the same background-only cases with the installed revision 6 fixture and pinned native executable. Both skipped the foreground case; its one-use approval was not reused. Run 10 launched that same binary through a shell `exec` wrapper adding the documented `--no-overlay` flag. Native PID/version and host-permission checks still passed. This did not change production startup flags or add another actuator.

| Sample                                   | Native overlay enabled, run 9    | Native overlay disabled, run 10  |
| ---------------------------------------- | -------------------------------- | -------------------------------- |
| Driver RSS observed                      | 274.58–297.80 MiB                | 54.22–78.14 MiB                  |
| Cumulative CPU time at first/last sample | 6.43 → 16.96 s                   | 0.18 → 0.50 s                    |
| Sampling interval covered                | 9.63 s, 19 samples               | 6.94 s, 14 samples               |
| Electron click                           | 2899.34 ms                       | 1434.92 ms                       |
| Electron AX set-value                    | 2634.16 ms                       | 1069.01 ms                       |
| AppKit AX set-value                      | 2701.81 ms                       | 1137.62 ms                       |
| Application-owned assertions             | Same background results as run 8 | Same background results as run 9 |

Reports and resources: [enabled report](evidence/overlay-enabled-report.json), [enabled samples](evidence/overlay-enabled-resources.json), [disabled report](evidence/overlay-disabled-report.json), [disabled samples](evidence/overlay-disabled-resources.json). Launch and sampling start offsets differ, these are single runs, and the table does not establish stable percentiles or a peak-memory reduction ratio. It supports a substantial native-overlay cost in this workload. It does not isolate the earlier foreground memory spike, establish idle behavior or demonstrate that disabling the overlay preserves cursor/hover functionality. The production integration still enables the native cursor; changing that behavior requires preserving or explicitly qualifying the affected capability.

Run 13 kept the native overlay but tried its documented `--glide-ms 50 --dwell-ms 0 --idle-hide-ms 500` options. [Report](evidence/short-cursor-report.json), [resources](evidence/short-cursor-resources.json). The driver peak was 1231.19 MiB, the AppKit sequence encountered a capture failure, and the gateway click was refused as `off_space_or_ax_unresolved`. Four gateway admission/refusal checks still passed. Different native routes, failures and process generations prevent a fair performance comparison with run 12; this experiment does not establish a safe optimization. Those flags were not applied to production startup. No additional foreground action was authorized or executed.

### Native delivery and cancellation boundary

The [official release list](https://github.com/trycua/cua/releases), checked on 7 September 2026, still lists 0.24.0 as the newest driver release. No newer published driver was available there to qualify these gaps; the pin was retained.

In the pinned source, a plain background coordinate click can return after successful `AXPress`, with its effect still unverified. Its public arguments provide no switch to force synthetic pixel delivery. Changing click count or modifiers would change the requested action, so Synara does not use that as a workaround. See [`platform-macos/src/tools/click.rs`](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/platform-macos/src/tools/click.rs#L890).

`end_session` may defer cleanup until an in-flight action finishes. Graceful daemon shutdown drains session/runtime state, but this does not establish held-input release: the native typing loop posts key down, waits, then posts key up. Forced termination can interrupt that sequence. These are source findings, not a native cancellation pass. See [`session_tools.rs`](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/cua-driver-core/src/session_tools.rs#L446), [`serve.rs`](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L1399), and [`input/keyboard.rs`](https://github.com/trycua/cua/blob/4b3396d9fe4bd3cf723b0eb8db83c18a8764b520/libs/cua-driver/rust/crates/platform-macos/src/input/keyboard.rs#L54).

## Verification ledger

Temporary logs are under `/private/tmp/synara-cua-implementation/`. Counts overlap; do not sum them into a purported repository-wide total.

| Run                                                                                                                        | Result                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `focused-5.log`: Computer, gateway tools/transport, session registry                                                       | 22 files passed; 318/319 tests passed. One stale guidance expectation failed.                                                                                                                      |
| `orchestration-tests.log`: corrected computer guidance, runtime ingestion, control decider, startup reconciliation         | 4 files, 202 tests passed; includes the previously failing guidance test.                                                                                                                          |
| `web-tests-2.log`: panel, settings, provisioning, permission copy, state and frame UI                                      | 13 files, 193 tests passed.                                                                                                                                                                        |
| `shared-tests.log`: shared transport/frame/JSON-RPC/targeting                                                              | 4 files, 41 tests passed.                                                                                                                                                                          |
| `shared-final-tests.log`: permission copy and frame transport                                                              | 2 files, 15 tests passed.                                                                                                                                                                          |
| `codex-approval-tests.log`: filtered Codex elicitation/respond/interrupt                                                   | 16 passed, 124 skipped by filter.                                                                                                                                                                  |
| `codex-manager-final-tests.log`: complete Codex manager test file                                                          | 138 passed, 2 skipped. Scratch creation uses a temporary root; version-gate tests provide a working directory instead of touching the user's cache.                                                |
| `claude-approval-tests.log`: filtered Claude background approval cases                                                     | 2 passed, 165 skipped by filter.                                                                                                                                                                   |
| `socket-tests.log`: transport tests rerun with temporary socket access                                                     | 2 files, 6 tests passed.                                                                                                                                                                           |
| `host-final-tests.log`: authority, UTF-8, retirement, allowlist                                                            | 1 file, 4 tests passed.                                                                                                                                                                            |
| `backend-foreground-tests.log`: public action projection, foreground routing and native/authority boundaries               | 1 file, 17 tests passed.                                                                                                                                                                           |
| `frame-identity-final-tests.log`: gateway capture binding, corrected guidance and Cua boundaries                           | 2 files, 101 tests passed (83 gateway, 18 backend).                                                                                                                                                |
| `backend-capture-schema-tests.log`: capture identity including public schema decoding                                      | 1 file, 18 tests passed; overlaps the preceding run.                                                                                                                                               |
| `preparation-identity-tests.log`: final native capture preparation and macOS screenshot schema                             | 2 files, 103 tests passed (83 gateway, 20 backend); overlaps the preceding focused runs.                                                                                                           |
| `settings-guidance-tests.log`: current settings copy                                                                       | 1 file, 8 tests passed.                                                                                                                                                                            |
| `capture-contract-tests.log`: existing computer contract tests                                                             | 1 file, 6 tests passed.                                                                                                                                                                            |
| `packaging-tests.log`: existing macOS artifact config tests updated for Cua resources/signing                              | 1 file, 8 tests passed.                                                                                                                                                                            |
| Desktop build                                                                                                              | Passed after final broker and identity-export changes.                                                                                                                                             |
| Web build                                                                                                                  | Final build passed in 61 seconds; Vite reported its existing large-chunk warning.                                                                                                                  |
| Fixture build                                                                                                              | Revision 7 built and installed ad-hoc signature verified, including AppKit and gateway targets; run 12 passed the five gateway assertions with mixed original Electron results.                    |
| Broad earlier server run                                                                                                   | Historical: 858 passed, 10 failed, 2 skipped. Its ten failures were cache/socket isolation and a Codex cancellation mock; superseded for this selected scope by the following run.                 |
| `server-integration-final-tests.log`: Computer, gateway, runtime ingestion, startup pending interactions and Codex manager | All 45 selected files passed: 887 passed, 2 skipped. Local socket access was permitted; no real desktop input was issued. This is the integration selection, not the entire repository test suite. |
| `bun fmt`, `bun lint`, `bun typecheck`                                                                                     | **Not run: explicitly not authorized. Required repository gates remain outstanding.**                                                                                                              |

The isolated development server was stopped after verification; ports 58317 and 9860 had no listeners. Fixture runs completed their teardown. The installed fixture and preserved prior builds remain available for review; no user Synara instance was stopped. `git diff --check` passed.

## Release gates

1. **Held-input cancellation:** Cua 0.24.0 exposes no cooperative cancel/held-key-release endpoint suitable for this adapter. Terminating and awaiting its process prevents later native admission, but cannot prove that every key/button down already posted to the OS receives a matching release. Do not claim Stop rolls back input or guarantees this cleanup. Qualify an upstream mechanism or narrow/remove operations that require the missing guarantee before release.
2. **Atomic target validity:** Synara rejects known moved/closed/out-of-bounds targets, but the last check and native dispatch are separate. Qualify rapid move/resize/close/Space transitions and do not describe the current checks as an atomic fence.
3. **Human desktop interference:** background mode does not promise unchanged focus or input isolation. Test simultaneous human typing, app switching and pointer movement only in an explicitly arranged safe session. No personal application was used as an input target here.
4. **Native/application coverage:** resolve variable Electron background click/text delivery; qualify remaining required application, drag/modifier and error cases. AppKit click and explicitly approved Electron foreground text now have passing native evidence. Refusals are valid outcomes but do not count as supported input coverage.
5. **Production host lifecycle:** build/sign/notarize the actual Synara host; grant, restart, revoke/regrant, upgrade and crash it. The current ad-hoc fixture establishes only part of this path.
6. **Display/OS matrix and cost:** diagnose the observed 3.23 GiB driver RSS peak. Mixed scale, secondary monitor, Spaces, relevant macOS versions and load behavior remain unqualified. Measure stable percentiles and incremental resource cost only after required correctness passes.
7. **Repository gates:** execute the required formatting, lint and type checks when authorized, fix any findings and then complete the appropriate final checks. No merge-ready claim is made.

## Comparison with the reviewed Swift proposal

| Concern                   | Current Cua integration                                     | Reviewed Swift proposal                                                                           |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Synara policy/ownership   | Repaired shared stack remains responsible                   | Needs the same shared repairs; changing language does not solve authority                         |
| Native maintenance        | Reuses pinned Cua app policies and native implementation    | Synara would own more private input/observation behavior                                          |
| Ambiguous effects         | Explicit effects; no automatic retry                        | The reviewed path had replay after uncertain native verification; it must be repaired if retained |
| Retirement                | Await actual child exit before replacement                  | Reviewed early replacement admission was a demonstrated defect                                    |
| Held-key cleanup          | Unqualified after forced termination                        | Must also be demonstrated; do not assume Swift fixes it                                           |
| Exact background keyboard | Real two-window same-PID refusal observed                   | No equivalent successful fixture result establishes an advantage here                             |
| Signing/permissions       | Ad-hoc GUI ownership demonstrated; production still pending | A production GUI lifecycle is also required                                                       |
| Performance               | Single Cua samples only; redundant capture remains          | No matching Swift run, so no valid numerical comparison                                           |

The defensible outcome is a bounded Cua integration with explicit unresolved gates. If a required operation fails in Cua and a reviewed, tested Swift implementation demonstrably passes it, revisit the selection using that evidence. Do not ship both paths or invent an automatic retry to hide a failure.
