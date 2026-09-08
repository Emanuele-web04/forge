# Computer-use audit — findings and remediation plan

Branch: `computer-use-linux`
Date: 2026-08-21
Status: **Plan only — no code changes made yet.**

## Scope and method

Deep audit of the computer-use feature added on this branch (~42.5k lines across 126 files): the server `apps/server/src/computer/` stack, `agentGateway/computerTools.ts`, both native components (`native/computer-use-kwin` C++ plugin, `native/computer-desktop-helper` C helper), the gateway/orchestration integration (capability lease, approval routing, decider/reactor), and the web surface (`ComputerPanel` and friends). Audited by six parallel review passes over the TypeScript, plus full manual reads of the KWin plugin C++, the helper C code (`json.c`, `main.c`, `image.c`, structural review of `wayland.c`), and the web pipeline.

Severity: **high** = likely in production; **medium** = edge case or robustness gap with a concrete trigger; **low** = quality/hardening. No critical (exploitable / stuck-input-by-default / data-loss) findings. The security architecture — approval gating, capability leasing, consent flows, native memory safety — held up under review.

## Summary

| ID      | Sev  | Area    | Finding                                                               | Effort |
| ------- | ---- | ------- | --------------------------------------------------------------------- | ------ |
| H1      | high | core    | FakeComputerBackend is the production default off-Linux               | S      |
| H2      | high | kwin    | Provisioning failures memoized forever                                | S      |
| H3      | high | portal  | GNOME path scrolls wheel notches where pixels were meant              | S      |
| H4      | high | portal  | Installed desktop-helper binary trusted forever, no upgrade path      | M      |
| M5      | med  | core    | Chord releases abort on first failure, stranding modifiers            | S      |
| M6      | med  | kwin    | D-Bus well-known name bound without owner validation                  | M      |
| M7      | med  | kwin    | Window titles not clamped to contract; one long title kills the pane  | S      |
| M8      | med  | kwin    | AT-SPI helper can exceed the 8 MiB transport frame                    | S      |
| M9      | med  | core    | Unclamped text into schema-bounded `lastError`/`availability.message` | S      |
| M10     | med  | gateway | `set_value` value and hotkey key array unbounded at tool layer        | S      |
| M11     | med  | ci      | Prebuild supply chain: mutable image tags, unsigned artifacts         | M      |
| M12     | med  | core    | Negative-origin multi-monitor layouts are unclickable                 | M      |
| M13     | med  | portal  | Session handle leak on thrown errors; clipboard fd without deadline   | S      |
| L14–L28 | low  | mixed   | Hardening and polish items (below)                                    | S each |

Proposed execution order: Batch 1 = H1–H4 + M5, M7–M10, M13 (highest risk-reduction; all small except H4, which is medium). Batch 2 = M6, M11, M12. Batch 3 = low items, grouped by file. Every fix lands with the regression test named in its entry. Full `bun fmt` / `bun lint` / `bun typecheck` / `bun run test` pass once per batch.

---

## High findings

### H1 — FakeComputerBackend is the production default off-Linux

- **Location:** `apps/server/src/computer/Layers/ComputerService.ts:48`; wiring in `apps/server/src/serverLayers.ts:209,239`; behavior in `FakeComputerBackend.ts:97-99,125`.
- **Problem:** On any non-Linux host `linux` backend selection is undefined, so the layer falls back to `new FakeComputerBackend()`. Its `probeAvailability()` answers `{kind:"available", backend:"fake"}`, so `supported` computes true: the whole RPC surface, pane, `/ws/computer-frames` route, and agent `computer_*` tools go live against a phantom 1920×1080 desktop with two fake windows.
- **Failure scenario:** User enables Computer control on macOS; the agent "clicks Calculator", reads result "468" from a fabricated UI, reports success. Nothing real happened. Also every call appends to `backend.calls` forever (`FakeComputerBackend.ts:79,447-449`) — unbounded growth on a long-running server.
- **Fix:** In `ComputerServiceLive`, when `linux?.backend` is undefined (non-Linux host), construct `UnavailableComputerBackend` with an `unsupported-platform` availability verdict instead of the fake. Keep `FakeComputerBackend` strictly injectable (tests, CI harnesses that ask for it by name). While there, cap or drop `calls` retention in the fake (ring buffer of the last N entries).
- **Verify:** Unit test: build the service layer with no linux options on a simulated non-linux selection and assert `supported === false` and the availability verdict kind is `unsupported-platform`.

