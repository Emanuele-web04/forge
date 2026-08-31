# Bitbucket Pull Request Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display read-only Paraty Bitbucket pull requests from local repositories such as `payment-seeker` alongside GitHub pull requests by consuming the authenticated outbound MCP foundation.

**Architecture:** Introduce provider-neutral repository/PR identity and a provider adapter boundary around the existing GitHub behavior, then add a Paraty Bitbucket adapter whose only remote dependency is the outbound MCP consumer binding. Aggregate providers with isolated caches/errors and drive web capabilities so unsupported Bitbucket actions are absent and rejected server-side.

**Tech Stack:** TypeScript, Effect services/layers and Schema, SQLite migrations, outbound MCP foundation, React 19, TanStack Query, Vitest, existing unified diff renderer.

**Spec:** `docs/superpowers/specs/2026-08-31-outbound-mcp-bitbucket-pull-requests-design.md`

## Global Constraints

- Complete `docs/superpowers/plans/2026-08-31-outbound-mcp-foundation.md` first.
- Every Bitbucket remote read must use the Paraty MCP binding; do not call Bitbucket HTTP APIs or a Bitbucket CLI.
- Recognize only `bitbucket.org/paraty/*` for the first Bitbucket provider.
- Bitbucket supports list, detail, unified diff, and comment reads only.
- Bitbucket must reject comment, resolve, merge, close/reopen, ready/draft, and every other mutation on the server even if a request is fabricated.
- Bitbucket entries appear only under involvement `all`; they are excluded from `reviewing` and `authored` because viewer identity is unknown.
- Map `OPEN` to `open`, `MERGED` to `merged`, and `DECLINED` to `closed`.
- Missing Bitbucket stats/checks/mergeability are unavailable (`null`/capability false), never fabricated as zero/success.
- Provider identity participates in repository keys, PR keys, route selection, caches, pins, and mutation keys.
- A provider failure is repository-scoped and preserves successful/cached results from the other provider.
- A non-authoritative inventory or disconnected MCP connection never deletes Bitbucket pins.
- Use `bun run test`, never `bun test`.
- Do not run workspace `bun fmt`, `bun lint`, or `bun typecheck` until the user explicitly authorizes the final verification pass.
- Apply the `git-paraty`, `paraty-tech`, `paraty-security`, `frontend-rules`, and `changes-review` skills at their relevant boundaries.

## File Structure

- `packages/shared/src/remoteRepository.ts`: credential-free GitHub/Bitbucket remote parsing and canonical identity.
- `packages/contracts/src/pullRequests.ts`: provider-aware inputs, outputs, involvement, capabilities, and unavailable fields.
- `apps/server/src/pullRequests/Services/PullRequestProvider.ts`: provider adapter contract.
- `apps/server/src/pullRequests/providers/GitHubPullRequestProvider.ts`: current GitHub behavior behind the adapter.
- `apps/server/src/pullRequests/providers/ParatyBitbucketPullRequestProvider.ts`: MCP mapping and normalization.
- `apps/server/src/pullRequests/providers/paratyBitbucketBinding.ts`: exact four-tool allowlist and Effect Schema decoders.
- `apps/server/src/pullRequests/Layers/PullRequestService.ts`: provider-neutral aggregation, pins, partial failures, and caches.
- `apps/web/src/components/pullRequest/PullRequestProviderBadge.tsx`: accessible source identity.
- `apps/web/src/components/pullRequest/pullRequestCapabilities.ts`: one capability decision surface for list/detail actions.

---

### Task 1: Canonical remote repository identity and discovery

**Files:**
- Create: `packages/shared/src/remoteRepository.ts`
- Create: `packages/shared/src/remoteRepository.test.ts`
- Modify: `packages/shared/package.json`
- Modify: `apps/server/src/pullRequests/repositoryResolution.ts`
- Modify: `apps/server/src/pullRequests/repositoryResolution.test.ts`
- Modify: `apps/server/src/pullRequests/projectRepositoryInventory.ts`
- Create: `apps/server/src/pullRequests/projectRepositoryInventory.test.ts`

**Interfaces:**
- Produces: `RemoteProvider = "github" | "bitbucket"`.
- Produces: `RemoteRepositoryRef { provider, host, owner, slug, webUrl, identityKey, displayName }`.
- Produces: `parseRemoteRepositoryUrl(url)` and `resolveRemoteRepositories(git, cwd)`.

- [ ] **Step 1: Write failing remote parser cases**

```ts
expect(parseRemoteRepositoryUrl("git@bitbucket.org:paraty/payment-seeker.git")).toEqual({
  provider: "bitbucket",
  host: "bitbucket.org",
  owner: "paraty",
  slug: "payment-seeker",
  webUrl: "https://bitbucket.org/paraty/payment-seeker",
  identityKey: "bitbucket:bitbucket.org:paraty/payment-seeker",
  displayName: "paraty/payment-seeker",
});
expect(parseRemoteRepositoryUrl("https://user:token@bitbucket.org/paraty/payment-seeker.git")).toBeNull();
expect(parseRemoteRepositoryUrl("git@bitbucket.org:other/payment-seeker.git")).toBeNull();
```

