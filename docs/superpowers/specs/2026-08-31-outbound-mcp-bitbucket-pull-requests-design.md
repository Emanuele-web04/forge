# Outbound MCP connections and Bitbucket pull requests

**Date:** 2026-08-31
**Branch:** `feature/bitbucket-mcp-paraty`
**Status:** Approved design

## Summary

Synara will gain a reusable, application-owned client for authenticated remote MCP servers. The
first consumer will read Bitbucket pull requests for local Paraty repositories through Paraty MCP.
This makes the immediate feature useful for repositories such as `paraty/payment-seeker` while
keeping the underlying capability suitable for upstream Synara: future product features can use
authenticated MCP services without depending on Codex, Claude, or another agent runtime.

The first release deliberately separates generic infrastructure from product exposure. The server,
contracts, OAuth flow, credential storage, transport, tool discovery, and tool-call boundary will be
generic. The user interface will initially expose one guided `Paraty MCP` preset rather than an
arbitrary MCP URL form.

Bitbucket support will be read-only. It will list pull requests, load details, render unified diffs,
and show comments. It will not clone repositories, publish or resolve comments, merge pull requests,
or change their state.

## Goals

- Give Synara its own authenticated outbound MCP connection layer.
- Keep outbound MCP independent from provider sessions and from the inbound MCP integration Synara
  already exposes to external agents.
- Detect supported remote repositories from local project Git configuration.
- Add provider-neutral pull request identities, capabilities, contracts, caching, and presentation.
- Show Bitbucket pull requests alongside GitHub pull requests without degrading GitHub when MCP is
  disconnected or unavailable.
- Use the existing Paraty MCP Bitbucket tools for every supported Bitbucket provider operation.
- Make the architecture credible for promotion to upstream Synara rather than embedding a one-off
  Paraty API client in the pull request service.

## Non-goals

- A general-purpose UI for adding arbitrary MCP endpoint URLs.
- Local `stdio` MCP servers. The first transport is remote Streamable HTTP.
- Repository search, cloning, or project creation from Bitbucket.
- Bitbucket write operations, including comments, resolutions, merge, close, or reopen.
- Bitbucket rows in the `Reviewing` or `Authored` filters. The current Paraty MCP catalog does not
  expose the authenticated Bitbucket identity or review requests needed to compute those filters.
- Direct Bitbucket API calls, Bitbucket credentials, or provider-specific CLIs.
- Reusing OAuth tokens or MCP configuration owned by Codex, Claude, or another client.
- A generic web RPC that lets the browser invoke arbitrary MCP tools.
- Support for Bitbucket workspaces other than `paraty` in this first consumer.

## Terminology

- **Outbound MCP connection:** a remote MCP server that Synara calls as a client.
- **Inbound MCP integration:** Synara's existing restricted MCP server used by external coding
  agents. It remains a separate subsystem and authority model.
- **Preset:** product-owned metadata that selects a known MCP endpoint and declares the consumer
  capabilities expected from it.
- **Consumer:** a server-side feature that is permitted to invoke a declared subset of tools on one
  outbound connection.
- **Remote repository identity:** provider, host, owner or workspace, and repository slug.

## Architecture

### 1. Generic outbound MCP subsystem

Add a focused server module, separate from `externalMcp` and `agentGateway`, with these boundaries:

#### `McpConnectionService`

Owns connection lifecycle and exposes typed operations to server-side consumers:

- list connection metadata;
- begin an interactive authorization attempt;
- finish or cancel authorization;
- validate or reconnect a connection;
- disconnect and remove stored credentials;
- inspect cached server capabilities and tool metadata;
- invoke a tool through an explicitly registered consumer binding.

The service does not expose raw tokens. It also does not expose a browser-facing `callTool` method.
Web RPCs cover lifecycle and status only.

Starting authorization returns a short-lived attempt id and authorization URL. The web client opens
that URL only after the user's action, then observes connection status through the normal server
query invalidation path. The OAuth callback consumes the attempt once and renders a minimal success
or failure page; it does not return tokens to the browser.

