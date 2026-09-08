# Synara platform-readiness audit — 2026-09-08

## Decision

**Do not position the current repository as a hosted, multi-tenant AI development
platform yet.** It is a capable and unusually well-tested *local-first agent
workstation*. The recent cloud work establishes useful contracts and a PostgreSQL data
model, but it does not yet provide the cloud control plane, execution plane, or
operational boundary that turns those foundations into a SaaS product.

This is a new platform audit, not a replacement for the focused local-runtime audit in
[`PR357_MERGE_READINESS_AUDIT.md`](./PR357_MERGE_READINESS_AUDIT.md). The latter remains
the source of truth for its local provider/ACP follow-ups. This document identifies the
missing product boundaries and orders the next work so that we do not accidentally ship
a browser skin over a user's local server as “cloud”.

## Audit method and scope

- Inspected all workspace packages, source/test inventories, package scripts, SQL
  migrations, CI/release workflow inventory, the local server entrypoint, and the
  existing audit/roadmap material.
- Performed static, evidence-backed review only. No source was changed and no tests,
  builds, formatters, linters, or typecheckers were run.
- The requested Codex read-only secondary audit could not run because the `codex`
  executable is unavailable in this environment. Its absence is recorded as an
  environment limitation, not as a product finding.
- Findings below describe currently observed code, not hypothetical scale problems.
  “Missing” means no production implementation, deployment manifest, or runtime
  integration was found in this repository at the audit date.

## What is already credible

1. **Local agent execution has substantial foundations.** `apps/server` contains the
   provider, orchestration, workspace, WebSocket, persistence, device, Git, and
   browser-automation subsystems, with focused tests co-located throughout. The local
   process starts the `ServerLive` layer directly from the CLI entrypoint.
2. **The cloud domain has been named before implementation.** `packages/contracts/src/cloud.ts`
   supplies schema-only types for organizations, workspaces, tasks, events, runners,
   and lifecycle commands. This is a good public-boundary starting point.
3. **The database design has useful tenant fences.** The control-plane migrations define
   organization keys, composite foreign keys, RLS policies, forced RLS, and separate
   identity credential tables. That is better than adding tenancy after the fact.
4. **Local persistence and recovery are serious concerns in the existing product.** The
   server continues to use a local `state.sqlite` and a provider event log, with
   migration/recovery code and orchestration replay. Preserve this quality bar when
   introducing cloud durability.

Those are foundations, not proof of a cloud platform. In particular, the contracts
explicitly call the runner interaction a “design sketch … not wired to any transport
yet,” which accurately describes the current state.

## Findings and required work

### P0-PLATFORM-01 — There is no deployable cloud control-plane application

**Evidence.** `apps/cloud-control` contains only three SQL migration files; it has no
`package.json`, source application, test suite, migration runner, container image, or
deployment configuration. The only server executable is the local CLI, which wires
`ServerLive`. No Cloudflare, Kubernetes, Terraform, Docker, or equivalent deployment
definition was found.

**Impact.** The web app can render cloud authentication routes but no repository-owned
service can answer them. There is no place to enforce organization authorization,
provision workspaces, issue cookies, write audit records, or expose a production health
endpoint.

**Required remediation.** Create one independently deployable `apps/cloud-control`
service before adding more cloud UI:

- own configuration validation, PostgreSQL connection pool, migration execution, health
  and readiness probes, structured logs, metrics, and trace/request IDs;
- expose versioned HTTP and event-stream APIs from `@synara/contracts` schemas;
- execute `SET LOCAL synara.user_id` and `SET LOCAL synara.organization_id` in every
  request transaction through one database access boundary;
- use a non-owner application database role, and make migrations/deployment a separate
  credential and pipeline.

**Exit gate.** A clean environment can migrate, start, pass readiness, create and read
an organization through authenticated HTTP, and prove that a query without tenant
context returns no tenant rows.

### P0-PLATFORM-02 — Cloud authentication is UI/protocol-only; no server identity flow exists

**Evidence.** The web gateway POSTs to `/api/cloud/auth/login` and `/signup`, starts
OAuth by browser navigation, and expects an HttpOnly-cookie session. No matching route
or cloud service exists under `apps/server`; its `AuthControlPlane` issues local pairing
links and bearer sessions backed by the local server's secret/session services instead.
The SQL migrations hold password and identity tables but do not implement password
hashing, cookie issuance, CSRF, OAuth PKCE, verification delivery, rate limits, session
rotation, or account recovery.

**Impact.** Login/signup UI cannot establish a cloud session in this repository. Trying
to reuse local pairing credentials for browser/cloud identity would merge distinct trust
domains and create an unacceptable tenant boundary.

**Required remediation.** Implement cloud identity only inside P0-PLATFORM-01, with a
dedicated auth service boundary: Argon2id policy, verified-email policy, opaque
server-side session rotation, Secure/HttpOnly/SameSite cookies, CSRF protection,
rate-limited login/recovery, OAuth state/nonce/PKCE validation, and revocation/audit
events. Keep GitHub user login separate from GitHub App repository authorization, as the
contracts already require.

