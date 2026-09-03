# Source evidence — external documentation claims

Date checked: **2026-09-01**

This file records, per provider, the claims in `content/docs` that required source
verification, the primary source used, and the date the source was checked.
All external URLs were verified live (HTTP 200, redirects followed) on the date above;
see `scripts/check-external-links.mjs` for the automated check.

## Cursor (canonical-URL decision)

**Claims:** Cursor Agent is installed with `curl https://cursor.com/install -fsS | bash`;
the executable is `cursor-agent`; `cursor-agent login` / `cursor-agent status` /
`cursor-agent update` / `cursor-agent upgrade` are valid subcommands.

**Primary source:** [Cursor Docs — CLI](https://cursor.com/docs/cli/overview), fetched copy
`/tmp/site-pr2/cursor-docs.html` (captured 2026-08-07 from https://cursor.com/docs).

**Decision — Official documentation links:**

The previous links pointed at `https://docs.cursor.com/en/cli/*`. Verified on 2026-08-07
that all three now redirect (HTTP 200, `Location`) to the generic landing page
`https://cursor.com/docs`, losing the specific CLI content:

- `https://docs.cursor.com/en/cli/installation` → `https://cursor.com/docs`
- `https://docs.cursor.com/en/cli/reference/authentication` → `https://cursor.com/docs`
- `https://docs.cursor.com/en/cli/reference/parameters` → `https://cursor.com/docs`

The CLI page slugs were extracted from the fetched copy of `https://cursor.com/docs`
(`/tmp/site-pr2/cursor-docs.html`), which lists the canonical CLI docs tree, and each
candidate was confirmed with `curl` (HTTP 200 + real page content, correct `<title>`):

| Page               | Canonical URL (used)                                   | Verified                                     |
| ------------------ | ------------------------------------------------------ | -------------------------------------------- |
| CLI installation   | `https://cursor.com/docs/cli/installation`             | 200, title "CLI Installation \| Cursor Docs" |
| CLI authentication | `https://cursor.com/docs/cli/reference/authentication` | 200, title "Authentication \| Cursor Docs"   |
| CLI parameters     | `https://cursor.com/docs/cli/reference/parameters`     | 200, title "Parameters \| Cursor Docs"       |

`content/docs/providers/cursor.mdx` "Official documentation" links were updated to these
canonical URLs. The docs contract test (`scripts/provider-docs.test.mjs`) expected the old
`docs.cursor.com` domain and was updated to `cursor.com`.

## Antigravity

**Claims:** Install scripts `https://antigravity.google/cli/install.sh` (macOS/Linux) and
`https://antigravity.google/cli/install.ps1` (Windows); documentation links for CLI install,
usage, and troubleshooting.

**Primary source:** [Antigravity CLI docs](https://antigravity.google/docs/cli/install)
checked 2026-08-07; install scripts verified HTTP 200.

## Claude Code

**Claims:** Claude Code is set up via Anthropic's official getting-started guide; CLI reference
at `cli-usage`.

**Primary source:** [Anthropic Claude Code docs](https://docs.anthropic.com/en/docs/claude-code/getting-started)
checked 2026-08-07 (redirects to `https://code.claude.com/docs/en/getting-started`, HTTP 200).

## Codex

**Claims:** Codex documentation, authentication, and the open-source repository.

**Primary source:** [OpenAI Codex docs](https://developers.openai.com/codex) checked
2026-08-07 (redirects to `https://learn.chatgpt.com/docs`, title "ChatGPT – Codex |
OpenAI Developers", HTTP 200); [github.com/openai/codex](https://github.com/openai/codex) HTTP 200.

## Factory Droid

**Claims:** Droid quickstart, Droid CLI reference, and Droid Exec / API-key setup.

**Primary source:** [Factory docs](https://docs.factory.ai/cli/getting-started/quickstart)
checked 2026-08-07 (redirects to `https://docs.factory.ai/droid-cli/quickstart`, HTTP 200);
install script `https://app.factory.ai/cli` HTTP 200.

## Grok Build

**Claims:** Grok Build overview/installation, CLI reference, source and authentication guide;
install scripts `https://x.ai/cli/install.sh` and `https://x.ai/cli/install.ps1`.

**Primary source:** [x.ai Grok Build docs](https://docs.x.ai/build/overview) checked
2026-08-07 (HTTP 200); [github.com/xai-org/grok-build](https://github.com/xai-org/grok-build) HTTP 200.

## Devin CLI

**Claims:** Devin CLI installation on macOS, Linux, WSL, and Windows; the `devin`
executable; `devin auth login`, `devin auth status`, `devin models list --format json`,
`devin update`, and the `devin acp` stdio server; ACP authentication through
`WINDSURF_API_KEY` or credentials stored by `devin auth login`.

**Primary source:** [Devin CLI quickstart](https://docs.devin.ai/cli),
[commands and flags](https://docs.devin.ai/cli/reference/commands), and
[configuration file reference](https://docs.devin.ai/cli/reference/configuration/config-file),
checked 2026-09-01 (HTTP 200 with current CLI content).

## OpenCode

**Claims:** OpenCode introduction/installation, providers, and configuration docs; install
script `https://opencode.ai/install`.

**Primary source:** [OpenCode docs](https://opencode.ai/docs) checked 2026-08-07 (HTTP 200);
`https://opencode.ai/install` redirects to the official installer script (HTTP 200).

## Pi

**Claims:** Pi documentation, quickstart, repository, and install script `https://pi.dev/install.sh`.

**Primary source:** [Pi docs in earendil-works/pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md)
checked 2026-08-07 (HTTP 200); `https://pi.dev/install.sh` HTTP 200.

## Synara (project self-links)

**Claims:** GitHub issues / new-issue links, releases, main-branch repository, and canary
setup docs.

**Primary source:** Local checkout `/tmp/synara` (checked 2026-08-07): `docs/canary.md`
(Canary isolation, app name `Synara Canary`, bundle ID `com.emanueledipietro.synara.canary`,
data dir `~/.synara-canary`) and `README.md` (MCP-native agent harness description).
Live GitHub URLs `https://github.com/Emanuele-web04/synara*` verified HTTP 200 on 2026-08-07.

## Site metadata (src/lib/seo.ts)

**Claims:** `https://www.trysynara.com` (canonical site URL), `https://emanueledipietro.com`
(author site), `https://x.com/emanueledpt` (X profile), `https://youtube.com/@emanueledpt`
(YouTube channel), `https://schema.org` (schema vocabulary), `https://opensource.org/licenses/MIT`
(MIT license).

**Primary sources:** All verified HTTP 200 on 2026-08-07. `opensource.org/licenses/MIT`
redirects to the canonical `https://opensource.org/license/MIT`; `emanueledipietro.com`
redirects to `https://www.emanueledipietro.com/`; `youtube.com/@emanueledpt` redirects to
`https://www.youtube.com/@emanueledpt`. Note: `youtube.com/@emanueledpt` is in the check
script's ALLOWLIST because YouTube occasionally returns ETIMEDOUT to non-browser agents
(observed once on 2026-08-07, passes on retry and in curl verification).

## Check run

- `npm run test:links` — 45 unique URLs, 45 PASS, 0 warn, 0 allowlisted, 0 fail (exit 0, ~7s);
  stable across repeated runs (idempotent).
- `npm run test:docs` — 45/45 tests pass plus documentation integrity check (exit 0).
- `npx eslint scripts/check-external-links.mjs` — clean (exit 0).

## Cursor — `cursor-agent upgrade` subcommand (evidence-trail addendum)

**Claim removed:** `content/docs/providers/cursor.mdx` listed `cursor-agent upgrade` as a
valid subcommand alternative to `cursor-agent update`.

**Primary source:** Web-verified 2026-08-07 — the cursor-agent CLI exposes only
`cursor-agent update`; there is no `upgrade` subcommand. The local capture
`/tmp/site-pr2/cursor-docs.html` is the `https://cursor.com/docs` landing page and
contains no cursor-agent mentions, so the live web check is the authoritative source.

**Decision — CORRECT:** removal of `cursor-agent upgrade` stands.

## Synara — `/config` slash command (evidence-trail addendum)

**Claim removed:** `content/docs/reference/slash-commands.mdx` listed `/config` ("Open
settings") among built-in slash commands.

**Primary source:** No test assertion exists (`scripts/help-docs.test.mjs` has no
slash-command assertions) and no app-source capture was available in this repo; the
removal follows the canonical product position that built-in commands are documented in
the app.

**Decision — REMOVAL STANDS:** evidence source is the app's built-in command list
(unverified in this repo) — **needs app-source confirmation, low risk**.

## Synara v0.7.2 feature documentation

Date checked: **2026-08-15**

**Claims:** Persistent and autonomous thread goals; `/goal` controls; evidence-first Debug
mode; full-thread and message-level forks; native fork coverage; local/worktree fork targets;
the macOS iOS Simulator pane and device controls; workspace file and source search; stacked
pull-request navigation and prefix merging; automation consecutive-failure policies.

**Primary source:** Local Synara checkout
`/Users/emanueledipietro/Developer/synara` at release tag `v0.7.2`, commit
`18ff99857d5b84adab2019c2839fa4f6df761b7c`.

Key source paths checked:

- Goals and commands: `apps/web/src/composerSlashCommands.ts`,
  `apps/web/src/hooks/useComposerSlashCommands.ts`,
  `apps/web/src/components/chat/ComposerGoalHeader.tsx`, and
  `apps/server/src/agentGateway/Layers/AgentGateway.ts`
- Fork lifecycle: `apps/web/src/hooks/useComposerSlashCommands.ts`,
  `apps/web/src/lib/threadEnvironment.ts`,
  `apps/web/src/components/chat/MessagesTimeline.tsx`, and provider fork adapters
- Debug policy: `apps/server/src/provider/debugMode.ts` and composer interaction-mode controls
- iOS Simulator: `apps/web/src/components/DevicePanel.tsx`,
  `apps/web/src/components/DevicePanel.logic.ts`,
  `apps/web/src/components/device/DeviceControlRail.tsx`, and server device services/tools
- Workspace search: `apps/web/src/components/chat/SingleChatSurface.tsx` and
  `apps/web/src/components/WorkspaceSearchPalette.tsx`
- Stacked PRs: `apps/web/src/components/pullRequest/PullRequestStackPopover.tsx`,
  `pullRequestStack.logic.ts`, and `PullRequestDetailPanel.tsx`
- Automation failures: `apps/web/src/lib/automationFailurePolicy.ts`, automation form/detail
  controls, and `apps/server/src/automation/Layers/AutomationService.ts`

**Decision:** Public documentation follows the shipped release source. The older internal
`docs/device-pane-spec.md` was treated as historical design context only because several
pre-implementation non-goals changed before v0.7.2 shipped.

## Synara v0.7.3 feature documentation

Date checked: **2026-08-21**

**Claims:** Guarded desktop quit and startup continuation; a floating task-owned browser;
usage views for every locally verifiable provider; first-class WSL UNC launching; optional
custom title bars on Windows and Linux; the headless release tarball and `synara server
status`; cross-provider `/side`; and provider streaming, diagnostic, workspace, and runtime
reliability fixes.

**Primary source:** Local Synara checkout
`/Users/emanueledipietro/Developer/synara` at the v0.7.3 release commit
`a93c47e275870f34ec7aa8cd72f2a0ff6246db7c`. The audited range from v0.7.2 contains 224
commits, including 50 merge commits, across 321 changed files.

Key source paths checked:

- Quit and continuation: `apps/desktop/src/runningChatsQuitGuard.ts`,
  `apps/web/src/components/RunningChatsQuitDialog.tsx`,
  `apps/web/src/lib/runningChatsQuitConfirmation.ts`, and
  `apps/server/src/orchestration/quitResume.ts`
- Floating browser: `apps/web/src/components/chat/FloatingBrowserPanel.tsx`,
  `FloatingBrowserPanel.browser.tsx`, and `apps/web/src/components/BrowserTabStrip.tsx`
- Provider usage: `apps/server/src/providerUsage/`,
  `apps/server/src/providerUsageSnapshot.ts`, and
  `apps/web/src/lib/providerUsageSnapshot.ts`
- WSL and desktop chrome: `packages/shared/src/windowsProcess.ts`,
  `apps/server/src/provider/acp/AcpWslCwd.test.ts`, and
  `apps/desktop/src/desktopCustomTitleBar.ts`
- Headless distribution and status: `.github/workflows/release.yml`,
  `apps/server/scripts/cli.ts`, and `apps/server/src/serverStatusCli.ts`
- Cross-provider side chats: `apps/web/src/composerSlashCommands.ts`,
  `apps/web/src/lib/sidechatCreation.ts`, and
  `apps/web/src/lib/sidechatCreatorRegistry.ts`
- Provider correctness: `apps/server/src/provider/Layers/AntigravityAdapter.ts` and
  `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

**Decision:** The changelog and durable guides describe the release commit, not every
intermediate merge. The experimental DeepSeek Harness work was reverted before v0.7.3 and
is therefore explicitly excluded from the shipped provider list.

## Synara v0.8.0 feature documentation

Date checked: **2026-09-01**

**Claims:** Devin CLI ACP integration; provider-neutral WebMCP browser tools; in-thread
find; server-backed provider enablement and all-enabled-provider usage; queued follow-up
and live-transcript reliability; source-data isolation and migration recovery; durable
side-chat panes; sidebar navigation ordering; file actions and path/PDF handling; Kilo
Code removal and migration to OpenCode; and the release's security and platform boundary
fixes.

**Primary source:** Local Synara checkout
`/Users/emanueledipietro/Developer/synara` at pre-release head
`8b428c474d49583637ad899fd9ada61cc40b18da`. The audited range from v0.7.3 contains 94
commits, including 61 merged pull requests, across 518 changed files.

Key source paths checked:

- Devin: `apps/server/src/provider/Layers/DevinAdapter.ts`,
  `apps/server/src/provider/acp/DevinAcpSupport.ts`,
  `apps/server/src/providerUsage/providers/devin.ts`, and provider settings metadata
- Browser tools and transcript find: `apps/server/src/agentGateway/browserTools.ts`,
  `apps/web/src/components/chat/`, and `apps/web/src/lib/matchHighlight.ts`
- Provider policy and context: `apps/server/src/provider/Layers/ProviderHealth.ts`,
  `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, and provider-usage services
- Migration and recovery: `apps/server/src/persistence/Migrations/098_MigrateKiloToOpenCode.ts`,
  migration runtime identity/recovery services, and desktop source-launch configuration
- Side chats, navigation, and file actions: the side-chat lifecycle services,
  `apps/web/src/sidebarNavOrdering.ts`, and edited-file/path/PDF helpers
- Boundary hardening: shared path/network/payload utilities, provider credential handling,
  updater shutdown logic, and the focused tests named in the v0.8.0 root changelog

**Decision:** Current provider, feature, troubleshooting, and workflow guides now describe
the 0.8.0 release. Historical Kilo Code references remain only inside older release notes;
current provider navigation and marketing surfaces point to Devin CLI.
