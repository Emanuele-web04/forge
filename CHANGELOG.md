# Changelog

## 0.6.3 - 2026-07-27

### Added

- Added explicit control, user, and normal orchestration lanes so stop, interrupt, and settlement commands drain ahead of new turns and background projection work without weakening reserved-capacity or shutdown admission rules.
- Added a compensating checkpoint-revert saga that captures the pre-revert worktree in a managed rescue ref and restores it if provider conversation rollback fails.
- Added deterministic, retryable revert completion and user-visible failure activities that identify retained rescue refs when manual recovery may be needed.
- Added bounded provider-command attempts and urgent lifecycle control so one unresponsive adapter or per-thread lock cannot stall every task.

### Changed

- Reworked provider lifecycle coordination and runtime reconciliation across Codex, Claude, Cursor, and ACP sessions so durable commands, terminal events, ownership, generations, and restart recovery converge on one session state.
- Unified checkpoint cwd resolution, validation, ref encoding, cleanup, and recovery behavior across file-only undo, conversation rollback, and edit-and-resend.
- Improved thread snapshot projection, visible-detail retention, store normalization, and refresh re-arming across lease, subscription, eviction, and reconnect races.
- Improved provider runtime activity attribution so late or replayed terminal events settle the intended turn without duplicating work-log output.
- Changed grouped file-change undo to revert every represented turn newest-first and stop on the first failure rather than silently leaving the card partially applied.
- Bumped Synara release package versions to `0.6.3` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed stop and interrupt actions being starved behind a saturated queue, rejected during overload, or blocked indefinitely by a wedged provider start.
- Fixed new turns being admitted while the orchestration engine was quiescing, which could orphan work during shutdown.
- Fixed Claude terminal results without live turn state leaving a thread permanently marked as running, and bounded Claude interrupt acknowledgements that could otherwise hang their caller.
- Fixed provider delivery timeouts holding the process-wide delivery lock forever; uncertain outcomes now settle explicitly for later reconciliation.
- Fixed checkpoint revert requiring a live provider session, diffing the wrong checkout, mutating before checkpoint validation, or trimming a provider conversation twice after a half-applied retry.
- Fixed invalid rescue-ref names for subagent thread identifiers, ineffective rescue-ref leak assertions, and unnecessary full-tree snapshots for no-op conversation rollbacks.
- Fixed stale Claude resumes leaving task chips stranded or retrying a native conversation that the provider had already reported missing.
- Fixed queued follow-ups being accepted while no real active turn existed, which could swallow the message instead of dispatching it.
- Fixed the newest live answer collapsing into a completed disclosure while provider terminal state was still converging.
- Fixed failed stop controls producing no visible explanation in the composer or keyboard shortcut path.
- Fixed visible thread details being evicted or losing a refresh race and temporarily rendering as an empty conversation.
- Fixed profile-stat cleanup purging soft-deleted threads without evidence of a manual delete, and retention sweeping archived or newly created fork and handoff threads because of inherited message timestamps.

### Verification

- `bun run fmt:check` passed across 15,536 files.
- `bun run lint` passed with 300 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only the existing TS44 informational schema messages remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful.
- Full `bun run test` passed with all 8 Turbo tasks successful in 11m14.547s. Web passed 264 files / 3,255 tests; server/CLI passed 279 files / 2,988 tests with 2 skipped files / 7 skipped tests. No targeted reruns or flaky failures were needed.

## 0.6.2 - 2026-07-27

### Added

- Added universal live tool activity across supported providers, with normalized running and settled states, consistent labels, expandable details, and transcript interactions.
- Added a configurable follow-up dispatch mode so messages sent during active work can either queue for the next turn or steer the current turn.
- Added an `Unblock thread` recovery action for provider-delivery quarantines; blockers are abandoned oldest-first and skipped turn starts are replayed without resending an ambiguous command.
- Added local customization for the Void space name and icon, including validation, reset behavior, and consistent presentation across the sidebar, Space switcher, project pickers, and project creation.
- Added dedicated automation-run handling, explicit completion policies, and authorized automation self-cancellation.
- Added bounded Electron renderer-crash recovery with reload limits and actionable recovery prompts.
- Added server-side working-tree diff statistics and shared unified-patch parsing so large diff totals no longer require transferring complete patches to the client.
- Added React Compiler parity coverage for chat, picker, hook, and shared UI hot paths.

### Changed

- Reworked reconnect reconciliation so provider status, active turns, work logs, and terminal thread projections converge to the server snapshot without stale refreshes winning races or settled tasks polling indefinitely.
- Batched stale thread-detail eviction and reconciled ownership across lease, reconnect, snapshot, and subscription-retention boundaries.
- Reduced startup and steady-state work by lazily loading provider and diff-parser dependencies, caching login-shell environment probes, reusing in-memory orchestration state, selectively preloading route chunks, and throttling supervised-process descendant scans.
- Hardened automation scheduling, projection, persistence, completion, and cancellation lifecycles for unattended work.
- Hardened desktop and server process management across executable discovery, shell-environment hydration, backend supervision, terminal wrappers, managed worktrees, Git status broadcasting, and replacement of stale processes.
- Enforced exclusive SQLite ownership and expanded verified retention, reclamation, and cleanup behavior for migration backups and interrupted update artifacts.
- Simplified subagent activity in the transcript and consolidated live and settled tool presentation around the shared work log.
- Reorganized Settings by user intent and consolidated shared settings cards, empty states, elevated surfaces, and hover styles.
- Improved completion notifications so bounded Markdown summaries preserve fenced and nested code, technical context, references, delimiters, and turn-scoped copy while remaining safe to render.
- Improved composer command-menu loading and empty states, shared picker styling, and React Compiler-friendly code paths.
- Bumped Synara release package versions to `0.6.2` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed universal tool rows that could duplicate, lose interactions, regress after settlement, or remain visually active after a tool or turn reached a terminal state.
- Fixed stale live thread projections after reconnect, including delayed refresh races, mismatched repair identity, stale terminal turns, and polling that continued after convergence.
- Fixed provider status disappearing or being replaced by stale data while a reconnect refresh was in flight.
- Fixed unowned thread details surviving lease, reconnect, and snapshot races.
- Fixed permanently quarantined threads that previously exposed the delivery blocker but offered no client recovery path.
- Fixed desktop renderer crashes that could leave Synara blank instead of recovering within a bounded retry policy.
- Fixed competing SQLite access that could proceed without proving exclusive database ownership.
- Fixed startup overhead from repeated shell probes, eagerly loaded provider SDKs and diff parsers, redundant orchestration reads, and over-frequent process-tree inspection.
- Fixed orphaned or interrupted migration artifacts not being reclaimed under the expanded retention policy.
- Fixed Windows `Ctrl+-` zoom behavior while preserving native menu shortcuts, browser-guest shortcuts help, and cross-platform shortcut boundaries.
- Fixed completion notifications that could flatten or truncate fenced code, nested inline code, Markdown references, technical detail, or delimiter-sensitive text.
- Fixed composer command-menu state transitions and exact-optional browser fixture typing when no empty-state label is supplied.
- Fixed completion-summary parsing when a closing inline-code run is absent.
- Fixed a default-parameter call in `ChatView` that caused React Compiler to bail out of a protected hot path.
- Fixed macOS release artifact builds exhausting Node's default heap while bundling the production web client.
- Fixed the landing project heading inheriting the wrong text color.

### Verification

- Final `bun run fmt:check` passed across 15,535 files.
- Final `bun run lint` passed with 296 warnings and 0 errors.
- Final `bun run typecheck` passed across all 7 packages after fixing two release-blocking exactness checks; only existing TS44 informational messages and Astro deprecation notices remained.
- `bun run release:smoke` passed across the 1,448-package dependency graph.
- `bun run build` passed with all 5 Turbo tasks successful; existing Astro/Vite deprecations, plugin timing notices, and large-chunk warnings remained non-blocking.
- Full `bun run test` passed with all 8 Turbo tasks successful in 10m58.197s after fixing one React Compiler bailout. Web passed 264 files / 3,250 tests; server/CLI passed 278 files / 2,951 tests with 2 skipped files / 7 skipped tests; desktop passed 39 files / 362 tests with 1 skipped file / 5 skipped tests; shared passed 41 files / 424 tests with 1 skipped test; contracts passed 13 files / 135 tests; scripts passed 13 files / 83 tests.
- Focused reruns passed for completion-notification logic (48 tests), the composer command menu (4 browser tests), and React Compiler hot-path parity (12 tests). No flaky test was identified.

## 0.6.1 - 2026-07-25

### Added

- Added guarded desktop recovery for the interrupted or partially applied migration state that could leave some 0.6.0 databases unable to start.
- Added migration-lineage validation and replay coverage, including a Windows CI gate for the recovery path.
- Added dynamic, state-specific icons to automation rows.
- Added a project picker directly to the new-task heading.

### Changed

- Simplified project, Space, and Studio navigation and normalized restored Studio workspace metadata so tasks reopen in the correct location.
- Refactored desktop backend supervision, shutdown, and process-tree teardown so replacement and restart only proceed after the previous runtime is proven stopped.
- Reduced redundant projection, thread-detail subscription, terminal-state, and sidebar work during active conversations.
- Aligned Pi model discovery with the current ModelRuntime SDK and tightened Claude, OpenCode, Codex, Cursor, Droid, Grok, and Antigravity session lifecycle handling.
- Bumped Synara release package versions to `0.6.1` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed 0.6.0 database recovery when a migration had committed schema changes without advancing the recorded lineage, while preserving verified backups and resumable recovery markers.
- Fixed migration replay across historically edited migration files and rejected unsafe lineage mismatches before application startup.
- Fixed desktop startup and shutdown races, including Windows backend termination, stale process replacement, and misleading startup-block diagnostics.
- Fixed diff view toggles, stale Git status refreshes, and Select All copying only the rendered portion of a virtualized diff.
- Fixed stale OpenCode plan-agent state, Pi model discovery, Claude resume and permission edge cases, and provider process teardown after interrupted sessions.
- Fixed project heading colors, empty-chat project selection, Space routing, and restored Studio task workspace paths.
- Fixed outbound HTTP pinning so Happy Eyeballs behavior remains available.

### Verification

- `bun run fmt:check` passed across 15,501 files.
- `bun run lint` passed with 290 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing TS44 informational JSON/schema-preference messages and Astro/Vite deprecation notices were reported.
- `bun run release:smoke` passed and retained the pinned dependency graph.
- `bun run build` passed with 5 successful Turbo tasks; existing Astro/Vite deprecations and tsdown/plugin timing warnings remain non-blocking.
- Full `bun run test` passed with 8 successful Turbo tasks in 16m15.769s. Web passed 256 files / 3,107 tests; server/CLI passed 274 files / 2,860 tests with 2 skipped files and 7 skipped tests; all remaining package suites passed. No targeted reruns were required.

## 0.6.0 - 2026-07-24

### Added

- Added the Synara Agent Gateway, a built-in MCP app-control surface automatically available to supported provider sessions so agents can understand and operate Synara itself.
- Added 23 internal Synara MCP tools for discovering context and capabilities; listing projects and tasks; reading transcripts; waiting for one or many tasks; creating one task or an exact parallel batch; continuing, steering, queuing, or interrupting work; renaming and archiving tasks; and inspecting activity, orchestration events, provider runtime events, and synthesized diagnostics.
- Added durable, idempotent multi-task creation across providers and models, with isolated worktrees, explicit target selection, privilege caps, crash recovery, operation ownership, compensation, result waiting, and visible provenance for agent-created work.
- Added agent-facing MCP tools for creating, suggesting, listing, viewing, replacing, pausing, deleting, remembering, and reporting results from Synara automations.
- Added guided External MCP integrations for Codex, Claude Code, and other agentic MCP clients, plus copy-ready manual configuration for Claude Desktop and clients that cannot complete the setup prompt.
- Added a one-prompt external setup flow for agentic clients with resumable pairing, automatic local stdio configuration, connection verification, and the exact executable and Synara data directory from the running installation.
- Added External MCP tools for one-call workspace overview, allowed-project discovery, provider/model capability discovery, idempotent task creation, bounded task waiting, and paginated task reading.
- Added all-or-selected project authorization, expiring and revocable credentials, capability-filtered tool catalogs, per-minute and active-task limits, durable request replay, and explicit advanced permissions for project-wide task reading, local-checkout execution, and full-access execution.
- Added Project Spaces with names, curated icons, persisted ordering, project assignment, drag-and-drop movement, bulk moves, activity indicators, and a Void view for unassigned projects.
- Added `Cmd/Ctrl+Alt+1–9` Space switching, shortcut labels in tooltips and the shortcuts sheet, and inline Space creation while adding a project.
- Added first-class Claude Task subagents as navigable child tasks with live status, recent tool traces, usage, model and effort information, steering, stop-all, and foreground/background controls.
- Added live workflow run cards with phases, agent metrics, saved run identity, pause and resume, optional phase filtering, and explicit background-state notices.
- Added cross-task composer mentions that attach bounded recent transcript context from another Synara task with its project and provider identity.
- Added a global Commit and Push shortcut that follows the active task's available Git action.
- Added configurable AppSnap global shortcuts with validation, persistence, and conflict detection.
- Added an isolated Synara Canary workflow for clean-checkout desktop testing and attachment uploads.
- Added a Studio folder row that opens the selected folder in the platform file manager.