Retain equivalent GitHub HTTPS/SSH fixtures and reject malformed hosts, empty slugs, query credentials, and path traversal.

- [ ] **Step 2: Run shared/parser tests and confirm missing implementation**

Run: `bun run --cwd packages/shared test src/remoteRepository.test.ts`

Expected: FAIL because the module/export does not exist.

- [ ] **Step 3: Implement canonical parsing and package export**

```ts
export function remoteRepositoryIdentityKey(input: {
  provider: RemoteProvider;
  host: string;
  owner: string;
  slug: string;
}) {
  return `${input.provider}:${input.host.toLowerCase()}:${input.owner.toLowerCase()}/${input.slug.toLowerCase()}`;
}
```

Support `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo(.git)`, `https://bitbucket.org/paraty/repo(.git)`, and `git@bitbucket.org:paraty/repo(.git)`. Return `null` for credential-bearing URLs.

- [ ] **Step 4: Generalize repository resolution without changing precedence**

```ts
export interface RemoteRepositoryInventory {
  readonly repositories: ReadonlyArray<RemoteRepositoryRef>;
  readonly authoritative: boolean;
}
```

Keep branch remote, `remote.pushDefault`, `origin`, then sorted remotes. Deduplicate by `identityKey`, not `owner/slug`. Rename GitHub-specific operation labels in this module to `PullRequestService.remoteRepository.*`.

- [ ] **Step 5: Verify alias expansion and authoritative failure behavior**

Run: `bun run --cwd packages/shared test src/remoteRepository.test.ts && bun run --cwd apps/server test src/pullRequests/repositoryResolution.test.ts`

Expected: PASS. A failed config read returns a non-authoritative error; an authoritative repo with no remotes returns an empty inventory.

- [ ] **Step 6: Commit provider-neutral discovery**

```bash
git add packages/shared apps/server/src/pullRequests/repositoryResolution* apps/server/src/pullRequests/projectRepositoryInventory.ts
git commit -m "refactor(pr): generalize repository discovery [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 2: Provider-aware pull request contracts and route identity

**Files:**
- Modify: `packages/contracts/src/pullRequests.ts`
- Test: `packages/contracts/src/pullRequests.test.ts`
- Modify: `apps/server/src/pullRequests.logic.ts`
- Modify: `apps/server/src/pullRequests.logic.test.ts`
- Modify: `apps/web/src/pullRequestReference.ts`
- Modify: `apps/web/src/pullRequestReference.test.ts`
- Modify: `apps/web/src/lib/pullRequestCache.ts`

**Interfaces:**
- Produces: `PullRequestProvider`, `PullRequestViewerInvolvement`, and `PullRequestCapabilities`; repository identity remains `RemoteRepositoryRef` from Task 1.
- Produces: `PullRequestProviderRequirement` entries in list results for eligible providers that require user connection.
- Adds `provider` to list/detail/batch/error/detail-input/action/comment/pin identities with a GitHub decoding default.
- Changes additions/deletions/changedFiles/checks/mergeability-related values to provider-safe optional/null forms.

- [ ] **Step 1: Write failing legacy and Bitbucket decoding tests**

```ts
expect(Schema.decodeUnknownSync(PullRequestDetailInput)({
  projectId,
  repository: "owner/repo",
  number: 12,
}).provider).toBe("github");

expect(Schema.decodeUnknownSync(PullRequestListEntry)({
  ...bitbucketFixture,
  provider: "bitbucket",
  capabilities: READ_ONLY_CAPABILITIES,
  additions: null,
  deletions: null,
  viewerInvolvement: "unknown",
}).capabilities.comment).toBe(false);
```

- [ ] **Step 2: Run contract/reference tests and observe schema failures**

Run: `bun run --cwd packages/contracts test src/pullRequests.test.ts && bun run --cwd apps/web test src/pullRequestReference.test.ts`

Expected: FAIL because provider/capability fields are absent.

- [ ] **Step 3: Define provider and capability schemas**

```ts
export const PullRequestProvider = Schema.Literals(["github", "bitbucket"]);
export const PullRequestViewerInvolvement = Schema.Literals([
  "author",
  "review-requested",
  "none",
  "unknown",
]);
export const PullRequestCapabilities = Schema.Struct({
  detail: Schema.Boolean,
  diff: Schema.Boolean,
  comments: Schema.Boolean,
  checks: Schema.Boolean,
  comment: Schema.Boolean,
  resolveComment: Schema.Boolean,
  stateMutation: Schema.Boolean,
  merge: Schema.Boolean,
});