### H2 — Provisioning failures are memoized forever

- **Location:** `apps/server/src/computer/KWinComputerBackend.ts:291,1168-1173`; retry-shape gate at `:1191`.
- **Problem:** `provisionPromises` is set-only and lives for the backend's lifetime, so a rejected provisioning promise replays forever. Additionally, the prebuilt→source second-attempt only runs when the first attempt's action was `"installed-prebuilt"`, so a machine whose first install was from source gets zero second candidates after a KWin upgrade.
- **Failure scenario:** First auto-provision fails transiently (OOM-killed compiler, disk-full, toolchain installed after the attempt, user hadn't logged out yet). Every future connect replays the identical stale error instantly until the server restarts. After a KWin upgrade, a cached success returns the already-refused id so `reprovisionAfterRefusal` cannot produce a fresh candidate.
- **Fix:** Delete the map entry on settlement so it dedups only concurrent callers: `pending.finally(() => this.provisionPromises.delete(allowPrebuilt))`. This drops memoized successes too, so it relies on `provisionPlugin`'s `already-current` stamp fast path (`kwinPluginProvisioning.ts:331`) making repeat calls cheap — that fast path is now load-bearing and must be pinned by test, not just relied on. Widen the second-candidate rule so source-first machines can try prebuilt afterwards (invert today's one-directional gate).
- **Verify:** Test asserting a second `provisionOnce()` after a failed first actually retries; test that a refusal followed by a new manifest version produces a fresh candidate; test pinning that a repeat `provisionOnce()` with a current stamp returns `already-current` without reinstalling or rebuilding.

### H3 — GNOME portal path scrolls wheel notches where pixels were meant

- **Location:** `apps/server/src/computer/portal/portalSession.ts:614-632` + `portalRemoteDesktopInputProvider.ts:75-77`; wrong-unit test pinned at `portalSession.test.ts:193`.
- **Problem:** The tool contract speaks logical pixels everywhere (KWin takes pixels directly; the wlroots helper converts px→notches at 15 px/notch with carried remainder — `wayland.c` `take_discrete_steps`). The GNOME RemoteDesktop provider forwards raw deltas into `NotifyPointerAxisDiscrete`, whose unit is whole wheel clicks.
- **Failure scenario:** `deltaY: -600` produces 600 discrete steps ≈ 40 screens of scroll; a precise 10 px nudge truncates to 0 and does nothing.
- **Fix:** Apply the same conversion before `NotifyPointerAxisDiscrete`: divide by `SCROLL_STEP_PX` (15), carry the sub-notch remainder per axis across calls, matching `wayland.c:36,1212-1218` semantics. Keep the shared constant in sync (it already cross-references).
- **Verify:** Replace the pinning test with one asserting pixel→notch math including remainder carry across two calls; add a cross-tier equivalence test ("one scroll means one thing" on kwin/wlroots/gnome paths).

### H4 — An installed desktop-helper binary is trusted forever

- **Location:** `apps/server/src/computer/portal/desktopHelperInstall.ts:147-149`; pinned as correct by `desktopHelperInstall.test.ts:227`.
- **Problem:** Resolution order returns _any_ executable already at `~/.local/share/synara/computer/synara-computer-desktop-helper` without consulting the shipped manifest's checksum or version. There is also no version field anywhere in `DesktopHelperPrebuild`, so once installed, the helper is never upgraded.
- **Failure scenario:** A truncated/corrupt local build or post-install tampered binary is auto-executed by the server on every use. And a shipped security fix to the C (e.g., the strtod overread fixed in a9114b6ca) never reaches existing installs until the user manually deletes the file.
- **Fix:** Mirror `kwinPluginProvisioning.writeInstallStamp`: stamp the install with the manifest entry's sha256 (and arch/os tuple) at first copy; on resolve, re-verify the installed bytes against the stamp, and re-install atomically when the shipped prebuilt differs. Add a protocol-version field to the helper handshake (`HELPER_PROTOCOL_VERSION` already exists) and treat mismatches as reinstall triggers.
- **Verify:** Tests: corrupt installed binary → replaced from bundle; newer shipped manifest → upgraded in place; stamp-missing → re-verified rather than blindly executed.

---

## Medium findings