### Changed

- Agents now receive explicit Synara operating guidance: when to delegate parallel work, wait for every requested result, prefer Synara diagnostics over raw database inspection, respect worktree and full-access boundaries, and suggest rather than silently enable automations.
- Agent-created and externally created work remains ordinary standalone Synara tasks with visible origin, independent lifecycle, and results that users and other agents can follow.
- External MCP setup defaults new work to managed worktrees and approval-required execution; higher-impact runtime modes remain separate explicit grants.
- External MCP credentials use a dedicated audience and never appear in client configuration. Pairing uses a short-lived code, stores the resulting credential privately, and verifies the live loopback runtime before forwarding authority.
- Automations now support standalone and heartbeat modes, persistent memory, heartbeat cooldowns, notification and completion policies, maximum runs, proposal review, run envelopes, and runtime reconciliation after interruptions or restarts.
- Automation lists now separate active and paused work, spell out cadence and next-run timing, and surface failed, cancelled, interrupted, approval-blocked, unread, and review-needed states directly in each row.
- Manual turns preserve their selected runtime and environment modes when they supersede automation work, and superseded heartbeat runs settle as interrupted.
- Project creation now uses a dedicated searchable dialog and shared picker surfaces across project, model, provider, and settings controls.
- Studio shows Git controls only when its selected folder is a repository; ordinary folders no longer imply that Git must be initialized.
- Live and attention-needing tasks receive clearer sidebar priority, while cross-task attribution is simplified to a single Synara label.
- Workflow and subagent chrome now uses one calmer stacked surface with state-driven color, compact phase pills, aligned rows, hover actions, and concise model labels.
- Chat Markdown headings now have visible hierarchy instead of rendering like body text.
- Provider and model picker popups retain a stable width and use more consistent spacing.
- Fast mode moved into the effort header.
- New-thread model discovery begins from sidebar intent so the composer more often opens with provider choices already available.
- New-chat navigation and persisted draft and terminal writes now defer non-critical work to improve first paint.
- Independent attachment reads and checkpoint resolution run concurrently at turn start.
- Streaming projection uses fewer SQL operations and avoids redundant nested savepoints.
- The React Compiler was upgraded and enabled across substantially more of the web app; redundant memoization and dead interface code were removed.
- The application architecture received a broad maintainability pass: the web store, composer drafts, chat, transcript, and sidebar controllers were decomposed; duplicated domain, protocol, browser, and runtime logic was consolidated; and obsolete modules and the retired internal ACP compatibility package were removed.
- Provider ACP handling now uses the official Agent Client Protocol SDK rather than the retired internal compatibility package.
- Provider callback and event ingress is now bounded, and restart reconciliation repairs provider and terminal activity that could otherwise drift during bursts or interrupted sessions.
- Provider updates install into the same npm prefix as the detected executable, preventing a successful update from landing in a different Node installation.
- The CLI publish flow now builds an isolated package stage and includes the migration-backup restore executable.
- The running-task spinner is slimmer and slower, dialog and input chrome is more consistent, composer picker rows are easier to scan, sidebar branding is quieter, and the retired World Cup playground has been removed.
- Bumped Synara release package versions to `0.6.0` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed Synara browser-control discovery and desktop browser RPC negotiation, session ownership, teardown, reconnect, and fixture readiness.
- Fixed blank provider `PATH` defaults being rejected or replaced incorrectly.
- Fixed MCP `serve` and `pair` ignoring `--home-dir`, which could connect an integration to the wrong Synara data directory.
- Fixed External MCP trust and lifecycle boundaries around credential selection, pairing retries, restart discovery, concurrent waits, cancellation, capacity compensation, revoked or expired credential checks, and loopback-only enforcement.
- Fixed External MCP documentation omitting the primary `synara_overview` discovery tool and describing a superseded client-picker setup flow.
- Fixed Agent Gateway privilege-escalation paths so approval-required or worktree-isolated callers cannot create or control higher-privilege tasks by proxy.
- Fixed gateway credentials leaking into spawned shell subprocesses and preserved that exclusion through Codex overlay rewrites.
- Fixed agent task creation recovery, cleanup ownership, shared-session queue reservations, wait behavior, deleted-caller authority, and interrupted worktree cleanup.
- Fixed `synara_list_projects` exposing system-managed Chat, Studio, and legacy Home containers as ordinary projects.
- Fixed task-list truncation counts and pinned parent/child sidebar behavior.
- Fixed active-turn checkpoint revert races; undo is rejected while provider work is genuinely in flight but remains available after terminal errors.
- Fixed queued sends and steers racing task settlement or provider-session ownership.
- Fixed manual turns inheriting stale automation or agent dispatch origin.
- Fixed Claude reroute pinning, excessive transcript replay, thinking and effort restarts, stale resume behavior, rate-limit blowups, and background-task process shutdown.
- Fixed Claude subagent stops being resurrected by late messages, parent interrupts being cleared by child events, background actions targeting already-backgrounded work, and final workflow snapshots being overwritten.
- Fixed OpenCode quiet-completion detection following stale rather than latest activity.
- Fixed OpenCode `/review` being forwarded as plain text instead of opening Synara's review flow.
- Fixed unmapped Codex child events contaminating the owning task.
- Fixed the Claude context meter ignoring `autoCompactWindow`, failing to refresh after live changes, or carrying stale values through handoffs.
- Fixed Pi discovery omitting authenticated Claude Fable 5 and Opus 4.8 models.
- Fixed namespaced Cursor and Grok ACP model identifiers and ACP permission-mode handling across Cursor, Droid, Grok, and OpenCode.
- Fixed Antigravity's global capture hook launching the Synara GUI outside active sessions.
- Fixed provider update success messages when a second Node or npm installation remained selected.
- Fixed file-icon lookup keys such as `constructor` or `__proto__` crashing a conversation.
- Fixed duplicate composer clearance and preserved transcript scroll position when stacked panels change.
- Fixed global new-task creation using stale rather than latest project state.
- Fixed Windows desktop shutdown so the backend and WebSocket clients stop reliably before quit.
- Fixed macOS DMG and update finalization and preserved the x64 update manifest in universal release metadata.
- Fixed durable secret writes and thread-deletion cleanup so interruption or restart cannot leave empty credentials, resurrect queued turns, or repeatedly retry deleted work.
- Fixed pull-request review badges briefly showing incomplete counts.
- Fixed macOS `Cmd+K` search while leaving native `Ctrl+K` line editing available.
- Fixed missing project directories being reported as "Codex not installed"; Synara now identifies the missing working directory and offers relocation guidance.
- Fixed automation heartbeat cooldown incorrectly throttling an automation's own next run.
- Fixed automation memory writes requiring redundant IDs or content fields when the active automation context already identifies the target.

### Verification

- `bun run fmt:check` passed across 15,490 files.
- `bun run lint` passed with 286 warnings and 0 errors.
- `bun run typecheck` passed across all 7 packages; only existing TS44 informational JSON/schema-preference messages and Astro/Vite deprecation notices were reported.
- `bun run release:smoke` passed with Bun temporary staging available and retained the pinned dependency graph.
- `bun run build` passed with 5 successful Turbo tasks in 47.361s. The build still reports existing Astro/Vite deprecations, tsdown/plugin timing, desktop typeless-module and unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed with 8 successful Turbo tasks in 4m50.382s. Web passed 255 files / 3,038 tests; CLI passed 272 files / 2,814 tests with 2 skipped files and 7 skipped tests; all remaining package suites passed. No targeted reruns were required.
- `bun install --frozen-lockfile` confirmed 1,448 pinned packages after the workspace-version update, with no dependency changes.

## 0.5.5 - 2026-07-17

### Added

- Added Antigravity CLI as a first-class provider, including installation and authentication guidance, runtime model and reasoning-effort discovery, session creation and resume, streaming text and reasoning, tool and plan events, approvals, usage reporting, cancellation, and restart recovery.
- Added dedicated Antigravity branding across provider setup and selection, with stable SVG filter identifiers for predictable rendering.
- Added shared parsing and normalization for desktop file and folder drops so paths containing spaces, parentheses, encoded characters, or multiple items become valid composer mentions.

### Changed

- Reworked live-turn settlement to follow the owning provider session, preventing transcript chrome from remaining active after a turn has already completed.
- Optimized chat reconciliation and event projection to reduce repeated scans and redundant updates during active conversations and sidebar-driven state changes.
- Coalesced pull-request entries through shared list logic and unified picker popup interactions across the workspace.
- Replaced Pierre-branded side-panel diff headers with Synara's shared visual chrome.
- Retired the legacy Gemini keybinding and updated provider documentation for Antigravity.
- Reset bundled theme seeds consistently so shipped theme changes apply predictably without disturbing user-created themes.
- Bumped Synara release package versions to `0.5.5` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed WebSocket RPC requests remaining unsettled after close, timeout, send failure, or reconnect boundaries.
- Fixed working indicators and live-turn UI becoming stuck when provider runtime events and session completion arrived in different orders.
- Fixed dropped paths with spaces or parentheses being split, escaped incorrectly, or omitted from chat and Kanban task composers.
- Fixed Cursor model-discovery failures taking down the picker or discarding usable cached and independently discovered model choices.
- Fixed pull-request list typing under `exactOptionalPropertyTypes` and reduced duplicate list state across project contexts.
- Fixed Antigravity SVG filter keys relying on floating-point geometry strings instead of the stable generated filter identifiers.

### Verification

- `bun run fmt:check` passed across 13,192 files.
- `bun run lint` passed with 202 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed and retained the pinned dependency set while noting `@pierre/diffs@1.2.12` is newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks in 8m19s; web passed 219 files, CLI passed 169 files / 1,863 tests with 2 skipped files and 7 skipped tests, and all remaining package suites passed. No targeted reruns were required.

## 0.5.4 - 2026-07-15

### Added

- Added a native Pull Requests workspace backed by the GitHub CLI, with cross-project and project-scoped discovery, search, state filters, involvement groups, pinned pull requests, and explicit loading, empty, authentication, and partial-failure states.
- Added pull-request detail views for summary, code, and timeline context, including checks, reviewers, commits, changed files, diffs, comments, and repository metadata.
- Added in-place pull-request actions for comments, merge, close, reopen, and pinning, with confirmation and error handling around destructive or remote mutations.
- Added a global feedback dialog available from the command menu and `/feedback` command.
- Added durable desktop window-state restoration for position, size, and maximized state, with monitor-bound validation when the display layout changes.

### Changed

- Refactored transcript rendering and provider-session orchestration into clearer shared lifecycles, including temporary-thread cleanup and more predictable runtime state transitions.
- Added shared pull-request UI primitives and centralized query, cache, mutation, and refresh coordination so list and detail surfaces stay consistent under overlapping requests.
- Improved pull-request discovery under load with bounded concurrency, single-flight fetches, cached fallback data, project-aware invalidation, and per-repository partial results.
- Updated the Pi SDK integration and model discovery behavior, including support for custom-provider authentication through `auth.json` semantics.
- Aligned Grok reasoning-effort handling with provider capabilities, hid Cursor transport-only model variants from user-facing selection, and standardized more of the interface on the system UI font.
- Refined theme initialization, browser navigation, external-link handling, sidebar behavior, composer actions, and shared disclosure/component styling as part of the workspace integration.