export const PullRequestProviderRequirement = Schema.Struct({
  provider: PullRequestProvider,
  presetId: TrimmedNonEmptyString,
  status: Schema.Literals([
    "not-connected",
    "reconnect-required",
    "incompatible",
    "temporarily-unavailable",
  ]),
});
```

Use decoding defaults only for absent provider on legacy payloads (`github`) and absent capabilities on legacy GitHub payloads. A Bitbucket payload must carry explicit read-only capabilities. Add `providerRequirements` to `PullRequestsListResult` with an empty-array decoding default for rolling restarts.

- [ ] **Step 4: Make every identity/cache key provider-aware**

```ts
export function pullRequestIdentityKey(input: {
  provider: PullRequestProvider;
  repository: string;
  number: number;
}) {
  return `${input.provider}\0${input.repository.trim().toLowerCase()}\0${input.number}`;
}
```

Update route parsing so `provider` is optional and defaults to `github`; serializers always include it for newly generated links. Update list/detail/mutation/pin query keys with provider.

- [ ] **Step 5: Verify involvement filtering and unknown semantics**

```ts
expect(matchesInvolvement(bitbucketEntry, "all")).toBe(true);
expect(matchesInvolvement(bitbucketEntry, "reviewing")).toBe(false);
expect(matchesInvolvement(bitbucketEntry, "authored")).toBe(false);
```

Run: `bun run --cwd packages/contracts test src/pullRequests.test.ts && bun run --cwd apps/server test src/pullRequests.logic.test.ts && bun run --cwd apps/web test src/pullRequestReference.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit provider-aware contracts**

```bash
git add packages/contracts/src/pullRequests* apps/server/src/pullRequests.logic* apps/web/src/pullRequestReference* apps/web/src/lib/pullRequestCache.ts
git commit -m "feat(pr): add provider-aware identities [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 3: Provider-aware pin migration and cleanup rules

**Files:**
- Create: `apps/server/src/persistence/Migrations/099_ProjectPullRequestPinProviders.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Migrations.test.ts`
- Modify: `apps/server/src/persistence/Services/ProjectPullRequestPins.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectPullRequestPins.ts`
- Modify: `apps/server/src/persistence/Layers/ProjectPullRequestPins.test.ts`
- Modify: `apps/server/src/pullRequests/projectRepositoryInventory.ts`

**Interfaces:**
- Adds `provider` to `ProjectPullRequestPin` and set/list operations.
- Unique identity becomes `(project_id, provider, repository_key, pull_request_number)`.
- Cleanup checks authoritative inventory for the pin's matching provider.

- [ ] **Step 1: Write a failing migration preservation test**

```ts
yield* sql`INSERT INTO project_pull_request_pins (project_id, repository_key, pull_request_number)
           VALUES (${projectId}, 'owner/repo', 7)`;
yield* runMigration99;
const [pin] = yield* pins.listByProjectIds({ projectIds: [projectId] });
expect(pin).toMatchObject({ provider: "github", repositoryKey: "owner/repo", number: 7 });
```

Add a uniqueness case showing GitHub and Bitbucket can pin the same `owner/repo#7` independently.

- [ ] **Step 2: Run migration/pin tests and confirm the missing provider failure**

Run: `bun run --cwd apps/server test src/persistence/Layers/ProjectPullRequestPins.test.ts src/persistence/Migrations.test.ts`

Expected: FAIL before migration 99 is registered.

- [ ] **Step 3: Rebuild the pin table with a GitHub default**

```sql
CREATE TABLE project_pull_request_pins_next (
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'github',
  repository_key TEXT NOT NULL,
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
  PRIMARY KEY (project_id, provider, repository_key, pull_request_number)
) STRICT;
INSERT INTO project_pull_request_pins_next
  (project_id, provider, repository_key, pull_request_number)
SELECT project_id, 'github', repository_key, pull_request_number
FROM project_pull_request_pins;
```

Swap tables inside the migration and recreate the project foreign-key/index behavior present in migration 69.

- [ ] **Step 4: Thread provider through persistence operations**

```ts
export const ProjectPullRequestPin = Schema.Struct({
  projectId: ProjectId,
  provider: PullRequestProvider,
  repositoryKey: TrimmedNonEmptyString,
  number: PositiveInt,
});
```

Include `provider` in every SQL predicate and conflict target while preserving the per-project cap across both providers.

- [ ] **Step 5: Prevent cleanup from treating disconnected MCP as a removed remote**

```ts
const repositoryPresent = input.repositoryKeysByProject
  .get(row.projectId)
  ?.has(`${row.provider}\0${row.repositoryKey.toLowerCase()}`);
return resolution?.inventory.authoritative === true && repositoryPresent !== true;
```

Inventory authority comes from local Git reads, not MCP connection state. Test that an authoritative local Bitbucket remote preserves a pin while MCP is disconnected.

- [ ] **Step 6: Verify migrations, uniqueness, limits, and cleanup**

Run: `bun run --cwd apps/server test src/persistence/Layers/ProjectPullRequestPins.test.ts src/persistence/Migrations.test.ts src/pullRequests/projectRepositoryInventory.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit pin migration**

```bash
git add apps/server/src/persistence apps/server/src/pullRequests/projectRepositoryInventory*
git commit -m "feat(pr): scope pins by provider [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 4: Pull request provider boundary and GitHub adapter

