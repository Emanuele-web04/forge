# Synara Roadmap Execution Controller

> **Purpose:** Keep execution prompts small. This file controls progress; the detailed,
> evidence-backed specification remains in
> [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md).
>
> **Planned at:** commit `5056e395e`, 2026-07-14.

## Active goal and objective

**Goal:** Implement every remaining row in the consolidated 17-workstream roadmap, in dependency
order, then sweep only those changes. Preserve the authoritative dirty worktree and do not reopen the
original 206-finding audit or add P4/P5 scope.

**Objective:** Finish the remaining release, desktop-security, Git, settings, automation, ACP,
web-state, and provider-metadata authorities. Keep each row on one canonical ownership path, delete
replaced implementations, use focused verification during implementation, and perform one final sweep
after all rows are code-complete.

- Do not open a new roadmap workstream or add a compatibility/fallback path.
- Every runtime phase must delete more LOC than it adds; migrations/recovery are the only exception.
- Preserve tests that prove invariants, but merge redundant fixtures and avoid broad scaffolding.
- ACP work is boundary/deletion planning first; no new `effect-acp` protocol ownership.
- After each pruning phase, record the removed authority, net runtime LOC, focused evidence, and next
  deletion target in this controller and the owning audit finding.

## Source of truth

- `AGENTS.md` owns repository rules.
- [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md)
  owns each workstream's evidence, scope, acceptance criteria, STOP
  conditions, dependency graph, and deferred/rejected decisions.
- This file owns execution order, current status, and the next eligible workstream.
- The dirty worktree is authoritative. Never revert or recreate existing changes.

Do not copy the full audit into a prompt. Before working on an item, read only:

1. `AGENTS.md`;
2. this controller;
3. the active workstream in
   [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md);
4. the dependency/order section of
   [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md)
   when needed;
5. the live code and existing diff in that workstream's scope.

## Current pointer

- **State:** `CODE COMPLETE`
- **Active workstream:** none; the shortened 17-workstream controller is implemented.
- **Active phase:** the ACP compatibility-package deletion is implemented. Focused ACP/provider
  gates, conformance, server build, benchmark smoke, and residual checks pass; heavyweight workspace
  verification remains deferred by instruction.
- **Phase boundary:** only the existing 17-workstream controller is in scope. No audit expansion,
  P4/P5 work, or unrelated product roadmap additions.

## Working rules