### Fixed

- Fixed pull-request refreshes, mutations, and route changes racing each other into stale lists or mismatched detail state.
- Fixed unavailable or failing repositories preventing successful pull-request results from other projects from remaining usable.
- Fixed desktop windows losing their prior bounds or reopening off-screen after restart or monitor changes.
- Fixed Pi custom-provider models authenticated through local auth configuration being omitted from discoverable models.
- Fixed temporary thread, transcript, and session transitions leaving inconsistent UI state during creation, navigation, reconnect, or cleanup.
- Fixed provider model pickers exposing unsupported Cursor variants or inconsistent Grok effort choices.

### Verification

- `bun run fmt:check` passed across 13,187 files.
- `bun run lint` passed with 192 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed after rerunning with Bun temporary staging available; it retained the pinned dependency set and reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- The first full `bun run test` exposed a stale local Pi SDK install (`0.74.0` instead of lockfile version `0.80.6`) in one custom-provider discovery test. A frozen dependency sync corrected the local graph, and the focused regression passed.
- Final full `bun run test` passed: 10 Turbo tasks in 18m46s; web passed 217 files / 2,670 tests, CLI passed 169 files / 1,852 tests with 2 skipped files and 7 skipped tests, and all remaining package suites passed.

## 0.5.3 - 2026-07-14

### Added

- Added AppSnap, an opt-in macOS capture workflow that attaches the active app window to the current task when both Option keys are pressed.
- Added a packaged native AppSnap helper with Screen Recording permission guidance, capture feedback, focus-safe window selection, parent-process monitoring, and app icon extraction.
- Added a dedicated AppSnap settings panel and first-run welcome dialog so supported desktop installs can discover, configure, and disable the shortcut.
- Added durable browser-side blob storage for pending image attachments so captures survive navigation and app restarts without inflating local-storage drafts.

### Changed

- Improved long user-message readability with overflow-aware collapsing, richer markdown attachment chips, and more predictable transcript measurement on the simple non-virtualized timeline path.
- Refactored session orchestration, composer attachment persistence, and transcript rendering to reduce duplicated state transitions and keep live work predictable.
- Included the native AppSnap helper and its Swift sources in macOS development and packaged desktop build paths.

### Fixed

- Fixed AppSnap recovery after permission changes, helper restarts, capture overlap, timeout, and transient probe failures.
- Fixed pending AppSnap blobs being omitted from manual attach-and-send flows or attachment-limit calculations.
- Fixed duplicate attachment persistence and duplicate feedback sounds during capture retries and already-handled capture events.
- Fixed ACP request failures dropping useful structured error detail before it reached the UI.
- Fixed rich user markdown, attachment chips, and long-message previews producing inconsistent layout or timeline height updates.

### Verification

- `bun run fmt:check` passed across 13,106 files.
- `bun run lint` passed with 189 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed and refreshed temporary install/lockfile state while retaining the pinned dependency set.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks in 8m43s; web passed 205 files / 2,544 tests, CLI passed 162 files / 1,772 tests with 2 skipped files and 7 skipped tests, and all remaining package suites passed. No targeted reruns were required.

## 0.5.2 - 2026-07-13

### Added

- Added Factory Droid as a first-class ACP provider, including runtime model discovery, session import, context-preserving forks and restarts, token multipliers, provider-aware model switching, and Factory branding.
- Added `Alt+]` / `Alt+[` shortcuts for cycling through available models without leaving the conversation.
- Kept unfinished task lists visible in the transcript after a turn completes, so follow-up work is easier to resume.

### Changed

- Changed file undo to restore turn-scoped workspace changes without trimming chat history or rolling back the conversation that explains them.
- Improved cross-platform agent workflows with runtime Codex reasoning options, more reliable Windows CLI launching, platform-aware project folder labels, and graceful Git status checks outside repositories.
- Softened the file-change header treatment so active diffs are easier to scan.
- Removed the Windows process regression job from CI.
- Stable 0.5.x releases now publish on GitHub Latest, while 0.4.x remains the historical compatibility line.
- Superseded the withdrawn 0.5.1 build after its activity-sequence migration could stall startup on large local histories.

### Fixed

- Fixed model cycling and runtime-discovered reasoning options so the active provider's available choices remain consistent while a conversation is open.
- Fixed task-list projection so unfinished work is not hidden when a turn settles.
- Fixed startup on large databases by replacing the quadratic activity-sequence backfill with an indexed linear migration; the recovered 1.1 GB production database retained all 21 projects, 70 threads, 14,683 messages, and 180,862 activities.
- Fixed stable updater feeds to publish both GitHub Latest metadata and the `synara-*` channel aliases expected by installed desktop builds.

### Verification

- `bun run fmt:check` passed across 13,087 files.
- `bun run lint` passed with 184 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed after rerunning outside the sandbox; it reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks; web passed 201 files / 2,481 tests, CLI passed 162 files / 1,771 tests with 2 skipped files and 7 skipped tests, and the remaining packages passed their suites with 1 skipped shared test.

## 0.5.0 - 2026-07-11

### Added

- Added live Claude context-usage controls, near-window warnings, in-session model/context switching, and resumable context state.
- Added Claude task tracking for TaskCreate, TaskUpdate, TaskGet, TaskList, and TodoWrite, normalized into the shared runtime task list.
- Added shared provider task progress and richer Codex reasoning summaries, compaction events, and runtime task updates for clearer long-running turns.

### Changed

- Completed the Synara identity cutover across desktop packaging, the renderer origin, workspace packages, the public CLI, runtime variables, storage, Git metadata, assets, documentation, and release automation.
- Set the production bundle ID and Windows AUMID to `com.emanueledipietro.synara`, with `.dev` used only for development.
- Published the CLI identity as `@synara/cli` with the `synara` executable and moved all first-party workspaces to `@synara/*`.
- Kept persisted renderer state available through the 0.4.2 origin bridge and retained brand-neutral structural access to existing checkpoint refs and migration lineage.
- Deferred secondary chat dock panels and added a repeatable LCP measurement script so the main conversation can become interactive sooner.
- Hardened the staged updater feed, compatibility-channel checks, and desktop startup around bundle swaps.

### Fixed

- Fixed Claude and Codex resume paths so task progress, context state, reasoning summaries, and streamed runtime events survive reconnects without unnecessary provider restarts.
- Fixed noisy Codex app-server stdout and incomplete reasoning ingestion from obscuring or dropping live transcript activity.
- Fixed deleted-project reconciliation and browser profile migration edge cases by preserving client tombstones and repairing database sidecars transactionally.

### Verification

- `bun run fmt:check` passed across 13,057 files.
- `bun run lint` passed with 178 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed with Bun temporary staging available; it reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, and large Vite chunk warnings.
- Final full `bun run test` passed: 10 Turbo tasks; `@synara/web` passed 200 files / 2,426 tests, and `@synara/cli` passed 152 files / 1,698 tests with 1 skipped file and 6 skipped tests. The initial run was interrupted while waiting on the serial server suite; the final rerun completed cleanly.

### Upgrade note

- Launch Synara 0.4.2 once before upgrading so renderer-local UI state is exported before 0.5.0 adopts the canonical `synara://app` origin.

## 0.4.2 - 2026-07-09

### Added

- Added the Synara identity bridge that exports canonical renderer storage before the packaged origin changes.
- Added per-thread 1M-token context window tracking for Claude sessions, with automatic compaction handling and context-usage warnings near the window limit.
- Added fallback model pinning for Claude after a safeguard reroute, cleared when the user explicitly selects a different model.
- Added a durable desktop update install marker that verifies installs across restarts, plus an install watchdog with recovery and macOS ShipIt/launchctl update diagnostics.
- Added a build-only native release validation mode and a team-bound macOS signing requirement for seamless future updates.
- Added a durable, bounded Codex-overlay suppression marker without modifying the user's source configuration.

### Changed

- Claude model and context-window switches now happen in-session instead of forcing a full session restart, sharply reducing restarts and runaway token usage.
- Canonicalized migration and checkpoint metadata while keeping existing persisted refs readable.
- Enforced the staged Synara update feed end to end, with fail-closed preflight checks in the release pipeline.
- Made Windows code signing optional in the release pipeline and finalized Synara license attribution.

### Fixed

- Fixed the new-chat keyboard shortcut routing inside Studio.
- Repaired incomplete legacy home imports and restored the legacy environment identity from the bridge marker.
- Ordered renderer storage migration before app hydration and guarded renderer bootstrap ordering.
- Preserved composer drafts more reliably through the storage-key migration.

### Verification

- `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run release:smoke`, `bun run build`, and the full `bun run test` suite (1688 passed, 6 skipped, 0 failed) all passed on the release commit.
- Build-only native validation succeeded for macOS arm64/x64, Linux x64, and Windows x64 prior to tagging; the tagged release pipeline completed with all four platform builds green.

### Upgrade note

- Launch Synara 0.4.2 at least once before installing the next release. This preserves drafts, pins, theme, browser state, and other local UI state through the identity cutover.
- Earlier command and environment aliases are accepted by 0.4.2 only and are removed by the following release.

## 0.4.1 - 2026-07-09

### Added

- Added Studio: a dedicated workspace for long-running, agent-led work, with its own projects, threads, routes, sidebar entries, and empty-state entry points.
- Added a Studio outputs surface in the Environment panel for agent-produced files, generated images, and related activity.
- Added visible project worktree setup steps so workspace preparation and setup failures are easier to understand.
- Added focused coverage for Studio routing, output projection, worktree setup, restore behavior, project metadata, and transcript/workspace handoffs.

### Changed

- Refined chat and Studio creation, routing, and restore flows to use canonical containers, wait for hydration when needed, and avoid overlapping fresh-chat creation.
- Refined session orchestration and transcript rendering so active work, sidebar visibility, and worktree setup remain predictable across streaming, reconnects, and segment switches.
- Refined Studio scaffolding and project ownership rules to preserve clear workspace boundaries during retries, restores, and partial creation states.
- Bumped Synara release package versions to `0.4.1` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed cross-kind project reuse so regular chats and Studio threads cannot accidentally share an incompatible container or workspace root.
- Fixed several restore and route edge cases involving archived threads, hidden segments, draft targets, startup hydration, and unclassifiable thread kinds.
- Fixed Codex startup ordering by preparing the authentication overlay before dependent paths, and fixed the Codex launcher path on Windows.
- Fixed Studio output display and projection edge cases so generated images and output activity remain discoverable in the Environment panel.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with existing warnings and no errors.
- `bun run typecheck` passed across all 8 packages (with existing TS44 informational JSON/schema-preference messages).
- `bun run release:smoke` passed.
- `bun run build` passed (with existing Astro, tsdown/plugin-timing, desktop module-type, and large Vite chunk warnings).
- `bun run test` passed.

## 0.4.0 - 2026-07-06

### Added

- Added richer pull request snapshot data in the Environment panel, including review/check preview handling and merged-state awareness.
- Added prompt-history navigation support that preserves the current draft's file/image attachments while browsing previous prompts.
- Added graceful Claude usage/rate-limit handling so provider usage limits show as a recoverable user-facing state instead of a generic failure.
- Added focused release coverage around PR snapshot edge cases, prompt-history navigation, provider usage parsing, and desktop restart stderr handling.

### Changed

- Bumped Synara release package versions to `0.4.0` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined prompt history navigation so stale navigation state resets cleanly and optimistic prompt-history entries do not duplicate after sends.
- Refined PR snapshot loading to dedupe GitHub field lists, format merge-head details more consistently, and keep long review previews readable.
- Refined provider usage type handling around Claude summaries and rate-limit responses.

### Fixed

- Fixed prompt-history browsing losing draft attachments while moving through previous prompts.
- Fixed duplicate optimistic prompt-history entries and stale prompt-history navigation state after related sends.
- Fixed desktop restart handling for broken stderr pipes, including the EPIPE path from restarted child processes.
- Fixed PR snapshot follow-up issues around merged PR state, truncated review previews, and merge-head formatting.
- Fixed automation migration lineage assertions and provider usage summary type narrowing uncovered by the recent release work.