**Files:**
- Create: `apps/server/src/pullRequests/Services/PullRequestProvider.ts`
- Create: `apps/server/src/pullRequests/providers/GitHubPullRequestProvider.ts`
- Create: `apps/server/src/pullRequests/providers/GitHubPullRequestProvider.test.ts`
- Modify: `apps/server/src/pullRequests/pullRequestOperations.ts`
- Modify: `apps/server/src/pullRequests/Layers/PullRequestService.ts`
- Modify: `apps/server/src/pullRequests/Layers/PullRequestService.test.ts`

**Interfaces:**
- Produces: `PullRequestProviderShape` with `supports`, `viewer`, `list`, `detail`, `diff`, optional `action`, optional `comment`.
- Produces: `ProviderListInput`, `ProviderListResult`, and `ProviderDetailInput` using `RemoteRepositoryRef` and project context.
- Produces: `GitHubPullRequestProvider` that wraps `GitHubCliShape` and preserves all current GitHub behavior.
- Consumer aggregate no longer imports `GitHubCli` operation types directly.

- [ ] **Step 1: Freeze existing GitHub behavior in adapter tests**

```ts
const result = yield* provider.list({
  repository: githubRepository,
  state: "open",
  involvement: "all",
  forceRefresh: false,
});
expect(result.entries[0]).toMatchObject({
  provider: "github",
  repository: "owner/repo",
  viewerInvolvement: "none",
});
```

Port representative list, reviewing companion, pinned recovery, detail/comments, diff, mutation, merge capability, and not-found cases from `PullRequestService.test.ts` without deleting their assertions.

- [ ] **Step 2: Run the new adapter test and confirm the missing provider failure**

Run: `bun run --cwd apps/server test src/pullRequests/providers/GitHubPullRequestProvider.test.ts`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Define the provider contract**

```ts
export interface PullRequestProviderShape {
  readonly provider: PullRequestProvider;
  readonly supports: (repository: RemoteRepositoryRef) => boolean;
  readonly viewer: () => Effect.Effect<string | null, unknown>;
  readonly list: (input: ProviderListInput) => Effect.Effect<ProviderListResult, unknown>;
  readonly detail: (input: ProviderDetailInput) => Effect.Effect<PullRequestDetail, unknown>;
  readonly diff: (input: ProviderDetailInput) => Effect.Effect<PullRequestDiffResult, unknown>;
  readonly action?: (input: PullRequestActionInput) => Effect.Effect<PullRequestActionResult, unknown>;
  readonly comment?: (input: PullRequestCommentInput) => Effect.Effect<PullRequestActionResult, unknown>;
}

export type ProviderListInput = {
  readonly repository: RemoteRepositoryRef;
  readonly state: PullRequestState;
  readonly involvement: PullRequestInvolvement;
  readonly forceRefresh: boolean;
};

export type ProviderListResult = {
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly truncated: boolean;
};

export type ProviderDetailInput = {
  readonly project: OrchestrationProject;
  readonly repository: RemoteRepositoryRef;
  readonly number: number;
};
```

- [ ] **Step 4: Move GitHub-specific caches and mappings behind the adapter**

Move viewer, list, item, review-match, stack, and merge-capability caches with their existing TTLs and keyed single-flight behavior. Keep six bounded GitHub read permits and mutation cache invalidation inside the adapter.

- [ ] **Step 5: Make the aggregate select providers by repository identity**

```ts
const provider = providers.find((candidate) => candidate.supports(repository));
if (!provider) return Effect.fail(new Error(`No pull request provider for ${repository.identityKey}`));
return provider.list({ repository, state, involvement, forceRefresh });
```

At this task, register only the GitHub adapter. Existing GitHub RPC payloads, actions, and UI behavior must remain green.

- [ ] **Step 6: Run the full focused GitHub PR backend suite**

Run: `bun run --cwd apps/server test src/pullRequests src/pullRequests.logic.test.ts src/git/testing/fakeGitHubCli.test.ts`

Expected: PASS with no Bitbucket implementation present yet.

- [ ] **Step 7: Commit the adapter extraction**