- Work on one authority/subsystem at a time.
- Do not reopen the audit or add P4/P5 work.
- Preserve behavior unless the active finding explicitly changes it.
- Consolidate duplicated ownership; do not add permanent old/new paths.
- Split large workstreams into reviewable phases under the same ID.
- Do not run builds or broad test suites.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` without explicit authorization.
- Use only the smallest targeted test/check set when necessary; otherwise record verification as
  deferred. Never run `bun test`; use `bun run test` when a targeted test is authorized.
- Do not install dependencies, commit, stage, push, reset, clean, or rebase unless asked.
- Preserve unrelated user changes in the dirty worktree.
- Do not run overlapping implementation agents in the same checkout.
- State the exact existing path being removed or consolidated before each edit.
- Require net-negative runtime LOC for every pruning phase.
- Stop rather than improvise if a migration risks data loss, accepted provider work may be
  duplicated/lost, a destructive Git action lacks exact identity, or scope crosses into an
  unrelated authority.

## Status meanings

- `TODO`: not started.
- `IN PROGRESS`: a bounded implementation phase is active.
- `CODE COMPLETE`: code and direct inspection are complete; heavyweight verification is
  deferred.
- `DONE`: acceptance criteria and the permitted verification evidence are complete.
- `BLOCKED`: include a one-line blocker and do not work around it implicitly.
- `REJECTED`: current code/evidence proves the workstream is no longer valuable.

## Execution order and status

| Order | Workstream               | Outcome                                                          | Depends on                                                         | Status                                                                                                                                            |
| ----: | ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
|     0 | Reconcile dirty worktree | Map partial implementations; avoid duplicate authorities         | —                                                                  | DONE                                                                                                                                              |
|     1 | `P0-REL-01`              | Fail-closed exact-source release/update authority                | Reconcile                                                          | CODE COMPLETE                                                                                                                                     |
|     2 | `P0-SEC-01`              | Server-only provider secrets and minimal child capabilities      | Reconcile                                                          | CODE COMPLETE                                                                                                                                     |
|     3 | `P0-SEC-02`              | Pinned credential-bearing outbound HTTP authority                | `P0-SEC-01` where credentials move                                 | CODE COMPLETE                                                                                                                                     |
|     4 | `P1-PERSIST-01`          | One durable SQLite/projection/migration/recovery authority       | Reconcile                                                          | CODE COMPLETE                                                                                                                                     |
|     5 | `P1-IDENTITY-01`         | Composite command/message/interaction identity                   | Persistence migration boundary stable                              | CODE COMPLETE                                                                                                                                     |
|     6 | `P1-PROVIDER-01`         | One per-thread provider lifecycle/turn/process owner             | Thread-scoped identity phases 1-3                                  | CODE COMPLETE                                                                                                                                     |
|     7 | `P1-RUNTIME-01`          | Bounded pipelines and staged shutdown                            | `P1-PROVIDER-01` lifecycle contract                                | CODE COMPLETE                                                                                                                                     |
|     8 | `P1-TRANSPORT-01`        | Cursor-safe live transport, compatibility, and request admission | `P1-PERSIST-01`, `P1-RUNTIME-01`                                   | CODE COMPLETE                                                                                                                                     |
|     9 | `P1-DELIVERY-01`         | Crash-recoverable accepted intent/output delivery                | `P1-IDENTITY-01`, `P1-PROVIDER-01`, `P1-RUNTIME-01`                | CODE COMPLETE                                                                                                                                     |
|    10 | `P1-FILE-01`             | Finish the exact-owner managed attachment lifecycle              | `P1-PERSIST-01`                                                    | CODE COMPLETE                                                                                                                                     |
|    11 | `P1-DESKTOP-SEC-01`      | Generation-scoped browser/native-control boundary                | `P0-SEC-01`, `P1-PROVIDER-01`                                      | CODE COMPLETE — unsupported Windows pipe fails closed                                                                                             |
|    12 | `P1-GIT-01`              | Canonical repository mutation/worktree saga                      | `P1-DELIVERY-01` where accepted work crosses workspace preparation | CODE COMPLETE — migration 68 journals handoff phases; stored Git results replay before command readiness and pre-result interruptions fail closed |
|    13 | `P1-SETTINGS-01`         | Revisioned settings/provider configuration authority             | `P0-SEC-01`, `P1-PROVIDER-01`                                      | CODE COMPLETE — server owns serialized intent commits; no client CAS path remains                                                                 |
|    14 | `P1-AUTO-01`             | One revision-fenced automation run saga                          | `P1-DELIVERY-01`, `P1-PROVIDER-01`, `P1-SETTINGS-01`               | CODE COMPLETE — bounded keyset recovery and one web summary subscription owner                                                                    |
|    15 | `P2-ACP-01`              | Official ACP SDK production wire authority                       | `P1-PROVIDER-01`, `P1-RUNTIME-01`                                  | CODE COMPLETE — official SDK is the sole standard type/wire authority; the residual compatibility package is deleted                              |
|    16 | `P2-WEB-STATE-01`        | Normalized frontend entity and persistence authority             | `P1-IDENTITY-01`, `P1-TRANSPORT-01`                                | CODE COMPLETE — normalized slices are the only runtime thread authority                                                                           |
|    17 | `P2-PROVIDER-META-01`    | One provider metadata/discovery/health/usage descriptor          | `P0-SEC-01`, `P1-SETTINGS-01`                                      | CODE COMPLETE — descriptor order, revision-fenced health, and account-safe usage ownership                                                        |

Independent items may be reordered only when their dependencies and the audit's
"must not run concurrently" rules remain satisfied.

## Short-list pruning checkpoint (2026-07-14)

No roadmap scope was added. The checkpoint changed only the seven existing rows:

- `P1-DESKTOP-SEC-01`: private random pipe leases, lease-owned tabs/CDP events, bounded clients and
  output, correct browser partition permission denial, denied custom schemes, and sandboxed SVG
  responses. Windows now publishes neither a pipe nor its environment capability until an explicit
  per-user ACL implementation exists; unreachable Windows socket branches were deleted. Phase runtime
  change: **-3 LOC**. Focused evidence: **20/20** desktop/server tests, including the 5/5 pipe helper
  gate in this phase.
- `P1-GIT-01`: one canonical-common-dir mutation coordinator now wraps mutating RPC ingress and the
  existing handoff/PR/stack sagas; stash deletion requires the inspected exact ref. Status and
  numstat now use Git's NUL machine protocol, deleting the quoted-path/rename heuristics (**-3 runtime
  LOC**). The handoff RPC now carries thread/command identity and commits the existing durable
  `thread.meta.update` server-side, deleting the browser's second dispatch, optimistic write, forced
  snapshot, and duplicated request shape (approximately **-4 runtime LOC**). Focused evidence:
  **4/4** mutation/saga tests, **1/1** adversarial-filename status test, and **12/12** handoff
  contract/manager/query tests. Migration 68 now owns the handoff lifecycle: retries reuse stored Git
  results, startup replays `git_applied` metadata, and pre-result interruptions become explicit
  `uncertain` rows instead of rerunning Git. The focused recovery test passes **1/1**; RPC/server
  module imports and the scoped diff check pass.
- `P1-SETTINGS-01`: persisted revision/migration envelope, invalid-file quarantine, atomic commit,
  disk re-read under the write lock, and server-resolved provider launch settings. Focused evidence:
  **4/4** settings tests. Client contracts carry patches rather than revisions, so there is no second
  CAS authority to delete; provider presentation mappings are owned by `P2-PROVIDER-META-01`.
- `P1-AUTO-01`: run insertion and iteration-cap reservation are one transaction; permission snapshots
  capture settings revision and server-resolved options. Dispatchable schedule advancement and
  one-shot disable now share that transaction, including deduped crash recovery; six result tails and
  cancellation use one terminal owner. Recovery exception: approximately **+2 runtime LOC**. Focused
  evidence: prior **113/113** sweep plus **10/10** terminal/schedule gates. Recovery now traverses
  bounded 200-row keyset pages, including the 201st-row integration gate, and the route-level event
  subscription was deleted in favor of the existing sidebar/cache owner. Additional focused evidence:
  **3/3** recovery gates and **32/32** automation UI tests.
- `P2-ACP-01`: the official TypeScript SDK owns framing, JSON-RPC dispatch/correlation, validation,
  and cancellation for Grok, Droid, and Cursor; runtime/event queues are bounded and resume/load no
  longer falls back to a new session. The deprecated constructor and legacy production wire branch
  are deleted; explicit extensions use SDK parsers and raw logging wraps bytes without a second
  parser. The mock agent now uses the official SDK too. The private `effect-acp` client, agent,
  protocol, RPC, terminal, stdio helpers, tests, examples, fixtures, generated compatibility schema,
  and workspace package are deleted. `AcpErrors.ts` and `AcpExtensions.ts` retain only Synara-owned
  runtime policy and non-standard extension decoding. Focused evidence: prior **40/40** and **48/48**
  sweeps plus the current **168/168** ACP/provider gates.
- `P2-WEB-STATE-01`: normalized slices are the only runtime thread authority. The derived `threads`
  property, every transition-side synchronization branch, and the one-way legacy-fixture gate were
  deleted; the two remaining production reads use the existing cached derivation helper. Phase
  runtime change: approximately **-70 LOC**. Focused evidence: prior **212/212** sweep plus **96/96**
  store/selector tests after deletion.
- `P2-PROVIDER-META-01`: one exhaustive shared descriptor owns provider order, display labels,
  picker availability, settings visibility, and usage presentation/support. Three remaining web
  order arrays and the unsafe provider/home usage TTL cache were deleted; health completion checks
  the existing settings revision before publication. Phase runtime change: approximately **-55
  LOC**. Focused evidence: **10/10** ordering/handoff/skills tests and **92/92** provider health/usage
  tests.

Prior sweep: `git diff --check` and residual-ownership searches pass. Focused regression gates pass
**439/439** (server 296, web 138, desktop 5). The repository-wide dirty diff remains large and is not
claimed as net-negative: tracked diff is **+23,908 / -9,254 (net +14,654)**. The shortened checklist
is code-complete except for the Git process-crash durability phase; this
checkpoint does not hide that blocker or create a replacement workstream.

Net-negative consolidation closeout: shared ACP locks, settlement, plan dedupe, logging, and image
attachment loading replace provider-local copies; `wsNativeApi` owns one listener registry/reset
path; three browser files share only their identical server/host fixtures. Runtime-source change for
this closeout is **+426 / -2,943 (net -2,517 LOC)**; total code change including retained tests and
the official mock agent is approximately **net -4,590 LOC**. Focused gates pass **48/48 server** and
**29/29 web unit**. The browser rerun exposed and fixed the missing registry reset operation, then hit
the existing incomplete WebSocket welcome fixture (`protocolEpoch` missing); no replacement scaffold
was added. The residual `effect-acp` schema/error compatibility layer is now deleted. The separately
recorded stdout backpressure gate remains open.

## Dirty worktree reconciliation

- Existing managed-attachment migration/store/cleanup work belongs to `P1-FILE-01`; finish
  that authority before creating any separate file ledger.
- The unnumbered/unregistered delivery migration scaffold and repositories belong to
  `P1-DELIVERY-01`; do not activate or duplicate them before identity/lifecycle/runtime dependencies.
- ACP protocol/conformance changes belong to `P2-ACP-01`; keep them dormant until the
  provider lifecycle and bounded-runtime contracts are stable.
- Existing authentication, WebSocket admission, workspace safety, dependency, frontend,
  and provider changes are preserved under their owning workstreams.
- `P0-REL-01` phase 1 now owns the dirty release workflow/smoke/updater-security diff. Dirty
  package manifests and `bun.lock` are pre-existing dependency remediation and must not be
  rewritten by the release phases.

## Pruning checkpoint progress

- Roadmap expansion is frozen; unopened TODO rows remain frozen.
- The phase-by-phase diary was deleted because it duplicated evidence owned by
  [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md).
- Active deletion targets, in order: duplicated provider/orchestration ownership in the five hotspot
  files; redundant focused-test scaffolding; then the official ACP SDK canary boundary and its exact
  custom-wire deletion map.
- Record only completed pruning phases here: removed path, net runtime LOC, focused evidence, and next
  deletion target.
- `PRUNE-01` — `ProviderCommandReactor` approval/user-input settlement no longer performs a direct
  thread projection read immediately before `resolveProviderSessionThread` repeats the same read. The
  approval error branch also dropped its dead generator tail and repeated stale-error classification.
  Net runtime change: **-8 LOC**. Focused interaction gates pass 2/2. Next: merge the remaining shared
  approval/user-input claim and failure-envelope ownership without changing settlement behavior.
- `PRUNE-02` — the duplicated approval and user-input durable claim, idempotent replay check,
  provider-thread resolution, stopped-session settlement, and activity envelope now have one in-file
  owner. Only the two provider-specific response calls remain separate. Net runtime change:
  **-18 LOC**. Focused approval/user-input claim, forwarding, and stopped-session gates pass 6/6.
  Next: remove duplicated durable-source replay/claim branching without weakening exact-once evidence.
- `PRUNE-03` — the durable source no longer repeats the replay-safe/external claimed-intent expression
  across ordered delivery, quarantine replay, and operator retry. The overlapping external-claim alias
  was replaced by one claimed-intent classifier while replay safety remains separately classified for
  expiry handling. Net runtime change: **-7 LOC**. Focused durable-delivery classification gates pass
  5/5. Next: inspect runtime ingestion for competing replay/live drain ownership and delete only an
  evidenced duplicate path.
- `PRUNE-04` — immediate journal draining and recovery polling remain separate because they have
  different latency/recovery duties. The actual duplicate in runtime ingestion was the synthetic
  `turn.started` construction and buffered-message flush repeated by Codex steer and ordinary request
  matching; both now share one tail without a new helper. Net runtime change: **-14 LOC**. Focused
  streaming, same-thread ordering, and Codex steer gates pass 3/3. Next: inspect `ProjectionPipeline`
  for repeated projection application ownership.
- `PRUNE-05` — `ProjectionPipeline.projectEvent` no longer implements a third copy of hot/deferred
  projector selection and environment provisioning. It composes the existing `projectHotEvent` and
  `projectDeferredEvent` paths while retaining their separate transactions, then advances snapshot
  cursors. Net runtime change: **-13 LOC**. Focused rollback, attachment-side-effect, and destructive
  history gates pass 3/3. Next: inspect `ProviderService` for overlapping session/provider ownership.
- `PRUNE-06` — approval and structured user-input responses no longer own parallel copies of route
  resolution, active-runtime validation, lifecycle-generation fencing, and lifecycle lock scope in
  `ProviderService`. One in-file interaction path owns those invariants; adapter payloads and approval
  analytics remain variant-specific. Net runtime-path change: **-26 LOC**. Focused Claude, Gemini,
  ACP/Droid, and Pi interaction-generation gates pass 4/4. Next: inspect `wsRpc` for duplicated RPC
  admission/dispatch ownership.
- `PRUNE-07` — fourteen Git mutation RPC handlers no longer each own a copy of the same best-effort
  status-refresh tail. One in-file wrapper preserves the original cause-swallowing refresh policy
  while each Git operation and RPC error remains unchanged. Net runtime change: **-4 LOC**. Existing
  wsRpc authentication/negotiation integration gates pass 6/6; the repo has no focused Git-handler RPC
  test, and no scaffold was added. Cumulative pruning runtime change: **-90 LOC**. Next: document the
  official ACP SDK canary boundary and exact custom-wire deletion map without changing runtime code.
- `PRUNE-08` — ACP boundary documentation is now exact. The seam is the existing
  `AcpSessionRuntime` wire-construction point; Grok is a static no-fallback canary; provider adapters
  keep the existing runtime shape; and the final cutover deletes the complete `packages/effect-acp`
  package (about 13,123 non-test source/generator LOC), production imports, legacy conformance block,
  dependency, and lock entry. No runtime ACP code changed. Next: continue net-negative deletion in an
  evidenced hotspot; do not begin the canary during this checkpoint.
- `PRUNE-09` — `ProviderService` no longer reads `SYNARA_PROVIDER_RUNTIME_IDLE_STOP_MS` twice through
  a nullish fallback to the exact same expression. Net runtime change: **-2 LOC**. Direct inspection
  and `git diff --check` prove value equivalence; no test scaffold was added. Cumulative pruning runtime
  change: **-92 LOC**. Next: continue with an evidenced duplicate inside an existing hotspot.
- `PRUNE-10` — eight pinned-message and thread-marker projector cases no longer repeat the same
  repository load, missing-row exit, and upsert protocol. One in-file `updateThreadProjection` owner
  preserves separate payload transforms while deleting the repeated persistence shell. Net runtime
  change: **-60 LOC**. Focused pinned-message/marker round-trip gates pass 2/2. Cumulative pruning
  runtime change: **-152 LOC**. Next: reuse the proven owner only for remaining simple thread-row
  mutations; keep async turn-start/meta logic separate.
- `PRUNE-11` — runtime-mode, interaction-mode, soft-delete, archive, and unarchive projection cases
  now reuse the same existing-row update owner. Attachment cleanup still registers before soft-delete;
  async metadata, turn-start, and deferred-summary paths remain independent. Net runtime change:
  **-38 LOC**. Focused runtime-mode and thread-delete cleanup gates pass 2/2. Cumulative pruning runtime
  change: **-190 LOC**. Next: inspect another hotspot for a similarly exact repeated ownership shell.
- `PRUNE-12` — `ProviderService.runStopAll` no longer persists active sessions once through the live
  session path and again through the persisted-thread path. One stopped-binding owner now writes the
  union of persisted and active thread ids once, retaining the richer live-session payload when
  available. Net runtime change: **-2 LOC**. The focused stopped-binding/adapter-cleanup gate passes
  1/1. Cumulative pruning runtime change: **-192 LOC**. Next: continue only where another existing
  hotspot path can be deleted or merged without adding an abstraction.
- `PRUNE-13` — approval and structured user-input handlers no longer repeat the null-command guard
  already owned by `claimInteractionResponse`; a non-null provider thread id proves that guard passed.
  Net runtime change: **-2 LOC**. Both focused interaction-forwarding gates pass 2/2. Cumulative
  pruning runtime change: **-194 LOC**. Next: continue deletion-only inspection of the same hotspots.
- `PRUNE-14` — the three turn-dispatch methods no longer maintain an `adapterReturned` flag that was
  captured as `false` when their finalizer was constructed and therefore could never affect cleanup.
  `finishTurnDispatch` now expresses that actual retained-result condition directly. Net runtime
  change: **-7 LOC**. Focused newer-owner and older-success-promotion gates pass 2/2. Cumulative
  pruning runtime change: **-201 LOC**. Next: inspect exact duplicate payload/projection ownership;
  do not generalize the dispatch API during this checkpoint.
- `PRUNE-15` — `ProviderRuntimeIngestion` now owns one activity-row constructor for item started,
  updated, and completed tool lifecycle events; the existing update/completion context-compaction
  variants remain in the same branch. Net runtime change: **-55 LOC**. Focused compaction progress and
  terminal gates pass 2/2. Two broader tool-lifecycle harness cases time out before reaching the
  mapper and remain deferred evidence; no scaffold was added. Cumulative pruning runtime change:
  **-256 LOC**. Next: continue only with mechanically provable deletion in an existing hotspot.
- `PRUNE-16` — activity-history projection for revert and conversation rollback now shares one
  load/empty/delete/reinsert path while retaining separate row-selection rules. Net runtime change:
  **-18 LOC**. Existing destructive-history integration gates pass 3/3; no activity-only fixture was
  added. Cumulative pruning runtime change: **-274 LOC**. Next: inspect the adjacent message/plan
  history branches for the same exact replacement ownership without introducing a generic layer.
- `PRUNE-17` — proposed-plan history projection now shares one repository replacement path for revert
  and conversation rollback while retaining the existing turn-count and removed-turn-id selectors.
  Net runtime change: **-20 LOC**. Direct branch inspection and `git diff --check` are the available
  evidence; the repository has no focused proposed-plan destructive-history fixture, and none was
  added. Cumulative pruning runtime change: **-294 LOC**. Next: inspect another exact duplicate owner;
  keep message history separate unless attachment side effects can remain explicit.
- `PRUNE-18` — message-history projection now shares one delete/reinsert and retained-attachment path
  for revert and conversation rollback. Rollback's zero-turn exit and attachment-prune suppression,
  plus revert's turn-count selection, remain explicit. Net runtime change: **-11 LOC**. Focused revert,
  rollback, and managed/legacy attachment gates pass 3/3. Cumulative pruning runtime change:
  **-305 LOC**. Next: inspect exact turn-history replacement ownership or stop if event semantics do
  not permit a direct merge.
- `PRUNE-19` — turn-history projection now shares one load/delete/reinsert path for revert and
  conversation rollback. Revert still rebuilds unconditionally from checkpoint counts; rollback still
  exits on no change and restores valid pending turn starts. Net runtime change: **-15 LOC**. Existing
  destructive-history gates pass 3/3; no pending-turn rollback fixture exists, and none was added.
  Cumulative pruning runtime change: **-320 LOC**. Next: leave projection history consolidated and
  inspect another named hotspot for exact duplicate control flow.
- `PRUNE-20` — shell and thread cursor-safe RPC streams now reuse one orchestration high-water Effect
  and identical RPC error mapping; their snapshots, filters, and replay errors remain separate. Net
  runtime change: **-3 LOC**. Direct value/error equivalence and `git diff --check` are sufficient;
  no focused stream-constructor fixture exists. Cumulative pruning runtime change: **-323 LOC**.
  Next: inspect another exact duplicate in a named hotspot without generalizing RPC stream assembly.
- `PRUNE-21` — the two assistant-delivery `Ref.modify` callbacks now construct their cloned three-map
  next state once instead of rebuilding the identical envelope at five return sites. Matching, debt,
  and cache logic are unchanged. Net runtime change: **-25 LOC**. Focused same-thread ordering, Codex
  steer, and settled-unmatched-debt gates pass 3/3. Cumulative pruning runtime change: **-348 LOC**.
  Next: inspect another mechanically identical state/payload shell in a named hotspot.
- `PRUNE-22` — canonical request opened/resolved events now share one approval activity constructor;
  requested summary/detail and resolved summary/decision remain explicit variants. Net runtime change:
  **-19 LOC**. The focused canonical request lifecycle gate passes 1/1. Cumulative pruning runtime
  change: **-367 LOC**. Next: continue with an exact duplicated payload/control-flow shell only.
- `PRUNE-23` — first-turn branch and title rename fibers now share one message/model/provider input
  object; branch/worktree fields remain branch-only and both workflows remain separate. Net runtime
  change: **-4 LOC**. Focused title and temporary-worktree branch rename gates pass 2/2. Cumulative
  pruning runtime change: **-371 LOC**. Next: continue only with literal repeated ownership in a named
  hotspot.
- `PRUNE-24` — deferred non-streaming user-message shell timestamps now reuse the existing
  `updateThreadProjection` load/missing/upsert owner; the timestamp transform remains local and
  effectful summary rebuilds remain separate. Net runtime change: **-10 LOC**. Direct equivalence and
  `git diff --check` are the available evidence; the existing timestamp fixture covers only the
  unchanged streaming-assistant exit. Cumulative pruning runtime change: **-381 LOC**. Next: inspect
  another synchronous thread-row mutation or move to a different hotspot.
- `PRUNE-25` — synchronous thread metadata patches now reuse `updateThreadProjection`; sparse field
  updates and branch-change reset semantics remain inside the callback. Net runtime change: **-6
  LOC**. Direct branch equivalence and `git diff --check` are the available evidence; no focused
  metadata projection fixture exists. Cumulative pruning runtime change: **-387 LOC**. Next: leave
  effectful thread summary/turn-start paths separate and inspect another hotspot.
- `PRUNE-26` — zero-turn and provider-backed conversation rollback now converge on one completion
  command; provider interruption/rollback remains conditional on a positive turn count. Net runtime
  change: **-14 LOC**. Focused provider rollback and active-turn interruption gates pass 2/2; the
  zero-turn path has direct control-flow equivalence but no dedicated fixture. Cumulative pruning
  runtime change: **-401 LOC**. Next: continue only with a literal duplicate owner.
- `PRUNE-27` — three attachment ownership checks no longer retain a parsed thread-segment alias or a
  redundant falsy clause before the same string comparison. Net runtime change: **-3 LOC**. Direct
  comparison equivalence and `git diff --check` are sufficient; cleanup policies remain separate.
  Cumulative pruning runtime change: **-404 LOC**. Next: inspect another dead alias/duplicate branch in
  the named hotspots.
- `PRUNE-28` — pending-interaction requested, resolved, and response-failure activities now compute
  branch-specific rows and share one repository upsert/shell-count tail. Lifecycle, response-command,
  and settlement guards remain local. Net runtime change: **-16 LOC**. Focused approval and user-input
  projection gates pass 2/2. Cumulative pruning runtime change: **-420 LOC**. Next: inspect another
  duplicate persistence tail in a named hotspot.
- `PRUNE-29` — structured user-input requested/resolved events now share one activity constructor;
  questions and answers remain explicit payload variants. Net runtime change: **-18 LOC**. The focused
  request-and-resolution projection gate passes 1/1. Cumulative pruning runtime change: **-438 LOC**.
  Next: continue only where another event pair has the same row owner and simple payload variants.
- `PRUNE-30` — provider turn dispatch now reuses the first-turn message/model/provider payload already
  built for title/branch work; skills, mentions, runtime, review, and dispatch fields remain local.
  Net runtime change: **-9 LOC**. The focused normal turn-start/session/send gate passes 1/1.
  Cumulative pruning runtime change: **-447 LOC**. Next: inspect another local payload rebuilt within
  one execution path.
- `PRUNE-31` — provider start/restart and native fork alternatives now share one local thread/cwd/model/
  provider-options/runtime configuration; provider/resume and source-thread fields remain path-local.
  Net runtime change: **-3 LOC**. The focused normal start gate passes 1/1. The native Droid fork case
  is quarantined before session resolution and times out, so fork evidence remains deferred; no
  scaffold was added. Cumulative pruning runtime change: **-450 LOC**. Next: continue only with direct
  payload or control-flow convergence.
- `PRUNE-32` — the local provider-session starter no longer accepts an unused optional provider field
  or wrapper object; its only live argument is the optional resume cursor. Net runtime change: **-5
  LOC**. Focused fresh-start and idle-session-restart gates pass 2/2. A broader runtime-mode scenario
  completes its restart calls but later misses an unrelated durable event assertion and remains
  deferred. Cumulative pruning runtime change: **-455 LOC**. Next: inspect dead local API fields and
  unreachable guards only.
- `PRUNE-33` — three one-use ProviderService `bindingOption` aliases now feed directory reads directly
  into `Option.getOrUndefined`; the persisted-binding iterator remains separate. Net runtime change:
  **-3 LOC**. Direct expression equivalence and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-458 LOC**. Next: continue dead-alias inspection in named hotspots only.
- `PRUNE-34` — the keyed binding-lock constructor now returns its only consumed `withLock` function
  directly; its never-called `clear` compatibility surface and wrapper alias are deleted. Net runtime
  change: **-1 LOC**. Direct call-graph evidence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-459 LOC**. Next: inspect dormant local APIs and one-use aliases only.
- `PRUNE-35` — ProviderService no longer names the one-use requested-session boolean before its guard;
  the active-session lookup alias remains because it carries meaning. Net runtime change: **-1 LOC**.
  Direct guard equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change:
  **-460 LOC**. Next: continue only with dead local API or control-flow deletion.
- `PRUNE-36` — runtime turn-state, turn-error, and runtime-error readers no longer assign parsed
  payload values only to return them immediately. Net runtime change: **-3 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-463 LOC**.
  Next: continue one-use parsing/control-flow deletion in named hotspots.
- `PRUNE-37` — `resolveRoutableSession` no longer copies the caller's validated thread id into every
  result branch. Adapter calls and compact/rollback persistence use the existing input identity; route
  recovery, provider selection, active state, and lifecycle generation remain unchanged. Net runtime
  change: **-4 LOC**. Direct call-graph inspection and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-467 LOC**. Next: continue only with dead result fields or duplicated
  control-flow ownership in the named hotspots.
- `PRUNE-38` — the expected provider-turn reader no longer stores the full session list and its single
  matching session only to return `activeTurnId`; it returns the unchanged lookup directly. Net runtime
  change: **-1 LOC**. Direct expression equivalence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-468 LOC**. Next: stop micro-pruning when aliases carry domain meaning;
  continue only with dead result fields or literal duplicate ownership in the named hotspots.
- `PRUNE-39` — revert activity and proposed-plan retention no longer compute the same
  checkpoint-bounded turn-id set independently. One local selector owns that calculation while the
  row filters and repository paths remain separate. Net runtime change: **-2 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-470 LOC**.
  Next: continue only with another literal duplicated owner in the named hotspots.
- `PRUNE-40` — revert message retention no longer owns separate copies of the same fallback
  count/filter/slice/add branch for user and assistant roles. One ordered role loop preserves the user-
  then-assistant sequence and all retained-id and turn-id rules. Net runtime change: **-16 LOC**.
  Direct control-flow equivalence and `git diff --check` are sufficient. Cumulative pruning runtime
  change: **-486 LOC**. Next: inspect another literal duplicate in a named hotspot; do not generalize
  distinct recovery or provider-dispatch envelopes.
- `PRUNE-41` — queued-send and steer dispatch no longer rebuild the same thread, attachment, skill,
  mention, model, and interaction payload. One local input owns those fields while message text,
  retries, and the distinct provider methods remain path-local. Net runtime change: **-2 LOC**. Direct
  object-shape equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change:
  **-488 LOC**. Next: continue literal duplicate deletion without merging distinct retry/lifecycle
  envelopes.
- `PRUNE-42` — thread-title generation debug and failure logs no longer rebuild the same provider and
  model diagnostic fields. One local context owns the common fields while provider-option presence and
  failure reason remain record-specific. Net runtime change: **-5 LOC**. Direct object-shape
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-493 LOC**.
  Next: continue only with another literal duplicate owner in a named hotspot.
- `PRUNE-43` — branch/title generation no longer tests for an impossible raw `model` property or
  defensively probes the resolver's required `modelSelection`. Both paths now consume the existing
  typed `TextGenerationProviderInput` directly while retaining optional provider options. Net runtime
  change: **-15 LOC**. Focused first-turn title and temporary-worktree branch rename gates pass 2/2.
  Cumulative pruning runtime change: **-508 LOC**. Next: inspect dormant compatibility shape checks or
  literal duplicate ownership only.
- `PRUNE-44` — provider recovery no longer returns a session field its only caller ignores. Session
  validation, persistence, and analytics remain inside the lifecycle-locked helper, which now returns
  only the adapter consumed by routing. Net runtime change: **-1 LOC**. Direct call-graph inspection
  and `git diff --check` are sufficient. Cumulative pruning runtime change: **-509 LOC**. Next:
  continue dead result-surface or literal duplicate deletion in the named hotspots.
- `PRUNE-45` — request-first matching, turn-first matching, and thread cleanup no longer clone the
  same three assistant-delivery binding maps independently. One local clone owner supplies mutable
  copies while each path retains its matching, debt, cache, and deletion rules. Net runtime change:
  **-9 LOC**. Focused same-thread ordering, Codex steer, and completed-unmatched-turn gates pass 3/3.
  Cumulative pruning runtime change: **-518 LOC**. Next: continue only with another literal duplicate
  owner or dead result surface in the named hotspots.
- `PRUNE-46` — bootstrap replay no longer calls through a one-use singleton-projector wrapper. It
  invokes the existing `runProjectorsForEvent` owner directly with the same one-element array. Net
  runtime change: **-3 LOC**. Direct call-graph inspection and `git diff --check` are sufficient.
  Cumulative pruning runtime change: **-521 LOC**. Next: continue dead wrapper/result-surface deletion
  without merging distinct hot/deferred projection policies.
- `PRUNE-47` — hot, deferred, and bootstrap projection callers no longer provide the same filesystem,
  path, and server-config services independently. The existing projector execution owner now supplies
  those dependencies while selection, cursors, ordering, and SQL error labels remain path-specific.
  Net runtime change: **-5 LOC**. Focused bootstrap and live projection gates pass 2/2. Cumulative
  pruning runtime change: **-526 LOC**. Next: continue duplicate ownership deletion without merging
  distinct hot/deferred policies.
- `PRUNE-48` — hot, deferred, and bootstrap projection effects no longer apply no-op `Effect.asVoid`
  adapters after already returning `void`. `projectEvent` keeps its adapter because snapshot cursor
  advancement can return transaction output. Net runtime change: **-3 LOC**. Direct effect-result
  inspection and `git diff --check` are sufficient. Cumulative pruning runtime change: **-529 LOC**.
  Next: continue dead wrapper/result-surface deletion in named hotspots.
- `PRUNE-49` — project metadata selection no longer filters a singleton projector, checks the result
  length, and reconstructs that same singleton. It returns the existing filter result directly. Net
  runtime change: **-4 LOC**. The focused project metadata update gate passes 1/1. Cumulative pruning
  runtime change: **-533 LOC**. Next: continue only with literal duplicate or redundant control-flow
  deletion in named hotspots.
- `PRUNE-50` — project metadata apply and snapshot-state advance callers no longer normalize effects
  whose declared contracts already return `void`. Net runtime change: **-1 LOC**. Direct contract
  inspection and `git diff --check` are sufficient. Cumulative pruning runtime change: **-534 LOC**.
  Next: continue dead wrapper/result-surface deletion in named hotspots.
- `PRUNE-51` — four yielded history-rewrite loops no longer normalize ignored result arrays or restate
  Effect's documented sequential default with `concurrency: 1`. Repository ordering and failure
  propagation remain unchanged. Net runtime change: **-7 LOC**. Direct contract inspection and
  `git diff --check` are sufficient. Cumulative pruning runtime change: **-541 LOC**. Next: continue
  no-op wrapper or duplicated owner deletion in named hotspots.
- `PRUNE-52` — seven directly yielded runtime-ingestion cleanup/finalization loops no longer normalize
  ignored arrays or restate Effect's sequential default. Returned reasoning-settlement effects keep
  their result shaping; cleanup order and failure propagation remain unchanged. Net runtime change:
  **-8 LOC**. Direct contract inspection and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-549 LOC**. Next: continue no-op result adapter deletion without changing returned
  effect contracts.
- `PRUNE-53` — fingerprint cleanup and replay-page enqueue no longer restate Effect's sequential
  default. Invalidation/enqueue order and the replay drain fence remain unchanged. Net runtime change:
  **-2 LOC**. Direct contract inspection and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-551 LOC**. Next: continue redundant default/result adapter deletion in named
  hotspots.
- `PRUNE-54` — eight attachment cleanup, projector transaction, cursor alignment, snapshot
  advancement, and bootstrap loops no longer restate Effect's sequential default. Loop boundaries,
  ordering, and returned results remain unchanged. Net runtime change: **-12 LOC**. Direct contract
  inspection and `git diff --check` are sufficient. Cumulative pruning runtime change: **-563 LOC**.
  Next: continue deletion of redundant defaults and result adapters in the named hotspots.
- `PRUNE-55` — queued-promotion recovery no longer carries a sequential/discard option object whose
  defaults were already provided by the directly yielded loop. Thread order, live-turn checks, and
  queue draining remain unchanged. Net runtime change: **-1 LOC**. Direct contract inspection and
  `git diff --check` are sufficient. Cumulative pruning runtime change: **-564 LOC**. Next: continue
  exact duplicate/default deletion in existing changed hotspot code.
- `PRUNE-56` — reasoning-summary settlement no longer restates Effect's sequential default in its
  nested activity-dispatch and outer summary loops. Both `Effect.asVoid` return contracts remain.
  Net runtime change: **-2 LOC**. Direct contract inspection and `git diff --check` are sufficient.
  Cumulative pruning runtime change: **-566 LOC**. Next: continue exact duplicate/default deletion in
  existing changed hotspot code.
- `PRUNE-57` — the scoped durable-source fork no longer normalizes its handle immediately before a
  bare final `yield*`; the enclosing generator already returns `void`. Fork scope and failure handling
  remain unchanged. Net runtime change: **-1 LOC**. Direct control-flow inspection and
  `git diff --check` are sufficient. Cumulative pruning runtime change: **-567 LOC**. Next: continue
  exact no-op result/default deletion in existing changed hotspot code.
- `PRUNE-58` — failed queued-promotion claim release now relies on `Effect.onError` as the sole owner
  of cleanup-result disposal instead of normalizing the repository's boolean first. Release timing,
  failure triggering, and the original effect result remain unchanged. Net runtime change: **-2 LOC**.
  Direct contract inspection and `git diff --check` are sufficient. Cumulative pruning runtime
  change: **-569 LOC**. Next: continue exact no-op result/default deletion in changed hotspot code.
- `PRUNE-59` — title generation no longer creates a provider-options alias used only for a debug
  presence flag. The flag reads the same resolved input directly; generation and logging behavior are
  unchanged. Net runtime change: **-1 LOC**. Direct expression equivalence and `git diff --check` are
  sufficient. Cumulative pruning runtime change: **-570 LOC**. Next: continue exact one-use alias or
  duplicated-owner deletion in changed hotspot code.
- `PRUNE-60` — queued promotion and retryable delivery recovery now share one exact-sequence
  orchestration-event reader instead of separately collecting and unpacking the same bounded stream.
  Their subtype, sequence, and failure policies remain local. Net runtime change: **-5 LOC**. Focused
  safe-retry and claimed queued-promotion recovery gates pass 2/2. Cumulative pruning runtime change:
  **-575 LOC**. Next: continue duplicated-owner deletion in existing changed hotspot code.
- `PRUNE-61` — delayed turn-start persistence now tests the repository's `Option` directly instead of
  converting it to a one-use binding alias solely for presence. Newer-binding preservation and stopped
  fallback behavior remain unchanged. Net runtime change: **-3 LOC**. The focused overlapping
  older-turn completion gate passes 1/1. Cumulative pruning runtime change: **-578 LOC**. Next:
  continue one-use conversion/alias deletion in existing changed hotspot code.
- `PRUNE-62` — provider replacement startup now yields the previous adapter's `hasSession` check
  directly instead of storing a one-use activity alias. Provider selection, replacement startup, and
  active previous-provider teardown remain unchanged. Net runtime change: **-1 LOC**. Direct
  expression equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change:
  **-579 LOC**. Next: continue exact one-use alias or duplicated-owner deletion in changed hotspots.
- `PRUNE-63` — delayed turn-start persistence now performs its latest-generation comparison directly
  instead of calling a one-use predicate. Dispatch-state creation, stale-result retention, and
  promotion behavior remain unchanged. Net runtime change: **-2 LOC**. Direct expression equivalence
  and `git diff --check` are sufficient. Cumulative pruning runtime change: **-581 LOC**. Next:
  continue exact one-use wrapper or duplicated-owner deletion in changed hotspots.
- `PRUNE-64` — approval and user-input shell-count updates now share one projection-row upsert
  envelope. Their counter fields remain explicit and retain the same clamped delta. Net runtime
  change: **-2 LOC**. Focused approval and user-input summary projection gates pass 2/2. Cumulative
  pruning runtime change: **-583 LOC**. Next: continue duplicated persistence-envelope deletion in
  existing changed hotspot code.
- `PRUNE-65` — feature and bootstrap WebSocket routes now share one request-URL/trusted-origin owner.
  Feature compatibility, authentication, session admission, and bootstrap negotiation stay local.
  Net runtime change: **-1 LOC**. The focused feature-socket pre-auth negotiation gate passes 1/1;
  bootstrap-origin behavior is directly equivalent and has no focused fixture. Cumulative pruning
  runtime change: **-584 LOC**. Next: continue duplicated route/persistence ownership deletion in
  existing changed hotspot code.
- `PRUNE-66` — pending delivery modes and unmatched provider turns now share one per-thread FIFO pop
  owner instead of duplicating first-item and delete-last/slice-rest mutation. Request debt, unmatched
  settlement, defaults, and cache binding remain local. Net runtime change: **-1 LOC**. Focused
  same-thread ordering, Codex steer, and settled unmatched-turn gates pass 3/3. Cumulative pruning
  runtime change: **-585 LOC**. Next: continue duplicated state-mutation ownership deletion in changed
  hotspot code.
- `PRUNE-67` — stop-all now builds its thread-indexed active-session map directly from adapter session
  listings and no longer normalizes results from directly yielded stop loops. Directory marking still
  precedes adapter cleanup, analytics, and flush. Net runtime change: **-3 LOC**. The focused active
  session persistence-before-cleanup gate passes 1/1. Cumulative pruning runtime change: **-588 LOC**.
  Next: continue intermediate collection or duplicated-owner deletion in changed hotspots.
- `PRUNE-68` — pending approval/user-input shell-count updates now reuse the existing thread-row
  update owner instead of duplicating read, missing-row, and upsert handling. Counter deltas and fields
  remain local. Net runtime change: **-4 LOC**. Focused approval and user-input summary projection gates
  pass 2/2. Cumulative pruning runtime change: **-592 LOC**. Next: continue exact persistence-shell
  deletion in existing changed hotspot code.
- `PRUNE-69` — ProviderService initialization now feeds the eagerly loaded binding list directly into
  lifecycle-generation adoption instead of storing a one-use collection alias. Order and filtering
  remain unchanged. Net runtime change: **-1 LOC**. The focused persisted-resume restart gate passes
  1/1. Cumulative pruning runtime change: **-593 LOC**. Next: continue exact intermediate collection
  or duplicated-owner deletion in changed hotspots.
- `PRUNE-70` — ProviderService session listing now flattens sequential adapter results directly rather
  than storing a one-use per-adapter collection. Persisted-binding enrichment is unchanged. Net runtime
  change: **-1 LOC**. Direct expression equivalence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-594 LOC**. Next: continue exact intermediate collection or duplicated
  owner deletion in changed hotspots.
- `PRUNE-71` — ProviderService session listing now uses Effect's existing `Array.getSomes` to build
  its ordered persisted-binding map instead of manually unwrapping and guarding every `Option`.
  Present values and duplicate-key behavior remain unchanged. Net runtime change: **-1 LOC**. The
  focused present-binding provider-operations gate passes 1/1. Cumulative pruning runtime change:
  **-595 LOC**. Next: continue manual collection/conversion deletion in existing changed hotspots.
- `PRUNE-72` — fingerprint cleanup now feeds its eagerly materialized cache-key array directly into
  the sequential prefix-filtered invalidation loop instead of storing a one-use alias. Net runtime
  change: **-1 LOC**. Direct expression equivalence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-596 LOC**. Next: continue one-use collection deletion in changed hotspot
  cleanup paths.
- `PRUNE-73` — the shared session-set/turn-diff projection branch now assigns its unchanged latest-turn
  selection directly to the thread row instead of storing a one-use alias. Plan-summary refresh and
  persistence order remain unchanged. Net runtime change: **-1 LOC**. Direct expression equivalence
  and `git diff --check` are sufficient. Cumulative pruning runtime change: **-597 LOC**. Next:
  continue exact one-use alias or duplicated-owner deletion in changed hotspot code.
- `PRUNE-74` — managed-attachment cleanup now assigns its unchanged relative-path parse and `att_v2_`
  filter directly to the retained-ID request property instead of storing a one-use alias. Claim timing
  and iteration order remain unchanged. Net runtime change: **-1 LOC**. Direct expression equivalence
  and `git diff --check` are sufficient. Cumulative pruning runtime change: **-598 LOC**. Next:
  continue exact one-use alias or duplicated-owner deletion in changed hotspot code.
- `PRUNE-75` — revert fallback retention now iterates its unchanged role filter and bounded slice
  directly instead of storing a one-use message collection. Role order and retained-ID mutation remain
  unchanged. Net runtime change: **-1 LOC**. Direct control-flow equivalence and `git diff --check` are
  sufficient. Cumulative pruning runtime change: **-599 LOC**. Next: continue exact one-use collection
  or duplicated-owner deletion in changed hotspot code.
- `PRUNE-76` — pending-response projection now yields the repository claim directly in the shell-count
  guard instead of storing a one-use boolean alias. The claim still executes exactly once before count
  mutation. Net runtime change: **-1 LOC**. Direct control-flow equivalence and `git diff --check` are
  sufficient. Cumulative pruning runtime change: **-600 LOC**. Next: continue exact one-use alias or
  duplicated-owner deletion in changed hotspot code.
- `PRUNE-77` — queued-promotion recovery now feeds its pending-thread repository snapshot directly
  into the sequential live-turn/drain loop instead of storing a one-use list alias. Net runtime change:
  **-1 LOC**. Direct expression equivalence and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-601 LOC**. Next: continue exact one-use collection or duplicated-owner deletion
  in changed hotspot code.
- `PRUNE-78` — rejected and uncertain provider-command attempts now share one terminal-settlement tail;
  an explicit tag mapping preserves `rejected -> dead` and `uncertain -> uncertain`. Net runtime
  change: **-7 LOC**. The focused uncertain quarantine/reconciliation gate passes 1/1; the rejected
  mapping is directly evident and has no focused fixture. Cumulative pruning runtime change:
  **-608 LOC**. Next: continue duplicate terminal/cursor tail deletion in changed hotspot code.
- `PRUNE-79` — claimed and unclaimed provider-intent processors now delegate quarantine admission to
  the existing skip owner instead of duplicating side-effect classification and blocker checks. Direct
  retry/replay callers retain the same guard. Net runtime change: **-2 LOC**. The focused quarantine,
  unrelated-thread continuation, and reconciliation replay gate passes 1/1. Cumulative pruning runtime
  change: **-610 LOC**. Next: continue duplicate terminal/cursor admission deletion in changed code.
- `PRUNE-80` — claimed provider-intent handling now evaluates replay safety only in the expired-inflight
  branch that consumes it instead of storing an early one-use alias. The classifier and event input are
  unchanged. Net runtime change: **-1 LOC**. Direct expression equivalence and `git diff --check` are
  sufficient. Cumulative pruning runtime change: **-611 LOC**. Next: continue exact terminal-state or
  one-use classifier deletion in changed hotspot code.
- `PRUNE-81` — accepted completion and non-exhausted safe retry now create their ISO settlement
  timestamps directly in the mutually exclusive repository writes instead of sharing an eager value
  that dead/uncertain paths did not consume. Net runtime change: **-1 LOC**. Direct branch inspection
  and `git diff --check` are sufficient. Cumulative pruning runtime change: **-612 LOC**. Next:
  continue exact terminal-state or eager-value deletion in changed hotspot code.
- `PRUNE-82` — queued-promotion and durable provider-command claims now initialize their ISO claim
  timestamps directly in repository payloads instead of storing one-use aliases. Lease expiry
  construction remains separate and unchanged. Net runtime change: **-2 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-614 LOC**.
  Next: continue exact eager-value or duplicate settlement deletion in changed hotspot code.
- `PRUNE-83` — terminal applicability now owns its outstanding-turn Ref read, and buffered reasoning
  reuses the existing terminal-event boolean. Non-terminal events avoid the ambiguity-state read. Net
  runtime change: **-2 LOC**. The no-turn-id and reasoning-abort gates timed out on initial thread state
  before the changed logic and remain deferred without new scaffolding; direct equivalence and
  `git diff --check` are the available evidence. Cumulative pruning runtime change: **-616 LOC**. Next:
  continue exact terminal-state or eager-read deletion in changed hotspot code.
- `PRUNE-84` — outstanding-turn cleanup now consumes terminal applicability's canonical
  `eventTurnId` instead of reconstructing and rebranding the same explicit or implicit identifier.
  Net runtime change: **-1 LOC**. Classifier contract inspection and `git diff --check` are sufficient;
  no test scaffolding was added. Cumulative pruning runtime change: **-617 LOC**. Next: continue exact
  terminal-state or one-use resolution deletion in changed hotspot code.
- `PRUNE-85` — parent/subagent runtime routing now destructures `thread` directly from its existing
  resolution expression instead of retaining a one-use result wrapper. Net runtime change: **-1 LOC**.
  Direct expression equivalence and `git diff --check` are sufficient. Cumulative pruning runtime
  change: **-618 LOC**. Next: continue exact one-use resolution or eager-value deletion in changed
  hotspot code.
- `PRUNE-86` — parent/subagent routing now owns its child-thread comparisons directly, deleting the
  one-use predicate and its repeated provider-thread guard. Net runtime change: **-2 LOC**. Direct
  condition equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change:
  **-620 LOC**. Next: continue exact one-use predicate or eager-value deletion in changed hotspot code.
- `PRUNE-87` — interrupt admission now checks the existing provider session directly instead of
  materializing a one-use truthy session alias. Net runtime change: **-1 LOC**. Direct boolean
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-621 LOC**.
  Next: continue exact one-use predicate or duplicated guard deletion in changed hotspot code.
- `PRUNE-88` — session turn-state cleanup now feeds each cache-key snapshot directly into its existing
  sequential loop instead of retaining three one-use arrays. Net runtime change: **-3 LOC**. Cache
  ownership inspection and `git diff --check` are sufficient. Cumulative pruning runtime change:
  **-624 LOC**. Next: continue exact one-use collection or duplicated cleanup deletion in changed
  hotspot code.
- `PRUNE-89` — proposed-plan session cleanup now keeps its unchanged key prefix at the sole cache
  filter instead of retaining a one-use alias. Net runtime change: **-1 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-625 LOC**.
  Next: continue exact one-use collection or duplicated cleanup deletion in changed hotspot code.
- `PRUNE-90` — tool-output buffering now owns its two accepted stream kinds at the sole admission
  guard, deleting a private type, classifier, and one-use result. Net runtime change: **-10 LOC**.
  Direct control-flow equivalence and `git diff --check` are sufficient. Cumulative pruning runtime
  change: **-635 LOC**. Next: continue exact single-caller classifier or duplicated admission deletion
  in changed hotspot code.
- `PRUNE-91` — tool-output buffering now constructs its item-scoped key at the sole admission owner,
  deleting the private single-caller key helper. Net runtime change: **-4 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-639 LOC**.
  Next: continue exact single-caller helper or duplicated admission deletion in changed hotspot code.
- `PRUNE-92` — subagent thread creation now brands its deterministic child id at the sole owner,
  deleting the private single-caller wrapper. Net runtime change: **-1 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-640 LOC**.
  Next: continue exact single-caller helper or duplicated identity deletion in changed hotspot code.
- `PRUNE-93` — runtime turn-state extraction now owns its accepted-state switch and fallback directly,
  deleting the single-caller normalizer. Net runtime change: **-4 LOC**. Direct switch equivalence and
  `git diff --check` are sufficient. Cumulative pruning runtime change: **-644 LOC**. Next: continue
  exact single-caller helper or duplicated normalization deletion in changed hotspot code.
- `PRUNE-94` — runtime-warning activity construction now owns summary and payload locally, deleting
  two single-caller builders and one duplicate native-type parse. Net runtime change: **-9 LOC**. The
  focused OpenCode retry warning gate passes 1/1. Cumulative pruning runtime change: **-653 LOC**.
  Next: continue exact single-caller helper or duplicated payload parsing deletion in changed hotspot
  code.
- `PRUNE-95` — buffered-reasoning settlement now classifies terminal status once per batch, deleting
  the private per-summary status helper. Net runtime change: **-5 LOC**. Direct condition equivalence
  and `git diff --check` are sufficient; the abort fixture remains deferred under its known pre-target
  harness timeout. Cumulative pruning runtime change: **-658 LOC**. Next: continue exact single-caller
  helper or duplicated per-item classification deletion in changed hotspot code.
- `PRUNE-96` — canonical request activity construction now brands its optional approval id at the sole
  payload owner, deleting the single-caller wrapper. Net runtime change: **-1 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-659 LOC**.
  Next: continue exact single-caller helper or duplicated conversion deletion in changed hotspot code.
- `PRUNE-97` — turn-completed activity construction now reads its error scalar once, lifecycle
  `lastError` reuses the existing status classification, and the thin getter is deleted. Net runtime
  change: **-2 LOC**. The focused failed-turn session lifecycle gate passes 1/1. Cumulative pruning
  runtime change: **-661 LOC**. Next: continue exact duplicate scalar parsing or single-caller helper
  deletion in changed hotspot code.
- `PRUNE-98` — runtime-error activity construction now shares one parsed payload for message/class,
  lifecycle owns its fallback read directly, and the thin message getter is deleted. Net runtime
  change: **-1 LOC**. The focused runtime-error session-state gate passes 1/1. Cumulative pruning
  runtime change: **-662 LOC**. Next: continue exact duplicate scalar parsing or single-caller helper
  deletion in changed hotspot code.
- `PRUNE-99` — message projection persistence now owns its append/preserve/replace text precedence at
  the sole `text` field, deleting a one-use alias. Net runtime change: **-1 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient; no focused fixture was added. Cumulative pruning
  runtime change: **-663 LOC**. Next: continue exact one-use projection value or duplicated
  persistence-shell deletion in changed hotspot code.
- `PRUNE-100` — pending-interaction shell counting now computes its next-minus-previous actionable
  delta directly, deleting two one-use booleans. Net runtime change: **-1 LOC**. Direct arithmetic
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-664 LOC**.
  Next: continue exact one-use projection value or duplicated counter/persistence deletion in changed
  hotspot code.
- `PRUNE-101` — first-turn thread persistence now owns its conditional model-selection spread,
  deleting the one-use patch object while retaining the named provider-adoption policy. Net runtime
  change: **-1 LOC**. Direct condition equivalence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-665 LOC**. Next: continue exact one-use projection value or duplicated
  persistence-shell deletion in changed hotspot code.
- `PRUNE-102` — resolved-interaction persistence now validates the extracted raw decision at its sole
  field owner, deleting the one-use validated alias. Net runtime change: **-1 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-666 LOC**.
  Next: continue exact one-use projection value or duplicated validation/persistence deletion in
  changed hotspot code.
- `PRUNE-103` — snapshot cursor advancement now consumes the imported project-metadata projector set
  directly, deleting its one-use pass-through alias. Net runtime change: **-1 LOC**. Direct identity
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-667 LOC**.
  Next: continue exact one-use projection value or duplicated cursor/persistence deletion in changed
  hotspot code.
- `PRUNE-104` — fork admission now tests target-binding presence at the directory boundary, deleting
  an `Option` conversion and one-use alias. Net runtime change: **-3 LOC**. Direct control-flow
  equivalence and `git diff --check` are sufficient; no focused existing-target fork fixture was
  added. Cumulative pruning runtime change: **-670 LOC**. Next: continue exact one-use lifecycle value
  or duplicated provider-session admission deletion in changed hotspot code.
- `PRUNE-105` — idle-stop admission now owns active-turn rejection only at its enclosing guard,
  deleting the duplicate running-session check. Net runtime change: **-1 LOC**. Direct logical
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-671 LOC**.
  Next: continue exact one-use lifecycle value or duplicated provider-session admission deletion in
  changed hotspot code.
- `PRUNE-106` — diagnostics payload construction now owns its bounded child-process slice, deleting a
  one-use array while retaining full-list totals. Net runtime change: **-1 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient; no focused diagnostics fixture was added.
  Cumulative pruning runtime change: **-672 LOC**. Next: continue exact one-use RPC payload value or
  duplicated admission/response deletion in changed hotspot code.
- `PRUNE-107` — local-server stop now searches the `listLocalServers()` result directly, deleting its
  one-use snapshot wrapper while retaining stop and tracked-project reconciliation order. Net runtime
  change: **-1 LOC**. Direct expression equivalence and `git diff --check` are sufficient; no focused
  RPC fixture was added. Cumulative pruning runtime change: **-673 LOC**. Next: continue exact one-use
  RPC payload value or duplicated admission/response deletion in changed hotspot code.
- `PRUNE-108` — skill-mention normalization now escapes the skill name at its existing local owner,
  deleting the single-caller regex wrapper. Net runtime change: **-3 LOC**. The focused skill-mention
  unit gate passes 2/2. Cumulative pruning runtime change: **-676 LOC**. Next: continue exact
  single-caller conversion or duplicated provider-input normalization deletion in changed hotspot
  code.
- `PRUNE-109` — sidechat turn dispatch now owns its fixed boundary template directly, deleting the
  single-caller wrapper while retaining the shared safety instruction. Net runtime change: **-3 LOC**.
  The focused non-native sidechat bootstrap gate passes 1/1. Cumulative pruning runtime change:
  **-679 LOC**. Next: continue exact single-caller conversion or duplicated provider-input
  normalization deletion in changed hotspot code.
- `PRUNE-110` — edit-replay restoration now consumes its Git-workspace check at the existing early
  guard, deleting a one-use boolean. Net runtime change: **-1 LOC**. Direct control-flow equivalence
  and `git diff --check` are sufficient; the broader checkpoint fixture was not rerun. Cumulative
  pruning runtime change: **-680 LOC**. Next: continue exact one-use guard or duplicated provider
  admission deletion in changed hotspot code.
- `PRUNE-111` — provider-session status mapping now names only its connecting/closed translations and
  shares one typed identity return for ready/running/error, deleting switch scaffolding. Net runtime
  change: **-10 LOC**. The focused starting-session gate passes 1/1. Cumulative pruning runtime change:
  **-690 LOC**. Next: continue exact identity-branch or duplicated provider-state mapping deletion in
  changed hotspot code.
- `PRUNE-112` — runtime-session status mapping now names only `waiting -> running` and shares one typed
  identity return for every other status, deleting switch scaffolding. Net runtime change: **-14 LOC**.
  The focused session-state transition gate passes 1/1. Cumulative pruning runtime change: **-704
  LOC**. Next: continue exact identity-branch or duplicated provider-state mapping deletion in changed
  hotspot code.
- `PRUNE-113` — persisted provider runtime status mapping now names its connecting/closed exceptions,
  preserves error, and shares running for ready/running, deleting switch scaffolding. Net runtime
  change: **-9 LOC**. Direct branch equivalence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-713 LOC**. Next: continue exact identity/default branch or duplicated
  provider-state mapping deletion in changed hotspot code.
- `PRUNE-114` — runtime last-error mapping now keeps its payload-sensitive branches and collapses four
  terminal-event null arms into one predicate, retaining undefined for unrelated events. Net runtime
  change: **-2 LOC**. Direct branch equivalence and `git diff --check` are sufficient. Cumulative
  pruning runtime change: **-715 LOC**. Next: continue exact identity/default branch or duplicated
  provider-state mapping deletion in changed hotspot code.
- `PRUNE-115` — runtime-event status mapping now expresses session/thread state exceptions directly,
  deleting two nested switches while retaining terminal and compacted-idle behavior. Net runtime
  change: **-10 LOC**. The focused compacted-runtime idle-stop gate passes 1/1. Cumulative pruning
  runtime change: **-725 LOC**. Next: continue exact identity/default branch or duplicated
  provider-state mapping deletion in changed hotspot code.
- `PRUNE-116` — session-driven turn finalization now expresses terminal identity, running, and
  existing-terminal preservation as three rules, deleting switch scaffolding. Net runtime change:
  **-11 LOC**. Direct branch equivalence and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-736 LOC**. Next: continue exact identity/default branch or duplicated projection
  state mapping deletion in changed hotspot code.
- `PRUNE-117` — runtime-turn state normalization now preserves only failed/interrupted/cancelled and
  shares completed for completed/unknown inputs, deleting switch scaffolding. Net runtime change:
  **-6 LOC**. Direct branch equivalence and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-742 LOC**. Next: continue exact identity/default branch or duplicated provider
  state mapping deletion in changed hotspot code.
- `PRUNE-118` — canonical request-kind mapping now expresses its command/file-read/file-change aliases
  directly and retains undefined for unknown values, deleting switch/default scaffolding. Net runtime
  change: **-6 LOC**. The focused canonical request activity gate passes 1/1. Cumulative pruning
  runtime change: **-748 LOC**. Next: continue exact identity/default branch or duplicated protocol
  mapping deletion in changed hotspot code.
- `PRUNE-119` — heavy-thread-detail classification now keeps one completed-item special case and one
  direct predicate for unconditional event types, deleting switch/default scaffolding. Net runtime
  change: **-5 LOC**. Direct case equivalence and `git diff --check` are sufficient. Cumulative pruning
  runtime change: **-753 LOC**. Next: continue exact boolean switch or duplicated admission
  classification deletion in changed hotspot code.
- `PRUNE-120` — shell-stream admission now expresses its four unconditional event types and
  thread-shell fallback as one predicate, deleting switch/default scaffolding. Net runtime change:
  **-3 LOC**. Direct case equivalence and `git diff --check` are sufficient; no focused classifier
  fixture was added. Cumulative pruning runtime change: **-756 LOC**. Next: continue exact boolean
  switch or duplicated admission classification deletion in changed hotspot code.
- `PRUNE-121` — thread-lifecycle admission now expresses only guarded turn starts and terminal
  applicability, deleting the IIFE switch and redundant true arms. Net runtime change: **-14 LOC**.
  The focused started/completed session lifecycle gate passes 1/1. Cumulative pruning runtime change:
  **-770 LOC**. Next: continue exact boolean switch or duplicated lifecycle admission deletion in
  changed hotspot code.
- `PRUNE-122` — assistant text, proposed-plan, tool-output, and reasoning-summary buffers now share
  one cache take-and-invalidate owner; each caller retains its own empty-value policy. The pending-image
  cache remains separate because its focused gate repeatedly times out independently of this
  consolidation. Net runtime change: **-16 LOC**. The four affected focused gates pass 4/4; module
  import and `git diff --check` pass. Cumulative pruning runtime change: **-786 LOC**. Next: continue
  only a mechanically equivalent duplicate or identity/default branch in a named hotspot.
- `PRUNE-123` — provider-attempt classification no longer names request/process errors separately
  from its identical uncertain default. Rejection and safe-retry tags remain explicit. Net runtime
  change: **-3 LOC**. Direct branch equivalence, module import, and `git diff --check` pass. Cumulative
  pruning runtime change: **-789 LOC**. Next: continue exact default/identity deletion in a changed
  hotspot without widening an API.
- `PRUNE-124` — projector selection and snapshot-cursor advancement now consume the existing
  `PROJECT_EVENT_TYPES` owner, deleting two duplicate three-event classifiers while retaining the
  typed project-application guard. Net runtime change: **-12 LOC**. Exact set/case equivalence and
  `git diff --check` are sufficient; no focused fixture was added. Cumulative pruning runtime change:
  **-801 LOC**. Next: continue only a mechanically equivalent duplicate or identity/default branch in
  a named hotspot.
- `PRUNE-125` — thread-turn projector admission now owns set-membership and assistant-message
  eligibility in one predicate, deleting a redundant true early return. Net runtime change:
  **-2 LOC**. Direct predicate equivalence, module import, and `git diff --check` pass. Cumulative
  pruning runtime change: **-803 LOC**. Next: continue exact default/identity deletion in a changed
  hotspot without widening an API.
- `PRUNE-126` — runtime id comparison now expresses its string-only domain and equality in one
  predicate, deleting the separate nullish guard. Net runtime change: **-3 LOC**. Direct predicate
  equivalence, module import, and `git diff --check` pass. Cumulative pruning runtime change:
  **-806 LOC**. Next: continue mechanically exact default/identity deletion in a changed hotspot.
- `PRUNE-127` — pending-interaction projector admission now owns response-event and activity-event
  eligibility in one predicate, deleting the redundant true early return while retaining activity
  payload narrowing. Net runtime change: **-3 LOC**. Direct predicate equivalence and
  `git diff --check` are sufficient; no focused fixture was added. Cumulative pruning runtime change:
  **-809 LOC**. Next: continue mechanically exact default/identity deletion in a changed hotspot.
- `PRUNE-128` — terminal-turn ambiguity now combines dispatch-state existence with the existing three
  ambiguity conditions, deleting a separate false early return. Net runtime change: **-1 LOC**.
  Direct predicate equivalence, module import, and `git diff --check` pass. Cumulative pruning runtime
  change: **-810 LOC**. Next: continue only mechanically exact deletion in a changed hotspot.
- `PRUNE-129` — proposed-plan markdown normalization now expresses trim-or-undefined directly,
  deleting its one-use alias and empty-value guard. Net runtime change: **-4 LOC**. Direct expression
  equivalence and `git diff --check` are sufficient; no focused fixture was added. Cumulative pruning
  runtime change: **-814 LOC**. Next: continue only mechanically exact deletion in a changed hotspot.
- `PRUNE-130` — runtime idle-timer reconciliation now expresses its three actions directly and merges
  the repeated scheduling arms into one fixed event/state predicate. Net runtime change: **-7 LOC**.
  Focused turn-start and compacted-runtime gates pass 2/2; module import and `git diff --check` pass.
  Cumulative pruning runtime change: **-821 LOC**. Next: continue only mechanically exact deletion in
  a changed hotspot.
- `PRUNE-131` — readable-reasoning normalization now uses the cleaned trimmed string as its existing
  truthiness decision, deleting the separate invalid-content guard and identity return. Net runtime
  change: **-3 LOC**. Direct expression equivalence and `git diff --check` are sufficient; no focused
  fixture was added. Cumulative pruning runtime change: **-824 LOC**. Next: continue only mechanically
  exact deletion in a changed hotspot.
- `PRUNE-132` — runtime-payload normalization now combines its null/non-object check with the identity
  cast, deleting the separate guard while preserving the original all-object domain. Net runtime
  change: **-1 LOC**. Direct branch equivalence and `git diff --check` are sufficient; no focused
  fixture was added. Cumulative pruning runtime change: **-825 LOC**. Next: continue only mechanically
  exact deletion in a changed hotspot.
- `PRUNE-133` — provider session binding now owns its connecting/closed status translations directly,
  deleting the single-use mapper while preserving pass-through statuses. Net runtime change:
  **-2 LOC**. The focused starting-session gate passes 1/1; module import and `git diff --check` pass.
  Cumulative pruning runtime change: **-827 LOC**. Next: continue only mechanically exact deletion in
  a changed hotspot.
- `PRUNE-134` — the handled-turn cache lookup now owns its command-id-first/event-id fallback key
  directly, deleting the single-use identity wrapper without changing prefixes. Net runtime change:
  **-3 LOC**. Direct expression equivalence, module import, and `git diff --check` pass. Cumulative
  pruning runtime change: **-830 LOC**. Next: continue only mechanically exact deletion in a changed
  hotspot.
- `PRUNE-135` — buffered-reasoning summary joining now uses a compact missing-summary guard, deleting
  its brace-only control-flow lines while leaving the transformation unchanged. Net runtime change:
  **-2 LOC**. Direct control-flow equivalence and `git diff --check` are sufficient; no focused fixture
  was added. Cumulative pruning runtime change: **-832 LOC**. Next: continue only mechanically exact
  deletion in a changed hotspot.
- `PRUNE-136` — the runtime-warning activity branch now owns its raw nested-payload parsing directly,
  deleting the single-use wrapper without changing object validation. Net runtime change: **-3 LOC**.
  Direct expression equivalence and `git diff --check` are sufficient; no focused fixture was added.
  Cumulative pruning runtime change: **-835 LOC**. Next: continue single-use wrapper deletion in a
  changed hotspot where ownership becomes clearer.
- `PRUNE-137` — the session-state switch now owns its waiting-to-running translation directly,
  deleting the single-use status mapper while preserving every identity state. Net runtime change:
  **-5 LOC**. Direct expression equivalence and `git diff --check` are sufficient; the previously
  passing focused session-state gate was not rerun. Cumulative pruning runtime change: **-840 LOC**.
  Next: continue single-use wrapper deletion in a changed hotspot where ownership becomes clearer.
- `PRUNE-138` — interaction response fencing no longer calls an always-true classifier that listed
  every legal provider kind. The existing non-legacy generation guard now applies directly to all
  routed providers. Net runtime change: **-14 LOC**. Focused Claude and ACP generation gates pass 2/2;
  module import and `git diff --check` pass. Cumulative pruning runtime change: **-854 LOC**. Next:
  continue only mechanically exact deletion in a changed hotspot.
- `PRUNE-139` — message projection now passes incoming attachments directly instead of routing them
  through a single-use Effect wrapper that returned the same array. The persisted-message fallback is
  unchanged. Net runtime change: **-7 LOC**. The focused mixed-attachment projection gate passes 1/1;
  module import and `git diff --check` pass. Cumulative pruning runtime change: **-861 LOC**. Next:
  continue only mechanically exact deletion in a changed hotspot.
- `PRUNE-140` — process-argument redaction now owns its fixed diagnostics truncation directly,
  deleting the single-use generic wrapper without changing the limit, reserve, or suffix. Net runtime
  change: **-1 LOC**. Direct expression equivalence and `git diff --check` are sufficient; no focused
  fixture was added. Cumulative pruning runtime change: **-862 LOC**. Next: continue only mechanically
  exact deletion in a changed hotspot.
- `PRUNE-141` — GitHub repository resolution now owns its nullable remote-name split/normalize/filter
  pipeline beside the sole `git remote` read, deleting the single-use parser. Net runtime change:
  **-6 LOC**. Direct pipeline equivalence and `git diff --check` are sufficient; no focused fixture was
  added. Cumulative pruning runtime change: **-868 LOC**. Next: continue single-use wrapper deletion in
  a changed hotspot where ownership becomes clearer.
- `PRUNE-142` — pending-interaction projection now reuses one payload-record coercion instead of four
  identical null/object guards. Array acceptance and every field-specific branded ID or status rule
  remain unchanged. Net runtime change: **-7 LOC**. Focused generation-fencing and user-input retry
  settlement gates pass 2/2; module import and `git diff --check` pass. Cumulative pruning runtime
  change: **-875 LOC**. Next: continue only mechanically exact consolidation in a changed hotspot.
- `PRUNE-143` — persisted model-selection, provider-options, and CWD reads now reuse ProviderService's
  existing runtime-payload record coercion instead of three identical invalid-object/array guards.
  Field validation is unchanged. Net runtime change: **-9 LOC**. Focused persisted Claude recovery
  and provider-options restart gates pass 2/2; module import and `git diff --check` pass. Cumulative
  pruning runtime change: **-884 LOC**. Next: continue only mechanically exact consolidation in a
  changed hotspot.
- `PRUNE-144` — live and replay thread-detail streams now share one aggregate/id/event classifier,
  deleting the nested scoping wrapper and its unused 18-case narrowing annotation. Net runtime-source
  change: **-22 LOC**. The exact short-circuit predicate and both callsites are unchanged; direct
  equivalence and `git diff --check` are sufficient. Cumulative pruning runtime change: **-906 LOC**.
  Next: continue only mechanically exact consolidation in a changed hotspot.
- `PRUNE-145` — resolved approval projection now reuses the shared payload-record coercion instead of
  a fifth inline null/object/property guard. Approval-only routing and allowed decisions are unchanged.
  Net runtime change: **-3 LOC**. The focused reused-request generation gate passes 1/1; module import
  and `git diff --check` pass. Cumulative pruning runtime change: **-909 LOC**. Next: continue only
  mechanically exact consolidation in a changed hotspot.
- `PRUNE-146` — ProviderRuntimeIngestion's optional object coercion now delegates to its existing JSON
  object type guard instead of duplicating the non-null/non-array predicate. Net runtime change:
  **-2 LOC**. Direct predicate equivalence, module import, and `git diff --check` pass; no focused
  fixture was added. Cumulative pruning runtime change: **-911 LOC**. Next: continue only mechanically
  exact consolidation in a changed hotspot.
- `PRUNE-147` — assistant-message state clearing now owns buffered-text cache invalidation directly,
  deleting its single-use pass-through wrapper while preserving both completion and session-cleanup
  consumers. Net runtime change: **-2 LOC**. Direct call equivalence and `git diff --check` are
  sufficient; no focused fixture was added. Cumulative pruning runtime change: **-913 LOC**. Next:
  continue only mechanically exact consolidation in a changed hotspot.
- `PRUNE-148` — proposed-plan Markdown and provider identifiers now share one trim-and-empty-string
  normalizer instead of two equivalent helpers. Their plan and subagent call sites remain separate.
  Net runtime change: **-4 LOC**. Focused buffered-plan and subagent-routing gates pass 2/2; module
  import and `git diff --check` pass. Cumulative pruning runtime change: **-917 LOC**. Next: continue
  only mechanically exact consolidation in a changed hotspot.
- `PRUNE-149` — accepted turn-start source-plan admission now owns its session list/thread match/
  active-turn lookup directly, deleting the single-use wrapper before the existing identity check.
  Net runtime change: **-2 LOC**. Direct pipeline equivalence and `git diff --check` are sufficient;
  no focused fixture was added. Cumulative pruning runtime change: **-919 LOC**. Next: continue only
  mechanically exact consolidation in a changed hotspot.
- `PRUNE-150` — buffered proposed-plan finalization now owns its cache invalidation directly,
  deleting the single-use clear wrapper without moving the post-upsert cleanup point. Net runtime
  change: **-2 LOC**. Direct call equivalence and `git diff --check` are sufficient; no focused fixture
  was added. Cumulative pruning runtime change: **-921 LOC**. Next: continue only mechanically exact
  consolidation in a changed hotspot.
- `PRUNE-151` — attachment delete and prune paths now share one root-entry normalization, ID parsing,
  and thread-ownership resolver instead of duplicating that sequence. Stat/removal behavior and unsafe
  thread guards are unchanged. Net runtime change: **-9 LOC**. Focused managed/legacy prune and
  deleted-thread cleanup gates pass 2/2; module import and `git diff --check` pass. Cumulative pruning
  runtime change: **-930 LOC**. Next: continue only mechanically exact consolidation in a changed
  hotspot.
- `PRUNE-152` — first-turn worktree-branch and thread-title renames now share one thread/message
  admission owner requiring exactly one matching native user message. Their eligibility, generation,
  fallback, and mutation policies remain separate. Net runtime change: **-5 LOC**. Focused generated-
  title and temporary-branch rename gates pass 2/2; module import and `git diff --check` pass.
  Cumulative pruning runtime change: **-935 LOC**. Next: continue only mechanically exact
  consolidation in a changed hotspot.
- `PRUNE-153` — edit/resend now queries the durable queued-turn promotion repository directly,
  deleting its single-use lookup pass-through while preserving the same thread/message key. Net
  runtime change: **-2 LOC**. Direct call equivalence and `git diff --check` are sufficient; no
  focused fixture was added. Cumulative pruning runtime change: **-937 LOC**. Next: continue only
  mechanically exact consolidation in a changed hotspot; ACP implementation remains frozen at its
  documented official-SDK canary and deletion boundary.
- `PRUNE-154` — deleted-thread attachment cleanup now lives directly in its side-effect loop,
  deleting two single-use nested functions while preserving safe-thread validation, shared entry
  resolution, and forced removal. Net runtime change: **-8 LOC**. Focused owning-thread deletion and
  unsafe-thread containment gates pass 2/2; `git diff --check` passes. Cumulative pruning runtime
  change: **-945 LOC**. Next: continue only mechanically exact consolidation in a changed hotspot;
  ACP implementation remains frozen at its documented official-SDK canary and deletion boundary.
- `PRUNE-155` — five ProjectionPipeline tests now reuse one typed append-then-project fixture factory
  instead of defining identical closures. Event payloads and assertions are unchanged. Net test-source
  change: **-3 LOC**. Focused attachment-prune and turn-conflict projection gates pass 2/2;
  `git diff --check` passes. Cumulative pruning runtime change remains **-945 LOC**. Next: continue
  only net-negative focused-test fixture consolidation; ACP implementation remains frozen.
- `PRUNE-156` — attachment pruning now lives directly in its sole side-effect loop, deleting the
  remaining single-use prune function while preserving shared entry resolution, file validation,
  retention, and forced removal. Net runtime change: **-8 LOC**. The focused legacy/managed prune gate
  passes 1/1; `git diff --check` passes. Cumulative pruning runtime change: **-953 LOC**. Next:
  continue only mechanically exact consolidation in a changed hotspot; ACP implementation remains
  frozen at its documented official-SDK canary and deletion boundary.
- `PRUNE-157` — seven ProviderService idle-cleanup tests now share one typed fake-session cursor
  omission helper instead of repeating the same callback. Timers, events, adapter calls, and
  assertions are unchanged. Net test-source change: **-17 LOC**. Focused persisted-cursor and failed-
  dispatch idle-restoration gates pass 2/2; `git diff --check` passes. Cumulative pruning runtime
  change remains **-953 LOC**. Next: continue only net-negative focused-test fixture consolidation;
  ACP implementation remains frozen.
- `PRUNE-158` — conversation rollback now calls the shared tail-turn collector directly, deleting its
  single-use type-only adapter while preserving the same messages and boundary message ID. Net runtime
  change: **-1 LOC**. Direct call equivalence and `git diff --check` are sufficient; no focused fixture
  was added. Cumulative pruning runtime change: **-954 LOC**. Next: continue only mechanically exact
  consolidation in a changed hotspot; ACP implementation remains frozen at its documented official-
  SDK canary and deletion boundary.
- `PRUNE-159` — six ProviderService assertions now share one permissive runtime-payload record
  coercion instead of repeating the same object check and cast. Array acceptance and assertions are
  unchanged. Net test-source change: **-13 LOC**. Focused overlapping-dispatch and runtime-ready
  settlement gates pass 2/2; `git diff --check` passes. Cumulative pruning runtime change remains
  **-954 LOC**. Next: continue only net-negative focused-test fixture consolidation; ACP implementation
  remains frozen.
- `PRUNE-160` — the preserve-queued-turns edit/resend branch now calls the durable promotion
  repository directly, deleting its single-use cancellation wrapper while preserving the same
  thread/message key and wall-clock timestamp. Net runtime change: **-2 LOC**. Direct call equivalence
  and `git diff --check` are sufficient; no focused fixture was added. Cumulative pruning runtime
  change: **-956 LOC**. Next: continue only mechanically exact consolidation in a changed hotspot;
  ACP implementation remains frozen at its documented official-SDK canary and deletion boundary.
- `PRUNE-161` — ProviderCommandReactor's test harness no longer returns the same `reactor` property
  twice consecutively. The duplicate overwrote the identical value, so the harness API is unchanged.
  Net test-source change: **-1 LOC**. Direct object-literal equivalence and `git diff --check` are
  sufficient; no focused fixture was added. Cumulative pruning runtime change remains **-956 LOC**.
  Next: continue only net-negative focused-test fixture consolidation; ACP implementation remains frozen.
- `PRUNE-162` — mirrored stale approval and user-input failure tests now share one typed harness thread
  reader instead of repeating poll-time and assertion-time read-model lookups. Predicates and assertions
  are unchanged. Net test-source change: **-5 LOC**. Both focused interaction-failure gates pass 2/2;
  `git diff --check` passes. Cumulative pruning runtime change remains **-956 LOC**. Next: continue
  only net-negative focused-test fixture consolidation; ACP implementation remains frozen.
- `PRUNE-163` — activity and proposed-plan projection retention now share one turn-scoped row owner
  for revert and one for conversation rollback, deleting four duplicated typed functions while
  preserving their exact predicates. Message and turn retention remain separate. Net runtime change:
  **-20 LOC**. Focused revert and conversation-rollback projection gates pass 2/2; `git diff --check`
  passes. Cumulative pruning runtime change: **-976 LOC**. Next: continue only mechanically exact
  consolidation in a changed hotspot; ACP implementation remains frozen at its documented official-
  SDK canary and deletion boundary.
- `PRUNE-164` — first-turn title and worktree-branch rename tests now reuse the typed harness thread
  reader instead of repeating read-model scans. Wait predicates and assertions are unchanged. Net
  test-source change: **-28 LOC**. Focused generated-title and fallback-branch gates pass 2/2;
  `git diff --check` passes. Cumulative pruning runtime change remains **-976 LOC**. Next: continue
  only net-negative focused-test fixture consolidation; ACP implementation remains frozen.
- `PRUNE-165` — runtime-mode/provider recovery tests now reuse the typed harness thread reader,
  deleting repeated thread scans. A misplaced uncertain-delivery assertion now lives in the failed-
  restart test that emits its command instead of the successful-restart test. Net test-source change:
  **-14 LOC**. Focused successful- and failed-restart gates pass 2/2; `git diff --check` passes.
  Cumulative pruning runtime change remains **-976 LOC**. Next: continue only net-negative focused-
  test fixture consolidation; ACP implementation remains frozen.
- `PRUNE-166` — lifecycle generation and response command ID now share one non-empty payload-string
  extractor, deleting two duplicated guards while retaining response-ID branding at its consumer.
  Request-ID and settlement rules remain separate. Net runtime change: **-5 LOC**. Focused reused-
  generation and failed-response correlation gates pass 2/2; `git diff --check` passes. Cumulative
  pruning runtime change: **-981 LOC**. Next: continue only mechanically exact consolidation in a
  changed hotspot; ACP implementation remains frozen at its documented official-SDK canary and
  deletion boundary.
- `PRUNE-167` — three Droid fork/sidechat recovery tests now reuse the typed harness reader for their
  custom thread IDs. Net test-source change: **-9 LOC**. Direct lookup equivalence and `git diff