### Verification

- `bun run fmt:check` passed across 1535 files.
- `bun run lint` passed with 168 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages in 18.277s with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 16.479s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Full `bun run test` passed: 10 tasks successful in 6m35.477s. `@synara/web` passed 194 files / 2352 tests, and `synara` passed 145 files with 1 skipped file, 1593 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.4.0`, and `npm run lint` passed.

## 0.3.9 - 2026-07-05

### Added

- Added the app-level `/export` slash command for saved, idle threads, producing a streamed ZIP archive with `thread.json` and `transcript.md`.
- Added full-history export hydration, shared export eligibility checks, blocked-export reasons, desktop CORS/error handling, and command-menu support for `/export`.
- Added profile stats archival for purged threads, including migration `050_ProfileStatsArchive`, retained command receipts, checkpoint ref cleanup safeguards, and retention cleanup coverage.
- Added a stable active-turn "Working for" transcript header while preserving the existing pending-setup shimmer row.
- Added a dedicated terminal process-tree killer with SIGTERM-to-SIGKILL escalation and disposal timing coverage.
- Added runtime-discovered OpenCode/Kilo model support for Git writing settings, plus contract/query coverage for selected text-generation backends.

### Changed

- Bumped Synara release package versions to `0.3.9` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined `/export` to stream archive entries incrementally, deflate large entries without buffering the whole ZIP, and avoid offering export while a turn is running or still streaming.
- Refined thread purge behavior so archived profile aggregates continue contributing to profile queries after thread rows are removed.
- Refined terminal shutdown so disposal waits for kill escalation instead of returning while stubborn process trees may still be alive.
- Refined Git action text-generation selection so commit messages, diff summaries, and PR text route through the configured Git-writing provider/model.

### Fixed

- Fixed `/export` menu selections falling through silently and local draft threads offering an export path that would 404.
- Fixed very large thread exports being capped by the UI thread-detail message limit.
- Fixed ACP resumed sessions reusing fallback assistant message IDs across runtime restarts, which could overwrite earlier assistant transcript segments.
- Fixed OpenCode/Kilo Git-writing model selections failing to reach Git actions and falling back to the wrong backend.
- Fixed archived profile stats being lost when thread cleanup purged the underlying messages and command receipts.
- Fixed terminal shutdown paths that could leave stubborn subprocess trees alive after disposal.

### Verification

- `bun run fmt:check` passed across 1528 files.
- `bun run lint` passed with 168 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 18.768s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Full `bun run test` passed: 10 tasks successful in 6m35.955s. `@synara/web` passed 193 files / 2316 tests, and `synara` passed 144 files with 1 skipped file, 1575 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.9`, and `npm run lint` passed.

## 0.3.8 - 2026-07-03

### Added

- Added ACP/Grok resume and compaction hardening so resumed sessions drop unsafe replay before consumers attach, seed quiet windows from response timing, and avoid memory-heavy replay loops.
- Added explicit worktree setup progress/failure state in local dispatch snapshots, transcript rows, and browser coverage.
- Added automation dispatch-origin persistence and a "Sent via Automation" transcript label for scheduled and heartbeat-triggered user turns.
- Added approval panel browser coverage for allow/deny decisions and shared choice-row presentation for pending approvals.
- Added focused tests for collapsed transcript work-duration grouping, failed worktree setup reset behavior, session lifecycle handling, provider/runtime ingestion, and profile/sidebar presentation helpers.

### Changed

- Bumped Synara release package versions to `0.3.8` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined ACP session runtime and Grok adapter handling around resume replay, compaction, JSON-RPC ordering, provider runtime ingestion, and provider service session state.
- Refined worktree setup timeline rendering so setup rows expose active/failed/done state more predictably and failed local dispatches clear on the next send.
- Reworked pending approval UI around the shared `ComposerChoiceRow` structure, trimming duplicate action styling and aligning it with pending input panels.
- Gated Claude credential keepalive/startup refresh behavior and refined provider usage/query invalidation paths so app startup does less surprise provider work.
- Refined transcript, sidebar, profile stats, share-card, and timeline-height logic around dispatch origins and folded work rows.

### Fixed

- Fixed Grok/ACP resume replay ordering that could attach replay before the event consumer and make resumed or compacted sessions unstable.
- Fixed failed worktree setup dispatch state lingering into a new local turn instead of resetting when the user sends again.
- Fixed collapsed turn "Worked for" timing so folded transcript segments report a duration spanning the whole folded section.
- Fixed automation-origin turns missing a durable transcript projection marker.
- Fixed a release-gate `exactOptionalPropertyTypes` error in `apps/web/src/components/ChatView.tsx` by omitting the optional dispatch `options` property when there is no worktree setup step.
- Fixed backend Node option handling around unsupported `--js-flags` forwarding while keeping covered desktop startup behavior.

### Verification

- `bun run fmt:check` passed across 1518 files.
- `bun run lint` passed with 162 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on `apps/web/src/components/ChatView.tsx` because `beginLocalDispatch` passed an explicit `options: undefined` into an exact-optional helper; after the targeted fix, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 23.921s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Initial full `bun run test` failed in `@synara/web` with one timeout: `apps/web/src/components/ChatMarkdown.test.tsx > ChatMarkdown > uses the theme foreground token for markdown text`. No stale duplicate test processes were present; the targeted rerun `bun run test src/components/ChatMarkdown.test.tsx -t "uses the theme foreground token for markdown text"` from `apps/web` passed in 1.01s.
- Final full `bun run test` passed: 10 tasks successful in 9m28.476s. `@synara/web` passed 193 files / 2308 tests, `synara` passed 140 files with 1 skipped file, 1547 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.8`, and `npm run lint` passed.

## 0.3.7 - 2026-07-02

### Added

- Added live desktop update download percentages on the sidebar update button, including clamped integer handling and focused edge-case coverage.
- Added single-flight checkpoint capture for matching repo/ref pairs, with a 180s aggregate timeout and first-writer-wins `skipIfExists` baselines.
- Added recovery coverage for missing message-start baselines before turn-start checkpoint aliasing.
- Added pure Claude auth-status parsing and generic provider CLI-output helpers, making provider health behavior easier to test in isolation.
- Added a shared in-process `claude auth status` lock so health probes and macOS credential keepalive ticks do not race the same rotating OAuth refresh token.
- Added CI timeouts and non-interactive browser-runtime install safeguards so hosted quality runs fail fast instead of hanging indefinitely.

### Changed

- Bumped Synara release package versions to `0.3.7` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Moved the sidebar Chats section into the scrollable sidebar content, added an accessible disclosure state, and reused the shared disclosure chevron.
- Refined the desktop update action styling to use the info color while active downloads show a compact percent pill.
- Refined Claude provider health to retry structured `loggedIn:false` false negatives once, read verified local credential metadata, and preserve subscription/auth labels more reliably.
- Forked the macOS Claude credential keepalive after server startup and passed the configured home dir into the Claude process environment so the best-effort keepalive cannot block boot.
- Moved the CI quality job onto GitHub-hosted runners and switched Playwright installation to the workspace-local binary after `bunx` installs stalled.

### Fixed

- Fixed Claude Agent health checks that could briefly report an authenticated account as logged out when concurrent `claude auth status` calls raced a refresh-token rotation.
- Fixed checkpoint baseline races that could overwrite or miss the original pre-turn snapshot used for transcript diffs and restore points.
- Fixed first-message sends from the empty chat landing opening the Environment panel unexpectedly after the transcript view appears.
- Fixed crowded sidebar footer behavior by keeping chat history rows with the main sidebar list and leaving the footer for account/update controls.
- Fixed release CI being blocked by the unavailable Blacksmith runner queue; Linux browser tests now continue for signal without blocking while geometry parity failures are tracked separately.

### Verification

- `bun run fmt:check` passed across 1508 files.
- `bun run lint` passed with 158 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 14.425s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, Rolldown/Babel plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m23.405s. `@synara/web` passed 191 files / 2274 tests. `effect-acp` passed 3 files / 24 tests. `synara` passed 140 files with 1 skipped file, 1532 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.7`, and `npm run lint` passed.

## 0.3.6 - 2026-06-30

### Added

- Added safer Cursor ACP command discovery and launcher fallback coverage for bundled sibling shims, legacy shims, and fallback ordering.
- Added Muxy Open In support through editor metadata, server open handling, and focused tests.
- Added live message trail rendering, shared trail logic, browser coverage, and timeline integration for active transcript updates.
- Added desktop clipboard image sharing for share-card/profile exports.
- Added Claude credential keepalive coverage to keep macOS OAuth credentials fresh across longer sessions.

### Changed

- Bumped Synara release package versions to `0.3.6` across the server, desktop, web, and contracts packages.
- Refined Cursor agent command resolution so fallback launchers prefer known-safe agent paths and reject unsafe editor fallbacks.
- Refined checkpoint and transcript handling around turn completion, live trail rendering, and message timeline integration.
- Refined Sonnet 5 model variant metadata, sidebar status icons, command-row branding, tool-call labels, chat bubble padding, and model effort picker copy.
- Refined task-completion notification logic and share-card export behavior around desktop clipboard support.

### Fixed

- Fixed Cursor ACP CLI path resolution for packaged/bundled Cursor layouts and legacy shim paths.
- Fixed unsafe Cursor editor fallback behavior by rejecting launch paths that do not match the expected agent command shape.
- Fixed Claude sessions becoming stale after long macOS OAuth credential idle periods.
- Fixed file-change checkpoint timing around completed turns so summaries attach after the relevant assistant message is known.
- Fixed formatting drift in ProviderHealth, Cursor ACP, and shared model test files caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/provider/Layers/ProviderHealth.test.ts`, `apps/server/src/provider/Layers/ProviderHealth.ts`, `apps/server/src/provider/acp/CursorAcpCommand.ts`, `apps/server/src/provider/acp/CursorAcpSupport.ts`, and `packages/shared/src/model.test.ts`; after targeted `bunx oxfmt` on those files, the final formatter check passed.
- `bun run lint` passed with 158 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m38.929s. `@synara/web` passed 191 files / 2273 tests. `synara` passed 138 files with 1 skipped file, 1517 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` and `npm run lint` passed.

## 0.3.5 - 2026-06-30

### Added

- Added temporary-thread promotion coverage and renamed disposable-thread helpers around the temporary-thread lifecycle.
- Added undo-toast archive behavior for sidebar thread archive actions, backed by shared thread archive helpers and toast coverage.
- Added macOS desktop icon-cache refresh logic with startup/update integration and focused platform-gated tests.
- Added focused coverage for queued composer headers, timeline work-row grouping, diff rendering, thread archive undo, and desktop update button presentation.

### Changed

- Bumped Synara release package versions to `0.3.5` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace package versions.
- Reworked temporary chat promotion so draft/temporary threads move into durable chat flow more predictably across ChatView, sidebar state, session logic, and route activation.
- Replaced archive confirmation friction with immediate archive plus undo toast, including sidebar row actions, settings primitives, and shared error messaging polish.
- Refined pending user-input panels, queued composer state, work rows, tool details, markdown spacing, composer picker styling, model/traits pickers, and chat timeline presentation.
- Cleaned up activity heatmap export, share cards, diff-rendering helpers, sidebar labels, and several compact toolbar/control labels.

### Fixed

- Fixed dark-mode composer input surface border styling after the recent composer picker polish.
- Fixed stale macOS Dock/Finder icon behavior after app icon changes by refreshing icon caches from the desktop process when needed.
- Fixed archive recovery ergonomics by replacing the blocking confirmation path with a reversible toast action.
- Fixed temporary-thread naming and lifecycle drift left over from disposable-thread terminology.
- Fixed small UI inconsistencies in pending approvals, pending inputs, PDF toolbar, terminal chrome, settings routes, and What's New popout sizing.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It reported a slow filesystem warning for the Bun install cache during the final pass.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 6m9.469s. `@synara/web` passed 190 files / 2229 tests. `synara` passed 137 files with 1 skipped file, 1492 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.5`, and `npm run lint` passed.