### M5 — Chord releases abort on first failure

- **Location:** `apps/server/src/computer/pointerSequencing.ts:185-189` (`pressHotkeyStrokes` finally loop), same shape at `:158-162` (`pressKeyStroke`) and `:200-205` (`pressButtonOnce`). Verified by direct read.
- **Problem:** The release loops `await sink.key(code,false,…)` unguarded; the first rejection throws out of `finally` and skips every remaining release.
- **Failure scenario:** Worst on the portal path, where a release is one D-Bus `notify()` that can fail transiently while the session survives: Ctrl latches **on the human's keyboard** until backend disposal. On Tier 1 a restarted plugin session clears devices, but a method-level refusal on one release strands the rest on a live session.
- **Fix:** Run every release, collecting errors: wrap each `await` in try/catch, continue the loop, throw the first error (or an aggregated error) after the loop completes. Same treatment in all three functions.
- **Verify:** Test: make the middle release reject; assert remaining releases were still attempted and the original press error (or aggregate) surfaces. Mirror for button-once and key-stroke shift-release.

### M6 — D-Bus well-known name bound without owner validation

- **Location:** `apps/server/src/computer/kwinDbus.ts:153-161` (`connectPlugin` binds `org.synara.ComputerUse` directly), `KWinComputerBackend.ts:1156`; same hole in `install-and-load.sh:411-414` health check.
- **Problem:** After `LoadPlugin` succeeds, the backend talks to whichever process owns the well-known name — no `GetNameOwner` pinning, no unique-name comparison, no check the owner corresponds to the generation just loaded.
- **Failure scenario:** (a) A stale duplicate Synara instance (or any same-session squatter) owning the name silently receives every `movePointer`/`key`/`button`/`captureWindow` call and can serve forged `stateJson`/screenshots the agent then acts on; (b) an unload race leaves a previous generation owning the name and the backend drives the wrong build.
- **Fix:** Resolve the unique bus name of the owner immediately before first use; assert it changed across the `LoadPlugin` boundary (or have `healthJson` echo the loading pid/plugin build id and verify it matches what we loaded). Apply the same check in the install script's health probe.
- **Verify:** Test simulating an owner change between load and connect → connect refuses with a classified error; script-level: health probe fails loudly when the reported build id differs.

### M7 — Window titles/app names not clamped to contract