#### `McpOAuthSession`

Implements the MCP OAuth authorization-code flow using the official TypeScript MCP SDK:

- protected-resource and authorization-server metadata discovery;
- PKCE and a cryptographically random, single-use `state` value;
- dynamic client registration when the authorization server supports it;
- browser authorization and a loopback callback owned by the local Synara server;
- authorization-code exchange;
- refresh-token rotation;
- typed handling for cancellation, expiry, revoked credentials, insufficient scope, and discovery
  failures.

If an authorization server does not support dynamic registration, a preset may provide a public
client id and fixed metadata. No client secret may be compiled into Synara. Supporting user-entered
client registration details belongs to the later arbitrary-URL UI; a server that supports neither
dynamic registration nor a safe preset client is reported as incompatible in this release.

The flow starts only from an explicit Connect or Reconnect action. Background data loading never
opens an authorization window. A server restart invalidates an unfinished attempt and the user can
start again; unfinished code verifiers do not need durable recovery.

The MCP SDK must become an explicit server dependency. Synara must not rely on the currently
transitive SDK dependency supplied by another provider package.

#### `McpToolClient`

Owns Streamable HTTP sessions, initialization, tool discovery, calls, cancellation, and shutdown.
Connections are lazy and bounded rather than permanently opening one transport per configured
server. The client applies:

- per-connection concurrency limits;
- single-flight connection and token refresh;
- request timeout and abort propagation;
- maximum response size;
- bounded tool-catalog and result caches where appropriate;
- clean transport disposal after invalidation or an unrecoverable auth error.

#### Consumer bindings

A consumer binding declares:

- a stable consumer identifier;
- the preset or connection kinds it accepts;
- exact required and optional tool names;
- the operations it may invoke;
- Effect Schema decoders for tool arguments and normalized results.

Tool discovery validates the required catalog before a connection becomes usable by that consumer.
A connected server with missing or incompatible tools has status `incompatible` for that consumer,
not `connected`.

The first binding is the Paraty Bitbucket pull request provider and permits only:

- `paraty_bitbucket_pr_list`;
- `paraty_bitbucket_pr_get`;
- `paraty_bitbucket_pr_diff`;
- `paraty_bitbucket_pr_comment_list`.

Write-capable Paraty tools are intentionally outside the binding even if the server advertises
them.

### 2. Persistence and secret storage

SQLite stores non-secret connection metadata:

- connection id;
- preset id;
- display name;
- canonical MCP endpoint;
- creation and update timestamps;
- last successful validation time;
- server identity and a bounded tool-catalog fingerprint;
- last non-sensitive status and error category.

OAuth client information and tokens are stored outside SQLite under the Synara data directory, for
example `<synara-home>/mcp/connections/<connection-id>.json`. The credential directory and file use
the same private, atomic-write discipline as Synara's existing local MCP credential bridge: `0700`
for the directory and `0600` for files on POSIX systems. Windows receives the same local-profile
placement and an explicit warning that POSIX modes are unavailable.

Credential files may contain the registered client information, access token, refresh token,
expiry, granted scopes, and authorization-server identity. They must never be copied into:

- application logs;
- telemetry;
- SQLite events or snapshots;
- WebSocket payloads;
- error messages;
- export or diagnostic bundles.

Disconnect revokes locally by deleting the credential file and invalidating live transports and
caches. Remote pull request results remain memory-only and are not added to durable persistence.
Remote token revocation is used only when the discovered server advertises a standards-based
revocation endpoint; local cleanup must succeed even if remote revocation fails.

### 3. Network and OAuth security boundary

The first Paraty preset pins an HTTPS MCP resource endpoint. The generic layer still applies the
shared outbound HTTP policy so enabling custom URLs later does not create a second, weaker network
stack.

Security requirements:

- reject non-HTTPS remote resource URLs, except a future explicitly designed loopback-only mode;
- validate every redirect and rediscovered endpoint through outbound policy;
- bind access tokens to the MCP resource connection for which they were issued;
- send access tokens only to that resource origin;
- allow the discovered authorization server to use a different origin, as required by MCP OAuth,
  without sending the resource access token to arbitrary hosts;