## 0.3.4 - 2026-06-29

### Added

- Added assistant streaming as the default for fresh app/server settings so new installs start with live assistant output enabled.
- Added smoother transcript auto-follow coverage for optimistic sends, streaming assistant text, message entry animations, and tool detail interactions.
- Added broader provider-health coverage for Claude local CLI credentials, Cursor ACP/headless probing, OpenCode model/runtime handling, and provider model-probe failures.
- Added focused OpenCode retry-warning ingestion and web session coverage so retry notices stay attached to work-log rows and collapse consistently across turns.
- Added tool-call label coverage and refined central icon usage for agent mentions, task rows, and file-change entries.

### Changed

- Bumped Synara release package versions to `0.3.4` across the server, desktop, web, and contracts packages.
- Refined transcript streaming and session-state handling so live assistant output, tool rows, and bottom-stick behavior stay separated more predictably.
- Made Claude provider health prefer usable local CLI credentials before inheriting direct credential env keys into subprocesses.
- Made Cursor provider probing use a safer headless environment for ACP commands.
- Improved chat card contrast, agent glyph consistency, file-change icon choices, and shared switch sizing/thumb animation.

### Fixed

- Fixed OpenCode retry warnings being projected into the wrong conversation surface or failing to collapse consistently across turns.
- Fixed provider-health status handling so model-probe failures can keep an authenticated provider available with a warning instead of degrading it too aggressively.
- Fixed transcript browser test type drift by normalizing `scrollTo` test-helper options without explicit `undefined` optional fields.
- Fixed Claude provider-health type drift by only passing `homeDir` to the Claude env builder when it exists.
- Fixed ProviderHealth test type drift by using the Effect platform `"Unknown"` system error tag supported by this workspace.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on `apps/web/src/components/ChatView.browser.tsx` because a browser `scrollTo` test helper produced explicit `undefined` optional fields; after that fix it failed in `synara` on `apps/server/src/provider/Layers/ProviderHealth.ts` and `ProviderHealth.test.ts` for the same exact-optional pattern and an unsupported Effect platform error tag; after targeted fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- Initial `bun run test` failed in `@synara/web` on `apps/web/src/appSettings.test.ts` because the persisted-settings decode-default fixture still expected `enableAssistantStreaming: false`; after updating the fixture to the new default, the targeted app settings test passed.
- Final `bun run test` passed: 10 tasks successful in 6m5.217s. `synara` passed 137 files with 1 skipped file, 1492 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.4`, and `npm run lint` passed.

## 0.3.3 - 2026-06-28

### Added

- Added Windows packaged-app editor discovery so VS Code and VS Code Insiders installed from the Microsoft Store can be launched from Synara.
- Added Windows editor URI fallback handling when the normal editor command is unavailable or unsuitable.
- Added a provider update-check preference across server settings, web app settings, settings search, provider health, and update notification filtering.
- Added shared workspace explorer keyboard navigation coverage and a dedicated keyboard shortcuts settings panel.
- Added focused release-gate coverage updates for server settings push payloads and Windows editor launch behavior.

### Changed

- Bumped Synara release package versions to `0.3.3` across the server, desktop, web, and contracts packages.
- Refreshed Synara icon and logo assets across desktop resources, marketing assets, web favicons, app icons, and shared brand assets.
- Corrected macOS app icon packaging after the Ventura rounded-icon pass and removed the temporary literal Dock icon workaround.
- Unified workspace explorer presentation, file row styling, diff stat labels, DockExplorerPane behavior, and shortcut settings navigation.
- Reduced idle local server polling by giving server React Query a calmer idle refresh cadence while preserving active-session refresh behavior.
- Aligned menu checkbox switch styling with the shared switch primitive track/thumb classes so compact switch-shaped controls stay visually consistent.

### Fixed

- Fixed VS Code Store editor launch on Windows by resolving packaged app identities and falling back to URI activation when needed.
- Fixed provider update notification behavior so disabled update checks suppress background notices instead of continuing to surface provider updates.
- Fixed release-blocking server typecheck drift in `apps/server/src/open.ts` by using the Effect error handler API available in this workspace.
- Fixed release-blocking web typecheck drift in `apps/web/src/wsNativeApi.test.ts` by including `enableProviderUpdateChecks` in the mocked server settings payload.
- Fixed formatting drift in `apps/server/src/editorAppDiscovery.ts`, `apps/server/src/open.test.ts`, and `scripts/build-desktop-artifact.ts` caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/editorAppDiscovery.ts`, `apps/server/src/open.test.ts`, and `scripts/build-desktop-artifact.ts`; after targeted `bunx oxfmt` on those files, `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` because `wsNativeApi.test.ts` missed the new `enableProviderUpdateChecks` setting; after that fix it failed in `synara` because `apps/server/src/open.ts` used unavailable `Effect.catchAll`; after both fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m8.962s. `@synara/web` passed 188 files / 2212 tests. `synara` passed 136 files with 1 skipped file, 1475 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.3`, and `npm run lint` passed.

## 0.3.2 - 2026-06-27

### Added

- Added project selection to the branch toolbar so project, branch, and worktree context can be managed from the active chat surface.
- Added preview grants for absolute local files, including local image route coverage, trusted-origin checks, workspace file-system normalization, and web preview/download handling.
- Added a collapsible review file tree for the diff panel, backed by shared file-diff tree logic and shared disclosure motion.
- Added focused coverage for branch toolbar project selection, chat-project container selection, project creation recovery, local file preview grants, review file trees, route inset surfaces, provider availability, and workspace file openers.

### Changed

- Bumped Synara release package versions to `0.3.2` across the server, desktop, web, and contracts packages.
- Refactored transcript scrolling and session-state handling so ChatView owns less browser-specific behavior directly and live transcript/layout state has clearer boundaries.
- Refactored composer chrome measurement, right-dock metadata, workspace preview headers, and the workspace explorer into reusable pieces.
- Made project and home-chat container selection more explicit by sharing project creation/recovery, draft-thread mapping, and chat-container selection helpers across sidebar and toolbar entrypoints.
- Refined provider send readiness by refreshing provider status before chat, Kanban, handoff, and route-driven sends, then returning focus to the composer more consistently.
- Unified explorer icons, working shimmer styles, compact route inset surfaces, composer picker styling, and sidebar visual details.

### Fixed

- Fixed absolute local file previews that could fail to open or download when agent output referenced files outside the immediate workspace preview path.
- Fixed review-heavy diff navigation by adding a tree view instead of forcing users to scan a flat patch list.
- Fixed stale provider availability before send paths that could leave chat or Kanban actions using outdated provider state.
- Fixed release-blocking exact-optional typecheck drift in `apps/web/src/components/Sidebar.tsx`, `apps/web/src/composerDraftStore.ts`, and `apps/web/src/lib/chatProjects.ts`.
- Fixed formatting drift in `apps/web/src/components/RouteInsetSurface.tsx` caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/web/src/components/RouteInsetSurface.tsx`; after targeted `bunx oxfmt` on that file, `bun run fmt:check` passed.
- `bun run lint` passed with 154 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on exact optional property handling in `Sidebar.tsx`, `composerDraftStore.ts`, and `chatProjects.ts`; after targeted fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed. It refreshed install/lockfile state during `bun install`, with no remaining `bun.lock` diff.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m44.64s. `@synara/web` passed 187 files / 2205 tests. `synara` passed 136 files with 1 skipped file, 1464 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.2`, and `npm run lint` passed.

## 0.3.1 - 2026-06-26

### Added

- Added transcript tool-call detail dialogs and formatting helpers for command output, patches, file changes, and tool output so command-heavy turns are easier to inspect.
- Added regression coverage for tool-call labels, tool-call detail formatting, message timeline grouping, sidebar hover-card anchoring, keybindings, Gemini ACP probing, provider runtime ingestion, ProviderService behavior, electron-updater security, and Windows process handling.
- Added a curated central icon asset set and provider/UI icon plumbing used by newer picker, header, sidebar, and preview surfaces.
- Added more explicit project and thread hover-card content, thread pin toggle behavior, recent view switching, and project shortcut targeting.

### Changed

- Bumped Synara release package versions to `0.3.1` across the server, desktop, web, and contracts packages.
- Refined session orchestration and transcript handling so assistant messages, tool/work rows, collapsed turns, runtime activity, and sidechat state stay separated more predictably.
- Improved chat header, recent-view, sidebar, split-chat, and hover-card navigation for multi-pane workflows.
- Tightened keyboard shortcut defaults and persisted keybinding migrations for chat creation, terminal creation, navigation, and duplicate/stale binding rows.
- Expanded provider runtime ingestion for canonical Codex event shapes, generated-image markdown, MCP tool progress, reasoning deltas, proposed-plan events, and synthetic placeholder thread ids.
- Hardened provider management around idle runtime retention, provider health refresh, process cleanup, Cursor/Gemini/Grok adapter paths, OpenCode runtime handling, and Gemini ACP probe parsing.
- Made automation setup/update flows stricter by separating conversational setup prompts, update-only approval paths, approval fallback behavior, prompt filler removal, and risk acknowledgement gating.
- Improved desktop startup/update handling by reducing noisy Node deprecation warnings and tightening electron-updater Windows command construction.
- Refined composer, automation banners, provider/model pickers, Kanban cards, preview cards, tooltip primitives, and project/sidebar icons with smaller consistency fixes.
- Welcomed focused external contributions in the project docs and README while keeping the early-WIP guidance explicit.

### Fixed

- Fixed transcript tool-call inspection gaps where shell command output, patch details, and normalized tool output were hard to review from the UI.
- Fixed session orchestration edge cases around review interrupt retry, compaction progress, runtime event replay, generated image completion replay, and provider-thread placeholder matching.
- Fixed provider runtime warning and ingestion paths that could mishandle missing usage details, auxiliary turn completions, or non-active turn completions in synthetic/runtime tests.
- Fixed automation approval regressions around update-only flows, fallback prompts, conversational setup follow-up text, and dispatch-time risk acknowledgement.
- Fixed desktop updater command-hardening coverage and reduced startup warning noise from desktop Node behavior.
- Fixed formatting drift caught by the release gate in `apps/server/src/keybindings.test.ts` and `apps/web/src/components/chat/ToolCallDetailsDialog.tsx`.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/keybindings.test.ts` and `apps/web/src/components/chat/ToolCallDetailsDialog.tsx`; after targeted `bunx oxfmt` on those two files, `bun run fmt:check` passed.
- `bun run lint` passed with 156 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and left `bun.lock` unchanged.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m6s. `@synara/web` passed 182 files / 2164 tests. `synara` passed 135 files with 1 skipped file, 1456 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.1`, and `npm run lint` passed.

## 0.3.0 - 2026-06-24

### Added

- Added first-class Automations as a real Synara workspace surface, including contracts, persistence, scheduler leases, run tracking, RPC methods, sidebar navigation, list/detail routes, Current/Paused views, inline detail editing, previous-run history, and triage actions.
- Added automation scheduler and composer flows so saved prompts can run manually, once, on intervals, daily, on weekdays, weekly, or from cron-like schedules.
- Added heartbeat automations that continue an existing target thread on each scheduled wake while preserving the normal provider/session/approval/worktree pipeline.
- Added AI-evaluated heartbeat stop clauses through completion policies, natural-language stop conditions, completion-evaluation results, and visible stop reasons in run history.
- Added a dedicated background queue for AI stop checks so slow or stuck completion evaluation does not block automation reconciliation.
- Added timeout handling for stop evaluation, recording a visible warning result and keeping the heartbeat alive when the evaluator stalls.
- Added automation recovery and scheduler observability for swallowed recovery failures and scheduler lease contention.
- Added DST and long-downtime scheduler coverage for spring-forward gaps, fall-back duplicate hours, and coalesced missed interval runs.
- Added generic chat file attachments alongside image attachments, with shared contracts, upload storage, composer paste/drop support, provider prompt projection, optimistic timeline rendering, Kanban dispatch, recap/bootstrap support, and reusable file attachment cards/chips.
- Added automation cards in the chat transcript after automation creation, and added thread automation summaries in the Environment panel.
- Added blob-based browser download handling for local image/generated markdown image downloads so failed local-image responses stay inside Synara instead of navigating the app window to an API error page.
- Added OpenCode CLI-only model discovery fallback so the model picker can still discover available models when the managed server or inventory path fails.
- Added profile skill usage counting coverage for retention-hidden threads and repeated slash/dollar skill invocations.

### Changed

- Bumped Synara release package versions to `0.3.0` across the server, desktop, web, and contracts packages.
- Reworked automation UI toward a Codex-style surface, including the sidebar badge, Current/Paused list, centered detail layout, inline rail editing, schedule editing, target-thread display, max-iteration controls, stop-on-error handling, and previous-run actions.
- Expanded automation composer parsing and review so explicit/generated prompts, schedule phrases, stop clauses, bounded fast loops, restored plan source metadata, queued plan follow-ups, and inline composer editing are handled consistently.
- Made generated automation intents require confirmation before creation, while preserving deterministic local auto-submit behavior for explicitly parsed bounded fast loops.
- Tightened automation cache updates by guarding live definition/run upserts with `updatedAt` and handling equal timestamps without letting stale events roll back newer cache rows.
- Consolidated scheduler-critical SQL around pending completion evaluation and run listing, including a shared view and a bounded evaluation backlog.
- Scoped OpenCode/Kilo server startup and CLI discovery to the request/session cwd, avoided cross-cwd warm server reuse, preserved OpenCode resume cwd, and stopped replacing file config with synthetic empty config content.
- Treated omitted Claude interaction mode as the default/base permission so fresh threads do not inherit sticky plan mode from the previously active thread.
- Preserved attachment-bearing plan follow-ups by routing them through the normal send path while keeping source plan metadata, including queued sends.
- Made composer image blob URL ownership clearer by revoking on normal clears while preserving ownership for optimistic handoff.
- Made composer dropzone generic-file support explicit and visibly rejected unsupported Kanban task files.
- Kept Environment panel open/close preference stable across chat switches while defaulting constrained/floating chat layouts to a calmer closed panel.
- Avoided full thread subscription for file previews and reused thread runtime workspace resolution so worktree-backed chat file/PDF links open in the correct right-dock preview root.
- Included retention-hidden threads in profile stats while still excluding manually deleted threads and deleted projects.

### Fixed

- Fixed automation lifecycle bugs around crash replay, failed-run rollback, duplicate scheduled occurrences, in-flight guards, terminal run transitions, cancellation behavior, and failed update rollback.
- Fixed automation worktree cleanup when standalone thread creation fails or cancellation wins before durable thread ownership exists.
- Fixed automation approval-wait reconciliation so a heartbeat run re-checks turn ownership before leaving `waiting-for-approval`, avoiding resurrection after a different turn takes over the target thread.
- Fixed a completion-evaluation race where a background stop check could clobber a user's archived/read state on the same automation run.
- Fixed stale completion-evaluation results being accepted after an automation changed before evaluation finished.
- Fixed automation review regressions around draft-thread promotion, restored source-thread metadata, source plan persistence, reruns, triage/detail actions, and provider start options.
- Fixed local image downloads so failed `/api/local-image` responses cannot replace the desktop renderer with a plain `Not Found` page.
- Fixed deleted chats staying visible by removing successful deletes from client projections immediately, adding client tombstones, and keeping archived bulk deletes responsive.
- Fixed worktree-backed file/PDF previews from chat links so absolute paths under a materialized worktree do not fall back to the default editor/main surface.
- Fixed OpenCode model discovery fallback so a failed server/inventory path no longer leaves the UI looking like only static GPT-5 is available.
- Fixed OpenCode provider config and sticky plan-mode behavior around cwd-scoped discovery, resume cwd, and fresh-thread bootstrap.
- Fixed attachment handling issues around attachment caps, server normalization rollback, unsupported files, plan follow-ups, image URL cleanup, and attachment drag/drop audit findings.
- Fixed profile skill counts so repeated `/skill` or `$skill` tokens in one prompt count correctly without double-counting structured skill references.
- Fixed release-blocking typecheck drift in automation worktree cleanup tests by asserting the created worktree branch before using it.
- Fixed formatting drift in the automation service test and local image preview download error description.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 151 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing large web chunk/plugin timing warnings, the Astro `transformWithEsbuild` deprecation warning, and the desktop `tsdown.config.ts` typeless-module warning.
- `bun run test` passed: 10 tasks successful in 8m53s. `@synara/web` passed 180 files / 2102 tests. `synara` passed 135 files with 1 skipped file, 1418 passed tests, and 6 skipped tests. The server suite was long-running but completed cleanly without a teardown stall.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.0`, and `npm run lint` passed.