**Exit gate.** Browser and API tests cover signup, verification, login, logout, expired
and rotated sessions, CSRF rejection, brute-force throttling, OAuth callback replay, and
cross-organization access denial.

### P0-PLATFORM-03 — There is no execution-plane isolation or workspace provisioning authority

**Evidence.** Cloud contracts describe `container-hardened`/`microvm` isolation and
provision/terminate/heartbeat messages, but state that this interaction is not wired to
any transport. The repository has no runner service, image build, sandbox policy,
scheduler, queue, or cloud network policy. Existing workspace and provider systems are
part of the local Node/Bun server and operate against local paths and child processes.

**Impact.** Accepting a hosted task today would require an undefined execution
environment. That would risk cross-tenant filesystem/process/network access, stranded
workspaces, unbounded cost, and credentials appearing in the wrong process.

**Required remediation.** Define and implement a separate execution plane with one
minimal runner protocol: signed runner registration, per-workspace lease + generation,
idempotent provision/terminate commands, heartbeats, reconciliation, immutable base
images, resource quotas, egress allowlists, secret injection with expiry, and a
default-deny filesystem/network/process policy. Start with one isolation technology and
one region; do not claim microVM support until it is executed and tested.

**Exit gate.** A fault-injection integration suite proves no two runners own a workspace
generation, lease expiry tears down resources, a stale runner cannot publish events, a
tenant cannot reach another workspace or metadata IP, and interrupted provisioning is
reconciled without duplicate billing/resource creation.

### P0-PLATFORM-04 — Cloud persistence has schema but no command/event consistency model

**Evidence.** The SQL schema contains `workspaces`, `tasks`, `task_events`, and quota
tables, while `CloudEvent` exposes an unconstrained `payload: Schema.Unknown`. There is
no repository implementation of a cloud command handler, outbox, idempotency key,
event-stream cursor, transaction boundary, or runner-event ingestion endpoint. The
local orchestration event log/replay mechanism is not connected to the cloud tables.

**Impact.** A retry, browser reconnect, or runner crash would have no defined exactly-once
*effect* boundary. Task state, UI transcript, quota, and runner status could diverge.

**Required remediation.** Before onboarding users, choose one durable authority per
cloud aggregate: transactional command handling plus an outbox, monotonic aggregate
sequence, client idempotency key, cursor-based replay, and projection version/fence.
Replace unbounded event payloads at external boundaries with discriminated, versioned,
size-limited schemas. Persist command intent before handing work to a runner; reconcile
unknown outcomes rather than replaying mutations blindly.

**Exit gate.** Kill/restart tests at every handoff prove duplicate requests/events do not
duplicate work, reconnect replays an ordered gap-free stream, malformed/oversized runner
input is rejected, and a cloud task reaches a terminal or explicitly `uncertain` state.

### P1-PLATFORM-05 — The product currently has two unrelated control planes

**Evidence.** The local server's `AuthControlPlane` is explicitly a pairing/bearer
session service with local `owner`/`client` roles. Cloud contracts explicitly state that
organization roles do not overlap those roles. The web root bypasses local event
hydration for `/login` and `/signup`, then otherwise requires a local native API.

**Impact.** There is no product-level session topology: which account owns a local
workspace, which cloud organization is active, how a desktop client attaches to a cloud
workspace, and how local/offline and cloud state converge are undefined.

**Required remediation.** Publish a short session/topology RFC before wiring the two:
separate browser user session, desktop-device credential, runner workload identity, and
provider credential; define their issuers, audience, TTL, revocation, storage location,
and allowed API paths. Then add a cloud-workspace connection adapter rather than making
local WebSocket state globally multi-tenant.

**Exit gate.** Threat-model review and integration tests demonstrate that a desktop
credential cannot act as a browser user, a browser cookie cannot act as a runner, and
organization switching cannot leak prior tenant state in the UI or event stream.

### P1-PLATFORM-06 — Repository and provider credentials need hosted ownership semantics

**Evidence.** The cloud schema reserves encrypted GitHub connection storage, but there is
no key-management integration, GitHub App installation exchange, credential rotation,
or runner secret-delivery implementation. The current server's provider adapters are
local-first and launch child processes; the existing audit correctly emphasizes
server-only provider credentials and minimal child capabilities.

**Impact.** A cloud rollout could otherwise put personal OAuth/API keys into runner
images, logs, browser state, or persistent workspace volumes, and cannot safely revoke
access after membership/repository changes.

**Required remediation.** Use a KMS-backed envelope-encryption service with key-version
rotation for cloud connections. Prefer a GitHub App with installation-scoped, short-lived
tokens. Bind every secret issue to workspace/organization/lease/audience and redact it
at process, event, audit, and support-export boundaries. Define which providers are
supported in hosted mode before porting adapters.

**Exit gate.** Security tests prove token redaction, expiry/revocation after membership
or repository removal, no token in database query logs/runner logs/serialized events,
and a runner cannot redeem a secret for another workspace or provider.