```bash
git add apps/server/src/pullRequests
git commit -m "refactor(pr): isolate GitHub provider [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 5: Paraty Bitbucket MCP binding and normalization

**Files:**
- Create: `apps/server/src/pullRequests/providers/paratyBitbucketBinding.ts`
- Create: `apps/server/src/pullRequests/providers/paratyBitbucketSchemas.ts`
- Create: `apps/server/src/pullRequests/providers/ParatyBitbucketPullRequestProvider.ts`
- Create: `apps/server/src/pullRequests/providers/ParatyBitbucketPullRequestProvider.test.ts`
- Modify: `apps/server/src/outboundMcp/presets/paraty.ts`

**Interfaces:**
- Consumes `McpConnectionService.invoke` from phase 1.
- Produces operations `list`, `detail`, `diff`, and `comments` mapped only to the four approved Paraty tools.
- Produces read-only Bitbucket `PullRequestCapabilities` and repository-scoped normalized errors.
- Subscribes to Paraty connection events: preserve cache on `credentials-invalidated`, clear it on explicit `disconnected`, and invalidate it after `connected`.

- [ ] **Step 1: Write failing MCP mapping tests with recorded-shaped fixtures**

```ts
expect(binding.operations.list.tool).toBe("paraty_bitbucket_pr_list");
expect(binding.operations.detail.tool).toBe("paraty_bitbucket_pr_get");
expect(binding.operations.diff.tool).toBe("paraty_bitbucket_pr_diff");
expect(binding.operations.comments.tool).toBe("paraty_bitbucket_pr_comment_list");
expect(Object.values(binding.operations).map(({ tool }) => tool)).not.toContain(
  "paraty_bitbucket_pr_comment_create",
);
```

Add fixtures for OPEN/MERGED/DECLINED, pagination/truncation, malformed one-entry skip, inline comment path/line, missing stats, and oversized diff truncation.

- [ ] **Step 2: Run the provider test and observe missing binding/provider failures**

Run: `bun run --cwd apps/server test src/pullRequests/providers/ParatyBitbucketPullRequestProvider.test.ts`

Expected: FAIL because the Bitbucket binding/provider are absent.

- [ ] **Step 3: Define strict result decoders for the four tools**

```ts
export const BitbucketPullRequestState = Schema.Literals(["OPEN", "MERGED", "DECLINED"]);
export const BitbucketPullRequestSummary = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
  state: BitbucketPullRequestState,
  author: Schema.optional(BitbucketActor),
  source: BitbucketBranch,
  destination: BitbucketBranch,
  created_on: IsoDateTime,
  updated_on: IsoDateTime,
  links: BitbucketLinks,
});
```

Decode the MCP `structuredContent` when present, otherwise decode the single JSON text content returned by the server. Reject multiple ambiguous text payloads.

- [ ] **Step 4: Bind exact tool arguments and bounded pagination**

```ts
yield* mcp.invoke(PARATY_BITBUCKET_BINDING, "list", {
  workspace: "paraty",
  repository: repository.slug,
  state: toBitbucketState(input.state),
  page: nextPage,
  pagelen: 50,
  sort: "-updated_on",
});
```

Stop at the existing repository batch cap, set `truncated: true` when another page exists, and preserve successfully decoded entries when one record is malformed by returning an incomplete repository error.

- [ ] **Step 5: Normalize provider-safe list/detail/comment/diff models**

```ts
export const BITBUCKET_READ_ONLY_CAPABILITIES: PullRequestCapabilities = {
  detail: true,
  diff: true,
  comments: true,
  checks: false,
  comment: false,
  resolveComment: false,
  stateMutation: false,
  merge: false,
};
```

Set `viewerInvolvement: "unknown"`, `isDraft: false`, unavailable stats to `null`, checks to `null`, and merge/stack fields unavailable. Cap unified diff text again at the application boundary and surface `truncated`.

Register a scoped connection-event listener when constructing the provider:

```ts
yield* mcp.subscribe((event) => {
  if (event.connectionId !== "paraty") return;
  if (event.type === "disconnected") bitbucketCache.clear();
  if (event.type === "connected") bitbucketCache.invalidateAll();
});
```

Do not clear cached PR data for `credentials-invalidated`; that state drives stale data plus Reconnect.

- [ ] **Step 6: Verify every read mapping and absence of write tools**

Run: `bun run --cwd apps/server test src/pullRequests/providers/ParatyBitbucketPullRequestProvider.test.ts src/outboundMcp/Layers/McpToolClient.test.ts`

Expected: PASS. The fake MCP call log contains only the four allowlisted tool names.

- [ ] **Step 7: Commit the Bitbucket provider**

```bash
git add apps/server/src/pullRequests/providers apps/server/src/outboundMcp/presets/paraty.ts
git commit -m "feat(pr): add Paraty Bitbucket read provider [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 6: Mixed-provider aggregation, partial failures, and read-only enforcement

**Files:**
- Modify: `apps/server/src/pullRequests/Layers/PullRequestService.ts`
- Modify: `apps/server/src/pullRequests/Layers/PullRequestService.test.ts`
- Modify: `apps/server/src/pullRequests/pullRequestOperations.ts`
- Modify: `apps/server/src/pullRequests/pullRequestOperations.test.ts`
- Create: `apps/server/src/pullRequests/Errors.ts`
- Modify: `apps/server/src/serverLayers.ts`

**Interfaces:**
- Registers both GitHub and Paraty Bitbucket providers.
- Aggregates successful repository batches while retaining provider/repository errors.
- Rejects mutations when provider capabilities/operations do not permit them.
- Produces: `PullRequestCapabilityError` with provider and denied capability only.

- [ ] **Step 1: Write failing mixed-provider aggregate tests**

```ts
const result = yield* service.list({ state: "open", involvement: "all" });
expect(result.entries.map((entry) => entry.provider)).toEqual(["github", "bitbucket"]);

bitbucket.failNext(new Error("timeout"));
const partial = yield* service.list({ state: "open", involvement: "all", forceRefresh: true });
expect(partial.entries.some(({ provider }) => provider === "github")).toBe(true);
expect(partial.errors).toContainEqual(expect.objectContaining({ provider: "bitbucket" }));
```