## 0.2.41 - 2026-06-17

### Added

- Added a compact chat-header handoff menu so handoff threads can be created directly from the active chat header again.
- Added provider-target filtering for the handoff menu so only currently usable handoff destinations are offered.

### Changed

- Bumped Synara release package versions to `0.2.41` across the server, desktop, web, and contracts packages.
- Kept the shared project-action dialog path mounted while hiding the visible inline project script runner from the chat header.
- Improved header handoff failure handling by checking provider send availability before creating a handoff and showing a toast when the target is unavailable.

### Fixed

- Fixed the missing header handoff action after the previous chat-header cleanup.
- Fixed chat-header crowding from the project script runner while preserving the project action dialog plumbing used by other header actions.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and left the worktree unchanged.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- Root `bun run test` did not complete cleanly in two attempts: both runs reached a green `@synara/web` suite (169 files / 1954 tests), then stalled in the `apps/server` Vitest tail. The stale duplicate root/Vitest processes were stopped before continuing verification.
- Direct `bun run test` from `apps/server` also stalled before reporting test-file progress, only printing Node SQLite experimental warnings, so it is not counted as passed.
- Direct package tests passed for the release-relevant and non-server packages: `apps/web` 169 files / 1954 tests, `packages/contracts` 9 files / 90 tests, `packages/shared` 24 files / 228 tests, `packages/effect-acp` 3 files / 24 tests, `apps/desktop` 19 files / 149 tests, and `scripts` 5 files / 36 tests.
- `apps/marketing` has no `test` script.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.41`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.4 - 2026-06-17

### Added

- Added focused route-restore recovery coverage so remembered chat routes wait for a fresh snapshot before falling back after restart.
- Added disabled-provider re-enable regression coverage for provider health refreshes.

### Changed

- Bumped Synara release package versions to `0.2.4` across the server, desktop, web, and contracts packages.
- Improved remembered chat route restore so stale empty startup snapshots do not immediately send users to the empty chat route.
- Removed the old handoff shortcut from the chat header to keep primary conversation controls quieter.

### Fixed

- Fixed app restart/chat restore behavior where a valid remembered thread could briefly appear missing while orchestration state was still loading.
- Fixed provider health refresh behavior around re-enabling disabled providers so availability state is less likely to remain stale.
- Fixed formatting drift in `apps/web/src/chatRouteRestore.ts` caught by `bun run fmt:check`.

### Verification

- `bun run fmt:check` initially failed on `apps/web/src/chatRouteRestore.ts`; after formatting that file, `bun run fmt:check` passed.
- `bun run lint` passed with 149 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- `bun run test` passed: 10 tasks successful, including `@synara/web` 169 files / 1954 tests and `synara` 129 files passed / 1 skipped with 1255 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.4`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.3 - 2026-06-16

### Added

- Added richer local profile statistics, including most-worked project, skill/agent usage, active hours, provider/model mix, reasoning usage, and token/activity heatmap data.
- Added compact pasted-text cards for large composer pastes, with line/character metadata, remove controls, restore-to-editor behavior, and expandable sent-message echoes.
- Added shared pasted-text parsing/serialization helpers and focused coverage for composer drafts, pasted text, assistant selections, terminal context, and transcript height handling.

### Changed

- Bumped Synara release package versions to `0.2.3` across the server, desktop, web, and contracts packages.
- Improved profile skill usage counting by combining structured skill references, mentions, agent references, and legacy text-token backfill while filtering obvious non-skill slash/dollar tokens.
- Kept large pasted prompt content out of the visible composer body by storing it as structured prompt context, making long prompts easier to scan and refine.

### Fixed

- Fixed message editing so pasted text blocks remain intact when a user edits a previous message.
- Fixed draft/edit preservation for structured prompt context so pasted text, terminal context, and assistant selections are less likely to be dropped or flattened across composer lifecycle changes.
- Fixed profile stats so prompt-block markup like pasted text, file comments, terminal context, and assistant selections does not pollute skill counting.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- `bun run test` passed: 10 tasks successful, including `@synara/web` 168 files / 1949 tests and `synara` 129 files passed / 1 skipped with 1246 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.3`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.2 - 2026-06-14

### Added

- Added richer profile and personalization surfaces, including profile stats, activity heatmap polish, profile editing updates, and settings panel refinements.
- Added soft-delete thread retention coverage so deleted thread data has clearer cleanup behavior during early WIP usage.
- Added release-test stability safeguards for child-process ACP fixtures and the server Vitest runner.

### Changed

- Improved live composer edit visibility so per-turn composer changes stay attached to the active turn lifecycle.
- Refined curated app/profile UI details across the settings, profile dialog, activity heatmap, and chat route.
- Changed the server test script to run Vitest files serially, avoiding Turbo teardown stalls caused by lingering server Vitest workers after otherwise-passing test runs.

### Fixed

- Fixed flaky `effect-acp` child-process fixture tests by giving slow process-backed assertions an explicit timeout.
- Fixed full root `bun run test` release validation getting stuck after green server test output by making the server package test runner deterministic under Turbo.
- Fixed formatting drift in the profile, retention, and chat-route files that had reached `main`.

### Verification

- `bun run fmt:check` initially failed on `apps/server/src/threadRetention.test.ts`, `apps/web/src/components/profile/ActivityHeatmap.tsx`, `apps/web/src/components/profile/EditProfileDialog.tsx`, `apps/web/src/components/settings/ProfileSettingsPanel.tsx`, and `apps/web/src/routes/_chat.tsx`; after formatting those files, `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- Initial full `bun run test` failed in `packages/effect-acp` on 5000ms child-process fixture timeouts, then repeated with timeouts in `packages/effect-acp/src/client.test.ts` and `packages/effect-acp/src/protocol.test.ts`. Targeted reruns passed after adding explicit fixture timeouts.
- A subsequent root `bun run test` reached green server test output but did not return because the server Vitest process kept worker forks alive during Turbo teardown. Direct server testing showed the suite exits cleanly with `--maxWorkers=1 --no-file-parallelism`, so the server test script was updated accordingly.
- Final `bun run test` passed: 10 tasks successful, including `@synara/web` 167 files / 1935 tests, `effect-acp` 3 files / 24 tests, and `synara` 129 files passed / 1 skipped with 1241 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.2`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.1 - 2026-06-14

### Added

- Added inline file comments from composer and preview surfaces, including line comment boxes, comment summary chips, draft persistence, reference attachment support, chat timeline rendering, and file-comment parsing helpers.
- Added startup turn reconciliation for provider restarts so Synara can recover unfinished turns from persisted runtime state instead of leaving stale active work behind.
- Added an ACP idle watchdog used by ACP-backed providers so quiet turns can complete or fail more predictably when runtime events stop flowing.
- Added partial workspace reference lookup helpers and tests so shortened file references can resolve to the intended workspace entry.

### Changed

- Scoped live changed-file activity to the active turn by carrying active turn identity through provider runtime ingestion, Codex/Claude adapter events, checkpoint handling, chat selectors, and composer live-change headers.
- Improved workspace file opening from chat and preview references so missing prefixes or partial paths are handled through shared workspace file-system logic.
- Refined provider restart recovery across Cursor, Grok, OpenCode, runtime ingestion, command cleanup, and shared thread summaries so session state is less likely to drift after reconnects.
- Extended comment and reference handling through kanban dispatch, terminal context, composer attachments, editor workspace, dock preview, and compact composer controls.

### Fixed

- Fixed stale live changed-files panels that could show file edits from a previous or inactive turn.
- Fixed partial file references failing to open when assistant output did not include the full workspace-relative path.
- Fixed restart and idle-watchdog paths that could leave turns hanging after provider interruption, reconnect, or quiet ACP runtime behavior.
- Fixed composer/file-preview context loss when attaching line comments to a prompt or preserving them across draft updates.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 146 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; marketing still reports the `transformWithEsbuild` deprecation warning; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First full `bun run test` before release-note edits did not complete cleanly: visible server integration and checkpoint suites passed, including `integration/orchestrationEngine.integration.test.ts` and `src/orchestration/Layers/CheckpointReactor.test.ts`, but the root Turbo/Vitest run stopped producing output during teardown with two server Vitest worker forks still alive. The stale `bun`/`turbo`/Vitest process group was interrupted, so this run is not counted as a full pass.
- Final `bun run test` from `apps/web` passed: 165 files passed, 1909 tests passed.
- Final `bun run test` from `packages/effect-acp` passed: 3 files passed, 24 tests passed.
- Final direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 128 files passed, 1 skipped; 1238 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.1`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.0 - 2026-06-13

