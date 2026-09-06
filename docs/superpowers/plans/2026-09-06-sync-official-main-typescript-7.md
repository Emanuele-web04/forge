# Official Main TypeScript 7 Compatibility Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `official/main` into `nacho/integration` while preserving local Outbound MCP, Bitbucket pull request, project-source, and sidebar behavior under TypeScript 7.

**Architecture:** Incorporate the current Nacho upstream in an isolated branch, merge Emanuel's tree with explicit conflict resolutions, then replay the protected local work snapshot. Keep upstream's migration 99 canonical and append the three local migrations at IDs 100–102; adapt local provider-discriminated data and MCP transport code at their existing boundaries.

**Tech Stack:** Bun, TypeScript 7 native preview, Effect, SQLite, React, Vitest, Model Context Protocol SDK 1.29.

**Spec:** User-supplied integration brief from 2026-09-06.

## Global Constraints

- Preserve every tracked and untracked file captured before the merge.
- Keep `099_InvalidateProjectionThreadsCursor`; relocate local migrations without changing their execution order.
- Preserve local APIs still consumed by Sidebar, Activity, and pull request UI code.
- Do not integrate into `nacho/integration` unless `bun fmt`, `bun lint`, and `bun typecheck` all exit zero.
- Do not push, open a pull request, or deploy.

---

### Task 1: Merge lineage and direct conflicts

**Files:**
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Migrations.test.ts`
- Move: `apps/server/src/persistence/Migrations/099_ProjectSources.ts` to `100_ProjectSources.ts`
- Move: `apps/server/src/persistence/Migrations/100_OutboundMcpConnections.ts` to `101_OutboundMcpConnections.ts`
- Move: `apps/server/src/persistence/Migrations/101_ProjectPullRequestPinProviders.ts` to `102_ProjectPullRequestPinProviders.ts`
- Modify: the remaining files reported by `git diff --name-only --diff-filter=U`

**Interfaces:**
- Consumes: Effect SQL migration loader tuples `[id, name, effect]`.
- Produces: canonical tail `99 InvalidateProjectionThreadsCursor`, `100 ProjectSources`, `101 OutboundMcpConnections`, `102 ProjectPullRequestPinProviders`.

- [ ] **Step 1: Encode the expected migration tail in the existing migration tests**

```ts
[99, "InvalidateProjectionThreadsCursor"],
[100, "ProjectSources"],
[101, "OutboundMcpConnections"],
[102, "ProjectPullRequestPinProviders"],
```

- [ ] **Step 2: Update imports, entries, aliases, and filenames to match the expected tail**

```ts
import Migration0102 from "./Migrations/102_ProjectPullRequestPinProviders.ts";
[102, "ProjectPullRequestPinProviders", Migration0102],
```

- [ ] **Step 3: Preserve both sides of additive conflicts**

Keep `deriveProjectSourcesFromCreated` alongside upstream's `maxIso`, keep full-scan local-server helpers, preserve Sidebar and provider-aware PR identity helpers, and combine project-source normalization with upstream expansion persistence.

- [ ] **Step 4: Run focused conflict tests**

```bash
bun run --cwd apps/server test src/persistence/Migrations.test.ts src/localServerMonitor.test.ts src/orchestration/projector.test.ts
bun run --cwd apps/web test src/components/Sidebar.logic.test.ts src/components/pullRequest/pullRequestList.logic.test.ts src/focusedChatContext.test.ts src/lib/threadBootstrap.test.ts src/storeNormalization.test.ts
```

### Task 2: Replay the protected local snapshot

**Files:**
- Modify: the 30 tracked files listed by `git stash show --name-status stash@{0}`.
- Restore: `.agents/skills/react-doctor/SKILL.md`, `.agents/skills/react-doctor/references/explain.md`, `.agents/skills/verify/SKILL.md`, and `tasks/memory`.

**Interfaces:**
- Consumes: the stash whose message starts `codex: pre official-main ts7 integration`.
- Produces: the merged tree plus every pre-merge local change and untracked file.

- [ ] **Step 1: Apply the tracked stash as a three-way change after the upstream merge commit**

```bash
git stash apply stash@{0}
```

- [ ] **Step 2: Confirm the untracked snapshot files are restored**

```bash
git status --short
```

Expected: `.agents/` and `tasks/memory` are present, and the protected stash remains until local integration is verified.

### Task 3: Port Outbound MCP and Bitbucket to TypeScript 7

**Files:**
- Modify: `apps/server/src/outboundMcp/**`
- Modify: `apps/server/src/pullRequests/**`
- Modify: `packages/contracts/src/ws.ts`
- Modify: `packages/shared/src/pullRequestList.ts`
- Test: colocated Outbound MCP, Bitbucket provider, contract, operations, and cache tests.

**Interfaces:**
- Consumes: MCP SDK 1.29 OAuth/HTTP transport types and provider-discriminated pull request contracts.
- Produces: exact-optional-compatible objects whose `provider` discriminant matches their provider-specific fields.

- [ ] **Step 1: Run TypeScript 7 and capture each diagnostic by subsystem**

```bash
bun typecheck
```

- [ ] **Step 2: Correct MCP SDK boundary types without weakening contracts**

Use SDK-native OAuth client information, stream conversion, transport metadata, and revocation metadata; omit optional keys instead of assigning `undefined`.

- [ ] **Step 3: Correct provider-discriminated builders and fixtures**

```ts
const bitbucketEntry = { provider: "bitbucket" as const, workspace, repositorySlug, number };
const githubEntry = { provider: "github" as const, owner, repository, number };
```

- [ ] **Step 4: Run the focused server and web tests changed by the snapshot**

```bash
bun run --cwd apps/server test src/outboundMcp src/pullRequests
bun run --cwd apps/web test src/lib/pullRequestReactQuery.action.test.ts src/lib/pullRequestReactQuery.pin.test.ts src/wsNativeApi.test.ts
```

### Task 4: Dependency and final verification gate

**Files:**
- Modify: `bun.lock` only as produced by the merged dependency graph.

**Interfaces:**
- Consumes: root workspace manifests including `@typescript/native` and `effect-tsgo`.
- Produces: a reproducible installed dependency graph and a zero-error workspace.

- [ ] **Step 1: Install the merged dependency graph**

```bash
bun install
```

- [ ] **Step 2: Run the required gate once**

```bash
bun fmt
bun lint
bun typecheck
```

- [ ] **Step 3: Review the complete branch diff and fix findings**

Inspect tracked and untracked changes against the pre-merge target, including migration lineage, frontend collateral effects, backend boundaries, documentation consistency, and repository hygiene.

- [ ] **Step 4: Commit and locally integrate only after the gate passes**

Create a Conventional Commit merge/compatibility commit with the `Agents-Toolkit-Version: 6.10.3` trailer, lock the shared Git common directory, merge the latest local target/upstream if they advanced, fast-forward `nacho/integration`, verify containment, and clean the temporary worktree without pushing.