### P1-PLATFORM-07 — No cloud SLO, observability, incident, or cost-control boundary exists

**Evidence.** There are local diagnostics and release scripts, but no cloud service,
deployment, alert configuration, central telemetry schema, tenant-aware audit query,
usage-meter pipeline, or documented operational runbook. SQL has `audit_log` and
`quota_usage`, but no writer/reconciler or retention policy implementation.

**Impact.** Production failures would be discovered by customers, while agent/runtime
costs could grow without a hard admission or shutdown point.

**Required remediation.** Define launch SLOs and dashboards before beta: control-plane
availability/latency, task queue latency, workspace-provision duration, event delivery
lag, runner reconciliation age, provider failure rate, and cost/tenant/day. Emit
correlated structured events at each command and runner handoff; implement hard quota
admission plus a reconciled usage ledger; write incident and data-export/deletion
runbooks.

**Exit gate.** A staged-load and failure drill produces actionable dashboards, alerts,
per-tenant cost attribution, and an auditable trace from browser request to runner
termination.

### P1-PLATFORM-08 — Delivery pipeline is mature for local releases, not a cloud service

**Evidence.** GitHub workflows cover CI, release, marketing, and device matrices, but
the repository has no cloud service artifact, environment promotion, infrastructure
plan/apply, migration deployment lock, secret-management definition, or rollback
manifest.

**Impact.** Even a correct control-plane application could be deployed manually with
unreviewed database changes and no reproducible rollback.

**Required remediation.** Add cloud delivery only after P0-PLATFORM-01 has a runnable
service: immutable image/SBOM/provenance, separate preview/staging/production accounts,
least-privilege deployment identity, migration lock and backward-compatible migration
gate, smoke test, canary, rollback, and secret scanning. Do not merge cloud migrations
that cannot be applied and rolled forward by the service pipeline.

**Exit gate.** A staging promotion performs a migration, deploys an immutable artifact,
passes end-to-end tenant/runner smoke tests, then demonstrably rolls application traffic
back without data loss.

### P2-PLATFORM-09 — The user-facing cloud narrative is ahead of product capability

**Evidence.** Login/signup copy says users can “resume cloud workspaces and agent tasks,”
although the server application and execution plane do not exist. The contracts are
explicitly a design sketch and the cloud directory contains migrations only.

**Impact.** This creates a support and trust problem, especially if the routes are
reachable in a release build configured with a cloud URL.

**Required remediation.** Keep cloud login/routes behind an explicit, default-off
capability flag until P0 launch gates pass, or change copy to a waitlist/private-preview
state. Add one release check that rejects a public cloud URL without the deployed
control-plane compatibility/version check.

**Exit gate.** Production builds cannot present a broken sign-in flow; preview access is
restricted to tenants and service versions allowed by the control plane.

## Ordered program of work

1. **Architecture decision (one short RFC):** choose the cloud control-plane runtime,
   PostgreSQL provider, runner isolation technology, identity provider/email delivery,
   regions, and single-tenant beta limits. Freeze the four credential classes and the
   command/event ownership model.
2. **P0-PLATFORM-01 + P0-PLATFORM-02:** ship a tiny control plane that supports only
   authenticated organization/session lifecycle and read-only workspace listing. No
   provider execution yet.
3. **P0-PLATFORM-04:** add the durable command/outbox/stream foundation and its
   restart/replay corpus.
4. **P0-PLATFORM-03:** introduce one sandboxed runner path and provisioning
   reconciliation, initially for an internal tenant only.
5. **P1-PLATFORM-05 through 08:** connect a desktop/browser client through the dedicated
   cloud boundary, then add secrets, observability/quotas, and deploy automation.
6. **Private beta:** one region, a small explicit provider allowlist, fixed workspace
   templates, hard quotas, no arbitrary inbound network exposure, and on-call ownership.
7. **Only then:** collaborative features, multi-region placement, broader provider
   marketplace, shared workspaces, and generic plugin/runner abstractions.

## Non-negotiable platform invariants

- A cloud request has one authenticated user, selected organization, request ID, and
  transaction-scoped tenant context; absence of either identity fails closed.
- A workspace has one current runner lease/generation; stale agents cannot mutate its
  state or deliver events.
- Every irreversible external effect is preceded by durable intent and is idempotent or
  reconciled as `uncertain`.
- Browser, desktop, runner, provider, and repository credentials are separate in issuer,
  audience, storage, and revocation path.
- Tenant data, secrets, transcripts, files, logs, metrics, and support exports are
  scoped and redacted by default.
- Local-first behavior remains supported; cloud adoption must not turn a local CLI into
  a remote multi-tenant server by configuration accident.

## Audit closeout

This audit intentionally adds no implementation tickets to the local-runtime roadmap.
The immediate next engineering change should be the platform RFC and a minimal deployable
cloud-control skeleton, not additional cloud UI, tables, or provider adapters. Re-audit
after the skeleton exists using running integration tests and a real non-production
deployment; static review cannot certify isolation, RLS transaction wiring, delivery
semantics, or operational readiness.