### Added

- Added a secure in-app PDF previewer backed by pdf.js, including page rendering, toolbar controls, zoom helpers, page navigation state, container sizing, document loading, page render cancellation, and PDF link normalization.
- Added `PdfFilePreview`, `WorkspaceFilePreview`, and a shared preview header so the right dock and editor workspace can render source files, images, markdown, and PDFs through one consistent preview path.
- Added authenticated local preview route coverage for image/PDF files, including workspace and scratch-workspace allowlists for generated local artifacts.
- Added Pi plugin/ACP startup prompt handling, model discovery support, cwd/session routing, provider service safeguards, and a mock ACP agent for focused provider tests.
- Added Cmd+L composer focus support across keybinding metadata, server/web keybinding definitions, shortcut-sheet data, and tests.
- Added markdown task-list parsing/rendering so checklist-style assistant output displays as task lists instead of plain bracket text.
- Added workspace file opener helpers, local preview URL helpers, file reference context-menu helpers, PDF zoom/link/navigation tests, chat view selector coverage, session logic tests, and extra right-dock runtime activation coverage.

### Changed

- Reworked file preview ownership by moving large preview behavior out of `EditorWorkspaceView` and into reusable preview components shared with the dock pane.
- Replaced the older nested changed-files tree/turn-diff-tree path with a flatter changed-files UI and simpler file-list behavior.
- Optimized chat startup and timeline derivation by tightening chat view selectors, route state handling, timeline ordering, collapsed settled-turn behavior, and timeline height calculations.
- Refined right-dock pane metadata and activation so file preview, PDF preview, and dock pane lifecycle state stay more predictable across chat/editor surfaces.
- Improved composer/user-input polish around inline mention chips, composer banners, pending user input panels, provider model picker state, and shortcut labels.
- Refined local preview file handling by renaming the shared helper from local image-only logic to broader local preview-file logic.
- Updated open-in target launcher prop naming and editor launcher hooks to match the newer workspace/dock preview surfaces.

### Fixed

- Fixed unsafe PDF preview behavior by sanitizing annotation links, rejecting unsafe URL schemes, resetting navigation when a new document loads, and avoiding stale page proxies after switching PDFs.
- Fixed local preview exposure risks by tightening preview response CORS/auth behavior and ensuring local file access stays scoped to allowed workspace/scratch paths.
- Fixed scratch workspace path generation so thread-derived scratch folders cannot smuggle path separators or traversal segments.
- Fixed Pi plugin UI routing, startup prompt delivery, model discovery for extensions, and cwd handling for provider-backed sessions.
- Fixed Cursor message id handling and stale changed-files presentation cases.
- Fixed duplicate plan mode icons, stale plan sidebar state, and noisy inline project actions in the chat header.
- Fixed settled-turn collapse fallback and timeline tail behavior when visible turn ids are empty or transcript rows update during long-running work.
- Fixed local image/PDF preview cleanup cases so loaded PDF documents and text layers are destroyed or cancelled when switching files, pages, or zoom levels.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 144 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; marketing still reports the `transformWithEsbuild` deprecation warning; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First full `bun run test` before release-note edits did not pass: `apps/server/integration/orchestrationEngine.integration.test.ts` failed `runs a single turn end-to-end and persists checkpoint state in sqlite + git`, and `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` failed `captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed`. The run then hung during teardown and was stopped after identifying and killing the stale `bun`/`turbo`/Vitest worker processes.
- Targeted rerun `bun run test src/orchestration/Layers/CheckpointReactor.test.ts -t "captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed"` from `apps/server` passed: 1 test passed, 15 skipped.
- Targeted rerun `bun run test integration/orchestrationEngine.integration.test.ts -t "runs a single turn end-to-end and persists checkpoint state in sqlite + git"` from `apps/server` could not reproduce the live integration test because the file uses `it.live`; the standard targeted Vitest command skipped all 12 tests.
- Final full `bun run test` after version and release-note edits did not pass: `packages/effect-acp/src/client.test.ts` timed out in `returns formatted invalid params when a typed extension request payload is wrong`, and `packages/effect-acp/src/protocol.test.ts` timed out in `does not emit a second process-exit error after a decode failure`. Turbo reported 7 successful tasks, canceled `synara:test` and `@synara/web:test` with code 130, and exited with `effect-acp#test` failed.
- Targeted rerun `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong"` from `packages/effect-acp` passed: 1 test passed, 4 skipped.
- Targeted rerun `bun run test src/protocol.test.ts -t "does not emit a second process-exit error after a decode failure"` from `packages/effect-acp` passed: 1 test passed, 16 skipped.
- Full `packages/effect-acp` rerun passed: 3 files passed, 24 tests passed.
- Full `apps/web` rerun passed: 164 files passed, 1894 tests passed.
- Direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 126 files passed, 1 skipped; 1214 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.0`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.9 - 2026-06-12

### Added

- Added Codex-style chat workspace folder creation and associated workspace/worktree metadata so generated chat files are easier to isolate per conversation.
- Added settings sidebar search deep links and related project/settings navigation polish.
- Added file-only workspace search refinements and stronger provider probe handling around Gemini-backed paths.

### Changed

- Reworked transcript turn collapse and live-tail behavior so collapsed work rows, latest-turn fallback, and active transcript scrolling stay calmer during long or partially visible turns.
- Improved browser session handling and copy-link flow behavior for in-app browsing and chat reference movement.
- Refined UI density controls, sidebar spacing, composer spacing, and settings page opening performance.
- Replaced bespoke editor project menu behavior with the shared `ProjectMenuPicker` path.
- Split kanban composer menu discovery from editor logic so each surface owns less unrelated state.
- Shared local image preview state and error-card handling across chat and editor views.

### Fixed

- Fixed transcript turn collapse and tail jitter cases where visible turn ids could be empty while a latest turn still had active work.
- Fixed browser/copy-link edge cases that could leave stale browser session state or awkward link movement.
- Fixed editor mode production feedback and local image preview duplication between chat and editor surfaces.
- Fixed settings page re-render churn caused by streaming ticks while opening settings.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 143 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First `bun run test` attempt visibly completed the long web/server/integration suites without an assertion failure, then hung during final server Vitest teardown with two workers still alive; it was interrupted and is not counted as a full pass.
- Final full `bun run test` after release-note and version edits failed in `packages/effect-acp/src/client.test.ts` on two 5000ms timeouts: `returns formatted invalid params when a typed extension request payload is wrong` and `replays buffered notifications to handlers registered after they arrive`. Turbo canceled `synara:test` with code 130 after the `effect-acp` failure, so the full run is not counted as passed.
- Targeted rerun `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong|replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed: 2 tests passed, 3 skipped.
- Full `packages/effect-acp` rerun passed: 3 files passed, 24 tests passed.
- Full `apps/web` rerun passed: 160 files passed, 1838 tests passed.
- Direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 125 files passed, 1 skipped; 1197 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.9`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.8 - 2026-06-11

### Added

- Added an editor workspace view beside chat, including file browsing, workspace view state, syntax highlighting, file reference selection, code selection actions, and focused tests around editor metadata, workspace file-system APIs, workspace entries, chat references, and route state.
- Added native editor app discovery and icon caching, with authenticated editor icon routes, shared editor icon path constants, icon rendering in the web app, and broader launcher coverage for Ghostty, Terminal, JetBrains, Xcode, Zed, Cursor, VS Code, and platform-specific fallbacks.
- Added a unified provider skills catalog with provider-root awareness, shared skill ownership display, provider skill prompt injection, skills settings UI/model state, and coverage for Codex/Cursor/native-discovery fallbacks.
- Added provider status/auth refresh plumbing on focus and root orchestration events so Codex auth overlays and provider discovery state recover without stale UI.
- Added composer footer layout helpers, file reference parsing helpers, relative time utilities, syntax highlighting helpers, diff route search, and extra web tests for composer layout, file icons, provider updates, and root invalidation.

### Changed

- Refined the chat header, chat view, composer controls, model/trait/open-in pickers, inline chips, transcript selection actions, and code-selection flows so references and controls stay easier to scan during active work.
- Reworked the diff panel toolbar, file list, and patch viewport behavior to make large diffs easier to navigate from both repository and turn contexts.
- Reworked provider skill discovery so provider-native skill lists can merge with Synara's catalog and fall back cleanly when a provider cannot answer.
- Reconciled legacy migration trackers before running migrations and tightened older sidechat/pinned-thread migration paths.
- Updated desktop stage dependency overrides to keep `@pierre/diffs` pinned to `1.2.8`.
- Tightened terminal environment propagation, terminal manager behavior, workspace path containment, and provider command/runtime plumbing around recent server contracts.

### Fixed

- Fixed stale Codex auth overlay behavior so installed/authenticated Codex states refresh more reliably.
- Fixed skill settings provider display so only providers that actually own a skill are shown for shared skill entries.
- Fixed Ghostty/open-in behavior and native icon sizing so editor launchers open the intended project path and render consistently with other picker icons.
- Fixed file reference selection and mention/chip rendering edge cases across composer text, sent user bubbles, and markdown/code selection surfaces.
- Fixed migration startup edge cases for early installs that still had legacy tracker state.
- Fixed several provider discovery and skill catalog edge cases around missing native provider binaries, invalid provider responses, and provider-root normalization.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 159 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First `bun run test` attempt was interrupted by SIGTERM after partial success; no assertion failure was reported before termination, and `@synara/web:test` had already passed 152 files / 1740 tests.
- Final rerun `bun run test` after version and release-note edits passed: 10 tasks successful; scripts 5 files / 36 tests, desktop 19 files / 149 tests, contracts 9 files / 90 tests, shared 22 files / 188 tests, effect-acp 3 files / 24 tests, web 152 files / 1740 tests, server 123 files passed / 1 skipped with 1187 passed / 6 skipped.
- The rerun still logged expected test-harness WARN/ERROR lines from failure-path coverage and native binding/provider-binary mocks.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.8`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.7 - 2026-06-10

### Added

- Added Claude Fable 5 to the Claude and Cursor model surfaces, including the shared model contract, Cursor model variants, keybinding metadata, provider discovery invalidation, and focused model-picker coverage.
- Added Cursor ACP model discovery and refresh handling so Cursor-backed sessions can recover from stale, partial, or invalid model state more reliably.
- Added provider usage infrastructure for Codex, Claude, Cursor, and Gemini, including credential discovery, provider-specific parsers, shared display helpers, SQLite-backed snapshot caching, server RPC routes, and client snapshot normalization.
- Added provider usage UI in chat and settings: Environment panel usage rows, compact usage menu controls, progress tracks, line lists, limit rows, rate-limit opening helpers, and provider usage settings navigation.
- Added desktop backend Node option handling and tests, memory diagnostics, WebSocket stream backpressure guards, and provider runtime ingestion buffer coverage.
- Added centralized Windows desktop caption controls, top-bar gutter support, preload IPC wiring, and focused browser/unit coverage for sidebar, keybinding, composer, usage, and provider discovery paths.

### Changed

- Reworked the composer model/options picker flow so split pickers are used where they help, empty threads stay focused, and stacked composer panels share steadier sizing/content helpers.
- Refined Cursor provider integration around ACP capability checks, model support parsing, discovery refreshes, provider health, and adapter behavior.
- Unified provider usage display and pacing logic across server snapshots, shared helpers, React hooks, settings panels, and in-chat usage sections.
- Tightened Codex app-server recovery, backend memory limits, and streaming behavior so reconnects, partial streams, and live provider updates stay more predictable.
- Refined Windows desktop chrome to keep native-style controls in one fixed cluster and avoid custom titlebar paths outside Windows.
- Updated Linux download metadata to use the current `-x64` AppImage asset naming.