Add reviewing/authored exclusion, provider-aware deduplication, GitHub failure with Bitbucket success, cached Bitbucket preservation on auth expiry, explicit disconnect cache clearing, and stale-pin preservation.

- [ ] **Step 2: Run aggregate tests and observe missing registration/aggregation failures**

Run: `bun run --cwd apps/server test src/pullRequests/Layers/PullRequestService.test.ts src/pullRequests/pullRequestOperations.test.ts`

Expected: FAIL on mixed-provider cases.

- [ ] **Step 3: Aggregate providers with isolated concurrency and errors**

```ts
const batches = yield* Effect.forEach(
  repositories,
  ({ repository, projects }) => loadProviderBatch(repository, projects, input),
  { concurrency: 6 },
);
return combineProviderBatches(batches, { preserveCachedFailures: true });
```

Do not use one provider's viewer value to classify the other. `reviewRequestCount` invokes only providers that support known review-request identity; Bitbucket contributes neither count nor a global failure. When an eligible local Bitbucket remote cannot load because Paraty MCP needs connection, return one deduplicated `providerRequirements` entry rather than one repository error per project.

- [ ] **Step 4: Route detail/diff by explicit provider and validate the local remote**

```ts
const repository = yield* validateProjectRepository(project, {
  provider: input.provider,
  displayName: input.repository,
});
const provider = yield* providerRegistry.require(input.provider, repository);
return yield* provider.detail({ project, repository, number: input.number });
```

Reject a fabricated Bitbucket identity if the project does not have the matching canonical local remote.

- [ ] **Step 5: Enforce mutation capability before dispatch**

```ts
if (!provider.action || !capabilities.stateMutation) {
  return yield* Effect.fail(new PullRequestCapabilityError({
    provider: input.provider,
    capability: input.action === "merge" ? "merge" : "stateMutation",
  }));
}
```

Define `PullRequestCapabilityError` in `Errors.ts` as an Effect Schema tagged error with `provider` and `capability`, then apply the same gate to comments. Ensure a fabricated Bitbucket action/comment fails before any MCP tool invocation.

- [ ] **Step 6: Compose the Bitbucket provider with the shared outbound connection service**

Reuse the exact `outboundMcpLayer` instance from phase 1 in `serverLayers.ts`, provide it to `ParatyBitbucketPullRequestProviderLive`, and register both adapters in the PR layer.

- [ ] **Step 7: Verify aggregate and mutation safety**

Run: `bun run --cwd apps/server test src/pullRequests src/persistence/Layers/ProjectPullRequestPins.test.ts`

Expected: PASS, including zero write-tool calls for every Bitbucket mutation test.

- [ ] **Step 8: Commit mixed-provider orchestration**

```bash
git add apps/server/src/pullRequests apps/server/src/serverLayers.ts
git commit -m "feat(pr): aggregate GitHub and Bitbucket [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 7: Mixed-provider list UX and connection prompt

**Files:**
- Create: `apps/web/src/components/pullRequest/PullRequestProviderBadge.tsx`
- Create: `apps/web/src/components/pullRequest/pullRequestCapabilities.ts`
- Test: `apps/web/src/components/pullRequest/pullRequestCapabilities.test.ts`
- Modify: `apps/web/src/components/pullRequest/PullRequestRow.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestRow.browser.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestDiffStat.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestList.tsx`
- Modify: `apps/web/src/components/pullRequest/pullRequestList.logic.ts`
- Modify: `apps/web/src/components/pullRequest/pullRequestList.logic.test.ts`
- Modify: `apps/web/src/routes/_chat.pull-requests.index.tsx`
- Modify: `apps/web/src/lib/pullRequestReactQuery.ts`

**Interfaces:**
- Consumes provider-aware contracts and outbound MCP status.
- Produces accessible provider badges, provider-safe row fields, and one restrained Paraty connection prompt.
- Keeps search/project/state filters across both providers while involvement filters exclude Bitbucket.

- [ ] **Step 1: Write failing row/filter/capability tests**

```ts
expect(filterPullRequests([bitbucketEntry], { involvement: "all" })).toHaveLength(1);
expect(filterPullRequests([bitbucketEntry], { involvement: "reviewing" })).toHaveLength(0);
expect(filterPullRequests([bitbucketEntry], { involvement: "authored" })).toHaveLength(0);
expect(visibleRowFields(bitbucketEntry).showDiffStats).toBe(false);
```

Browser test: render a GitHub and Bitbucket row, assert visible accessible text “GitHub”/“Bitbucket”, ensure absent additions/deletions for Bitbucket, and verify row selection includes provider in the URL.

- [ ] **Step 2: Run focused list tests and observe provider-key/UI failures**

Run: `bun run --cwd apps/web test src/components/pullRequest/pullRequestList.logic.test.ts src/components/pullRequest/pullRequestCapabilities.test.ts && bun run --cwd apps/web test:browser src/components/pullRequest/PullRequestRow.browser.tsx`

Expected: FAIL before provider-safe rendering is added.

- [ ] **Step 3: Centralize capability decisions**

```ts
export function visibleRowFields(entry: PullRequestListEntry) {
  return {
    showDiffStats: entry.additions !== null && entry.deletions !== null,
    showChecks: entry.capabilities.checks,
    showDraft: entry.provider === "github" && entry.isDraft,
  };
}
```

All list/detail components call these helpers rather than checking `provider` independently, except provider badge/icon copy.

- [ ] **Step 4: Add provider identity to query and selection keys**

```ts
const detailKey = ["pull-requests", "detail", provider, repository, number] as const;
const rowKey = `${entry.provider}:${entry.repository}#${entry.number}`;
```

Update pin mutation coordination, detail prefetch, route search serialization, and row React keys.

- [ ] **Step 5: Render one eligible-project connection prompt**

When the result reports at least one eligible Bitbucket remote and outbound Paraty status is disconnected/reconnect-required, render one prompt above partial results. Its action navigates to Settings → Integrations; do not emit one repository error card per project.

```tsx
<PullRequestsUnavailableState
  title="Connect Paraty MCP for Bitbucket pull requests"
  actionLabel="Open integrations"
  onAction={openIntegrations}