- **Location:** `apps/server/src/computer/computerGeometry.ts:118-155` vs `packages/contracts/src/computer.ts:270-271` (`COMPUTER_LABEL_MAX_LENGTH = 1024`, list cap 512).
- **Problem:** `parseWindows` copies `title`/`appName` verbatim and does not cap the window count or `occludedBy` arrays. This is exactly the bug class f33159dfd fixed for AT-SPI labels, missed for window titles. (The plugin's `windowsJson` emits unbounded occluder lists — N² in the worst case — so the TS side must clamp.)
- **Failure scenario:** One app sets a >1024-char title (browsers/SPAs do): every `list_windows`/`get_state` response and every `windows-changed` push fails schema encode at the RpcServer boundary — the whole pane and event stream die for every thread over one string.
- **Fix:** Clamp `title`/`appName` with the existing surrogate-safe truncation helper used by `atspiTreeTargeting.ts:212-218`; slice the windows list to 512 and `occludedBy` to a sane cap (e.g. 32) before constructing contract objects.
- **Verify:** Boundary tests: >1024-char title, >512 windows, deep occluder list — assert encode succeeds and values are truncated.

### M8 — AT-SPI helper can exceed the 8 MiB transport frame

- **Location:** `apps/server/native/../atspi_helper.py:72-120` (uncapped `label`/`value`/`description` serialization), transport cap `atspiClient.ts:16`; silent swallow at `KWinComputerBackend.ts:591-595`.
- **Problem:** MAX_NODES=2048 leaves ~4 KiB/node average budget; dense Chromium/Electron accessibility trees with paragraph-sized names blow past the client's 8 MiB newline-framed cap. The TS-side clamps run only after the frame has crossed the wire.
- **Failure scenario:** `read-tree` builds a >8 MiB line → transport error → reset + backoff → perception silently disappears for that app; every retry respawns the helper and repeats.
- **Fix:** Truncate name/value/description in the Python helper itself (e.g. 1024 chars each, UTF-8-safe) before `json.dumps`. Optionally drop the node when even the truncated shape would exceed a per-node byte budget.
- **Verify:** Helper test feeding a tree with megabyte-scale accessible names; assert emitted line stays under the client cap and parsing still succeeds.

### M9 — Unclamped backend text into schema-bounded fields

- **Location:** `KWinComputerBackend.ts:521-524` (`availability().message` ← raw `failure.message`), `ComputerManager.ts:1312` (`lastError` ← `errorMessage(error)`); rule stated at `packages/contracts/src/computer.ts:49-54`.
- **Problem:** Both fields are schema-bounded at 2048 chars and the contract requires producers to clamp before payload assembly. Health paths comply via `ComputerHealthState.recordFailure`; these two sites don't.
- **Failure scenario:** One long D-Bus diagnostic makes `WsComputerGetThreadStateRpc.success` encoding fail — the getThreadState RPC errors and thread-state pushes break for that thread until the message changes.
- **Fix:** Route both sites through `clampComputerMessage(...)`.
- **Verify:** Test injecting an oversized backend error; assert getThreadState encodes and the stored message length ≤ 2048.

### M10 — Tool-layer bounds missing where schemas are advisory

- **Location:** `apps/server/src/agentGateway/computerTools.ts:829` (`set_value` reads `value` with `readRawRequiredString` — no bound) and `:795` (`hotkey` keys via `readStringArrayArg` — no item-count/item-length bound). MCP args are never validated against schemas (the file says so itself at `:252-259`).
- **Failure scenario:** `set_value` accepts up to the 1 MiB body cap; when the AT-SPI write falls back to `typeText`, the backend types it character-by-character over D-Bus while holding the exclusive lease and the turn for hours. Thousands of hotkey keys each become a press/release pair holding the seat indefinitely.
- **Fix:** Enforce `COMPUTER_TEXT_MAX_LENGTH` on `set_value.value` exactly as `readRequiredText` does; enforce `minItems/maxItems` (16) and per-key length on the hotkey array. Add the missing bounds for symmetry to `performAction.action` (contract caps 256).
- **Verify:** Tool-layer tests mirroring the existing drag-duration clamp tests: oversize `set_value`, oversized key array → structured refusal before dispatch.

### M11 — Prebuild supply chain hardening

- **Location:** `.github/workflows/desktop-helper-prebuilds.yml:57-62` (mutable tags: `archlinux:latest`, `opensuse/tumbleweed`), `:117,189,205` (tag-pinned actions); same posture in `.github/workflows/kwin-plugin-prebuilds.yml`. Artifacts execute with session-compositor authority; rolling entries rebuild monthly on schedule so provenance drifts.
- **Fix:** Pin container images by digest; pin actions by commit SHA; sign the assembled manifest (minisign/cosign) in CI and verify the signature in `desktopHelperInstall` / `kwinPluginProvisioning.verifyPrebuilt` before checksum comparison. Note: signing adds a key-management obligation — if that is too heavy for now, digest-pinning + SHA-pinned actions is the minimum bar.
- **Verify:** `desktopHelperPrebuilds.workflow.test.ts` extended to assert digest-pinned images; install path refuses an unsigned/mismatched-signature manifest (unit test with fixture).

### M12 — Negative-origin multi-monitor layouts are unaddressable

- **Location:** `uiTreeTargeting.ts:94-97` and `computerGeometry.ts:198-218` (`resolveComputerPoint` refuses x/y < 0, treats (0,0) as top-left) while `workspaceRectFromWindows` faithfully preserves negative workspace origins (plugin reports `Workspace::geometry()` raw, plugin cpp `windowsJson`); input coordinates forwarded untranslated (`KWinComputerBackend.ts:1416-1423`); window-scoped containment check refuses at `ComputerManager.ts:1104`.
- **Failure scenario:** Monitor arranged left/above primary: its windows report negative-origin bounds the coordinate space cannot address; screenshots cover the region fine, so the model sees pixels it can never click.
- **Fix:** Introduce an explicit agent-space↔global-space translation anchored on the workspace origin: either (a) translate at the `KWinComputerBackend` boundary so agent space stays 0..screenSize and all downstream math is unchanged, or (b) normalize geometry to positive space in `parseWindows`. Option (a) is preferred — single choke point, no contract change.
- **Verify:** End-to-end unit test with a negative-origin workspace fixture: screenshot region mapping, point resolution, and click delivery all agree on the translated space.

### M13 — Portal lifecycle leaks

- **Location:** `portalSession.ts:297-373` — failure _code_ paths call `closeSession`, but a thrown error (timeout on `SelectSources`/`CreateSession`, bus error between CreateSession and Start) propagates without closing the created handle; `portalSelectionClipboardProvider.ts:145-168` — fd transfer resolves only when the writer closes the pipe.
- **Failure scenario:** Retry after a thrown open() opens a second portal-side session while the first lives until bus drop. A stalled paste target hangs `computer_read_clipboard` forever (the 10 s bus timeout covers only the fd handout).
- **Fix:** Wrap post-CreateSession steps in try/finally closing `sessionHandle` on any throw. Race the clipboard socket read against a timeout (10 s) and destroy on loss.
- **Verify:** Test forcing SelectSources to throw → session handle closed (assert via fake portal service call log); clipboard stall test with a never-writing fd → timed-out structured error.

---

## Low findings (batch by file)

**kwinPluginProvisioning.ts**

- L14: Non-atomic writes — `ensureEnvScript`/`writeInstallStamp` use plain `writeFile` into `~/.config/plasma-workspace/env/synara-computer-use.sh`, which Plasma sources at every login; crash mid-write wedges session env. Use temp+rename like `install-and-load.sh:449-459`. Also validate prebuilt-manifest `file` fields against path escapes (`:165-175`) and `sha256` as 64 hex chars.

**codexAppServerManager.ts**

- L15: `acceptForSession` on the new `"tool"` kind flips the whole session to `approvalPolicy:"never"` + `dangerFullAccess` (`:2155-2157`, `:683-687`). Honor `_meta.persist` scoping instead of a global override, or gate the override to command/file-change kinds; at minimum adjust approval-card copy.
- L16: Forks lease base capabilities only (`:1873`) — propagate `enableComputerControl` through `ProviderForkThreadInput` or surface the loss at fork time.

**evdevInput.ts**

- L17: QWERTY synthesis is CapsLock-blind (`:244-260`): uppercase relies solely on Shift, so host CapsLock on → `typeText("Hello")` lands `hELLO`. Read the plugin's locked-modifiers state (it tracks its own xkb state) and invert the Shift decision when CapsLock is latched; document the limitation where it can't be detected.

**Portal misc**

- L18: Probe frozen for process lifetime (`PortalComputerBackend.ts:146,177-180`) — re-probe when a capability refusal fires or on panel refresh.
- L19: Boot-time probe installs the helper binary (`probe.ts:249-282`), contradicting ca9408761's "install nothing until someone uses the desktop". Either defer `resolveDesktopHelper` to first connect or amend the design-doc claim (pick one; deferral preferred).
- L20: `foreignToplevelWindowProvider.ts:32` reports human activation as `focused` — set `focused:false`, keep `active`, matching the GNOME provider convention (`gnomeShellWindowProvider.ts:288-315`), before the helper ever grows geometry.
- L21: `gnomeShellWindowProvider.ts:149` `closeWindow` is unreachable dead surface — delete.

**Core misc**

- L22: `ThreadComputerState.cursor` declared, spread, never assigned (`ComputerManager.ts:98,1395`) — the web agent-cursor dot (`ComputerPanel.tsx:395`) is dead code as a result. Wire backend pointer position into publishes, or remove the field and the overlay.
- L23: Web pane drops input silently at queue limit — `sendInput` ignores `push()`'s return (`ComputerPanel.tsx:133`); surface a transient "desktop busy" message on drop (wire `onDrop`).
- L25: Overlapping `attachStream` orphans the frame interval (`KWinComputerBackend.ts:868-878`) — clear the pending interval again after the `ensurePlugin` await.
- L26: `recordError` writes `lastError` on all threads without publishing (`ComputerManager.ts:1443-1446`) — debounce-republish so stream attach failures reach the panel.
- L27: Concurrent publishes can emit duplicate versions (`ComputerManager.ts:1281-1318`) — per-thread promise chain around `publish`.
- L28: `sessionBusNames.ts:88-91` removes error/disconnect listeners before `bus.disconnect()` — reorder; `frameTransport.ts:303-311` tracks `queuedBytes` but never enforces it — apply the byte cap alongside the count cap.

**Plugin/scripts**

- L29: Plugin `movePointer`/`axis` accept non-finite doubles (NaN survives the clamps, reaches `wl_fixed_from_double`); add `isfinite` guards in the plugin entry points.
- L30: `synara-kwin-computer-use-rebuild.path` watches only `/usr/lib64/*` ABI paths and hardcodes `~/Projects/synara` — derive watch globs and checkout path from the same sources `KWIN_CMAKE_CONFIG_PATHS` uses (`KWinComputerBackend.ts:143-148`).
- L31: `wlClipboard.ts:222-234` `ChunkBuffer.push` drops the overflowing chunk wholesale making post-limit `stdout.text()` an arbitrary prefix — harmless today, trap later; make overflow throw deterministically.
- L32: `appLaunchResolution.ts:337-348` enumerates absolute search paths (incl. `$HOME/...`) into model-facing errors — name the searched kinds, not paths.
- L33: `atspiClient.ts:120-134,175` — SIGTERM-only helper teardown without SIGKILL escalation; backoff timer not unref'd. Escalate after a short grace; `unref()` the timer.
- L34: `AgentGateway.ts` `surfacedComputerControlDenials.clear()` wholesale at 512 — FIFO eviction instead.
- L35: `packages/contracts/src/rpc.ts:678-680` comment describes unbuilt WS capability gating — rewrite to describe the real split (agent access = MCP gateway + capability lease; human access = authenticated pane socket, turnless).
- L36: Docs drift — `docs/computer-use-design.md` "install nothing" claim vs boot-time probe install (resolve together with L19).

---

## Test coverage gaps to close alongside

1. Failed-release continuation inside chord/button sequences (with M5).
2. Provisioning retry-after-failure and fresh-candidate-after-refusal (with H2).
3. Cross-tier scroll equivalence: one pixel delta means the same thing on kwin / wlroots / gnome (with H3).
4. Helper upgrade/re-install and stamp verification (with H4).
5. Contract-clamp boundaries: >1024-char titles, >512 windows, oversized backend errors (M7/M9).
6. Oversized AT-SPI frames staying under the transport cap (M8).
7. Negative-origin workspace end-to-end mapping (M12).
8. Reactor-level `computerControlChanged`: legacy-session `?? false` comparison, cache updates, resume-cursor retention on computer-control-only restarts.
9. Frame-route auth wiring integration test (authorizeUpgrade ordering, token rejection).
10. Natural idle-expiry handover returning the retryable lease error to the original owner.
11. A pin on `PROVIDERS_WITHOUT_APPROVAL_GATE` contents so a new gate-less provider can't drift in silently.
12. Shell provisioning under shellcheck/bats in CI (numbering, visibility-before-unload, void-reply tolerance are regression-prone).

## Verified solid — deliberately not changing

For the record, these were checked and found correct; fixes above must not regress them:

- Approval/capability model: every mutating tool in `COMPUTER_APPROVAL_REQUIRED_TOOLS` (pinned by test); `read_clipboard` approval-required without `readOnlyHint`; `computer:control` opt-in only via `additionalCapabilities`, derived in one place, `=== true` strictness; per-call server-side capability checks keyed off the bearer-token thread id (cross-thread lease use impossible); elicitation routing fail-closed.
- Lease mechanics: check-and-set claim, takeover requires staleness + zero in-flight calls, idle expiry suppressed mid-call, release on terminal events.
- KWin plugin: exactly-once resource injection with oldest-resource rationale; pressed buttons/keys released before detach on all four stop paths; direct-injection leaves gated on human seat ownership; capture latch released on every failure path incl. both watchdogs; 16384px/64MP limits with overflow-guarded math; QPointer lifetimes throughout.
- Helper C: depth-capped exact-size JSON parser; fd-3 verified before `wl_display_connect`; bounded strtod copy; oversized-line recovery preserving sibling requests; registry version caps everywhere; release-vs-destroy per interface version; release-all on destroy.
- Consent/privacy: restore tokens 0600 atomic O_NOFOLLOW; consent dialog unbypassable, denial latched, revocation races guarded; post-action screenshots can't substitute the human's focused window.
- Web: uint32 sequence-gate wraparound math; single-flight latest-wins decode; generation-guarded reconnect/backoff; letterbox mapping correct incl. HiDPI; hotkey-style key forwarding (no stuck-modifier class possible from pane input); disclosure-motion convention honored.
