// FILE: whatsNew/entries.ts
// Purpose: Curated "What's new" changelog rendered in the post-update dialog
// and the settings Release history view.
// Layer: static data consumed by `useWhatsNew`, `WhatsNewDialog`, and
// `ChangelogAccordion`.
//
// Authoring guide
// ---------------
//   - Prepend new releases so the file reads newest-first (the UI sorts too,
//     but keeping the source tidy makes PRs easier to review).
//   - `version` must match `apps/web/package.json#version` exactly. The
//     logic compares versions as semver and only opens the dialog when the
//     installed build has a curated entry here.
//   - `date` is rendered verbatim — pick whatever format you want (e.g.
//     `"Apr 18"`, `"2026-04-18"`), just be consistent release-to-release.
//   - Each feature takes an `id` (stable, unique per release), a short
//     `title`, a marketing `description`, and optionally an `image`
//     (absolute path from `apps/web/public`, e.g. `/whats-new/0.0.29/foo.png`)
//     plus `details` for the longer technical note shown under the image.

import type { WhatsNewEntry } from "./logic";

export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    version: "0.6.3",
    date: "Jul 27",
    features: [
      {
        id: "responsive-stop-controls",
        title: "Stop stays responsive under load",
        description:
          "Interrupt and stop actions now take priority over new work, even when a busy Synara server has filled its ordinary command queue.",
        details:
          "Control, user, and background commands now use separate admission priorities while preserving reserved capacity for recovery. Provider calls and lifecycle locks are bounded too, so one wedged session cannot hold every other task hostage, and failed stop requests now surface an actionable error instead of silently leaving the UI spinning.",
      },
      {
        id: "compensating-checkpoint-reverts",
        title: "Undo can recover from a partial failure",
        description:
          "File and conversation reverts now preserve a rescue snapshot before changing your worktree and restore it if the provider rollback fails.",
        details:
          "Reverts validate checkpoints before mutation, work without a live provider session, retry their deterministic completion step, and clean up managed refs only after the operation commits. Grouped file-change cards undo newest-first, while failures identify any retained rescue ref so recovery remains explicit.",
      },
      {
        id: "durable-session-settlement",
        title: "Interrupted sessions settle cleanly",
        description:
          "Turns are less likely to remain stuck as running after terminal provider events, restarts, stale resumes, or delayed lifecycle updates.",
        details:
          "Synara retains enough turn identity to settle late Claude results, fences stale lifecycle generations, reconciles durable provider commands and runtime events, and aligns Codex, Claude, Cursor, and ACP session ownership through start, stop, reconnect, and restart boundaries.",
      },
      {
        id: "safe-follow-up-queues",
        title: "Follow-ups no longer disappear into stale queues",
        description:
          "A thread that looks busy but has no real active turn keeps the composer available instead of accepting a message that cannot be dispatched.",
        details:
          "Queue draining now requires a queueable live turn, the transcript keeps the newest answer open while terminal state converges, and visible stop failures are reported immediately. These safeguards keep the conversation usable while server-side recovery repairs stale session state.",
      },
      {
        id: "visible-thread-rehydration",
        title: "Open tasks stay present during refreshes",
        description:
          "Visible task details are retained and re-requested across overlapping snapshot, subscription, and eviction work instead of briefly rendering as an empty conversation.",
        details:
          "Thread-detail retention now understands what is on screen, re-arms refreshes that race an in-flight snapshot, and normalizes projections more defensively. Cleanup also preserves archived tasks, newly forked or handed-off tasks, and soft-deleted history without proven manual-delete provenance.",
      },
    ],
  },
  {
    version: "0.6.2",
    date: "Jul 27",
    features: [
      {
        id: "universal-live-tool-activity",
        title: "Every agent's live tool work is visible",
        description:
          "Follow tools as they start, update, and finish across supported providers, with consistent labels and details directly in the transcript.",
        details:
          "Synara now normalizes live and settled tool activity into one presentation model, preserves expandable tool details and interactions, and reconciles terminal states without leaving duplicate or permanently running work rows behind.",
      },
      {
        id: "reliable-live-recovery",
        title: "Live tasks recover after reconnects",
        description:
          "Provider status, active turns, and thread details converge back to the server's real state after dropped connections or delayed events.",
        details:
          "Reconnect refreshes preserve useful status while new data arrives, stale live projections are fenced and repaired, settled turns stop polling, and thread-detail ownership is reconciled across lease, snapshot, and subscription races.",
      },
      {
        id: "follow-up-dispatch-mode",
        title: "Choose whether follow-ups queue or steer",
        description:
          "Set new messages sent during active work to wait their turn or steer the current agent immediately.",
        details:
          "The new conversation setting is searchable in Settings and is applied consistently by the composer while a task is running, with Queue as the predictable default and Steer available for more interactive workflows.",
      },
      {
        id: "recover-blocked-threads",
        title: "Blocked threads can be recovered",
        description:
          "When an uncertain provider delivery quarantines a thread, the error banner now offers a safe Unblock thread action.",
        details:
          "Synara abandons ambiguous blockers oldest-first, then replays only the skipped turn starts. This restores the conversation without risking a duplicate resend of the command whose delivery could not be proven.",
      },
      {
        id: "automation-and-desktop-resilience",
        title: "Automations and desktop recovery are tougher",
        description:
          "Dedicated automation runs, clearer completion policies, and bounded desktop crash recovery make unattended work more dependable.",
        details:
          "Automation self-cancellation is explicitly authorized, run state and completion policies persist more reliably, renderer crashes use bounded reload recovery with actionable prompts, and process supervision, executable lookup, terminal wrappers, worktrees, and Git status broadcasting handle failure boundaries more carefully.",
      },
      {
        id: "faster-startup-and-diffs",
        title: "Startup and large diffs do less work",
        description:
          "Synara loads expensive provider and diff machinery only when needed and computes working-tree statistics without transferring full patches.",
        details:
          "Shell environment probes and orchestration startup state are reused, route chunks are preloaded selectively, supervised process scans are throttled, and React Compiler coverage protects chat, picker, hook, and UI hot paths.",
      },
      {
        id: "storage-and-artifact-safety",
        title: "Local state stays safer",
        description:
          "Exclusive SQLite locking and stricter migration-artifact cleanup reduce the chance of competing writers or abandoned update files.",
        details:
          "Database access now proves exclusive ownership, migration backups and resumable artifacts receive broader retention and reclamation coverage, and orphan cleanup stays bounded to verified Synara-owned paths.",
      },
      {
        id: "custom-void-space",
        title: "Make the Void space your own",
        description:
          "Rename Void and choose its icon so unassigned projects fit the way you organize your workspace.",
        details:
          "The custom presentation is stored locally and appears consistently in the sidebar, Space switcher, project pickers, and creation flows, with validation and a one-step reset to the default.",
      },
      {
        id: "readability-and-interface-polish",
        title: "Small details are calmer and clearer",
        description:
          "Completion notifications retain useful Markdown context, command menus explain loading and empty states, and Settings are organized around user intent.",
        details:
          "This release also standardizes settings cards and elevated hover surfaces, simplifies subagent transcript rows, preserves the landing project color, keeps Ctrl-minus zoom working on Windows and browser guests, improves diff and composer hot paths, and makes fenced code, references, nested Markdown, and technical completion summaries safer and easier to read.",
      },
    ],
  },
  {
    version: "0.6.1",
    date: "Jul 25",
    features: [
      {
        id: "database-recovery",
        title: "Updates recover safely from interrupted migrations",
        description:
          "Synara now detects and repairs the database state that could leave some 0.6.0 installations stuck during startup.",
        details:
          "Migration lineage is validated before launch, recovery uses verified backups and resumable markers, and the desktop supervisor distinguishes recoverable migration failures from ordinary backend exits. The recovery path is covered on macOS, Linux, and Windows, including Windows-specific process and filesystem behavior.",
      },
      {
        id: "simpler-project-navigation",
        title: "Projects are easier to enter and switch",
        description:
          "Start from the project you want directly in the new-task heading, with fewer intermediate workspace screens and steadier navigation state.",
        details:
          "The project name in the empty-chat heading is now a picker trigger, Space navigation is normalized through one shared path, and Studio workspace metadata is repaired during migration so restored tasks open in the right place.",
      },
      {
        id: "reliable-diffs-and-git",
        title: "Diff and Git tools stay in sync",
        description:
          "Switch diff views, refresh repository state, and copy large virtualized changes without stale controls or missing content.",
        details:
          "The diff toolbar now derives its mode and selection consistently, Select All copies the complete virtualized diff, Git status refreshes after actions, and branch controls handle repository and worktree state more predictably.",
      },
      {
        id: "steadier-agent-sessions",
        title: "Agent sessions settle and recover more cleanly",
        description:
          "Claude, OpenCode, Pi, Codex, and other providers keep their model choices, runtime state, and shutdown boundaries aligned through reconnects and failures.",
        details:
          "This release fixes Pi model discovery against the current runtime SDK, ignores stale OpenCode plan agents, hardens Claude resume and permission handling, preserves WebSocket requests across reconnect boundaries, and proves process-tree teardown before replacing desktop or provider backends.",
      },
      {
        id: "clearer-live-status",
        title: "Live work is easier to read",
        description:
          "Automation rows show state-specific icons, task hydration is calmer, and active conversations avoid unnecessary projection and subscription churn.",
        details:
          "Automation status now distinguishes running, attention, failure, and settled states at a glance. Store projection, thread-detail retention, terminal cleanup, and sidebar updates were tightened so busy workspaces remain responsive and predictable.",
      },
    ],
  },
  {
    version: "0.6.0",
    date: "Jul 24",
    features: [
      {
        id: "external-synara-mcp",
        title: "Bring Synara to any MCP-capable agent",
        description:
          "Connect Codex, Claude Code, Claude Desktop, or another local MCP app, then let it discover your Synara workspace, launch isolated tasks, wait for results, and bring the answer back.",
        details:
          "Settings → Integrations now provides a copy-ready guided prompt for agentic clients, manual JSON configuration for Claude Desktop and other non-agentic clients, resumable pairing, all-or-selected project access, provider and model discovery, connection status, and immediate revocation. Connections expire, are rate-limited and capability-scoped, and default new work to managed worktrees with approval-required execution; local-checkout, full-access, and project-wide task reading stay behind explicit advanced permissions.",
      },
      {
        id: "built-in-synara-mcp",
        title: "Synara's agents can now operate Synara",
        description:
          "Every supported agent running inside Synara receives built-in tools to understand the app, delegate work, coordinate parallel tasks, inspect failures, and manage automations.",
        details:
          "The new Synara Agent Gateway can list and read projects and tasks, create one task or an exact multi-agent batch across providers and models, wait for every result, continue or interrupt work, rename or archive tasks, inspect runtime diagnostics, and manage automation lifecycles. Thread-bound authority, privilege caps, idempotent creation, isolated worktrees, and restart recovery keep delegated work visible and contained.",
      },
      {
        id: "project-spaces",
        title: "Organize projects into Spaces",
        description:
          "Create named, icon-based Spaces for the parts of your work that belong together, while unassigned projects remain easy to find in Void.",
        details:
          "Spaces support persisted ordering, project assignment, drag-and-drop movement, bulk moves, activity indicators, inline creation while adding a project, and numbered keyboard shortcuts for direct switching.",
      },
      {
        id: "automation-collaborators",
        title: "Automations become long-running collaborators",
        description:
          "Ask an agent to suggest or create scheduled and heartbeat automations with memory, limits, notifications, and clear review states.",
        details:
          "Automations now support standalone and heartbeat modes, persistent memory, cooldowns, maximum runs, notification and completion policies, pause and resume, proposal review, run reconciliation after interruptions, and richer list rows for unread results, failures, approvals, and changes that need attention.",
      },
      {
        id: "claude-subagents-workflows",
        title: "Claude subagents and workflows are first-class",
        description:
          "Follow Claude's native subagents and dynamic workflows as real Synara work, with live status, phases, tools, usage, steering, and background controls.",
        details:
          "Child tasks are navigable and independently visible, workflow cards show every phase and agent by default, model and effort stay live, and pause, resume, stop, foreground, and background actions remain synchronized through late events and provider restarts.",
      },
      {
        id: "cross-task-context",
        title: "Bring another task into the conversation",
        description:
          "Mention an existing Synara task from the composer to give the current agent the right recent context without copying a transcript by hand.",
        details:
          "Cross-task mentions include bounded recent conversation context together with the source project and provider identity, and disambiguate tasks that share the same title.",
      },
      {
        id: "faster-agent-work",
        title: "New work starts faster and streams lighter",
        description:
          "New chats paint sooner, model choices arrive earlier, and active turns spend less time on repeated setup, storage, and rendering work.",
        details:
          "Synara prefetches provider models before the composer opens, avoids a redundant first-turn Claude permission wait, prepares Codex overlays without blocking, parallelizes independent turn-start I/O, reduces streaming SQL work, and expands React Compiler coverage across the web app.",
      },
      {
        id: "provider-reliability",
        title: "Provider sessions stay truer to their capabilities",
        description:
          "Claude, Codex, Cursor, Droid, Grok, OpenCode, Kilo, Pi, and Antigravity receive a broad round of model, permission, resume, child-event, and completion fixes.",
        details:
          "Highlights include Fable 5 and Opus 4.8 in Pi, namespaced Cursor and Grok model support, accurate Claude context windows, official ACP SDK handling, app-owned OpenCode review commands, isolated Codex child events, safer provider updates, preserved blank PATH defaults, and an Antigravity hook that no longer launches Synara unexpectedly.",
      },
      {
        id: "desktop-runtime-hardening",
        title: "Desktop and browser lifecycles recover cleanly",
        description:
          "Browser control, Windows shutdown, managed worktrees, durable secrets, thread deletion, and macOS release finalization now fail and recover more predictably.",
        details:
          "The desktop browser bridge restores discovery, ownership, teardown, and reconnect behavior; Windows waits for the backend to stop; interrupted worktree cleanup resumes safely; deleted work cannot resurrect queued turns; credential writes survive interruption; and universal macOS releases preserve the correct update metadata.",
      },
      {
        id: "workspace-polish",
        title: "Hundreds of small edges feel calmer",
        description:
          "Sharper Markdown hierarchy, steadier pickers, better composer spacing, smarter sidebar priority, clearer Studio Git controls, and new shortcuts make daily work easier to scan.",
        details:
          "This release also adds Commit and Push from the active task, configurable AppSnap shortcuts, a folder opener in Studio, a slimmer running indicator, reliable Cmd+K search on macOS, fixed PR review counts, safer file-icon lookup, cleaner stacked composer panels, and a global new-task flow that uses the latest project state.",
      },
    ],
  },
  {
    version: "0.5.5",
    date: "Jul 17",
    features: [
      {
        id: "antigravity-provider",
        title: "Antigravity joins Synara",
        description:
          "Connect the Antigravity CLI as a first-class coding agent, with discovered models, reasoning controls, streaming activity, approvals, and resumable conversations.",
        details:
          "The new provider adapter covers installation and authentication guidance, model and effort discovery, session creation and resume, tool and plan events, permission requests, usage reporting, cancellation, and restart recovery. Synara also includes dedicated Antigravity branding throughout provider setup and selection.",
      },
      {
        id: "steadier-live-turns",
        title: "Live turns settle cleanly",
        description:
          "Working indicators and streamed turn chrome no longer linger after the underlying provider session has already finished.",
        details:
          "Turn settlement now follows the owning session lifecycle, while WebSocket RPC requests resolve or reject across close, timeout, send failure, and reconnect paths. This keeps pending UI state from becoming stuck during partial streams or interrupted connections.",
      },
      {
        id: "faster-chat-updates",
        title: "Active chats stay lighter",
        description:
          "Conversation updates do less repeated reconciliation work, keeping busy transcripts and sidebar-driven changes more responsive.",
        details:
          "Chat state now avoids redundant scans and projections during live updates, bundled theme seeds reset consistently, and common transcript behavior remains on the simpler rendering path without introducing new measurement loops.",
      },
      {
        id: "reliable-path-drops",
        title: "Dropped paths become reliable mentions",
        description:
          "Drop files and folders whose names contain spaces or parentheses into the composer without losing or mangling the path.",
        details:
          "Desktop path payloads are parsed and normalized through shared composer logic, then preserved as mentions across chat and Kanban task creation. Focused coverage includes encoded paths, multiple drops, punctuation, send normalization, and unsupported payloads.",
      },
      {
        id: "resilient-model-pickers",
        title: "Provider failures stay contained",
        description:
          "A failed Cursor model refresh no longer takes down the model picker or discards usable choices from other discovery sources.",
        details:
          "Model-catalog queries retain successful and cached data when one Cursor discovery path fails, while pull-request data is coalesced through shared list logic and picker popups use a unified interaction model. Diff headers now use Synara's own visual chrome for a more consistent workspace.",
      },
    ],
  },
  {
    version: "0.5.4",
    date: "Jul 15",
    features: [
      {
        id: "pull-request-workspace",
        title: "Review pull requests without leaving Synara",
        description:
          "Browse, search, and filter pull requests across your projects, then open a complete review workspace beside the conversation.",
        details:
          "The new GitHub CLI-backed Pull Requests view groups work by involvement and state, supports project-scoped discovery, and opens summary, code, and timeline views with checks, reviewers, commits, file changes, and discussion context.",
      },
      {
        id: "pull-request-actions",
        title: "Take action from the review workspace",
        description:
          "Comment, merge, close, reopen, and pin pull requests while keeping the latest repository state close at hand.",
        details:
          "Mutations use shared cache coordination, single-flight refreshes, guarded optimistic state, and recovery paths so overlapping actions and refreshes remain predictable. Pinned pull requests stay easy to return to from the project workspace.",
      },
      {
        id: "resilient-pr-discovery",
        title: "Repository failures stay contained",
        description:
          "One unavailable repository no longer prevents useful pull-request results from the rest of your workspace.",
        details:
          "GitHub CLI availability, authentication, repository discovery, partial-result errors, stale cached data, and retry recovery now have explicit states. Per-repository failures remain visible without discarding successful results.",
      },
      {
        id: "global-feedback",
        title: "Send feedback from anywhere",
        description:
          "Open the new feedback dialog from the command menu or with /feedback whenever an idea or problem comes up.",
        details:
          "Feedback is now a global workflow rather than a settings-only destination, with consistent command routing and a focused dialog that keeps the current task in place.",
      },
      {
        id: "desktop-window-restore",
        title: "Desktop windows reopen where you left them",
        description:
          "Synara restores the previous desktop window size, position, and maximized state while keeping reopened windows on a visible display.",
        details:
          "Window state is persisted across launches and validated against the current monitor layout, avoiding off-screen restoration when displays have changed.",
      },
      {
        id: "steadier-model-sessions",
        title: "Model and session behavior is more predictable",
        description:
          "Agent sessions, transcript rendering, model discovery, and reasoning controls now stay aligned across more providers.",
        details:
          "Session orchestration and transcript rendering share a cleaner lifecycle, Pi custom-provider authentication follows auth.json semantics, Cursor transport-only variants stay out of the picker, and Grok reasoning-effort options match provider capabilities. The interface also adopts the system UI font more consistently.",
      },
    ],
  },
  {
    version: "0.5.3",
    date: "Jul 14",
    features: [
      {
        id: "appsnap-capture",
        title: "Capture any Mac app straight into your task",
        description:
          "Press both Option keys to capture the window you are using and attach it to the current Synara task.",
        details:
          "AppSnap is an opt-in macOS workflow with a dedicated setup panel, permission guidance, capture feedback, app icons, and a first-run introduction. Captures stay tied to the active task without stealing focus, and the desktop helper is included in packaged Mac builds.",
      },
      {
        id: "durable-appsnap-drafts",
        title: "AppSnaps wait safely until you send",
        description:
          "Captured windows remain available through navigation, restarts, retries, and manual attachment flows.",
        details:
          "Pending image blobs are persisted outside the lightweight draft record, restored into the composer on startup, counted against attachment limits, deduplicated across retry paths, and hydrated immediately before send. Failed or overlapping captures recover without duplicating attachments or replaying feedback sounds.",
      },
      {
        id: "clearer-long-messages",
        title: "Long messages are easier to scan",
        description:
          "Large user messages collapse into a focused preview while rich markdown and attachment chips remain readable.",
        details:
          "Transcript measurement, overflow detection, markdown chip rendering, and the simple non-virtualized timeline path now work together more predictably, reducing layout churn without losing the full message on demand.",
      },
      {
        id: "steadier-agent-sessions",
        title: "Agent sessions fail more clearly",
        description:
          "ACP errors preserve more useful detail, and session and transcript state stay steadier during active work.",
        details:
          "ACP request failures now retain structured provider context, while session orchestration and transcript handling avoid redundant state transitions and keep live output presentation predictable.",
      },
    ],
  },
  {
    version: "0.5.2",
    date: "Jul 13",
    features: [
      {
        id: "droid-provider",
        title: "Factory Droid is now a first-class provider",
        description:
          "Droid is now available alongside Synara's other agents, with runtime model discovery, session import, token multipliers, and resilient resume and recovery.",
        details:
          "Synara now connects to Factory Droid through ACP, discovers models and their switching capabilities at runtime, imports existing Droid sessions, carries context across forks and restarts, and keeps bootstrap, configuration, and turn teardown state coherent. The release also adds the Factory logo and richer Droid token reporting.",
      },
      {
        id: "large-history-startup",
        title: "Large conversation histories start reliably",
        description:
          "Synara now upgrades large local histories without leaving the project list stuck on its loading screen.",
        details:
          "The activity-sequence backfill now builds one indexed lookup instead of repeatedly scanning the entire event history. A database with more than 180,000 activities completes the recovery in seconds while preserving every project, thread, message, and activity.",
      },
      {
        id: "keyboard-model-cycling",
        title: "Switch models from the keyboard",
        description:
          "Use Alt+] and Alt+[ to cycle through available models without leaving the conversation.",
        details:
          "The shortcuts use the active provider's available model options and keep model selection quick during an ongoing workflow.",
      },
      {
        id: "unfinished-task-lists",
        title: "Unfinished task lists stay visible",
        description:
          "Task lists now remain in the transcript after a turn completes, making follow-up work easier to resume.",
        details:
          "Runtime task projections preserve unfinished items after completion while keeping finished and resumed task state consistent.",
      },
      {
        id: "file-undo-chat-history",
        title: "File undo leaves chat history intact",
        description:
          "Undoing an agent turn now rolls back its files without deleting the conversation that explains the change.",
        details:
          "Turn-scoped checkpoints restore workspace state while preserving transcript history and provider conversation state.",
      },
      {
        id: "cross-platform-agent-polish",
        title: "Smoother cross-platform agent workflows",
        description:
          "Codex model options, Windows launching, project folder labels, and Git status checks now behave more predictably across platforms.",
        details:
          "Runtime-discovered Codex reasoning efforts map correctly, the Windows CLI path forwards arguments reliably, project picker labels match the host OS, and Git status handles directories outside repositories gracefully.",
      },
      {
        id: "calmer-file-change-header",
        title: "File changes are calmer to scan",
        description:
          "File-change headers use a softer visual treatment, keeping active work readable without competing with the diff itself.",
      },
    ],
  },
  {
    version: "0.5.0",
    date: "Jul 11",
    features: [
      {
        id: "synara-identity",
        title: "Synara, all the way through",
        description:
          "The app now uses one identity everywhere, from its desktop installation and command line to packages, settings, diagnostics, and release artifacts.",
        details:
          "The desktop bundle is now com.emanueledipietro.synara, the CLI is @synara/cli with the synara command, and every first-party runtime identifier uses the Synara namespace. The 0.4.2 bridge preserves renderer state during the origin change.",
      },
      {
        id: "claude-context-and-resume",
        title: "Claude keeps context under control",
        description:
          "Claude sessions now report live context usage, warn before compaction, switch model and context settings in place, and resume with their safeguards intact.",
        details:
          "The adapter combines SDK context controls with accumulated token usage, preserves the effective context window across responses, keeps fallback reroutes pinned until you choose another model, and stores resume state without forcing unnecessary provider restarts.",
      },
      {
        id: "provider-task-progress",
        title: "Agent task progress stays visible",
        description:
          "Claude task tools and Codex task events now appear through one shared progress stream, so resumable work is easier to follow while it runs.",
        details:
          "Claude TaskCreate, TaskUpdate, TaskGet, TaskList, and TodoWrite results are normalized into the shared runtime task list and persisted in the resume cursor. Codex task events and provider summaries use the same projection, with coverage for reconnects and resumed sessions.",
      },
      {
        id: "codex-stream-reliability",
        title: "Codex reasoning and streams are easier to trust",
        description:
          "Codex reasoning summaries, context compaction, task updates, and noisy app-server output are handled more reliably, keeping live transcripts clearer during long turns.",
        details:
          "The app-server bridge now ignores non-protocol stdout safely, preserves provider-authored reasoning summaries, normalizes runtime events, and hardens resume and ingestion paths so progress is not lost between streamed updates.",
      },
      {
        id: "faster-recovery",
        title: "Chat startup and recovery are lighter",
        description:
          "Chat dock panels load on demand, deleted projects remain safe client tombstones, and browser profile migrations repair database sidecars transactionally instead of leaving partial state behind.",
        details:
          "The chat route measures LCP while deferring secondary panels, while project deletion and desktop profile repair now preserve predictable local state through reloads, retries, and interrupted migrations.",
      },
      {
        id: "safer-release-updates",
        title: "Desktop updates have stronger guardrails",
        description:
          "Release automation now validates compatibility-feed manifests and protects the packaged desktop from unsafe bundle swaps across update and startup paths.",
        details:
          "The release workflow verifies the pinned updater lane, keeps clean releases off the compatibility channel, repairs update-feed metadata, and hardens desktop startup when an app.asar swap is detected.",
      },
    ],
  },
  {
    version: "0.4.2",
    date: "Jul 9",
    features: [
      {
        id: "synara-identity-bridge",
        title: "Synara is preparing a seamless identity upgrade",
        description:
          "Launch this version at least once before installing the next Synara release so your drafts, pins, theme, browser state, and other local interface preferences move with you.",
        details:
          "This bridge writes a validated Synara-only snapshot of renderer state, keeps existing project and thread data intact, and prepares database and checkpoint metadata for the final identity cutover. Earlier command and environment aliases are accepted by this bridge release only and will be removed next.",
      },
      {
        id: "claude-usage-reliability",
        title: "Claude threads use far fewer tokens and restart less",
        description:
          "Long Claude conversations now track their 1M-token context window per thread, compact automatically, and switch models without restarting the session — ending runaway usage.",
        details:
          "Each thread tracks its own context window and warns as usage approaches the limit. After a safeguard reroute, the fallback model stays pinned until you explicitly pick another model, and model or context-window changes apply in-session instead of tearing the session down.",
      },
      {
        id: "desktop-update-verification",
        title: "Desktop updates now verify their own installs",
        description:
          "Synara checks that an update actually installed after restart, detects failed installs, and recovers instead of silently staying on the old version.",
        details:
          "A durable install marker survives restarts and tracks handoff state, an install watchdog recovers from hung installs, and on macOS dedicated diagnostics capture updater state to make failures actionable.",
      },
      {
        id: "studio-and-migration-fixes",
        title: "Studio shortcut and migration fixes",
        description:
          "The new-chat keyboard shortcut now routes correctly inside Studio, composer drafts survive the storage migration, and incomplete legacy home imports repair themselves.",
        details:
          "Renderer storage migration is guaranteed to run before app hydration, the legacy environment identity is restored from the bridge marker, and checkpoint metadata is canonicalized while keeping existing persisted refs readable.",
      },
    ],
  },
  {
    version: "0.4.1",
    date: "Jul 9",
    features: [
      {
        id: "studio-workspace",
        title: "A dedicated Studio workspace for agent-led work",
        description:
          "Studio gives long-running, agent-led work its own focused space, keeping it distinct from your regular chats while making it quick to start or revisit.",
        details:
          "Studio projects, threads, routing, sidebar rows, empty-state entry points, and restore behavior now share a clear workspace boundary. The release also hardens cross-kind project ownership so a regular chat and a Studio thread cannot accidentally reuse the same container.",
      },
      {
        id: "studio-outputs",
        title: "Studio outputs are collected where you need them",
        description:
          "Files, generated images, and other agent outputs from Studio are surfaced in the Environment panel so finished work is easier to find and open.",
        details:
          "The server records Studio output activity and generated-image metadata, then projects it into a dedicated Environment section with resilient display helpers and targeted coverage for output ordering and presentation.",
      },
      {
        id: "worktree-setup",
        title: "Starting work in a worktree is more transparent",
        description:
          "Project actions now make worktree setup visible, so you can understand what is being prepared before a new workspace-backed thread starts.",
        details:
          "New setup steps and timeline states expose progress and failure more clearly, while the underlying scaffold path self-heals and keeps project/worktree ownership consistent through retries and restores.",
      },
      {
        id: "restore-and-routing-reliability",
        title: "Returning to a chat or Studio is more reliable",
        description:
          "Synara is more careful about restoring the right destination after reloads, segment switches, reconnects, and partially completed project creation.",
        details:
          "Routing now prefers canonical containers, waits for snapshot hydration where needed, fails closed on ambiguous thread kinds, and guards against overlapping fresh-chat creation so drafts and active work land in the intended surface.",
      },
      {
        id: "steadier-live-transcripts",
        title: "Live transcripts stay steadier during active work",
        description:
          "Transcript rendering and active-turn behavior have been refined to keep ongoing agent work easier to follow without needless scroll or layout churn.",
        details:
          "The session orchestration and timeline paths were refactored with focused coverage for worktree setup, transcript rows, sidebar visibility, and workspace handoffs, preserving predictable behavior as sessions stream and reconnect.",
      },
      {
        id: "provider-and-windows-hardening",
        title: "Safer provider startup and Windows launching",
        description:
          "Authentication preparation and provider launch handling are more robust, including a fix for launching Codex on Windows.",
        details:
          "The release prepares the Codex auth overlay before dependent startup paths run, hardens process environment handling, and includes the Windows launcher repair alongside broader orchestration and projection reliability work.",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "Jul 6",
    features: [
      {
        id: "prompt-history-attachments",
        title: "Prompt history keeps drafts and attachments together",
        description:
          "Browsing your previous prompts no longer strips the attachments from the draft you are building, so history navigation is safer for image- and file-heavy follow-ups.",
        details:
          "Composer draft history now preserves attachment state while you move through previous prompts, resets stale navigation state more carefully, and avoids duplicate optimistic history entries after sends.",
      },
      {
        id: "pr-environment-panel",
        title: "Pull request context is clearer in the Environment panel",
        description:
          "Threads attached to GitHub pull requests now surface richer PR context, including merged-state handling and more readable review/check previews.",
        details:
          "The PR snapshot path now captures pull request data for the Environment panel, handles merged PRs more predictably, trims long review previews, dedupes GitHub field requests, and tightens merge-head formatting.",
      },
      {
        id: "claude-rate-limits",
        title: "Claude rate limits fail more gracefully",
        description:
          "When Claude reports usage or rate-limit trouble, Synara now presents the condition more calmly instead of turning it into a generic provider failure.",
        details:
          "Provider usage handling now narrows usage summary types more safely and treats Claude usage limit responses as a recoverable, user-facing state with focused parser and resilience coverage.",
      },
      {
        id: "desktop-stderr-resilience",
        title: "Desktop restarts handle broken stderr pipes",
        description:
          "The desktop app is less likely to crash or get noisy when a restarted child process loses its stderr pipe during shutdown or relaunch.",
        details:
          "Desktop process restart handling now tolerates broken stderr writes, including the EPIPE path that could appear while the app was restarting provider or server processes.",
      },
      {
        id: "release-polish",
        title: "Small reliability fixes across agents and PR flows",
        description:
          "This release rounds off recent agent-session and pull-request work with tighter assertions, safer formatting, and cleaner edge-case behavior.",
        details:
          "The release includes automation migration lineage assertion fixes, PR snapshot review follow-up fixes, provider usage type narrowing, and general cleanup from the prompt-history and PR environment-panel review loops.",
      },
    ],
  },
  {
    version: "0.3.9",
    date: "Jul 5",
    features: [
      {
        id: "thread-export-zip",
        title: "Export a thread as a ZIP",
        description:
          "Type `/export` in a saved, idle chat to download a portable archive with the full thread projection and a readable Markdown transcript.",
        details:
          "The export route streams `thread.json` and `transcript.md` through the server with shared eligibility checks, desktop-friendly CORS/error handling, large-thread history hydration, and browser download support from both typed slash commands and the command menu.",
      },
      {
        id: "archived-profile-stats",
        title: "Archived stats survive cleanup",
        description:
          "Deleting or purging old threads no longer erases their lifetime contribution to profile stats, so cleanup keeps your usage history intact.",
        details:
          "Thread deletion now snapshots profile aggregates before purging rows, merges archived stats back into profile queries, preserves command receipts, cleans checkpoint refs carefully, and includes a migration plus purge/retention regression coverage.",
      },
      {
        id: "active-turn-working-header",
        title: "Active turns show steady work timing",
        description:
          "While an agent is working, the transcript now keeps a stable 'Working for' header at the top of the active turn instead of relying only on a transient shimmer row.",
        details:
          "MessagesTimeline now inserts a stable active-turn header for duration display while preserving the existing setup shimmer, making live turns easier to scan and less jumpy during layout updates.",
      },
      {
        id: "terminal-shutdown-escalation",
        title: "Terminal shutdown is more reliable",
        description:
          "Synara is better at shutting down stubborn terminal process trees without returning early while child processes are still alive.",
        details:
          "TerminalManager now routes shutdown through a dedicated process-tree killer with SIGTERM-to-SIGKILL escalation, cancellation when processes exit cleanly, nested process activity coverage, and tests for disposal timing.",
      },
      {
        id: "acp-resume-message-ids",
        title: "Resumed ACP replies stay distinct",
        description:
          "ACP-backed sessions are less likely to lose assistant replies after a restart or resume because fallback assistant message IDs no longer collide across runtime instances.",
        details:
          "A per-runtime instance ID is included in fallback ACP assistant item IDs, preventing resumed sessions with the same provider session ID and segment index from overwriting earlier transcript messages.",
      },
      {
        id: "git-writing-model-picker",
        title: "Git writing respects OpenCode and Kilo models",
        description:
          "Git commit, diff summary, and PR text generation now honor runtime-discovered OpenCode and Kilo model selections from Settings.",
        details:
          "Settings now persists discovered Git-writing model options, git actions pass the chosen provider/model through the shared contracts, and query cache keys include the text-generation selection so generated commit/PR text routes to the intended backend.",
      },
    ],
  },
  {
    version: "0.3.8",
    date: "Jul 3",
    features: [
      {
        id: "grok-resume-replay-resilience",
        title: "Grok resume handles long sessions more safely",
        description:
          "Grok and other ACP-backed sessions are better at resuming after compaction or reconnects without replaying messages into the wrong runtime or growing memory unexpectedly.",
        details:
          "ACP resume now drops replay before the event consumer is attached, seeds compaction quiet windows from response timing, hardens provider/runtime ingestion, and covers JSON-RPC/session-runtime edge cases that previously made resume replay fragile.",
      },
      {
        id: "worktree-setup-status",
        title: "Worktree setup failures recover cleanly",
        description:
          "When a worktree setup step fails, Synara now shows the failed setup state, keeps the timeline from looking stuck, and resets the local dispatch when you send again.",
        details:
          "ChatView and timeline setup snapshots now carry explicit setup step status, targeted cleanup for failed local dispatches, and focused browser/unit coverage for new-turn reset and setup rows.",
      },
      {
        id: "automation-sent-label",
        title: "Automation messages are labeled",
        description:
          "Prompts sent by an automation now carry a lightweight 'Sent via Automation' label above the bubble, so you can tell at a glance which turns you typed and which a scheduled or heartbeat run kicked off.",
        details:
          "User turns dispatched by the automation engine now persist a `dispatchOrigin` on the message end to end (command → event → projection → snapshot), and the transcript renders a clock-marked chip that mirrors the existing steering label.",
      },
      {
        id: "approval-choice-polish",
        title: "Approval prompts are easier to answer",
        description:
          "Pending approvals now use a clearer shared choice-row layout, with steadier panel behavior and browser coverage for allow/deny decisions.",
        details:
          "ComposerPendingApprovalPanel now shares ComposerChoiceRow structure with pending inputs, tracks decision actions in browser tests, and trims duplicated action styling.",
      },
      {
        id: "startup-keepalive-gating",
        title: "Startup does less surprise work",
        description:
          "Synara avoids unnecessary provider refresh work during startup and gates Claude keepalive behavior more carefully, so opening the app is calmer and less likely to fight credential checks.",
        details:
          "Server startup no longer runs provider refresh eagerly, Claude keepalive respects auth-state timing, provider usage hooks handle inactive summaries more predictably, and related settings/server query invalidation paths have tests.",
      },
      {
        id: "collapsed-work-timing",
        title: "Folded work rows report time more accurately",
        description:
          "Collapsed transcript segments now show a 'Worked for' duration that spans the whole folded section, not just a single row inside it.",
        details:
          "Timeline duration grouping now tracks folded row boundaries and tests the aggregate timing behavior so compact transcripts better match what actually happened.",
      },
    ],
  },
  {
    version: "0.3.7",
    date: "Jul 2",
    features: [
      {
        id: "update-download-progress",
        title: "Update downloads show their progress",
        description:
          "When Synara is downloading a desktop update, the sidebar update button now shows a live percent badge so you can tell whether it is moving or nearly ready.",
        details:
          "The desktop update helper now clamps reported download percentages, hides them outside active downloads, and covers edge cases for null, negative, oversized, and fractional progress values.",
      },
      {
        id: "claude-auth-status-stability",
        title: "Claude auth checks are less jumpy",
        description:
          "Claude sessions are less likely to be marked logged out during refresh-token races, especially when health checks and the macOS credential keepalive run near the same time.",
        details:
          "`claude auth status` is now serialized through a shared lock, retried once for structured false negatives, and can fall back to verified local credential metadata before showing an unauthenticated state.",
      },
      {
        id: "checkpoint-baseline-resilience",
        title: "Turn checkpoints are harder to confuse",
        description:
          "Synara preserves the first pre-turn snapshot more carefully, so transcript diffs and restore points better match what was on disk when you pressed send.",
        details:
          "Checkpoint capture now has single-flight behavior per repo/ref, a bounded capture timeout, first-writer-wins `skipIfExists` baselines, and extra recovery when a startup or backup path missed the original message baseline.",
      },
      {
        id: "chat-sidebar-polish",
        title: "The sidebar chat list behaves more naturally",
        description:
          "The Chats section now lives with the rest of the scrollable sidebar content, has a familiar disclosure chevron, and keeps the footer focused on account/update controls.",
        details:
          "Sidebar chat collapse state now exposes `aria-expanded`, reuses the shared disclosure chevron, and separates chat rows from the footer while preserving sort and new-chat actions.",
      },
      {
        id: "first-send-environment-panel",
        title: "First sends keep the workspace calm",
        description:
          "Starting from an empty chat no longer opens the Environment panel by surprise after the first message turns the landing view into a transcript.",
        details:
          "ChatView now records a closed environment-panel preference when sending from the centered empty landing, preventing the default-open policy from popping the panel into a just-started conversation.",
      },
      {
        id: "provider-health-parser-coverage",
        title: "Provider health parsing is easier to trust",
        description:
          "Provider CLI output handling and Claude auth interpretation now have clearer, isolated parsing paths with more focused tests around failure and metadata cases.",
        details:
          "Generic CLI-output helpers moved out of ProviderHealth, Claude auth parsing moved into a pure module, and new tests cover auth JSON markers, credential summaries, the auth-status lock, checkpoint single-flight behavior, and provider health edge cases.",
      },
    ],
  },
  {
    version: "0.3.6",
    date: "Jun 30",
    features: [
      {
        id: "cursor-launch-fallbacks",
        title: "Cursor launch fallback is much sturdier",
        description:
          "Synara now finds Cursor agent commands across more install layouts, including bundled sibling shims and legacy shim locations, while rejecting unsafe fallbacks.",
        details:
          "Cursor ACP command discovery now resolves safer CLI paths, honors bundled sibling launchers, preserves legacy shim coverage, and avoids falling back to paths that do not match the expected Cursor agent shape.",
      },
      {
        id: "muxy-open-in",
        title: "Muxy can open from Synara",
        description:
          "Open-in support now recognizes Muxy, so editor/open buttons can hand files to the right desktop target when Muxy is part of your workflow.",
        details:
          "Editor metadata, open-route handling, and focused coverage were extended so Muxy is treated as a supported external app alongside the existing editor launch targets.",
      },
      {
        id: "live-message-trail",
        title: "Live chats leave a clearer message trail",
        description:
          "Active replies now expose a calmer live trail through the transcript, making long-running turns easier to follow while new work arrives.",
        details:
          "The transcript gained MessageTrail rendering, shared message-trail logic, browser coverage, and timeline integration so live assistant activity can stay visible without fighting the normal message rows.",
      },
      {
        id: "clipboard-image-sharing",
        title: "Image sharing works better on desktop",
        description:
          "Share cards and exported profile visuals can now use the desktop clipboard image path, making it easier to paste polished snapshots elsewhere.",
        details:
          "The web share-card export path now cooperates with desktop clipboard IPC, including preload contracts and browser-side helpers for copying generated image blobs.",
      },
      {
        id: "claude-credential-keepalive",
        title: "Claude credentials stay fresh longer",
        description:
          "Synara refreshes Claude credential freshness on macOS so long sessions are less likely to hit the familiar stale-token sign-in failure.",
        details:
          "A Claude credential keepalive helper, adapter integration, and focused tests now keep the OAuth token file active enough to avoid the roughly eight-hour stale credential path.",
      },
      {
        id: "model-and-sidebar-polish",
        title: "Models, command rows, and status icons got a polish pass",
        description:
          "Sonnet 5 variants, sidebar status icons, branded command rows, chat bubble padding, and tool labels were tightened for a more readable daily workspace.",
        details:
          "The release adds Sonnet 5 model variant metadata, refines sidebar status presentation, brands command/tool rows more clearly, and trims chat typography spacing in dense transcript areas.",
      },
    ],
  },
  {
    version: "0.3.5",
    date: "Jun 30",
    features: [
      {
        id: "temporary-thread-promotion",
        title: "Temporary chats graduate more naturally",
        description:
          "Draft and temporary threads now promote into the main chat flow more predictably, with clearer naming and steadier routing once work becomes real.",
        details:
          "Disposable-thread helpers were renamed around temporary-thread behavior, ChatView and sidebar state now share the promotion path, and timeline coverage guards the new handoff from temporary work into durable chat rows.",
      },
      {
        id: "archive-undo-toast",
        title: "Archived chats are easier to recover",
        description:
          "Archive actions now use an undo toast instead of an interrupting confirmation dialog, so cleaning up threads is faster while still giving you a quick escape hatch.",
        details:
          "The sidebar archive flow, shared toast primitive, settings surfaces, environment panel hints, and threadArchive helper now cooperate around immediate archive plus undo behavior.",
      },
      {
        id: "pending-input-and-work-polish",
        title: "Pending inputs and work rows feel calmer",
        description:
          "User-input prompts, queued composer state, work rows, tool details, markdown spacing, and composer preview surfaces were tightened so active sessions scan better.",
        details:
          "Composer pending-input panels now float more cleanly in the stack, queued headers and work rows have focused coverage, and shared rendering helpers reduce small inconsistencies across tool and diff displays.",
      },
      {
        id: "macos-icon-cache-refresh",
        title: "macOS icon refreshes after app updates",
        description:
          "The desktop app now refreshes macOS icon caches on startup/update paths so Dock and Finder icons are less likely to stay stale after an icon change.",
        details:
          "A dedicated macOS icon-cache refresh helper was added to the desktop main process with coverage for the app-support marker, cache invalidation command, and platform gating.",
      },
      {
        id: "settings-and-export-cleanup",
        title: "Settings, heatmaps, and labels got a tidy pass",
        description:
          "The settings route, activity heatmap export, share cards, model/traits pickers, sidebar labels, and dark-mode composer border all received small polish fixes.",
        details:
          "This release cleans up settings panel primitives, aligns heatmap and diff-rendering helpers, restores a dark-mode composer input border, simplifies repeated labels, and trims a handful of dense UI edges.",
      },
    ],
  },
  {
    version: "0.3.4",
    date: "Jun 29",
    features: [
      {
        id: "assistant-streaming-default",
        title: "Assistant streaming is on by default",
        description:
          "New installs now start with assistant streaming enabled, so replies feel live immediately without needing a settings pass first.",
        details:
          "The default app settings and shared settings schema now agree on streamed assistant output, keeping fresh web and server state aligned.",
      },
      {
        id: "smooth-transcript-follow",
        title: "Live transcript follow feels smoother",
        description:
          "Streaming replies, optimistic sends, tool details, and message entry animations now keep the transcript pinned more predictably while work is active.",
        details:
          "ChatView, ChatTranscriptPane, MessagesTimeline, smooth streamed text, and browser regression coverage were tightened so live assistant text and tool rows do not fight the scroll position.",
      },
      {
        id: "provider-health-hardening",
        title: "Provider health handles more real-world CLI states",
        description:
          "Claude, Cursor, and OpenCode status checks are sturdier around credentials, headless environments, model probes, and transient command failures.",
        details:
          "Provider health now detects usable local Claude CLI credentials before passing process env through, runs Cursor ACP probes with a safer headless env, handles model-probe failures without marking an authenticated provider unusable, and expands focused provider-health coverage.",
      },
      {
        id: "opencode-retry-warnings",
        title: "OpenCode retry warnings are easier to follow",
        description:
          "Retry warnings from OpenCode now stay in the work-log flow and collapse consistently across turns instead of cluttering the main conversation.",
        details:
          "Provider runtime ingestion and session logic now preserve OpenCode retry-warning metadata, keep it attached to work rows, and cover repeated warning behavior in both server and web tests.",
      },
      {
        id: "tool-and-agent-polish",
        title: "Tool rows and agent markers are cleaner",
        description:
          "Agent mentions, task rows, tool labels, file-change rows, chat seams, and switches received a small polish pass that makes dense chats easier to scan.",
        details:
          "Synara now reuses the central robot glyph for agent chips, improves file-change and tool-call labels, refines chat card contrast, and tightens shared switch sizing, thumb travel, and animation.",
      },
      {
        id: "release-gate-type-fixes",
        title: "Release gates tightened browser and provider tests",
        description:
          "The v0.3.4 deep release pass fixed exact-optional type drift in transcript browser coverage and provider health checks before publishing.",
        details:
          "The release pass corrected a browser `scrollTo` test helper so it no longer passes explicit `undefined` optional fields, fixed a Claude health env call the same way, and updated a ProviderHealth test to use the Effect platform error tag supported by this workspace.",
      },
    ],
  },
  {
    version: "0.3.3",
    date: "Jun 28",
    features: [
      {
        id: "windows-vscode-store-launch",
        title: "VS Code from the Microsoft Store opens correctly on Windows",
        description:
          "Synara can now launch VS Code Store installs through the right Windows app identity and URI fallback, so editor buttons work even when the normal `code` command is unavailable.",
        details:
          "Editor launch discovery now understands Windows packaged app metadata, adds VS Code and VS Code Insiders Store coverage, falls back from command launch to URI activation, and keeps file-manager launches isolated from editor-specific behavior.",
      },
      {
        id: "provider-update-checks",
        title: "Provider update checks are now optional",
        description:
          "A new settings toggle lets you disable provider update checks when you want Synara to stay quieter about external CLI versions.",
        details:
          "Provider health, server settings, app settings migration, settings search, root notifications, and provider update filtering now share the same `enableProviderUpdateChecks` flag so background update notices respect the user's preference.",
      },
      {
        id: "icons-and-logo-refresh",
        title: "The app icon and Synara mark look cleaner",
        description:
          "The desktop, web, marketing, and release assets were refreshed so the Synara icon renders more consistently across macOS, Windows, browser favicons, and update artifacts.",
        details:
          "This release refreshes the inline Synara logo path, replaces generated icon assets from the full source image, corrects macOS bundle icon handling after the rounded-icon Ventura pass, and removes a literal Dock-icon workaround that was not the final direction.",
      },
      {
        id: "workspace-explorer-polish",
        title: "Workspace browsing feels more unified",
        description:
          "Workspace explorer navigation, file-row presentation, diff stat labels, and shortcut settings now use more shared behavior, making file browsing and review surfaces easier to scan.",
        details:
          "Explorer keyboard navigation moved into shared logic with coverage, DockExplorerPane and workspaceExplorer were simplified, keyboard shortcut settings gained a clearer panel, and file/diff row styling now lines up with the rest of the workspace UI.",
      },
      {
        id: "lighter-idle-polling",
        title: "Idle server polling is lighter",
        description:
          "Synara polls local server state less aggressively while idle, reducing background work without changing the active-session refresh path.",
        details:
          "The server React Query helper now separates active and idle refresh intervals, the sidebar uses the calmer idle cadence, and focused tests cover the interval behavior.",
      },
      {
        id: "release-gate-cleanups",
        title: "Release gates caught a few small compatibility fixes",
        description:
          "The v0.3.3 release pass tightened formatting, settings test coverage, and Effect API compatibility before publishing.",
        details:
          "The release check formatted recent Windows editor-launch and desktop artifact code, updated the web settings push fixture for provider update checks, and switched one editor fallback path from `Effect.catchAll` to the Effect API used by this workspace.",
      },
    ],
  },
  {
    version: "0.3.2",
    date: "Jun 27",
    features: [
      {
        id: "branch-toolbar-projects",
        title: "Project switching moved closer to your branch work",
        description:
          "The branch toolbar can now show and change the active project, so project, branch, and worktree context are easier to keep aligned while you move around Synara.",
        details:
          "This release teaches the branch toolbar about project selection, shared home-chat containers, draft-thread mapping, project creation recovery, and project picker state so navigation does not depend only on the sidebar.",
      },
      {
        id: "absolute-file-previews",
        title: "Local previews can open more real files",
        description:
          "Absolute local file paths now get preview grants, making image, PDF, and workspace previews more reliable when agent output points at files on disk.",
        details:
          "The server now grants and validates local preview access more carefully, including trusted-origin checks, local image route coverage, workspace file-system normalization, and web-side preview/download handling for absolute paths.",
      },
      {
        id: "review-file-tree",
        title: "Review diffs have a collapsible file tree",
        description:
          "The diff panel now has a review file tree, giving larger review batches a clearer outline before you dive into individual patches.",
        details:
          "Synara now builds file diff trees, renders a collapsible review panel with shared disclosure motion, and reuses file-row styling so review navigation feels closer to the rest of the workspace.",
      },
      {
        id: "workspace-explorer",
        title: "The workspace explorer is tidier",
        description:
          "The right-side workspace explorer and preview header were split into cleaner pieces, reducing composer chrome churn and making file browsing steadier.",
        details:
          "Workspace browsing now lives behind a reusable dock explorer pane and workspace explorer helpers, with tighter right-dock activation metadata, preview header behavior, and composer measurement boundaries.",
      },
      {
        id: "send-readiness",
        title: "Send actions check provider readiness first",
        description:
          "Starting a chat, Kanban task, or handoff now refreshes provider availability before sending and returns focus to the composer more consistently.",
        details:
          "Provider availability refresh has dedicated helpers and coverage, while ChatView, Kanban submit flows, thread handoff, and route startup paths now share more predictable send-readiness behavior.",
      },
      {
        id: "visual-polish",
        title: "Explorer icons and working states feel more coherent",
        description:
          "File explorer icons, working shimmers, route inset surfaces, composer pickers, and sidebar details received a focused visual cleanup pass.",
        details:
          "This release unifies more icon choices through central icon helpers, refines shimmer styling, tightens compact route surfaces, and keeps repeated explorer/sidebar affordances closer to the same visual language.",
      },
      {
        id: "transcript-session-state",
        title: "Long sessions keep their footing better",
        description:
          "Transcript scrolling, session state, sidebar routing, and draft equality checks were refactored so active work stays calmer across thread and project changes.",
        details:
          "ChatView now separates more browser-specific behavior, route inset layout has focused coverage, draft-thread comparisons are stricter, and project/chat container helpers handle exact optional state more safely.",
      },
    ],
  },
  {
    version: "0.3.1",
    date: "Jun 26",
    features: [
      {
        id: "tool-call-details",
        title: "Tool calls are easier to inspect",
        description:
          "Transcript tool calls now expose clearer detail dialogs for shell commands, patches, file changes, and tool output, so review-heavy chats are easier to audit.",
        details:
          "Synara now formats tool command transcripts, normalizes patch/change output, labels more tool kinds consistently, preserves structured work metadata through the timeline, and adds focused coverage for tool-call labels and formatting.",
      },
      {
        id: "transcript-flow",
        title: "Long chats stay calmer while work is running",
        description:
          "Transcript grouping and scroll behavior were refined so live assistant text, collapsed work rows, sidechat panes, and tool-only activity behave more predictably.",
        details:
          "This release tightens message timeline derivation, keeps real assistant text separate from tool/work rows, improves collapsed-turn signatures, preserves assistant selection actions, and adds focused tests for timeline rows and ChatView state.",
      },
      {
        id: "multi-pane-navigation",
        title: "Multi-pane work is quicker to navigate",
        description:
          "Recent views, split chats, pinned threads, hover cards, and project sidebar actions received a round of smaller navigation polish.",
        details:
          "Recent view switching, sidebar hover-card anchors, thread/project hover content, pin toggles, chat header actions, project shortcut targets, and split/sidechat affordances now share more predictable state and keyboard routing.",
      },
      {
        id: "keybindings",
        title: "Keyboard shortcuts got stricter",
        description:
          "Shortcut defaults and migrations are now safer, with better handling for chat creation, terminal actions, navigation, and stale keybinding rows.",
        details:
          "Server and web keybinding logic now validates persisted bindings more carefully, avoids carrying conflicting defaults forward, improves new-chat/new-terminal command resolution, and has expanded regression coverage.",
      },
      {
        id: "provider-runtime-reliability",
        title: "Providers recover from more edge cases",
        description:
          "Codex, Gemini, Grok, Cursor, OpenCode, and provider health paths are sturdier around runtime events, discovery, process cleanup, and idle sessions.",
        details:
          "Provider runtime ingestion now handles more canonical event shapes, Gemini ACP probing is more defensive, provider service behavior has broader coverage, idle runtime cleanup was tightened, process runner handling is safer, and Codex review/compaction progress is easier to reconcile.",
      },
      {
        id: "automation-approval-safety",
        title: "Automation setup asks for the right approval",
        description:
          "Automation creation and updates now separate setup prompts, update-only flows, approval fallbacks, and risk acknowledgement more carefully.",
        details:
          "This release hardens conversational automation setup, preserves update-only approval paths, restores the approval fallback, strips carried setup filler from prompts, and keeps the risk acknowledgement gate attached to dispatch.",
      },
      {
        id: "desktop-update-hardening",
        title: "Desktop updates and startup are quieter",
        description:
          "The desktop shell now suppresses noisy Node warnings in more places and hardens electron-updater command handling on Windows.",
        details:
          "Desktop startup applies safer warning handling, voice transcription edge cases were tightened, and electron updater command construction now has dedicated security coverage around Windows process spawning.",
      },
      {
        id: "icons-and-ui-polish",
        title: "The interface has more useful visual signals",
        description:
          "Provider icons, central icon assets, model pickers, composer controls, automation banners, Kanban cards, preview cards, and tooltips were cleaned up in small but visible ways.",
        details:
          "Synara now ships a curated central-icons set, improves provider/model picker presentation, refines composer picker and automation banners, adds better project/thread hover details, and keeps repeated UI surfaces closer to the same visual language.",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "Jun 24",
    features: [
      {
        id: "automations-workspace",
        title: "Automations are a real workspace surface",
        description:
          "Synara now has first-class Automations for scheduled agent work, with sidebar navigation, list/detail pages, run history, triage actions, and inline editing.",
        details:
          "This release wires automation contracts, persistence, scheduler leases, run tracking, RPC methods, sidebar badges, Current/Paused views, detail routes, editable fields, previous-run history, and result triage so scheduled work lives inside the same thread/provider/worktree pipeline as normal chat work.",
      },
      {
        id: "heartbeat-stop-clauses",
        title: "Heartbeat automations can stop when the goal is met",
        description:
          "Heartbeat automations can store an AI-evaluated stop clause, evaluate it after successful runs, and disable themselves with a recorded reason when the condition is satisfied.",
        details:
          "Completion policies now support natural-language stop conditions, dedicated background evaluation, visible completion results, timeout handling, stale-result guards, legacy-row defaults, and archive/read preservation so a stop check cannot silently undo user triage state.",
      },
      {
        id: "automation-composer-scheduling",
        title: "Automation creation understands natural prompts",
        description:
          "The composer can turn automation-style prompts into scheduled drafts, including intervals, daily/weekly timing, cron-like schedules, heartbeat targets, and review dialogs.",
        details:
          "Automation intent parsing now covers explicit and generated prompts, English and Italian stop/schedule phrasing, bounded fast-loop safety, draft review, source-thread handling, restored plan source metadata, inline editing from composer text, and stricter confirmation for LLM-generated automations.",
      },
      {
        id: "automation-reliability",
        title: "Scheduled runs are harder to lose or corrupt",
        description:
          "Automation scheduling, recovery, and run reconciliation were hardened so crashes, duplicate wakes, approval waits, stale cache updates, and cleanup failures are handled more predictably.",
        details:
          "The automation service now has occurrence dedupe, scheduler leases, crash replay, failed-run rollback, startup recovery, bounded completion-evaluation queues, recovery/lease observability, approval ownership re-checks, standalone worktree cleanup, equal-timestamp cache merging, and DST/long-downtime schedule coverage.",
      },
      {
        id: "file-attachments-and-previews",
        title: "Files attach, preview, and download more reliably",
        description:
          "Chat now supports generic file attachments alongside images, with better chips/cards, safer upload normalization, worktree-aware previews, and in-app local image downloads.",
        details:
          "File attachments now flow through contracts, upload storage, composer paste/drop, provider prompts, Kanban dispatch, recap/bootstrap surfaces, optimistic timeline rendering, caps/rollback, attachment-bearing plan follow-ups, explicit unsupported-file rejection, worktree-backed file preview roots, and blob-based download handling that keeps failed local image downloads inside Synara.",
      },
      {
        id: "provider-model-scoping",
        title: "Providers and models stay scoped to the right project",
        description:
          "OpenCode and Claude startup paths are more careful about cwd, model discovery, config scope, and sticky plan mode so new threads inherit less accidental state.",
        details:
          "OpenCode model discovery can fall back to `opencode models --verbose`, managed OpenCode/Kilo paths run in the request/session cwd, warm server reuse is scoped, file config is no longer replaced with synthetic empty config, OpenCode resume preserves cwd, and fresh Claude threads avoid inheriting plan mode from the previous active thread.",
      },
      {
        id: "chat-panels-and-thread-state",
        title: "Chats and side panels stay in sync",
        description:
          "Deleted chats disappear immediately, the Environment panel behaves better in constrained layouts, automation cards show up in the transcript, and file previews avoid extra full-thread subscriptions.",
        details:
          "Client projections now use delete tombstones and responsive archived bulk-delete updates, environment-panel open/close preferences survive chat switches, constrained/floating layouts stay calmer by default, thread automation summaries appear in the environment panel, created automation cards render in chat, and file preview routing avoids unnecessary full thread subscriptions.",
      },
      {
        id: "profile-skill-counts",
        title: "Profile skill counts reflect more real work",
        description:
          "Profile stats now count repeated `/skill` and `$skill` usage more accurately, including retained history that should still contribute to your local activity picture.",
        details:
          "Skill aggregation now includes retention-hidden threads while still excluding manually deleted data, counts repeated slash/dollar skill tokens inside one prompt, avoids double-counting structured references, and has regression coverage for retained threads and repeated skill invocation.",
      },
    ],
  },
  {
    version: "0.2.41",
    date: "Jun 17",
    features: [
      {
        id: "header-handoff-menu",
        title: "Hand off chats from the header again",
        description:
          "The chat header now has a compact Hand off menu, so you can start a provider handoff without hunting through the rest of the workspace.",
        details:
          "The header handoff action now offers only usable target providers, checks provider availability before creating the handoff thread, and keeps the action disabled while the current thread is busy or waiting on approvals/input.",
      },
      {
        id: "hidden-project-script-runner",
        title: "Project scripts stay out of the way",
        description:
          "Project action dialogs remain available, but the old inline script runner no longer crowds the chat header controls.",
        details:
          "Project script controls stay mounted for the shared Open-in/project-action dialog path, while the visible header play/chevron runner is hidden to keep the top bar focused.",
      },
    ],
  },
  {
    version: "0.2.4",
    date: "Jun 17",
    features: [
      {
        id: "restart-chat-restore",
        title: "Restarts bring you back to the right chat",
        description:
          "Synara now waits for one fresh server snapshot before giving up on a remembered chat route, so app restarts are less likely to dump you onto an empty fallback screen.",
        details:
          "Chat route restore now validates remembered thread/split routes against refreshed orchestration state, holds fallback while startup data is still empty, and has focused coverage for missing-thread and empty-startup recovery paths.",
      },
      {
        id: "provider-reenable-health",
        title: "Disabled providers recover more predictably",
        description:
          "Provider health refreshes now have regression coverage around re-enabling disabled providers, making settings changes less likely to leave stale unavailable states behind.",
        details:
          "Provider health and Pi adapter paths were tightened with coverage for disabled-provider re-enable behavior, while provider badges and menu icons were kept aligned with the refreshed availability state.",
      },
      {
        id: "cleaner-chat-header",
        title: "The chat header is quieter",
        description:
          "The old handoff shortcut has been removed from the chat header, leaving the main conversation controls easier to scan during active work.",
        details:
          "The chat header no longer renders the handoff action path, reducing duplicate top-bar controls and keeping project/thread actions focused on the surfaces that still own them.",
      },
    ],
  },
  {
    version: "0.2.3",
    date: "Jun 16",
    features: [
      {
        id: "smarter-profile-stats",
        title: "Your profile understands more of your work",
        description:
          "Synara now tracks richer local profile stats, including your most worked project, skill and agent usage, active hours, provider/model mix, and prompt activity.",
        details:
          "Profile stats now derive more signal from Synara's local projection database: most-worked project, prompt/thread activity, skill and agent usage, provider/model usage, reasoning patterns, active-hour windows, and token heatmap data are all represented in the profile contract and settings panel.",
      },
      {
        id: "pasted-text-cards",
        title: "Large pastes become cleaner composer cards",
        description:
          "Big pasted blocks now collapse into tidy attachment-style cards, keeping the composer readable while still letting you restore or remove the full text.",
        details:
          "Large pasted text blocks are serialized separately from the visible prompt, shown as compact cards in the composer, expandable in sent messages, and counted with line/character metadata so long prompts are easier to review.",
      },
      {
        id: "pasted-text-editing",
        title: "Pasted text survives message edits",
        description:
          "Editing a message now preserves pasted text blocks instead of dropping or flattening them, so larger prompts stay intact when you refine them.",
        details:
          "The composer draft, edit, assistant-selection, terminal-context, and WebSocket send paths now preserve structured pasted text blocks instead of folding them into fragile plain text. Focused tests cover pasted text, draft persistence, terminal context, timeline height, and edit behavior.",
      },
    ],
  },
  {
    version: "0.2.2",
    date: "Jun 14",
    features: [
      {
        id: "profile-and-personalization",
        title: "Your Synara profile has more personality",
        description:
          "Profile settings now include richer identity details, activity stats, and a cleaner editing flow so Synara feels more like your own workspace.",
        details:
          "This release adds profile stats aggregation, profile settings UI polish, activity heatmap refinements, avatar/profile editing updates, and focused coverage for the new profile data paths.",
      },
      {
        id: "soft-delete-retention",
        title: "Deleted threads get a safer recovery window",
        description:
          "Thread deletion now keeps soft-deleted data around long enough to avoid accidental loss while still letting cleanup happen predictably.",
        details:
          "Synara now tracks thread retention state explicitly, covers soft-delete cleanup behavior with server tests, and keeps deletion/recovery semantics more predictable for early WIP data.",
      },
      {
        id: "live-composer-edits",
        title: "Live composer edits stay visible per turn",
        description:
          "Composer changes made while a turn is running now stay attached to the right turn, reducing confusing stale text or hidden edits during active work.",
        details:
          "The chat route and composer state handling were tightened so live edits remain visible in the correct turn lifecycle without bleeding into unrelated transcript updates.",
      },
      {
        id: "release-test-stability",
        title: "Release checks are steadier",
        description:
          "The release test path now avoids known teardown and child-process timing traps, making full validation less likely to stall after tests have passed.",
        details:
          "Effect ACP child-process fixture tests now have explicit timeouts, and the server test script runs its Vitest files serially so the root Turbo test gate exits cleanly during release validation.",
      },
    ],
  },
  {
    version: "0.2.1",
    date: "Jun 14",
    features: [
      {
        id: "inline-file-comments",
        title: "File comments can ride along with your next message",
        description:
          "You can now leave focused line comments from composer and preview surfaces, then send them with the prompt so agents get clearer file-specific context.",
        details:
          "This release adds file-line comment boxes, summary chips, draft persistence, reference attachment handling, preview/editor entry points, chat timeline support, and focused tests for comment parsing, composer drafts, terminal context, kanban dispatch, and chat-view logic.",
      },
      {
        id: "active-turn-file-changes",
        title: "Live file changes stay scoped to the active turn",
        description:
          "The live changed-files panel now follows the turn that is actually running, avoiding stale or unrelated file edits when sessions overlap or recover.",
        details:
          "Provider runtime ingestion now carries active turn identity through Codex, Claude, checkpoint, and live-change paths. Chat selectors and composer change headers were tightened so tool/file rows from older turns do not masquerade as current live output.",
      },
      {
        id: "workspace-reference-recovery",
        title: "Partial workspace file references resolve more reliably",
        description:
          "Opening files from shortened or partial references is more forgiving, especially when assistant output mentions a file path without the full workspace prefix.",
        details:
          "Workspace file-system lookup now searches entries more deliberately, exposes shared server helpers, improves opener behavior, and adds coverage around partial references so previewing referenced files lands on the intended workspace item.",
      },
      {
        id: "restart-and-idle-recovery",
        title: "Restarted sessions are less likely to leave turns hanging",
        description:
          "After provider restarts, reconnects, or quiet ACP sessions, Synara does a better job of reconciling active turns and finishing idle work instead of getting stuck.",
        details:
          "Startup turn reconciliation, ACP idle watchdog handling, provider runtime ingestion, Cursor/Grok/OpenCode adapter event paths, command reactor cleanup, and shared thread summaries now work together to recover unfinished turns and surface stale runtime state more predictably.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "Jun 13",
    features: [
      {
        id: "secure-pdf-preview",
        title: "PDFs open safely inside Synara",
        description:
          "Local PDFs can now be previewed directly in the workspace pane with page navigation, zoom controls, selection-safe rendering, and hardened link handling.",
        details:
          "This release replaces browser iframe PDF handling with a pdf.js-powered viewer, authenticated local preview routes, workspace/scratch allowlists, sanitized annotation links, page reset behavior when switching files, fresh page proxies per document, and focused server/web tests for local image/PDF access and PDF navigation helpers.",
      },
      {
        id: "workspace-file-preview",
        title: "File preview is shared across chat and editor workspaces",
        description:
          "The right dock and editor workspace now use the same richer file preview surface, so browsing files, images, markdown, and PDFs feels more consistent.",
        details:
          "Synara now routes file preview through `WorkspaceFilePreview`, `PdfFilePreview`, shared preview headers, markdown/source selection references, workspace file openers, dock pane activation metadata, local preview URL helpers, and tighter file reference context-menu behavior.",
      },
      {
        id: "pi-plugin-routing",
        title: "Pi plugin sessions start in the right place",
        description:
          "Pi-backed plugin flows now route through Synara more reliably, discover model support better, and keep startup prompts attached to the correct provider session.",
        details:
          "The Pi adapter gained richer ACP handling, extension model discovery, cwd/session wiring, startup prompt routing, provider command reactor coverage, provider service safeguards, and an ACP mock agent so plugin startup, prompt forwarding, and provider state transitions are covered more directly.",
      },
      {
        id: "chat-startup-and-timeline",
        title: "Chat startup and timelines do less unnecessary work",
        description:
          "Opening busy chats should feel calmer: timeline ordering, transcript selection, collapsed turns, and sidebar-driven updates were tightened for the common path.",
        details:
          "This release optimizes chat view startup selectors, timeline ordering, settled-turn collapse fallback, message timeline height logic, transcript tail behavior, right-dock runtime activation, and route-level chat restoration with additional selector, timeline, and browser coverage.",
      },
      {
        id: "composer-shortcuts-and-markdown",
        title: "Composer and markdown interactions picked up useful polish",
        description:
          "Cmd+L now focuses the composer, markdown task lists render cleanly, inline mentions behave more predictably, and pending user-input panels are easier to scan.",
        details:
          "New keybinding metadata and tests cover the composer focus shortcut, while markdown task-list parsing, chat references, inline mention chips, composer banners, pending user-input panels, and shortcut-sheet entries received focused fixes.",
      },
      {
        id: "cursor-and-changed-files",
        title: "Cursor and changed-file views are easier to trust",
        description:
          "Cursor message ids are handled more carefully, changed files moved to a flatter UI path, and stale plan/sidebar indicators were cleaned up.",
        details:
          "Synara now preserves Cursor message identity more reliably, removes the older turn diff tree path, refines changed-file file-list rendering, fixes duplicate plan-mode icons and stale plan sidebar state, and hides inline project actions from the chat header where they created noise.",
      },
      {
        id: "preview-security-and-local-files",
        title: "Local previews have tighter safety rails",
        description:
          "Local image/PDF preview routes are more explicit about what can be opened, how auth applies, and when unsafe paths or URLs should be rejected.",
        details:
          "Server-side local preview handling now shares local preview file helpers, narrows CORS behavior for preview responses, covers local image routes, hardens scratch workspace path generation, and keeps external PDF links on an allowlisted path instead of trusting unsafe annotation URLs.",
      },
    ],
  },
  {
    version: "0.1.9",
    date: "Jun 12",
    features: [
      {
        id: "chat-workspace-folders",
        title: "Chats get Codex-style workspace folders",
        description:
          "Project chats now keep their generated files in clearer chat-specific workspace folders, making it easier to understand what belongs to each conversation.",
        details:
          "This release adds Codex-like workspace folder creation, associated worktree metadata handling, file-only workspace search, settings search deep links, and harder Gemini probe handling so workspace state stays more predictable across chat and editor surfaces.",
      },
      {
        id: "transcript-turn-stability",
        title: "Transcript turns collapse more reliably",
        description:
          "Long-running assistant work, collapsed turn rows, and transcript tail-follow behavior are steadier during active output and after reconnects.",
        details:
          "The timeline now falls back to the latest turn when visible turn ids are empty, fixes collapsed-turn and tail-jitter edge cases, and keeps scroll-follow logic scoped to real transcript messages instead of tool-only churn.",
      },
      {
        id: "browser-and-copy-flow",
        title: "Browser sessions and copy links feel smoother",
        description:
          "In-app browser sessions recover better, and copy-link flows now have cleaner behavior when moving between browser and chat contexts.",
        details:
          "Browser session handling, copy-link actions, local image preview state, and shared error-card behavior were tightened so browsing, previewing, and moving references into prompts produce fewer stale or duplicated states.",
      },
      {
        id: "settings-and-density",
        title: "Settings open faster and density is easier to tune",
        description:
          "Settings navigation, sidebar search, and UI density controls picked up polish so repeated configuration work feels lighter.",
        details:
          "Settings page open avoids extra streaming-tick re-renders, sidebar search deep links can jump directly to matching settings, UI density follow-ups refine sidebar and composer spacing, and shared project menus replace older bespoke editor picker code.",
      },
      {
        id: "editor-and-kanban-polish",
        title: "Editor and kanban workflows are cleaner",
        description:
          "Editor mode feedback, project picker reuse, kanban composer menus, and image preview handling all received focused follow-ups.",
        details:
          "This release fixes editor-mode production feedback, shares project menu picker behavior, splits kanban composer menu discovery from editor logic, and consolidates local image preview state across chat and editor views.",
      },
    ],
  },
  {
    version: "0.1.8",
    date: "Jun 11",
    features: [
      {
        id: "editor-workspace",
        title: "Editor workspace is built into chat",
        description:
          "You can now keep a project file workspace beside the conversation, inspect files, and move references into prompts without bouncing between tools.",
        details:
          "This release adds the editor workspace view, file reference selection state, syntax highlighting, project file-system APIs, and focused coverage for workspace entries, path containment, editor view state, and chat reference parsing.",
      },
      {
        id: "native-editor-launchers",
        title: "Open-in editor support is broader and prettier",
        description:
          "Ghostty, Terminal, JetBrains, Xcode, Zed, Cursor, VS Code, and other editor launchers now have better discovery, icons, and platform-specific launch behavior.",
        details:
          "Synara now discovers native editor apps and icons, caches icon assets server-side, exposes authenticated icon routes, and tightens macOS/Linux/Windows launcher handling, including Ghostty working-directory behavior and Linux desktop-entry matching.",
      },
      {
        id: "portable-skills",
        title: "Skills are unified across providers",
        description:
          "The settings skill catalog now understands provider roots and shared skill copies, so Codex, Claude, Cursor, and compatible providers show cleaner ownership instead of duplicate noise.",
        details:
          "A shared server-side skills catalog, provider prompt injection, provider discovery service updates, settings model, and provider icon chips now keep provider-specific and portable skills aligned across the UI.",
      },
      {
        id: "composer-and-chat-polish",
        title: "Composer, references, and diffs feel steadier",
        description:
          "Composer controls, inline chips, file references, markdown rendering, and diff navigation picked up tighter layout and interaction polish.",
        details:
          "The chat view now shares composer footer layout helpers, richer file-entry icons, code-selection actions, syntax highlighting, diff route search, improved diff toolbar/list behavior, and cleaner picker layout for model, trait, and open-in controls.",
      },
      {
        id: "provider-refresh-and-auth",
        title: "Provider status refreshes are less stale",
        description:
          "Codex auth overlays, provider status refreshes, and provider discovery invalidation now recover better after focus changes, settings updates, and native provider checks.",
        details:
          "The web app now refreshes provider auth/status on focus and root events, while the server-side provider discovery layer handles native skill and capability fallbacks more predictably.",
      },
      {
        id: "migration-and-terminal-hardening",
        title: "Older data and terminals recover more predictably",
        description:
          "Legacy migration trackers, pinned/sidechat reconciliation, terminal environment handling, and workspace path checks were tightened for early-WIP installs.",
        details:
          "Synara now reconciles legacy migration bookkeeping before running migrations, expands migration coverage, validates workspace real-path containment, and carries terminal environment updates through shared server and web contracts.",
      },
    ],
  },
  {
    version: "0.1.7",
    date: "Jun 10",
    features: [
      {
        id: "claude-fable-5",
        title: "Claude Fable 5 available to Claude and Cursor",
        description:
          "Claude Fable 5 now appears across the Claude and Cursor model paths, so you can pick the new model without hand-editing provider settings.",
        details:
          "The shared model contract, Cursor variant list, keybinding metadata, provider discovery invalidation, and model-picker coverage were updated so Claude and Cursor stay in sync when new supported models land.",
      },
      {
        id: "cursor-acp-discovery",
        title: "Cursor model discovery is smarter",
        description:
          "Cursor-backed sessions now discover ACP model support more reliably, refresh stale model lists, and recover better when the provider reports partial or invalid state.",
        details:
          "Cursor ACP support now has stronger parsing, refresh, health, and adapter handling, with tests for discovery fallbacks, stale cache invalidation, and provider health behavior.",
      },
      {
        id: "provider-usage-panels",
        title: "Provider usage is visible where you work",
        description:
          "Usage limits and pace now show up in the chat environment, settings, and compact controls for Codex, Claude, Cursor, and Gemini.",
        details:
          "Synara now reads provider credentials and usage data through shared server parsers, normalizes snapshots, stores cached values in SQLite, and renders reusable usage rows, progress tracks, line lists, and settings panels in the web app.",
      },
      {
        id: "composer-picker-polish",
        title: "Composer controls are easier to scan",
        description:
          "Model and options pickers are split more cleanly, empty threads keep the focused picker layout, and stacked composer panels have steadier sizing.",
        details:
          "The composer stack now uses shared panel content and sizing helpers, refreshed trait-picker behavior, tighter queued/live-change headers, and extra browser/unit coverage for compact controls and panel styles.",
      },
      {
        id: "windows-titlebar-and-packaging",
        title: "Desktop chrome and installers got sturdier",
        description:
          "Windows desktop builds now use a more reliable custom titlebar path, and Linux download metadata matches the current AppImage asset naming.",
        details:
          "The desktop app gained centralized Windows caption controls, top-bar gutter handling, preload IPC support, font-family cleanup, and backend Node option tests, while the marketing download page now points at the `-x64` AppImage naming used by current releases.",
      },
      {
        id: "stream-recovery-and-memory",
        title: "Long-running sessions recover under pressure",
        description:
          "Backend memory diagnostics, WebSocket backpressure handling, and live stream recovery were tightened so heavy sessions stay predictable.",
        details:
          "This release adds memory diagnostics, stream backpressure guards, buffered provider-runtime ingestion coverage, and Codex app-server recovery fixes to keep partial streams and reconnects from leaving the UI stale.",
      },
      {
        id: "message-and-sidebar-fixes",
        title: "Small UI fixes landed across chat and navigation",
        description:
          "Plugin mention icons stay correct after sending, sidebars and search palettes have sharper state, and chat/task rows picked up focused polish.",
        details:
          "Mention-chip icon logic, composer mention parsing, sidebar route metadata, search palette tests, active task cards, right-dock layout, root route chrome, and settings navigation all received focused fixes.",
      },
    ],
  },
  {
    version: "0.1.6",
    date: "Jun 9",
    features: [
      {
        id: "thread-markers",
        title: "Transcript markers make long chats easier to navigate",
        description:
          "You can now mark important transcript moments, jump back to them, and manage them from the Environment panel without losing your place in busy threads.",
        details:
          "Markers now round-trip through orchestration events, projection storage, migrations, shared validation helpers, transcript selection actions, highlighted markdown spans, marker-aware scrolling, and focused browser/unit coverage.",
      },
      {
        id: "link-favicons",
        title: "Links show real site identity",
        description:
          "AI response links, source lists, composer chips, and sent user bubbles now share the same link parsing path with website favicons instead of generic globe icons.",
        details:
          "Synara now caches site favicons server-side, serves authenticated favicon image URLs, recognizes bare domains in composer text, and keeps markdown link text aligned with the same medium-weight chip styling used while composing.",
      },
      {
        id: "local-server-environment",
        title: "Local dev servers are easier to spot",
        description:
          "The Environment panel can now show local servers tied to the current project, with clearer browser/terminal identity and controls for tracked project runs.",
        details:
          "The server now monitors listening processes with address-family metadata, tracks project-run ownership, syncs local server state over WebSocket/RPC contracts, and adds sidebar/project-run affordances for starting, viewing, and stopping dev servers.",
      },
      {
        id: "transcript-scroll-reliability",
        title: "Transcript scrolling is calmer",
        description:
          "Collapsed work sections no longer drag the transcript tail, marker navigation is more predictable, and thread rendering does less surprising work while sessions update.",
        details:
          "The timeline path now separates marker scroll behavior from live-output sticking, avoids retriggering tail scrolls for collapsed work disclosure changes, and has extra coverage around marker selection, rendering, and scrolling.",
      },
      {
        id: "orchestration-and-keybindings",
        title: "Small orchestration and shortcut fixes landed too",
        description:
          "Thread orchestration, terminal identity, recent view switching, retired-model shortcuts, and local-server cleanup picked up focused reliability fixes.",
        details:
          "This release tightens provider/runtime event projection, terminal visual identity, local-server process cleanup, recent-view key handling, and retired model picker shortcuts, with new tests for the affected contracts and stores.",
      },
    ],
  },
  {
    version: "0.1.5",
    date: "Jun 8",
    features: [
      {
        id: "desktop-update-packaging",
        title: "Desktop updates are packaged more reliably",
        description:
          "The macOS release path now has stronger artifact smoke checks, zip finalization helpers, and updater download coverage so new builds are easier to trust before they ship.",
        details:
          "Release tooling now validates Mac update artifacts, parses boolean environment flags consistently, and tests the resumable update downloader without the older update-feed cache layer. The README and release docs were refreshed around the current Synara desktop flow too.",
      },
      {
        id: "diff-panel-refactor",
        title: "The diff panel is easier to navigate",
        description:
          "Diff review now has a cleaner toolbar, file list, jump menu, and patch viewport so repository and turn changes are easier to scan without losing context.",
        details:
          "The large diff panel was split into focused components with explicit repo-vs-turn view logic, shared selectors, searchable file filtering, and tests for the new source-resolution behavior.",
      },
      {
        id: "queued-plan-dispatch",
        title: "Queued chat turns stay chat turns",
        description:
          "Queued follow-ups now preserve their own mode and attachments even when the live composer is sitting in a plan follow-up state.",
        details:
          "Queue draining now dispatches the queued turn payload directly, keeps in-progress composer drafts intact, and has browser coverage for plan-mode threads with pending follow-ups and image attachments.",
      },
      {
        id: "composer-stack-polish",
        title: "Composer panels line up cleanly",
        description:
          "Plan activity, queued follow-ups, and live file-change panels now share one frame style above the composer, with consistent width, borders, radius, and dark-mode opacity.",
        details:
          "The stacked composer chrome now flows through a shared panel wrapper and rail sizing token, while the file-change strip only appears for active turns that actually contain provider file edits.",
      },
      {
        id: "markdown-and-menu-icons",
        title: "Markdown and mention menus got sharper",
        description:
          "Chat markdown spacing, composer command selection, plugin discovery, file icons, and mention rendering were tightened so selected references look the same before and after sending.",
        details:
          "Provider discovery now normalizes aliases and built-in metadata more carefully, command menu grouping is simpler, markdown blocks have better visual rhythm, and sent user bubbles preserve the selected file/plugin icon instead of falling back to generic text.",
      },
    ],
  },
  {
    version: "0.1.4",
    date: "Jun 7",
    features: [
      {
        id: "workspace-pinning-depth",
        title: "Important work can stay pinned",
        description:
          "Projects, threads, and specific transcript messages can now be pinned so the context you keep returning to stays close at hand across sessions.",
        details:
          "Pin state is now projected through the orchestration model, stored in dedicated persistence columns, reconciled for older databases, and shared with focused client stores so sidebar ordering, project rows, and thread detail all agree after reloads.",
      },
      {
        id: "environment-memory",
        title: "Thread context has a memory shelf",
        description:
          "The environment panel now carries pinned messages and editable notes, giving long-running chats a durable place for decisions, constraints, and useful references.",
        details:
          "Pinned message actions round-trip through server commands and snapshots, while thread notes autosave through the same projected thread detail path. This keeps the side panel useful without turning the transcript itself into a scratchpad.",
      },
      {
        id: "recent-view-switcher",
        title: "Jump between recent views faster",
        description:
          "A new recent-view switcher lets you move through recent chats, terminals, and workspace surfaces with keyboard-first navigation and visible keycap hints.",
        details:
          "Recent views are tracked in a dedicated store, activated through shared route logic, and covered by browser and unit tests so switching does not lose terminal state or collide with existing global shortcuts.",
      },
      {
        id: "composer-mentions-drafts",
        title: "Composer references behave better",
        description:
          "Mention chips, draft restoration, queued composer headers, picker sizing, and empty-chat controls were cleaned up so references stay readable while you build prompts.",
        details:
          "Mention parsing now has shared helpers and tests, composer drafts keep stronger thread/project references, and compact controls use consistent iconography across the empty state and active chat surface.",
      },
      {
        id: "resumable-desktop-updates",
        title: "Desktop updates can resume",
        description:
          "The desktop updater now has resumable download infrastructure with coverage for partial files, retries, checksum-style state, and release browser test fixes.",
        details:
          "The update downloader writes through a dedicated resumable path, validates persisted metadata, handles interrupted ranges, and is tested separately from the Electron main process wiring so future updater changes have a sturdier base.",
      },
      {
        id: "git-action-guardrails",
        title: "Git actions know when pull is available",
        description:
          "Git action controls now surface pull availability more accurately and avoid offering branch actions that cannot safely run for the current repository state.",
        details:
          "The Git core contract, broadcaster, React query helpers, and UI control logic now carry pull availability together, so action buttons line up with upstream/behind checks instead of guessing locally in the component.",
      },
      {
        id: "claude-terminal-reliability",
        title: "Runtime failures are easier to survive",
        description:
          "External Claude shutdowns, terminal cleanup, websocket RPC errors, and provider session recovery picked up extra guards for reconnects and interrupted work.",
        details:
          "Claude SIGTERM from outside Synara is treated as a benign suspend path, terminal process cleanup has stronger tests, and websocket RPC failure handling is less likely to leave the UI believing a request is still in flight.",
      },
      {
        id: "migration-and-release-hardening",
        title: "Migrations and release checks got sharper",
        description:
          "Pinned-state migrations, snapshot projection tests, browser release tests, shortcut tests, and shared pinning logic were expanded to keep this deeper state model predictable.",
        details:
          "New migrations cover pinned messages, thread notes, and project pins; legacy pinned-thread reconciliation was tightened; and the release suite now exercises the new state through contracts, server projection, shared helpers, and web UI logic.",
      },
    ],
  },
  {
    version: "0.1.3",
    date: "Jun 5",
    features: [
      {
        id: "session-side-panel-clarity",
        title: "The chat side panel is clearer",
        description:
          "Thread activity, agent detail rows, environment controls, Git actions, branch controls, and queued composer state were tightened so the main chat and side panel stay easier to scan during busy sessions.",
      },
      {
        id: "thread-recap-panel",
        title: "Long chats can be recapped in place",
        description:
          "Synara can now generate and cache thread recaps, show current-state context in the chat environment, and reuse provider-backed recap generation without making the transcript harder to follow.",
      },
      {
        id: "diff-totals-performance",
        title: "Large diffs do less duplicate work",
        description:
          "Repo diff totals are computed once for the active chat and shared between the header and environment panel, with memoized patch stats to avoid re-parsing the same large diff during live updates.",
      },
      {
        id: "archived-delete-cleanup",
        title: "Archived cleanup is more immediate",
        description:
          "Deleting archived threads now goes through one shared client path, removes rows optimistically, batches worktree-linked deletes, and reconciles once with the latest server snapshot.",
      },
      {
        id: "terminal-and-transcript-guards",
        title: "Terminals and transcripts are safer under load",
        description:
          "Terminal runtime cleanup, provider activity ingestion, transcript rendering, and session handoff logic picked up extra safeguards for reconnects, shell summaries, agent activity, and active task rendering.",
      },
      {
        id: "desktop-update-polish",
        title: "Desktop update prompts are quieter",
        description:
          "Background update polling no longer exposes a manual check button at the wrong time, update state is restored more predictably, and production builds keep source maps off unless a diagnostic release opts in.",
      },
      {
        id: "release-readiness-fixes",
        title: "Small release-readiness fixes landed too",
        description:
          "Image attachment expectations, optional callback typing, recap test doubles, composer spacing, reference chips, and queued row styling were aligned with the current UI so the final check suite stays green.",
      },
    ],
  },
  {
    version: "0.1.2",
    date: "Jun 4",
    features: [
      {
        id: "lighter-terminals",
        title: "Terminals are lighter",
        description:
          "Terminal output now does less work end-to-end: batching, renderer acknowledgements, smarter backpressure, cheaper history updates, and more faithful reconnect replay keep busy terminals lighter under noisy commands and long-running TUIs.",
      },
      {
        id: "terminal-workspace-and-appearance",
        title: "Terminal workspaces feel cleaner",
        description:
          "Terminal-only workspaces skip hidden chat work, panes move between layouts without remount churn, close prompts only appear when a tab is active or needs attention, and terminal font/color settings now follow the active theme.",
      },
      {
        id: "opencode-startup-reliability",
        title: "OpenCode starts faster and fails louder",
        description:
          "Local OpenCode servers are pooled for recent sessions, startup waits longer before timing out, session creation runs alongside inventory discovery, and failure details now include redacted command output instead of vague startup errors.",
      },
      {
        id: "provider-health-stability",
        title: "Provider health checks are less jumpy",
        description:
          "Slow Claude and OpenCode probes get longer timeouts, transient command timeouts no longer make a previously ready provider look broken, and Claude auth refreshes invalidate cached subscription state.",
      },
      {
        id: "stale-claude-resume-recovery",
        title: "Claude resumes recover from stale native sessions",
        description:
          "When Claude reports a missing conversation id, Synara clears the stale resume cursor, recreates the provider session, and retries with transcript context instead of leaving the turn failed.",
      },
      {
        id: "desktop-update-manual-fallback",
        title: "Desktop updates now have a manual escape hatch",
        description:
          "If an in-app install silently fails, Synara restarts the backend, resumes update polling, deduplicates error toasts, and points you at the exact GitHub release page for a manual download.",
      },
      {
        id: "mac-desktop-chrome-alignment",
        title: "macOS desktop chrome stays aligned",
        description:
          "Traffic-light placement and renderer gutter spacing now share one geometry helper and react to Electron zoom changes, keeping top-bar controls lined up across chat, settings, and workspace views.",
      },
      {
        id: "settings-appearance-refresh",
        title: "Settings and appearance controls are easier to scan",
        description:
          "Theme selection moved to a segmented control, settings rows share tighter typography, provider update failures can expose a copyable manual command, and custom binary-path confirmations survive restarts.",
      },
      {
        id: "agent-task-activity-rendering",
        title: "Agent task activity is easier to follow",
        description:
          "OpenCode task child sessions and newer shell-step events now flow into Synara's activity timeline, while generic agent task rows keep their useful prompt and result text instead of disappearing or showing wrapper noise.",
      },
      {
        id: "transport-reconnect-events",
        title: "Reconnect state is visible to UI runtimes",
        description:
          "The web transport now publishes local WebSocket state changes, giving terminal recovery and other renderer code a cleaner signal when the server reconnects or closes.",
      },
    ],
  },
  {
    version: "0.1.1",
    date: "Jun 4",
    features: [
      {
        id: "opencode-provider-depth",
        title: "OpenCode support is much deeper",
        description:
          "OpenCode startup, model discovery, command discovery, server connection options, and experimental WebSocket mode now flow through the same settings and runtime paths as the rest of Synara.",
      },
      {
        id: "opencode-command-discovery-settings",
        title: "Slash commands respect your OpenCode setup",
        description:
          "Composer slash-command discovery now uses the configured OpenCode binary, server URL, password state, and WebSocket mode, so command lists match the runtime you actually selected.",
      },
      {
        id: "desktop-update-recovery",
        title: "Desktop updates are harder to get stuck",
        description:
          "The updater now caches GitHub release metadata, preserves actionable update state across transient failures, detects stalled downloads, and clears stale same-version update payloads more deliberately.",
      },
      {
        id: "chat-chrome-refresh",
        title: "The chat surface feels tighter",
        description:
          "Composer padding, button spacing, picker sizing, panel headers, banners, dock surfaces, and chat chrome were tuned so the main workspace reads cleaner without losing controls.",
      },
      {
        id: "desktop-window-polish",
        title: "Desktop chrome fits the OS better",
        description:
          "macOS traffic-light spacing, sidebar seams, Electron card borders, motion, and titlebar controls were refined so the app frame feels more native on desktop.",
      },
      {
        id: "markdown-and-transcript-performance",
        title: "Large chats do less unnecessary work",
        description:
          "Markdown parsing is deferred more carefully, pending-interaction state is derived in one place, and transcript/session rendering avoids extra churn during busy or long-running chats.",
      },
      {
        id: "settings-back-navigation",
        title: "Settings back navigation lands in the right place",
        description:
          "The Settings sidebar back button now restores the last valid chat route, falls back to the newest live thread when needed, and drops stale split-view routes before navigating.",
      },
      {
        id: "sidebar-section-toggles",
        title: "Chats can be hidden",
        description:
          "A new sidebar section toggle lets you hide the standalone Chats footer list while keeping Projects available.",
      },
      {
        id: "legacy-database-repairs",
        title: "Imported legacy databases recover missing columns",
        description:
          "Fresh repair migrations reconcile older imported migration trackers that skipped Synara's sidechat-source or pinned-thread columns, preventing startup crashes in those upgraded histories.",
      },
      {
        id: "opencode-visual-polish",
        title: "OpenCode looks better in dark mode",
        description:
          "The OpenCode provider icon now switches to a clearer reversed asset in dark mode, with sidebar and provider picker styling adjusted around it.",
      },
      {
        id: "settings-surface-cleanup",
        title: "Settings are easier to scan",
        description:
          "Repeated boolean settings were consolidated into a shared row pattern, provider install rows got cleaner reset behavior, and OpenCode-specific controls sit with the rest of provider tools.",
      },
    ],
  },
  {
    version: "0.1.0",
    date: "Jun 3",
    features: [
      {
        id: "synara-home-migration",
        title: "Synara is now the default home",
        description:
          "The app now starts from `~/.synara`, carries the Synara environment variables through the desktop and server runtime, and safely imports data from previous installations on first launch.",
      },
      {
        id: "desktop-platform-polish",
        title: "Desktop startup feels more native",
        description:
          "Windows now hydrates the desktop environment from the registry so provider CLIs are found reliably, macOS keeps Liquid Glass styling only where it belongs, and older Macs get a rounded dock icon without breaking Tahoe.",
      },
      {
        id: "dock-state-recovery",
        title: "Right dock and saved UI state are sturdier",
        description:
          "Recovered browser, dock, sidechat, split-view, and panel state is now validated before use, preventing stale or corrupted localStorage from crashing the workspace.",
      },
      {
        id: "composer-picker-refresh",
        title: "Composer pickers are cleaner",
        description:
          "The traits picker and shared menu styling were refreshed with a tighter layout, clearer selection states, and a calmer feel across model and composer controls.",
      },
      {
        id: "provider-runtime-fixes",
        title: "Provider runtime noise is reduced",
        description:
          "Claude thinking-token telemetry no longer floods the timeline, provider task warnings are deduplicated more carefully, and Codex home overlays avoid stale SQLite sidecar files during startup.",
      },
      {
        id: "daily-polish",
        title: "Small workflow details got sharper",
        description:
          "Context meter labels, edit actions, completion separators, Git controls, diff routing, desktop update retry state, and shortcut handling all picked up focused fixes for smoother day-to-day sessions.",
      },
    ],
  },
  {
    version: "0.0.50",
    date: "May 28",
    features: [
      {
        id: "claude-opus-4-8",
        title: "Claude Opus 4.8 is available",
        description: "Synara now includes Claude Opus 4.8 in the Claude model picker.",
      },
    ],
  },
  {
    version: "0.0.49",
    date: "May 23",
    features: [
      {
        id: "grok-build-discovery",
        title: "Grok Build models stay current",
        description:
          "Grok model discovery now combines the CLI with xAI language-model metadata, including API aliases, so Grok Build and code-fast variants appear in the picker without waiting for another manual app update.",
      },
      {
        id: "provider-picker-readiness",
        title: "Provider choices wait for real readiness",
        description:
          "The provider picker no longer treats unknown provider status as usable. Providers stay in a checking state until Synara has confirmed that the local runtime is available and authenticated.",
      },
      {
        id: "desktop-shutdown-recovery",
        title: "Desktop shutdown is calmer",
        description:
          "The desktop backend now shuts down more deliberately on quit, reducing noisy restarts and preserving a cleaner thread sync path when the app is closing.",
      },
      {
        id: "faster-large-history-sync",
        title: "Large histories sync with less work",
        description:
          "Snapshot queries, checkpoint reads, and transcript updates picked up more focused data paths, keeping busy workspaces lighter when sessions reconnect or histories grow.",
      },
      {
        id: "diff-and-transcript-polish",
        title: "Diffs and transcripts feel steadier",
        description:
          "Whitespace diff controls, thread title updates, copy metadata, and live transcript rows received targeted fixes so common review and resume flows update more predictably.",
      },
    ],
  },
  {
    version: "0.0.48",
    date: "May 21",
    features: [
      {
        id: "grok-provider-headline",
        title: "Grok joins Synara",
        description:
          "Pick Grok as a first-class coding provider with ACP-backed sessions, model selection, approval handling, resume support, provider health checks, settings, icons, and handoff wired through the same app surfaces as the rest of your agents.",
      },
      {
        id: "provider-fallbacks-and-menus",
        title: "Provider fallbacks and desktop menus behave better",
        description:
          "Provider startup and recovery paths are more forgiving when preferred runtimes are unavailable, and desktop menu shortcuts now line up more reliably with the active workspace.",
      },
      {
        id: "snapshot-memory-caps",
        title: "Large histories stay lighter",
        description:
          "Snapshot hydration, diagnostics, and capped history paths now do less unnecessary work, reducing memory pressure when busy sessions or large workspaces reconnect.",
      },
      {
        id: "pi-and-opencode-polish",
        title: "Pi and OpenCode edge cases are smoother",
        description:
          "Pi aborts now read as interruptions, thinking levels are clamped more safely, live sidebar updates are steadier, and OpenCode/provider update handling picked up targeted reliability fixes.",
      },
      {
        id: "rpc-input-answer-preservation",
        title: "Answers survive the RPC hop",
        description:
          "User-input answers are preserved through the JSON-RPC codec, which keeps pending provider questions from losing their payload as they move between the app and server.",
      },
    ],
  },
  {
    version: "0.0.47",
    date: "May 15",
    features: [
      {
        id: "pi-provider-headline",
        title: "Pi gets a much sturdier seat at the table",
        description:
          "Pi provider sessions now benefit from tighter lifecycle handling, clearer extension-limit warnings, and provider probes that respect the binaries configured in settings.",
      },
      {
        id: "provider-auto-updates",
        title: "Providers can keep themselves fresher",
        description:
          "Provider auto-update plumbing landed across the app, making it easier to keep agent runtimes current without turning setup and maintenance into a separate chore.",
      },
      {
        id: "create-pr-availability",
        title: "Create PR only appears when it can actually work",
        description:
          "Create-PR actions now check upstream branch and availability state more carefully, so the UI is quieter until the repository is ready for a real pull request.",
      },
      {
        id: "pending-input-recovery",
        title: "Pending questions stop advancing at the wrong time",
        description:
          "Pending user-input auto-advance now cancels on question changes and in-flight responses, reducing stale answers and empty submissions in interrupted provider flows.",
      },
      {
        id: "git-and-transcript-polish",
        title: "Git status and provider transcripts read cleaner",
        description:
          "Git status refreshes, pull-error messaging, Kilo/OpenCode transcript handling, repo diff scopes, and provider install docs links all picked up focused reliability polish.",
      },
    ],
  },
  {
    version: "0.0.46",
    date: "May 13",
    features: [
      {
        id: "attachment-previews-stay-visible",
        title: "Image attachments stay visible after sending",
        description:
          "Persisted image previews now load through the same reliable byte-serving path as local generated images, fixing the brief preview flash followed by broken attachment thumbnails.",
      },
      {
        id: "kilo-code-provider",
        title: "Kilo Code joins the provider lineup",
        description:
          "Synara can now launch and monitor Kilo Code sessions alongside Codex, Claude, Cursor, OpenCode, and Gemini, with health checks, settings, mentions, handoff, and model compatibility wired through the app.",
      },
      {
        id: "provider-ordering",
        title: "Provider order is now yours to arrange",
        description:
          "The settings screen now lets you drag providers into the order that fits your workflow, and the composer, sidebar, search palette, and plugin surfaces follow the same custom ordering.",
      },
      {
        id: "opencode-snapshot-cleanup",
        title: "Cleaner OpenCode and Kilo transcript updates",
        description:
          "Synthetic snapshot progress is filtered more carefully, so restored or refreshed provider output avoids repeating internal progress text while keeping real assistant activity intact.",
      },
      {
        id: "diff-header-totals",
        title: "Diff totals are easier to trust at a glance",
        description:
          "The chat header now owns unified diff totals, keeping added and removed line counts consistent between the header and diff panel as content refreshes.",
      },
    ],
  },
  {
    version: "0.0.45",
    date: "May 12",
    features: [
      {
        id: "opencode-latest-events",
        title: "OpenCode sessions understand the latest event stream",
        description:
          "Synara now tracks the newer OpenCode SDK session events, keeps titles fresher, and has much deeper coverage around OpenCode startup, output, and recovery flows.",
      },
      {
        id: "turn-recovery-stability",
        title: "Interrupted turns recover more predictably",
        description:
          "Ready and idle transitions now clear or restore turn state more carefully, reducing stuck busy states after reconnects, restarts, and partial provider streams.",
      },
      {
        id: "cursor-live-model-options",
        title: "Cursor model choices follow live ACP metadata",
        description:
          "Cursor model selection now normalizes against the provider's current ACP options instead of relying on stale context traits, so the composer better matches what Cursor can actually run.",
      },
      {
        id: "diff-and-pinned-state",
        title: "Diff and pinned-thread state stay in sync",
        description:
          "Projection, sidebar, and store updates now carry pinned-thread metadata through the app, while the diff panel handles refreshed content with fewer display glitches.",
      },
      {
        id: "quieter-git-keybinding-polish",
        title: "Small workflow polish for Git and keybindings",
        description:
          "Git summaries are clearer for rename-like moves into untracked folders, and routine keybinding reloads no longer pop a success toast every time they quietly refresh.",
      },
    ],
  },
  {
    version: "0.0.44",
    date: "May 10",
    features: [
      {
        id: "codex-generated-images",
        title: "Codex image generation now renders in chat",
        description:
          "Generated images from Codex are captured as local artifacts, rendered inline in assistant messages, and include expand and download controls without dragging bulky base64 payloads through the transcript.",
      },
      {
        id: "secure-local-image-route",
        title: "Generated images use a safer local route",
        description:
          "Synara now serves generated files through a dedicated local-image endpoint with MIME checks, workspace-aware path resolution, and Codex generated_images allowlists for both the normal home and desktop overlay home.",
      },
      {
        id: "provider-favorites",
        title: "Provider favorites are quicker to manage",
        description:
          "The provider model picker gained native favorite toggles and cleaner context-menu separators, making large Codex, Cursor, and OpenCode model lists easier to shape around the models you actually use.",
      },
      {
        id: "thread-retention-cleanup",
        title: "Old inactive threads hide after seven days",
        description:
          "The retention job now hides stale inactive threads from the app in batches, publishes maintenance progress, and protects running work and approvals while keeping database history available for long-term stats.",
      },
      {
        id: "websocket-and-server-polish",
        title: "Transport and server edges are steadier",
        description:
          "WebSocket HTTP URL helpers, lifecycle events, provider runtime ingestion, and chat-route plumbing were tightened so generated artifacts and cleanup events move through the app more predictably.",
      },
    ],
  },
  {
    version: "0.0.43",
    date: "May 9",
    features: [
      {
        id: "cursor-provider",
        title: "Cursor is now a first-class Synara provider",
        description:
          "Run Cursor CLI sessions directly from Synara with ACP-backed startup, model discovery, existing-chat resume, handoff, and provider health checks alongside Codex and OpenCode.",
      },
      {
        id: "effect-acp-runtime",
        title: "New Effect TS ACP runtime",
        description:
          "The new Effect TS ACP package owns generated schemas, JSON-RPC transport, client and agent helpers, terminal release handling, and protocol tests so provider integrations have a sturdier core.",
      },
      {
        id: "effect-websocket-server",
        title: "The server moved onto Effect RPC",
        description:
          "WebSocket routing, auth, readiness, settings, environment, git status, and orchestration flows were rebuilt around Effect services so reconnects and failure paths stay more predictable.",
      },
      {
        id: "cursor-streaming-polish",
        title: "Cursor output is easier to read and resume",
        description:
          "Cursor reasoning, tool progress, usage events, plan updates, composer behavior, and model-selection compatibility now render more consistently across fresh and resumed threads.",
      },
      {
        id: "sidebar-and-task-polish",
        title: "Busy sessions stay calmer",
        description:
          "Sidebar project recovery, visible-thread PR lookups, task banner resizing, stale target repair, sidechat split handling, and compact chat controls were tightened for heavier day-to-day use.",
      },
    ],
  },
  {
    version: "0.0.41",
    date: "May 2",
    features: [
      {
        id: "sidechat-threads",
        title: "Sidechat threads are easier to track",
        description:
          "Sidechat source metadata now flows through projections, filters, and snapshots so secondary threads stay easier to separate from the main conversation.",
      },
      {
        id: "desktop-startup-window",
        title: "Desktop startup feels faster",
        description:
          "Packaged desktop builds now open the app window before backend readiness finishes, reducing the blank-start feeling while services come online.",
      },
      {
        id: "git-commit-push-action",
        title: "Git gained commit and push",
        description:
          "The Git actions menu can now commit current work and push it from Synara, keeping the common release and handoff flow closer to the chat.",
      },
      {
        id: "task-and-approval-polish",
        title: "Task controls are clearer",
        description:
          "Active task controls were tightened, and approval counts are now separated from user input requests so pending work is easier to read at a glance.",
      },
    ],
  },
  {
    version: "0.0.40",
    date: "Apr 29",
    features: [
      {
        id: "visible-browser-use-webview",
        title: "Browser-use now drives the visible browser",
        description:
          "The desktop browser and browser-use tools now share the same visible webview, so automation, screenshots, navigation, and manual browsing stay in sync instead of racing separate hidden pages.",
      },
      {
        id: "browser-panel-polish",
        title: "The browser panel is steadier",
        description:
          "Browser resizing, overlay handling, tab controls, screenshot actions, and browser-use panel requests were tightened while keeping the browser from reopening by default.",
      },
      {
        id: "plan-markdown-actions",
        title: "Plans are easier to export",
        description:
          "Proposed plans now share one compact action set for copying markdown, saving into a `.plan` workspace folder, or exporting a markdown file through the desktop save dialog.",
      },
      {
        id: "split-pane-maximize",
        title: "Split panes expand predictably",
        description:
          "Expanding a chat pane now opens that selected chat as the single full-screen surface, closing the rest of the split layout.",
      },
      {
        id: "git-branch-pr-flow",
        title: "Git flows are smoother",
        description:
          "The Git menu now includes branch creation with Synara-style names, and PR creation can recover from GitHub duplicate-PR responses by reusing the existing open pull request.",
      },
      {
        id: "legacy-import-recovery",
        title: "Legacy imports heal themselves",
        description:
          "A new migration reconciles older imported databases whose migration history skipped required schema changes, preventing missing-column crashes after import.",
      },
      {
        id: "runtime-idle-cleanup",
        title: "Idle sessions clean up after themselves",
        description:
          "Provider runtimes and Codex discovery sessions now stop after idle periods, while active turns and pending approvals remain protected from premature shutdown.",
      },
      {
        id: "assistant-stream-stability",
        title: "Streaming output lands in the right message",
        description:
          "Assistant turn ingestion now prefers existing completed item IDs when possible, reducing placeholder duplication and keeping streamed assistant text attached to the intended message.",
      },
      {
        id: "diff-copy-and-thread-details",
        title: "Small workflow polish landed",
        description:
          "Diff views can copy the full patch directly, terminal-started chats get a clearer header icon, sidebar titles truncate more cleanly, and long transcripts cap normalized messages for lighter rendering.",
      },
    ],
  },
  {
    version: "0.0.39",
    date: "Apr 28",
    features: [
      {
        id: "split-chat-drag-drop",
        title: "Split chats are easier to arrange",
        description:
          "Split chat panes now support direct drag-and-drop, cross-project drops, and safer orphan handling so multi-chat layouts stay easier to build and recover.",
      },
      {
        id: "split-chat-routing-stability",
        title: "Split chat navigation is steadier",
        description:
          "Split chat activation, route restore, sidebar grouping, and thread subscriptions were tightened so opening and switching chats feels more predictable.",
      },
      {
        id: "opencode-task-events",
        title: "OpenCode tasks show live progress",
        description:
          "OpenCode todo events now flow into Synara as active task updates, with a compact banner option for keeping current work visible without taking over the chat.",
      },
      {
        id: "opencode-model-favourites",
        title: "OpenCode models can be favourited",
        description:
          "The model picker now supports OpenCode favourites, making preferred models quicker to find across larger provider model lists.",
      },
      {
        id: "opencode-context-usage",
        title: "OpenCode context usage is tracked",
        description:
          "OpenCode sessions now report context usage more consistently, giving Synara better runtime visibility as conversations grow.",
      },
      {
        id: "production-debug-flags",
        title: "Debug controls stay out of production",
        description:
          "Debug feature flags are now hidden behind local opt-in behavior, keeping production sidebars cleaner while preserving developer-only controls.",
      },
    ],
  },
  {
    version: "0.0.38",
    date: "Apr 26",
    features: [
      {
        id: "cursor-provider",
        title: "Cursor CLI support landed",
        description:
          "Cursor is now available as a provider, with ACP sessions, model discovery, existing chats, handoff, shortcuts, and git text generation wired into Synara.",
      },
      {
        id: "chatgpt-voice-transcription",
        title: "Voice transcription is scoped more carefully",
        description:
          "Voice transcription now stays on ChatGPT sessions, avoiding confusing provider mismatches while keeping dictation available where it is supported.",
      },
      {
        id: "api-key-voice-transcription",
        title: "Voice transcription setup is smoother",
        description:
          "Voice transcription setup was tightened so spoken prompts can flow into the composer more reliably in supported ChatGPT sessions.",
      },
      {
        id: "composer-mention-labels",
        title: "Mentions keep their names",
        description:
          "Composer replacements now preserve mention labels, so referenced files, apps, and tools remain readable after the prompt text is normalized.",
      },
      {
        id: "plugin-mentions",
        title: "Plugin mentions are handled in prompts",
        description:
          "Plugin references can now flow through composer prompts cleanly, making connected-tool context less brittle when you hand work to an agent.",
      },
      {
        id: "toast-feature-flags",
        title: "Toast behavior can be feature-flagged",
        description:
          "Toast notifications picked up feature-flag wiring, giving Synara a safer way to roll notification changes forward or back.",
      },
      {
        id: "desktop-bridge-reconnects",
        title: "Desktop reconnects are steadier",
        description:
          "The desktop bridge now refreshes reconnects more reliably and preserves the workspace home directory, reducing drift after desktop runtime restarts.",
      },
    ],
  },
  {
    version: "0.0.37",
    date: "Apr 25",
    features: [
      {
        id: "branch-switch-recovery",
        title: "Branch switching is much safer",
        description:
          "Synara now handles messy branch switches with clearer recovery actions, recreated stashes, unpublished branch publishing, and stronger checks around conflicts and local work.",
      },
      {
        id: "plan-mode-proposals",
        title: "Plan mode proposals show up properly",
        description:
          "Proposed plans from providers are now parsed and surfaced as first-class UI state, so planning turns feel more predictable instead of blending into ordinary assistant output.",
      },
      {
        id: "desktop-navigation-controls",
        title: "Desktop navigation controls landed",
        description:
          "The desktop app now has app-level back and forward navigation controls, making it easier to move around Synara without losing your place.",
      },
      {
        id: "sidebar-sort-stability",
        title: "Sidebar ordering stays put",
        description:
          "Stored sidebar sort preferences are preserved on load, fixing cases where project and thread ordering could unexpectedly reset.",
      },
      {
        id: "font-consistency",
        title: "Fonts are more consistent",
        description:
          "Theme and chat font handling now share one normalization path, tightening up typography across the chat UI, model controls, and theme settings.",
      },
    ],
  },
  {
    version: "0.0.36",
    date: "Apr 24",
    features: [
      {
        id: "gpt-5-5-available",
        title: "GPT-5.5 is available",
        description:
          "GPT-5.5 is now in the model picker with the right default reasoning behavior, so you can move new Codex sessions onto the latest model directly from Synara.",
      },
      {
        id: "opencode-provider",
        title: "OpenCode support is here",
        description:
          "OpenCode is now available as a provider, with runtime model discovery, session handling, provider settings, model search, variants, agents, and git text generation wired into the app.",
      },
      {
        id: "model-picker-search-polish",
        title: "Model search feels faster",
        description:
          "Large OpenCode model lists now get provider-aware search, clearer labels, automatic search focus, arrow-key navigation, and tighter picker clipping.",
      },
      {
        id: "turn-start-diffs",
        title: "Diffs now start from the turn",
        description:
          "Turn diffs use turn-start checkpoints, making changed-file views line up more closely with what the agent actually changed in the current turn.",
      },
      {
        id: "chat-markdown-math",
        title: "Chat markdown is smarter",
        description:
          "Math rendering was added to chat markdown, while literal dollar amounts stay intact so normal prices and currency snippets do not get misread as formulas.",
      },
      {
        id: "theme-and-release-polish",
        title: "More polish around search and releases",
        description:
          "Sidebar theme search, release verification, Windows signing config, and a handful of provider/model edge cases were tightened up for a smoother build and update path.",
      },
    ],
  },
  {
    version: "0.0.35",
    date: "Apr 22",
    features: [
      {
        id: "project-import-path-browsing",
        title: "🗂️ Project import browsing got smarter",
        description:
          "The import palette can now browse nearby paths more directly, helping you find and open the right project location with less guesswork.",
      },
      {
        id: "provider-usage-in-branch-toolbar",
        title: "📊 Provider usage is visible in-context",
        description:
          "The branch toolbar now surfaces provider usage snapshots, making it easier to keep an eye on current usage without leaving your working view.",
      },
      {
        id: "desktop-boot-splash-screen",
        title: "🚀 Desktop startup feels clearer",
        description:
          "Synara now shows a proper splash screen while the desktop backend spins up, so launch feels intentional instead of looking briefly stalled.",
      },
      {
        id: "provider-capability-and-theme-polish",
        title: "🎛️ Better provider and theme polish",
        description:
          "Model capability handling, theme editing, and related picker behavior were tightened up so settings feel more consistent and trustworthy.",
      },
      {
        id: "desktop-release-reliability",
        title: "🛠️ Desktop release plumbing is sturdier",
        description:
          "Startup readiness checks, desktop packaging config, and platform entitlements were refined to make desktop builds and app boot more reliable.",
      },
    ],
  },
  {
    version: "0.0.34",
    date: "Apr 21",
    features: [
      {
        id: "theme-pack-editor",
        title: "🎨 Theme packs are editable",
        description:
          "The new theme pack editor lets you tune UI colors directly in Synara, with shared theme tokens keeping the sidebar, composer, transcript, and controls in sync.",
      },
      {
        id: "sidebar-notifications",
        title: "🔔 Sidebar notifications are easier to read",
        description:
          "Thread activity now surfaces more clearly in the sidebar, so updates, background work, and attention states are easier to spot without opening every conversation.",
      },
      {
        id: "steadier-transcript-performance",
        title: "🧵 Steadier transcripts under load",
        description:
          "Transcript rendering and sidebar-owned state were separated more cleanly, reducing unnecessary churn while long conversations and live agent output are moving.",
      },
      {
        id: "runtime-mode-recovery",
        title: "🛡️ Safer runtime-mode recovery",
        description:
          "Codex runtime permissions now propagate more reliably across resumed sessions and provider restarts, keeping the app closer to the mode you actually selected.",
      },
      {
        id: "composer-and-picker-polish",
        title: "✨ Cleaner composer and picker styling",
        description:
          "Composer chrome, picker hover states, runtime controls, and changed-file rows picked up a more consistent visual pass across light and dark themes.",
      },
    ],
  },
  {
    version: "0.0.33",
    date: "Apr 20",
    features: [
      {
        id: "local-folder-browsing-in-composer",
        title: "📂 Browse local folders right from the composer",
        description:
          "Folder mentions now open a real local directory picker, so you can drill into nearby files and attach the right path without leaving the chat flow.",
      },
      {
        id: "cleaner-file-and-folder-mentions",
        title: "🗂️ Cleaner file and folder mentions",
        description:
          "Mention chips, file trees, and changed-file rows now use a lighter shared icon system that keeps paths easier to scan across the app.",
      },
      {
        id: "desktop-browser-and-runtime-upgrades",
        title: "🌐 Stronger desktop browser runtime",
        description:
          "The desktop browser path picked up better IPC plumbing, screenshots, clipboard support, and more efficient state syncing for browser-driven tasks.",
      },
      {
        id: "safer-startup-and-provider-recovery",
        title: "🛟 Smoother startup and provider recovery",
        description:
          "Project hydration, desktop startup, auth visibility, and aborted-turn cleanup were tightened up so sessions recover more predictably after interruptions.",
      },
    ],
  },
  {
    version: "0.0.32",
    date: "Apr 19",
    features: [
      {
        id: "steering-conversation-label",
        title: "↪︎ Steering messages are clearly marked",
        description:
          "Messages sent with steering now keep a lightweight 'Steering conversation' label above the bubble, even after the app reconciles with the server.",
      },
      {
        id: "calmer-foreground-update-checks",
        title: "🚦 Less aggressive background return checks",
        description:
          "Desktop update checks now wait for a real background return instead of reacting to every tiny blur/focus bounce.",
      },
      {
        id: "update-check-timeout-recovery",
        title: "🛟 No more stuck checking state",
        description:
          "If the updater never answers, Synara now times out and recovers instead of hanging on a permanent Checking status.",
      },
    ],
  },
  {
    version: "0.0.31",
    date: "Apr 19",
    features: [
      {
        id: "gemini-provider-support",
        title: "♊ Gemini support is here",
        description:
          "Use Gemini alongside Codex and Claude Agent, with provider-aware models and handoff support built into the app.",
      },
      {
        id: "custom-provider-binaries",
        title: "🛠️ Custom binary paths for every provider",
        description:
          "Point Synara at your own Codex, Claude, or Gemini binary when your setup lives outside the default install path.",
      },
      {
        id: "assistant-selections-as-context",
        title: "📎 Reuse assistant replies as attachments",
        description:
          "Select parts of an assistant response and send them back as structured context in your next prompt.",
      },
      {
        id: "stronger-thread-continuity",
        title: "🧵 Better thread continuity",
        description:
          "The app now remembers your last open thread, carries pull request context into draft threads, and keeps sidebar state more stable.",
      },
      {
        id: "stability-and-update-polish",
        title: "🩹 Smoother recovery and update checks",
        description:
          "Project creation recovery, foreground update checks, and a few rough edges around long messages and download state have been tightened up.",
      },
    ],
  },
  {
    version: "0.0.30",
    date: "Apr 18",
    features: [
      {
        id: "chats-are-now-available",
        title: "💬 Chats are now available!",
        description: "Write without a selected project, or create threads from there.",
      },
      {
        id: "new-shortcuts",
        title: "⌨️ New shortcuts",
        description:
          "Quickly open a new chat or jump to your latest project thread with dedicated shortcuts.",
      },
      {
        id: "claude-1m-context",
        title: "🧠 Claude 1M context support",
        description:
          "Take full advantage of Claude's 1M-token context window for long conversations and large codebases.",
      },
      {
        id: "bulk-thread-actions",
        title: "📁 Bulk thread actions",
        description: "Select multiple threads at once and act on them together.",
      },
      {
        id: "cleaner-reasoning-picker",
        title: "✨ Cleaner reasoning picker order",
        description:
          "The reasoning picker has been reordered to make the most common choices quicker to reach.",
      },
      {
        id: "polished-ui-ux",
        title: "💻 New polished UI/UX",
        description: "A round of visual and interaction polish across the app.",
      },
    ],
  },
  {
    version: "0.0.29",
    date: "Apr 18",
    features: [
      {
        id: "whats-new-dialog",
        title: "🆕 What's new, inline",
        description:
          "Every update now opens a one-time dialog highlighting the latest changes, so you don't have to hunt through a changelog to know what shipped.",
        details:
          "The dialog only shows up once per release — dismiss it and it stays out of your way until the next version.",
      },
      {
        id: "release-history-settings",
        title: "📚 Release history in Settings",
        description:
          "A full changelog lives under Settings → Release history, grouped by version in a collapsible accordion.",
        details:
          "Revisit any past release at any time. The same notes as the post-update dialog, nothing to hunt for.",
      },
    ],
  },
];