- validate issuer metadata and OAuth callback issuer data supported by the SDK;
- use exact callback state matching and one-time completion;
- expose the OAuth callback only on a loopback-bound Synara server; remote or published server mode
  disables interactive outbound MCP authorization until a separately secured callback design is
  provided;
- require normal Synara request authentication for lifecycle RPCs such as Connect, Reconnect, and
  Disconnect; the callback itself may complete only the pending connection identified by its
  unguessable, one-time OAuth state;
- redact authorization codes, tokens, client secrets, and sensitive query parameters;
- cap metadata, catalog, and tool-result bodies before buffering them;
- never silently weaken issuer validation to make a server connect.

## Provider-neutral repositories and pull requests

### 1. Remote repository discovery

Replace the GitHub-only inventory shape with a provider-neutral `RemoteRepositoryRef` containing:

- `provider`: initially `github` or `bitbucket`;
- `host`;
- `owner` or `workspace`;
- `slug`;
- canonical web URL;
- canonical identity key.

Repository identity includes the provider and normalized host. A representative key is
`bitbucket:bitbucket.org:paraty/payment-seeker`. This prevents collisions with a GitHub repository
that has the same owner and slug.

Remote discovery keeps the current branch-aware precedence rules but recognizes credential-free
Bitbucket HTTPS and SSH URLs. The first Bitbucket provider accepts only `bitbucket.org/paraty/*`.
Other Bitbucket workspaces remain ordinary local Git repositories with no remote PR provider.

Inventory remains authoritative only when Git configuration was read successfully. A partial or
failed inventory must not remove persisted PR pins.

### 2. Pull request provider interface

Refactor `PullRequestService` to orchestrate provider adapters instead of directly orchestrating
`GitHubCli`. A provider interface covers:

- viewer identity when supported;
- list;
- detail;
- diff;
- comments;
- optional mutation operations;
- repository and pull request capabilities.

The existing GitHub behavior moves behind a GitHub adapter with no intended feature regression. The
Paraty Bitbucket adapter depends on the outbound MCP consumer binding.

Each provider owns its concurrency queue, single-flight keys, cache namespace, error normalization,
and refresh behavior. The aggregate service combines successful repository batches and returns
repository-scoped errors. A global GitHub failure does not erase Bitbucket data, and an MCP failure
does not erase GitHub data.

### 3. Contract changes

Pull request contracts gain provider-aware identity and capability information:

- `provider` on list entries, details, batches, errors, selection inputs, and pin mutations;
- repository identity separate from the display string;
- effective capabilities for detail, diff, comments, checks, comment mutation, state mutation, and
  merge;
- optional or explicitly unavailable additions, deletions, changed-file count, checks,
  mergeability, merge methods, stack metadata, and fields not supplied by a provider;
- viewer involvement with values `author`, `review-requested`, `none`, and `unknown`.

Compatibility defaults decode absent `provider` as `github` during rolling development restarts.
New optional capability fields default to existing GitHub behavior only for legacy GitHub payloads.
They never default a Bitbucket row to writable.

The PR route selection adds an optional provider value that defaults to GitHub for old URLs. Cache
keys, row keys, detail queries, and mutation keys include provider identity.

### 4. Pins migration

Add a provider column to project pull request pins with `github` as the migration default. The unique
identity becomes project id, provider, repository key, and pull request number. Existing GitHub pins
remain valid.

Stale-pin cleanup considers a repository absent only when the matching provider inventory is
authoritative. A disconnected MCP connection does not imply that the local Bitbucket remote was
removed and must not delete Bitbucket pins.

## Paraty Bitbucket mapping

### Repository eligibility

A local remote is eligible when its canonical identity is `bitbucket.org/paraty/<slug>`. The MCP
workspace argument is `paraty`, and the repository argument is the parsed slug. `payment-seeker`
therefore maps to workspace `paraty`, repository slug `payment-seeker`.

### List