--check` pass; two focused gates timed out because the reactor skipped each target thread as already
  quarantined before the unchanged predicate could succeed. Cumulative pruning runtime change remains
  **-981 LOC**. Next: continue only net-negative focused-test fixture consolidation; ACP implementation
  remains frozen.
- `PRUNE-168` — conversation-rollback turn retention now reuses the shared turn-scoped row owner,
  deleting its type-specific helper while preserving the empty-set fast path and exact removal
  predicate. Activities and proposed plans remain on that same owner; message rollback stays separate.
  Net runtime change: **-8 LOC**. The focused conversation-rollback projection gate passes 1/1;
  `git diff --check` passes. Cumulative pruning runtime change: **-989 LOC**. Next: continue only
  mechanically exact consolidation in a changed hotspot; ACP implementation remains frozen at its
  documented official-SDK canary and deletion boundary.
- `PRUNE-169` — final dense turn-start/edit-failure tests now reuse the typed harness thread reader
  instead of polling `threads[0]` and rescanning for `thread-1`. Status predicates and assertions are
  unchanged. Net test-source change: **-17 LOC**. Focused edit-start failure and observable-starting-
  session gates pass 2/2; `git diff --check` passes. Cumulative pruning runtime change remains
  **-989 LOC**. Next: close focused-test fixture pruning and retain the documented ACP boundary;
  ACP implementation remains frozen.
- `PRUNE-170` — message retention, turn-scoped activity/plan retention, and the turn projector now
  share one checkpoint-eligible revert-turn owner, deleting three predicate copies and the single-use
  retained-turn-ID wrapper. Net runtime change: **-10 LOC**. The focused removed-turn message-
  retention gate passes 1/1; `git diff --check` passes. Cumulative pruning runtime change:
  **-999 LOC**. Next: continue only mechanically exact consolidation in a changed hotspot; ACP
  implementation remains frozen at its documented official-SDK canary and deletion boundary.
- `PRUNE-171` — the bounded pruning checkpoint is closed. The five named provider/orchestration
  hotspots now have one fewer layer of duplicated ownership, with a cumulative runtime reduction of
  **999 LOC**. Nine focused-test fixture phases also removed **107 test-source LOC** without changing
  their predicates or assertions. The official ACP SDK seam, static Grok canary, no-fallback rule,
  parity gate, and full `effect-acp` deletion ledger remain defined but unimplemented. `git diff