/>
```

- [ ] **Step 6: Verify list UX, state filters, and GitHub regression**

Run: `bun run --cwd apps/web test src/components/pullRequest/pullRequestList.logic.test.ts src/lib/pullRequestReactQuery.query.test.ts src/lib/pullRequestReactQuery.pin.test.ts && bun run --cwd apps/web test:browser src/components/pullRequest/PullRequestRow.browser.tsx`

Expected: PASS. Existing GitHub stats/check/draft presentations remain unchanged.

- [ ] **Step 7: Commit mixed-provider list UX**

```bash
git add apps/web/src
git commit -m "feat(pr): show Bitbucket in pull request lists [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 8: Read-only Bitbucket detail, comments, and diff UX

**Files:**
- Modify: `apps/web/src/components/pullRequest/PullRequestDetailPanel.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestCodeTab.tsx`
- Modify: `apps/web/src/components/pullRequest/PullRequestCommentCard.tsx`
- Modify: `apps/web/src/components/pullRequest/pullRequestDetail.logic.ts`
- Modify: `apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts`
- Test: `apps/web/src/components/pullRequest/PullRequestDetailPanel.browser.tsx`

**Interfaces:**
- Consumes normalized Bitbucket detail/comments/diff and capability helpers.
- Produces summary/code/timeline tabs only when supported.
- Omits every unsupported Bitbucket mutation control.

- [ ] **Step 1: Write failing detail action-visibility tests**

```ts
const model = buildPullRequestDetailModel(bitbucketDetail);
expect(model.tabs).toEqual(["summary", "code", "timeline"]);
expect(model.actions).toEqual([]);
expect(model.showCommentComposer).toBe(false);
expect(model.showResolveControls).toBe(false);
expect(model.showMergeability).toBe(false);
```

Browser assertions must confirm the absence of Merge, Close, Reopen, Ready for review, Convert to draft, Add comment, and Resolve buttons while comments and unified diff remain visible.

- [ ] **Step 2: Run detail tests and observe unsupported-control failures**

Run: `bun run --cwd apps/web test src/components/pullRequest/pullRequestDetail.logic.test.ts && bun run --cwd apps/web test:browser src/components/pullRequest/PullRequestDetailPanel.browser.tsx`

Expected: FAIL before capability-driven rendering.

- [ ] **Step 3: Drive sections/actions only from effective capabilities**

```tsx
{detail.capabilities.comment ? <PullRequestCommentComposer detail={detail} /> : null}
{detail.capabilities.merge ? <MergeControls detail={detail} /> : null}
{detail.capabilities.checks && detail.checks ? <ChecksSection checks={detail.checks} /> : null}
```

Do not render disabled placeholders for missing capabilities. Preserve stale cached content and show Reconnect when an auth-expiry error accompanies cached Bitbucket data.

- [ ] **Step 4: Render bounded comments and diff truncation honestly**

Show comment author/body/timestamp plus inline path/line where present. Show an incomplete/truncated note when the server flags it. Pass the MCP patch into the existing `@pierre/diffs` flow and retain the existing diff color/wrap preferences.

- [ ] **Step 5: Verify GitHub controls and Bitbucket read-only presentation together**

Run: `bun run --cwd apps/web test src/components/pullRequest/pullRequestDetail.logic.test.ts src/components/pullRequest/pullRequestComment.logic.test.ts src/lib/pullRequestReactQuery.action.test.ts src/lib/pullRequestReactQuery.comment.test.ts && bun run --cwd apps/web test:browser src/components/pullRequest/PullRequestDetailPanel.browser.tsx`

Expected: PASS. GitHub mutation tests remain green; Bitbucket browser fixture exposes no mutation control.

- [ ] **Step 6: Commit read-only detail UX**