Use `paraty_bitbucket_pr_list` with bounded pages and newest-update ordering. Normalize states:

- `OPEN` to `open`;
- `MERGED` to `merged`;
- `DECLINED` to `closed`.

The existing state tabs remain available. Bitbucket rows appear in `All` only. Because current-user
identity and review requests are unavailable, their viewer involvement is `unknown`; they are
excluded from `Reviewing` and `Authored`, and grouped with the neutral remainder in the `All` view.

Bitbucket list responses do not provide additions and deletions. Those values remain unavailable,
not zero. Pagination is bounded per repository and reports truncation through the existing batch
concept.

### Detail and comments

Use `paraty_bitbucket_pr_get` for title, body, state, author, participants, branches, timestamps, URL,
and head commit when available. Missing GitHub-only concepts remain unavailable.

Use `paraty_bitbucket_pr_comment_list` for a bounded, paginated read of comments. Normalize authors,
timestamps, body, thread relationships, inline path and line placement where the existing timeline
can represent them. The result reports truncation and incompleteness instead of silently dropping
additional pages or malformed comments.

No comment composer or resolve controls are rendered for Bitbucket. The server also rejects a
fabricated write request based on provider capabilities.

### Diff

Use `paraty_bitbucket_pr_diff` and pass the bounded unified patch into the existing diff renderer.
The application applies its own maximum size even though the MCP tool already returns bounded text.
Truncation is visible to the user.

## User experience

### Settings

`Settings -> Integrations` distinguishes the two MCP directions:

- **Services Synara uses** contains outbound MCP connections and initially exposes the `Paraty MCP`
  preset.
- **Agents connected to Synara** retains the current inbound external MCP integration UI.

The Paraty preset exposes these states:

- disconnected;
- authorizing;
- connected;
- reconnect required;
- incompatible;
- temporarily unavailable.

Connect and Reconnect are explicit actions. Disconnect requires confirmation because it removes
local credentials, but it does not delete projects or pins. The status UI shows non-sensitive,
actionable errors and the last successful validation time.

### Pull request list

When an eligible Bitbucket remote exists and Paraty MCP is disconnected, the pull request view shows
one restrained connection prompt rather than one error per project. GitHub results remain usable.

After connection:

- GitHub and Bitbucket rows share the current list;
- provider icon and accessible provider text identify their source;
- unsupported diff stats and status indicators are omitted;
- Bitbucket rows remain visible in `All` for open, merged, and closed states;
- Bitbucket rows are absent from `Reviewing` and `Authored`;
- search and project filtering work across both providers.

### Pull request detail

The existing summary, code, and timeline surfaces are reused when supported. Sections with no
provider capability are absent rather than disabled placeholders. Bitbucket never renders merge,
ready/draft, close/reopen, comment, or resolve controls.

If credentials expire while cached data is visible, Synara keeps the cached data, marks it stale,
and offers Reconnect. A refresh failure must not replace useful cached results with an empty list.
An explicit Disconnect is different: it clears provider caches and replaces Bitbucket content with
the connection prompt while leaving GitHub results available.

## Failure handling

Failures are classified so the UI can choose a useful action:

- `not-connected`: show Connect;
- `authorization-required` or `credential-revoked`: show Reconnect;
- `authorization-cancelled`: return to disconnected without a destructive error;
- `incompatible-tools`: explain which required capability is missing without exposing schemas or
  secrets;
- `network`, `timeout`, or `rate-limited`: preserve cached data and allow retry;
- `invalid-response`: identify the affected provider and repository, skip malformed entries, and
  preserve other batches;
- `repository-not-found` or `forbidden`: show a repository-scoped error;
- `cancelled`: stop work without converting cancellation into a user-visible provider failure.

OAuth refresh and connection setup are single-flight. Read concurrency is bounded both globally for
the connection and per aggregate PR request so a large project inventory cannot overload Paraty MCP.

## Testing strategy

### Contracts and shared utilities