--check` passes; heavyweight workspace checks remain deferred by instruction. Two focused Droid
  gates retain their recorded pre-predicate quarantine timeouts. Next: no implementation work until
  an unopened roadmap row or ACP cutover is explicitly unfrozen.
- `PRUNE-172` — `sendTurn`, `steerTurn`, and `startReview` now share one ProviderService dispatch-
  generation lifecycle owner, deleting three repeated idle-sensitive/suspend/begin/finish shells while
  preserving their method-specific routing, persistence, and analytics. Net runtime change: **-5 LOC**.
  Focused send persistence and overlapping steer/review generation gates pass 2/2; `git diff --check`
  passes. Cumulative pruning runtime change: **-1004 LOC**. The user then explicitly unfroze every
  remaining consolidated roadmap row for sequential implementation followed by one sweep.
- `PRUNE-173` — the residual `effect-acp` compatibility layer is deleted. Shared runtime/model code,
  Grok, Droid, Cursor, and focused tests use official SDK types directly; local `AcpErrors.ts` and
  `AcpExtensions.ts` retain only Effect-native runtime errors and non-standard extension codecs. The
  generated schema, workspace package, server dependency, release manifest entry, historical
  benchmark engine, and lockfile entries are gone. Focused ACP/provider gates pass **168/168** with
  3 environment-dependent tests skipped; official conformance passes **10/10**, the server build and
  official-only benchmark smoke pass, and zero-import plus `git diff --check` searches pass.
  Heavyweight workspace verification remains deferred by instruction.

## Per-workstream loop

1. Set the row to `IN PROGRESS` and update **Current pointer**.
2. Read the exact finding in
   [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md);
   do not load unrelated findings.
3. Inspect cited symbols, callers, existing tests for behavior, and the current diff.
4. State a small in-scope/out-of-scope boundary.
5. Implement one coherent phase, adapting to existing changes rather than replacing them.
6. Inspect the diff for scope leakage and duplicated old/new authority.
7. Run only a necessary small check, or record verification as deferred.
8. Update the finding in
   [`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md)
   with implementation status and concise evidence.
9. Update this table and pointer.
10. Report files changed, behavior, duplication removed, checks run/deferred, risks, and next
    eligible item.

## ACP completion rule

`P2-ACP-01` is code-complete at the approved wire seam inside `AcpSessionRuntime`; no provider-level
SDK facade exists. Grok, Droid, and Cursor all fail through the official SDK path—an operation is
never retried through `effect-acp`. The official SDK owns validation, JSON-RPC correlation and
cancellation, handler dispatch, and NDJSON encoding. Synara retains Effect lifecycle, bounded
admission, process teardown, product/session policy, normalized events, three local Effect-native
errors, and minimal non-standard extension codecs. No `effect-acp` package or import remains.

## Completion rule

The roadmap is code-complete when every row is `DONE`, `CODE COMPLETE`, or explicitly
`REJECTED`/`BLOCKED` with evidence; duplicate authorities and dormant competing scaffolds have
been removed or safely activated; and both this controller and
[`audit/PR357_MERGE_READINESS_AUDIT.md`](../audit/PR357_MERGE_READINESS_AUDIT.md) agree.

It is not release-verified until the user separately authorizes the repository-required full
verification pass.