```bash
git add apps/web/src/components/pullRequest apps/web/src/lib
git commit -m "feat(pr): render read-only Bitbucket details [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 9: End-to-end `payment-seeker` acceptance and final verification

**Files:**
- Create: `apps/server/src/pullRequests/paratyBitbucket.e2e.test.ts`
- Create: `apps/web/src/components/pullRequest/ParatyBitbucketFlow.browser.tsx`
- Modify: `apps/server/src/outboundMcp/testing/fakeMcpAuthority.ts`
- Modify: `docs/superpowers/plans/2026-08-31-bitbucket-pull-request-provider.md` (check completed boxes during execution only)

**Interfaces:**
- Uses the phase-1 fake OAuth/MCP authority with the four Paraty-shaped tools.
- Proves discovery of a local `payment-seeker` remote, OAuth, mixed listing, detail, comments, diff, expiry, reconnect, disconnect, and write rejection.

- [ ] **Step 1: Extend the fake MCP authority with Paraty-shaped read fixtures**

```ts
const paymentSeeker = {
  workspace: "paraty",
  repository: "payment-seeker",
  pullRequest: { id: 42, state: "OPEN", title: "Read-only MCP acceptance" },
};
```

Register only `paraty_bitbucket_pr_list`, `paraty_bitbucket_pr_get`, `paraty_bitbucket_pr_diff`, and `paraty_bitbucket_pr_comment_list`. Record every invocation for assertions.

- [ ] **Step 2: Write the server acceptance flow**

```ts
yield* fakeGit.configureRemote(
  project.workspaceRoot,
  "origin",
  "git@bitbucket.org:paraty/payment-seeker.git",
);
const before = yield* pullRequests.list({ state: "open", involvement: "all" });
expect(before.providerRequirements).toContainEqual(expect.objectContaining({ presetId: "paraty" }));
yield* authorizeParatyFixture();
const after = yield* pullRequests.list({ state: "open", involvement: "all", forceRefresh: true });
expect(after.entries).toContainEqual(expect.objectContaining({ provider: "bitbucket", number: 42 }));
```

Load detail, comments, and diff; fabricate comment/action calls and assert capability errors plus zero write-tool invocations. Expire the token and assert cached Bitbucket + GitHub data remains. Explicitly disconnect and assert Bitbucket cache clears while GitHub remains.

- [ ] **Step 3: Write the browser acceptance flow**

Render the query/API fixture from disconnected through connected. Verify one connection prompt, mixed provider rows, state tabs, Bitbucket exclusion from Reviewing/Authored, readable summary/comments/diff, truncation note, and no mutation controls.

- [ ] **Step 4: Run all focused feature suites**

Run: `bun run --cwd apps/server test src/outboundMcp src/pullRequests src/persistence/Layers/ProjectPullRequestPins.test.ts src/persistence/Migrations.test.ts && bun run --cwd packages/contracts test src/outboundMcp.test.ts src/pullRequests.test.ts && bun run --cwd packages/shared test src/remoteRepository.test.ts && bun run --cwd apps/web test src/components/pullRequest src/lib/pullRequestReactQuery.query.test.ts src/lib/pullRequestReactQuery.action.test.ts src/lib/pullRequestReactQuery.comment.test.ts src/lib/pullRequestReactQuery.pin.test.ts && bun run --cwd apps/web test:browser src/components/pullRequest/ParatyBitbucketFlow.browser.tsx`

Expected: PASS.

- [ ] **Step 5: Perform the manual isolated-instance acceptance**

Dry run first:

```bash
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 bun run dev -- --home-dir ./.synara-bitbucket-pr --port 58090 --dry-run
lsof -nP -iTCP:58090 -sTCP:LISTEN
lsof -nP -iTCP:61248 -sTCP:LISTEN
```

Then start the isolated instance with `SYNARA_NO_BROWSER=1`, add the existing `payment-seeker` folder, connect Paraty MCP through Settings, and execute the nine acceptance steps in the design spec. Do not use the default Synara ports or home directory.

- [ ] **Step 6: Run the authorized final quality gate**

Only after the user explicitly authorizes heavyweight checks, run once:

```bash
bun fmt
bun lint
bun typecheck
```

Then run `bun run test`. Compare any full-suite failures with the recorded pre-feature baseline (48 failed web tests, 4138 passing); focused feature suites must remain green regardless.

- [ ] **Step 7: Review the complete branch**

Use `changes-review`, `paraty-security`, `backend-architecture`, and `ux-design-reviewer`. Fix every relevant finding, rerun the smallest affected focused tests, and run `git diff --check`.

- [ ] **Step 8: Commit acceptance coverage**

```bash
git add apps/server/src apps/web/src docs/superpowers/plans/2026-08-31-bitbucket-pull-request-provider.md
git commit -m "test(pr): verify Paraty Bitbucket MCP flow [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

- [ ] **Step 9: Prepare integration handoff without pushing**

Confirm `git status --short --branch`, inspect the commit range against `origin/nacho/integration`, and summarize focused/full verification. Ask the user before any push or PR creation. The first PR target is `nacho/integration`, never `main` directly.