- Parse GitHub and Bitbucket HTTPS and SSH remotes.
- Reject unsupported hosts, workspaces, malformed slugs, and credential-bearing URLs.
- Verify provider-aware identity, cache keys, route selection, and pin identity.
- Verify legacy GitHub decoding defaults and read-only Bitbucket capability defaults.
- Verify state and viewer-involvement filtering.

### Outbound MCP server module

- Use a fake MCP transport and OAuth authority; tests must not require the real Paraty service.
- Cover metadata discovery, PKCE, state validation, dynamic registration, callback completion,
  refresh rotation, cancellation, revoked credentials, issuer mismatch, timeout, response limits,
  and cleanup.
- Verify token redaction from errors, logs, events, RPC responses, and persisted metadata.
- Verify tool discovery, compatibility checks, consumer allowlists, schema decoding, cancellation,
  single-flight refresh, and concurrency limits.
- Verify credential file permissions and atomic replacement on supported platforms.

### Pull request service

- Preserve the current GitHub suite behind the new adapter boundary.
- Cover mixed GitHub and Bitbucket inventories, deduplication, pagination, pins, force refresh, and
  partial failures.
- Cover all Bitbucket state mappings and unavailable fields.
- Prove that Bitbucket writes are rejected server-side.
- Prove that a disconnected MCP connection never triggers stale-pin deletion.

### Web

- Cover integration states and explicit connect, reconnect, and disconnect actions.
- Cover the eligible-project connection prompt and its absence when no eligible remote exists.
- Cover mixed-provider lists, icons, filtering, search, cached stale data, and partial errors.
- Cover detail sections and the absence of every unsupported Bitbucket action.
- Exercise the OAuth callback and pull request read flow in browser tests using a fake local MCP
  authority.

### Acceptance flow

With a local `payment-seeker` checkout:

1. Add the existing folder to Synara.
2. Detect `bitbucket.org/paraty/payment-seeker` without project-specific configuration.
3. Show the Paraty MCP connection prompt.
4. Complete OAuth once.
5. List open Bitbucket pull requests in `All`.
6. Open a pull request and load summary, comments, and unified diff.
7. Confirm no Bitbucket write action is present or accepted by the server.
8. Simulate expiry and confirm GitHub and cached Bitbucket data remain usable with a Reconnect
   prompt.
9. Disconnect explicitly and confirm Bitbucket cache is cleared while GitHub remains usable.

## Rollout and upstream framing

The implementation should be reviewed as two conceptual layers even if delivered in one feature
branch:

1. generic authenticated outbound MCP connections;
2. provider-neutral pull requests with a Paraty Bitbucket consumer.

The generic layer must not import Paraty-specific tool names or repository rules. The Paraty preset
and Bitbucket adapter depend on generic interfaces, never the reverse. This boundary lets an
upstream PR present the reusable MCP client as a Synara capability while keeping provider consumers
small, optional, and replaceable.

No feature flag is required for users without eligible repositories: without a configured outbound
connection or a matching Bitbucket remote, behavior remains the current GitHub-only experience.

## Completion criteria

- Synara owns and persists a standards-compliant outbound MCP OAuth session.
- The generic server boundary can support another preset and consumer without modifying OAuth,
  transport, or credential storage.
- A local `paraty/payment-seeker` remote is detected automatically.
- Bitbucket PR list, detail, diff, and comments work through Paraty MCP only.
- Bitbucket remains read-only in both UI and server enforcement.
- `All` and state filters behave as specified; `Reviewing` and `Authored` exclude unknown Bitbucket
  involvement.
- GitHub behavior and legacy data remain compatible.
- MCP, repository, and provider failures remain partial and preserve cached usable data.
- Secrets do not cross the documented storage, logging, telemetry, or RPC boundaries.
- Focused automated tests and the `payment-seeker` acceptance flow pass.

## References

- MCP authorization specification: <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- MCP TypeScript client guide: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md>
- Existing Synara pull request service: `apps/server/src/pullRequests/`
- Existing Synara inbound MCP integration: `apps/server/src/externalMcp/`
- Existing Synara agent gateway: `apps/server/src/agentGateway/`