### Fixed

- Fixed plugin mention icons in sent user bubbles so selected plugin/file identity is preserved after sending.
- Fixed provider discovery invalidation so refreshed model lists can update the UI without stale model state lingering.
- Fixed usage parsing/display edge cases for provider-specific quota and pacing data.
- Fixed composer stacked panel sizing, queued/live-change header alignment, and trait-picker behavior around compact controls.
- Fixed sidebar/search palette state and route metadata edge cases covered by new tests.
- Fixed WebSocket backpressure and buffered provider-runtime ingestion cases that could otherwise leave live updates stale under load.

### Verification

- `bun run fmt:check` initially failed on `apps/web/src/routes/__root.tsx`; after formatting that file with `bunx oxfmt apps/web/src/routes/__root.tsx`, `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` initially failed in `apps/web/src/components/chat/TraitsPicker.browser.tsx`, `apps/web/src/store.ts`, `apps/server/src/provider/Layers/CursorAdapter.ts`, and `apps/server/src/wsRpc.ts`; after targeted fixes, `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings.
- `bun run test` failed in `packages/effect-acp/src/client.test.ts` on `returns formatted invalid params when a typed extension request payload is wrong` and `replays buffered notifications to handlers registered after they arrive`, both with 5000ms timeouts; Turbo then canceled `synara:test` and `@synara/web:test` with code 130.
- `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong|replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed (2 tests passed, 3 skipped).
- `bun run test` from `packages/effect-acp` passed (3 files passed; 24 tests passed).
- `bun run test` from `apps/server` passed (118 files passed, 1 skipped; 1136 tests passed, 6 skipped).
- `bun run test` from `apps/web` passed (147 files passed; 1690 tests passed).
- Final `bun run fmt:check` passed.
- Final `bun run lint` passed with 148 warnings, 0 errors.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.7`.

## 0.1.6 - 2026-06-09

### Added

- Added transcript text markers with orchestration events, projection persistence, migration `042_ProjectionThreadsMarkers`, shared marker validation, transcript selection actions, marker-aware scrolling, and an Environment panel marker section.
- Added website favicon support for markdown links, composer/user-bubble link chips, and bare-domain link parsing, backed by a server-side favicon cache and authenticated favicon image route.
- Added local server monitoring, project-run tracking, local-server Environment panel rows, sidebar/project-run controls, and WebSocket/RPC contracts for listing and stopping tracked dev servers.
- Added terminal/project visual identity helpers and project-run target/running helpers so local server and terminal surfaces can share clearer labels and icons.
- Added focused tests for marker round-trips, marker scrolling, local server monitoring, project run targets, terminal visual identity, favicon parsing/cache behavior, and link chip parsing.

### Changed

- Refined transcript rendering and timeline behavior so marker navigation, markdown highlights, collapsed work disclosures, and auto-scroll follow logic are less likely to fight each other.
- Unified link rendering across AI responses, composer chips, and sent user bubbles so site identity, favicon fallback, alignment, and medium-weight text stay consistent.
- Reworked local-server discovery around listener address-family metadata, project ownership matching, and tracked PTY/dev-server state.
- Refined recent view switching, browser panel identity, terminal chrome sizing, and local server display state around project-aware surfaces.
- Tightened orchestration projection and provider/runtime handling around markers, thread updates, local server state, and terminal/runtime cleanup.

### Fixed

- Fixed retired model picker keybindings so shortcuts keep working when hidden/retired model entries are present.
- Fixed collapsed work disclosures retriggering tail-scroll behavior after output had already settled.
- Fixed formatter drift in `apps/server/src/wsRpc.ts` and `apps/web/src/lib/serverReactQuery.ts`.
- Fixed the local-server test fixture to include the required listener address `family` field.
- Fixed bare domains such as `linear.app/...` being ignored by composer/user-bubble link chip parsing while full `https://...` links worked.

### Verification

- `bun run fmt:check` initially failed on `apps/server/src/wsRpc.ts` and `apps/web/src/lib/serverReactQuery.ts`; both files were formatted and the rerun passed.
- `bun run lint` passed with 145 warnings, 0 errors.
- `bun run typecheck` initially failed in `apps/server/src/devServerManager.test.ts` because a `ServerLocalServerProcess` fixture lacked `family`; after the fixture fix, `bun run typecheck` passed.
- `bun run release:smoke` passed.
- `bun run build` passed.
- `bun run test` failed in `packages/effect-acp/src/client.test.ts` on `replays buffered notifications to handlers registered after they arrive` with a 5000ms timeout; Turbo canceled the server test package afterward with code 130.
- `bun run test src/client.test.ts -t "replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed (1 test passed, 4 skipped).
- `bun run --cwd apps/server test -- --reporter verbose --maxWorkers=1` passed (112 files passed, 1 skipped; 1108 tests passed, 6 skipped).
- `bun run test` from `apps/web` passed (140 files passed; 1657 tests passed).
- `bun run test` from `packages/contracts` passed (9 files passed; 90 tests passed).
- `bun run test` from `packages/shared` passed (21 files passed; 183 tests passed).
- `bun run test` from `apps/desktop` passed (18 files passed; 141 tests passed).
- `bun run test` from `scripts` passed (5 files passed; 36 tests passed).
- `apps/marketing` has no `test` script.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.6`.

## 0.1.5 - 2026-06-08

### Added

- Added macOS update artifact smoke tooling, zip finalization helpers, and boolean environment parsing tests for the desktop release path.
- Added focused diff panel components for the toolbar, file jump menu, file list, patch viewport, and selector helpers.
- Added browser/unit coverage for queued turn auto-dispatch, plan-mode queued chat turns, composer stacked panel framing, diff view-source logic, provider discovery, markdown rendering, and mention/file icon behavior.

### Changed

- Refreshed README/release messaging and Synara desktop update flow documentation around the current app positioning.
- Reworked the diff panel around explicit repo-vs-turn state, searchable file filtering, and smaller view components.
- Unified composer stacked panels above the input so plan activity, queued follow-ups, and live file-change rows share width, border, radius, and dark-mode opacity.
- Refined chat markdown spacing, composer command menu selection, provider/plugin discovery normalization, and file/plugin icon rendering in sent messages.

### Fixed

- Fixed queued chat dispatch so queued turns preserve their own interaction mode, attachments, and prompt while a plan follow-up is pending.
- Fixed live file-change composer chrome so it appears only for active turns with actual provider file edits.
- Fixed draft/reference handling so selected plugin and file mentions keep their structured references and icons after navigation or reload.
- Removed the older update-feed cache path in favor of the newer resumable update download coverage.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with 145 warnings, 0 errors)
- `bun run typecheck` (passes with TS44 informational messages about JSON usage in tests/protocol files)
- `bun run release:smoke`
- `bun run build` (passes; Vite still warns about large web chunks and plugin timings)
- `bun run test` (failed once: `packages/effect-acp/src/client.test.ts` timed out in `replays buffered notifications to handlers registered after they arrive`)
- `bun run test src/client.test.ts -t "replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` (targeted rerun passed: 1 test passed, 4 skipped)
- `bun run test src/whatsNew/logic.test.ts` from `apps/web`
- `bun run test src/components/ChatMarkdown.test.tsx` from `apps/web`
- `bun run test` from `apps/web` (132 test files passed; 1588 tests passed)
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website`

## 0.1.4 - 2026-06-07

### Added

- Added project, thread, and message pinning across the orchestration projection, persistence layer, shared pin helpers, sidebar state, environment panel, and focused web stores.
- Added environment-panel pinned-message management and autosaved thread notes so durable context can live beside the transcript without being mixed into the chat stream.
- Added a recent-view switcher with keyboard navigation, keycap hints, route activation logic, persistent recent-view tracking, and browser/unit coverage.
- Added resumable desktop update download infrastructure with dedicated tests for partial files, persisted metadata, retry behavior, and interrupted download recovery.
- Added pull-availability data to the Git contract/server/web path so Git action controls can reflect whether pull is actually safe and useful for the current branch.
- Added broader tests for keybindings, composer mentions, composer drafts, pinned projects/threads/messages, thread detail prewarming, recent views, migrations, and release browser flows.

### Changed

- Reworked the sidebar/project/thread pinning model around shared logic so pinned state is projected consistently after reloads, legacy migration reconciliation, and snapshot refreshes.
- Expanded the chat environment surface with dedicated pinned and notes sections, tighter environment row styling, and shared action hooks for pin/unpin flows.
- Tightened composer behavior around mention icons, draft references, queued headers, picker styling, compact controls, and empty-chat controls.
- Improved runtime resilience around external Claude shutdowns, terminal manager cleanup, websocket RPC error flow, and provider session recovery.
- Refined projection snapshot queries and pipeline behavior so pinned messages, notes, and project pins are present in thread detail and orchestration snapshots.
- Updated release/browser tests and mocks around the recent switcher, keybindings, and app release surfaces.

### Fixed

- Fixed pinned-state migrations and legacy reconciliation so older projected thread data can upgrade cleanly.
- Fixed composer mention icon rendering and draft reference handling.
- Fixed release browser tests by adding switcher keycap coverage and the needed test mock.
- Fixed Git action availability checks that previously had to infer pull state too late in the UI.
- Fixed external Claude SIGTERM handling so an outside shutdown is treated as a benign suspended session instead of a failed turn.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with 138 warnings, 0 errors)
- `bun run typecheck` (passes with TS44 informational messages about JSON usage in tests/protocol files)
- `bun run release:smoke`
- `bun run build` (passes; Vite still warns about large web chunks and plugin timings)
- `bun run test` (109 test files passed, 1 skipped; 1068 tests passed, 6 skipped; 6m13s)
- `bun install` after version bump to update `bun.lock`
- `bun run test src/whatsNew/logic.test.ts` from `apps/web` after release-note edits (12 tests passed)
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website`

## 0.1.3 - 2026-06-05

### Added

- Added in-app thread recap support with provider-backed generation, cached recap state, current-state context, and tests around recap assembly.
- Added richer agent activity detail surfaces so subagent/task rows can be opened and inspected from the transcript flow.
- Added release notes for `0.1.3` to the built-in What's New / Release History data.

### Changed

- Reworked transcript, chat header, environment panel, Git action, branch toolbar, and queued composer rendering so busy sessions remain easier to scan.
- Computed repo diff totals once in `ChatView` and reused them across the header and environment panel, avoiding duplicate large-patch parsing during live updates.
- Streamlined archived-thread deletion through shared client helpers, including optimistic local removal, batched worktree-linked cleanup, and a single shell snapshot reconciliation.
- Made desktop update UI quieter during background polling and kept production web/server/desktop sourcemaps disabled by default unless explicitly enabled for diagnostics.
- Tightened terminal runtime cleanup, shell summary handling, provider activity ingestion, and session handoff safeguards.
- Refined composer attachment, reference chip, queued row, and compact control spacing for a cleaner release build.

### Fixed

- Fixed TypeScript exact-optional-property failures in optional callback pass-throughs.
- Fixed recap generation test doubles to use the shared `ThreadRecapGenerationInput` contract.
- Updated image attachment chip tests to match the current compact thumbnail UI.
- Preserved the final archived-thread and diff-total behavior with focused tests.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with existing warnings)
- `bun run typecheck`
- `bun run release:smoke`
- `bun run build`
- `bun run test`
- `bun run test integration/orchestrationEngine.integration.test.ts -t "reverts to an earlier checkpoint and trims checkpoint projections"`
- `bun run test integration/orchestrationEngine.integration.test.ts -t "forwards thread.turn.interrupt to claudeAgent provider sessions"`
- `bun run test -- src/lib/archivedThreadDelete.test.ts src/components/chat/ComposerImageAttachmentChip.test.tsx src/whatsNew/logic.test.ts`
- `bun run test -- src/git/Layers/GitManager.test.ts -t "thread recap|commit message|status"`
