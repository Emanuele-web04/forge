# Authenticated Outbound MCP Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Synara a reusable, application-owned client for authenticated remote MCP services and expose a guided Paraty MCP connection in Settings.

**Architecture:** Add an `outboundMcp` server subsystem that owns non-secret connection metadata, private OAuth credentials, MCP SDK transports, consumer tool allowlists, and lifecycle RPCs. Keep it independent from provider runtimes and the existing inbound `externalMcp` subsystem; only lifecycle/status crosses the WebSocket boundary, while OAuth completion uses a loopback HTTP callback.

**Tech Stack:** TypeScript, Effect services/layers and Schema, SQLite migrations, `@modelcontextprotocol/sdk@1.29.0`, Streamable HTTP, OAuth 2.1/PKCE, React 19, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-outbound-mcp-bitbucket-pull-requests-design.md`

## Global Constraints

- This plan is phase 1; complete it before `docs/superpowers/plans/2026-08-31-bitbucket-pull-request-provider.md`.
- The generic `outboundMcp` core must not import Paraty tool names; those live only in `presets/paraty.ts`.
- Only remote Streamable HTTP is supported; resource endpoints must use HTTPS.
- This release exposes the guided Paraty preset only; it does not expose arbitrary URL entry, local `stdio` MCP servers, or a generic browser tool console.
- Interactive authorization is enabled only when Synara is loopback-bound.
- OAuth tokens, authorization codes, code verifiers, and client registration data never enter SQLite, logs, telemetry, WebSocket payloads, or diagnostics.
- Credential directories use mode `0700`, credential files use `0600`, and replacement is atomic on POSIX.
- Browser RPCs expose list/begin/finish-status/disconnect operations, never raw `callTool` or credentials.
- A consumer invokes only exact tool names declared by its binding.
- MCP calls have cancellation, bounded concurrency, response size limits, and single-flight connect/refresh behavior.
- Use `bun run test`, never `bun test`.
- Do not run workspace `bun fmt`, `bun lint`, or `bun typecheck` until the user explicitly authorizes the final verification pass.
- Apply the `git-paraty`, `paraty-tech`, `paraty-security`, and `changes-review` skills before each review/commit boundary.

## File Structure

- `packages/contracts/src/outboundMcp.ts`: public connection states and lifecycle RPC payload schemas.
- `packages/contracts/src/index.ts`, `ipc.ts`, `rpc.ts`, `ws.ts`: export and transport the lifecycle API.
- `apps/server/src/outboundMcp/Services/*.ts`: Effect service contracts for metadata, credentials, transport, and orchestration.
- `apps/server/src/outboundMcp/Layers/*.ts`: live and test implementations of those service contracts.
- `apps/server/src/outboundMcp/oauthProvider.ts`: MCP SDK `OAuthClientProvider` adapter for one authorization attempt.
- `apps/server/src/outboundMcp/authorizationAttempts.ts`: in-memory, restart-volatile PKCE/state attempt registry.
- `apps/server/src/outboundMcp/networkPolicy.ts`: URL/origin/redirect validation and bounded fetch wrapper.
- `apps/server/src/outboundMcp/presets/paraty.ts`: Paraty endpoint and consumer catalog declaration.
- `apps/server/src/outboundMcp/httpRoute.ts`: one-time loopback OAuth callback.
- `apps/server/src/persistence/Migrations/098_OutboundMcpConnections.ts`: non-secret metadata table.
- `apps/web/src/components/settings/OutboundMcpSettingsPanel.tsx`: Paraty service status and lifecycle actions.
- `apps/web/src/lib/outboundMcpReactQuery.ts`: query keys/options and cache invalidation.

---

### Task 1: Public lifecycle contracts and explicit MCP SDK dependency

**Files:**
- Create: `packages/contracts/src/outboundMcp.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/ws.ts`
- Modify: `apps/server/package.json`
- Modify: `bun.lock`
- Test: `packages/contracts/src/outboundMcp.test.ts`
- Test: `apps/web/src/wsNativeApi.test.ts`

**Interfaces:**
- Produces: `OutboundMcpConnection`, `OutboundMcpListResult`, `OutboundMcpBeginAuthorizationInput`, `OutboundMcpBeginAuthorizationResult`, `OutboundMcpDisconnectInput`.
- Produces Native API methods: `listOutboundMcpConnections()`, `beginOutboundMcpAuthorization(input)`, and `disconnectOutboundMcpConnection(input)`.

- [ ] **Step 1: Add failing schema compatibility tests**

```ts
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { OutboundMcpConnection } from "./outboundMcp";

describe("OutboundMcpConnection", () => {
  it("decodes a disconnected preset without credentials", () => {
    expect(
      Schema.decodeUnknownSync(OutboundMcpConnection)({
        id: "paraty",
        presetId: "paraty",
        displayName: "Paraty MCP",
        endpoint: "https://mcp-paraty-224371693889.europe-west1.run.app/mcp",
        status: "disconnected",
        lastValidatedAt: null,
        errorCategory: null,
      }).status,
    ).toBe("disconnected");
  });
});
```

- [ ] **Step 2: Run the contract test and confirm the missing export failure**

Run: `bun run --cwd packages/contracts test src/outboundMcp.test.ts`

Expected: FAIL because `./outboundMcp` does not exist.

- [ ] **Step 3: Define the lifecycle-only schemas**

```ts
export const OutboundMcpConnectionStatus = Schema.Literals([
  "disconnected",
  "authorizing",
  "connected",
  "reconnect-required",
  "incompatible",
  "temporarily-unavailable",
]);

export const OutboundMcpConnection = Schema.Struct({
  id: TrimmedNonEmptyString,
  presetId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
  status: OutboundMcpConnectionStatus,
  lastValidatedAt: Schema.NullOr(IsoDateTime),
  errorCategory: Schema.NullOr(TrimmedNonEmptyString),
});

export const OutboundMcpBeginAuthorizationResult = Schema.Struct({
  attemptId: TrimmedNonEmptyString,
  authorizationUrl: TrimmedNonEmptyString,
});

export const OutboundMcpListResult = Schema.Struct({
  connections: Schema.Array(OutboundMcpConnection),
});
```

Add WS method names `server.listOutboundMcpConnections`, `server.beginOutboundMcpAuthorization`, and `server.disconnectOutboundMcpConnection`, register their RPC schemas, and add the corresponding `NativeApi.server` signatures. Do not add a browser-callable tool invocation method.

- [ ] **Step 4: Make the SDK a direct server dependency**

Run: `bun add --cwd apps/server @modelcontextprotocol/sdk@1.29.0`

Expected: `apps/server/package.json` contains the exact dependency and `bun.lock` still resolves `1.29.0`.

- [ ] **Step 5: Wire `wsNativeApi` and verify transport serialization**

```ts
listOutboundMcpConnections: () =>
  transport.request(WS_METHODS.serverListOutboundMcpConnections),
beginOutboundMcpAuthorization: (input) =>
  transport.request(WS_METHODS.serverBeginOutboundMcpAuthorization, input),
disconnectOutboundMcpConnection: (input) =>
  transport.request(WS_METHODS.serverDisconnectOutboundMcpConnection, input),
```

Run: `bun run --cwd packages/contracts test src/outboundMcp.test.ts && bun run --cwd apps/web test src/wsNativeApi.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the contract boundary**

```bash
git add packages/contracts/src apps/server/package.json apps/web/src/wsNativeApi.ts apps/web/src/wsNativeApi.test.ts bun.lock
git commit -m "feat(mcp): define outbound connection contracts [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 2: Non-secret connection metadata repository

**Files:**
- Create: `apps/server/src/persistence/Migrations/098_OutboundMcpConnections.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/persistence/Migrations.test.ts`
- Create: `apps/server/src/outboundMcp/Services/OutboundMcpRepository.ts`
- Create: `apps/server/src/outboundMcp/Layers/OutboundMcpRepository.ts`
- Test: `apps/server/src/outboundMcp/Layers/OutboundMcpRepository.test.ts`

**Interfaces:**
- Produces: `OutboundMcpRepositoryShape.list()`, `.get(connectionId)`, `.upsertMetadata(record)`, `.setStatus(input)`, `.delete(connectionId)`.
- Produces: `OutboundMcpRepositoryError = PersistenceSqlError | PersistenceDecodeError`.
- Stores only connection id, preset id, display name, endpoint, timestamps, validation timestamp, catalog fingerprint, status, and error category.

- [ ] **Step 1: Write a failing migration/repository test**

```ts
it.effect("persists metadata without a credential column", () =>
  Effect.gen(function* () {
    const repository = yield* OutboundMcpRepository;
    yield* repository.upsertMetadata(paratyMetadata);
    expect(yield* repository.get("paraty")).toMatchObject({ presetId: "paraty" });
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(outbound_mcp_connections)`;
    expect(columns.map(({ name }) => name)).not.toContain("access_token");
    expect(columns.map(({ name }) => name)).not.toContain("refresh_token");
  }),
);
```

- [ ] **Step 2: Run the focused test and confirm the missing service failure**

Run: `bun run --cwd apps/server test src/outboundMcp/Layers/OutboundMcpRepository.test.ts`

Expected: FAIL because the repository and migration are absent.

- [ ] **Step 3: Add migration 98 and register its lineage**

```ts
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE outbound_mcp_connections (
      connection_id TEXT PRIMARY KEY NOT NULL,
      preset_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL,
      error_category TEXT,
      catalog_fingerprint TEXT,
      last_validated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;
});
```

Append `[98, "OutboundMcpConnections", Migration0098]` and update the expected migration list in `Migrations.test.ts`.

- [ ] **Step 4: Implement schema-decoded repository operations**

```ts
export interface OutboundMcpRepositoryShape {
  readonly list: () => Effect.Effect<ReadonlyArray<OutboundMcpConnectionRecord>, OutboundMcpRepositoryError>;
  readonly get: (connectionId: string) => Effect.Effect<OutboundMcpConnectionRecord | null, OutboundMcpRepositoryError>;
  readonly upsertMetadata: (record: OutboundMcpConnectionRecord) => Effect.Effect<void, OutboundMcpRepositoryError>;
  readonly setStatus: (input: OutboundMcpStatusUpdate) => Effect.Effect<void, OutboundMcpRepositoryError>;
  readonly delete: (connectionId: string) => Effect.Effect<void, OutboundMcpRepositoryError>;
}
```

- [ ] **Step 5: Verify migration replay and repository behavior**

Run: `bun run --cwd apps/server test src/persistence/Migrations.test.ts src/outboundMcp/Layers/OutboundMcpRepository.test.ts`

Expected: PASS, including a schema assertion proving there are no secret columns.

- [ ] **Step 6: Commit metadata persistence**

```bash
git add apps/server/src/persistence apps/server/src/outboundMcp
git commit -m "feat(mcp): persist outbound connection metadata [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 3: Private credential store and OAuth provider adapter

**Files:**
- Create: `apps/server/src/outboundMcp/Services/OutboundMcpCredentials.ts`
- Create: `apps/server/src/outboundMcp/Layers/OutboundMcpCredentials.ts`
- Create: `apps/server/src/outboundMcp/oauthProvider.ts`
- Create: `apps/server/src/outboundMcp/authorizationAttempts.ts`
- Create: `apps/server/src/outboundMcp/redaction.ts`
- Test: `apps/server/src/outboundMcp/Layers/OutboundMcpCredentials.test.ts`
- Test: `apps/server/src/outboundMcp/oauthProvider.test.ts`
- Test: `apps/server/src/outboundMcp/authorizationAttempts.test.ts`

**Interfaces:**
- Produces: `credentialPath(homeDir, connectionId)` under `<homeDir>/mcp/connections/`.
- Produces: `OutboundMcpCredentialsShape.read`, `.write`, `.delete`, and `.clearAttemptSecrets`.
- Produces: `AuthorizationAttemptRegistry.create`, `.saveVerifier`, `.consume`, and `.cancel`; all state is memory-only.
- Produces: `makeOAuthClientProvider(input): OAuthClientProvider` backed by one connection and one authorization attempt.

- [ ] **Step 1: Write failing private-file and one-time-state tests**

```ts
expect((await fs.stat(credentialsDirectory)).mode & 0o777).toBe(0o700);
expect((await fs.stat(credentialsFile)).mode & 0o777).toBe(0o600);
expect(attempts.consume(attemptId, state)).toMatchObject({ connectionId: "paraty" });
expect(attempts.consume(attemptId, state)).toBeNull();
```

Also assert that serialized lifecycle metadata and formatted errors do not contain `access-token`, `refresh-token`, `authorization-code`, or the PKCE verifier.

- [ ] **Step 2: Run focused tests and observe missing-store failures**

Run: `bun run --cwd apps/server test src/outboundMcp/Layers/OutboundMcpCredentials.test.ts src/outboundMcp/authorizationAttempts.test.ts src/outboundMcp/oauthProvider.test.ts`

Expected: FAIL because the credential service is absent.

- [ ] **Step 3: Implement atomic private JSON writes**

```ts
const directory = path.join(homeDir, "mcp", "connections");
yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
const temporary = `${target}.${randomUUID()}.tmp`;
yield* fileSystem.writeFileString(temporary, JSON.stringify(credentials), { mode: 0o600 });
yield* fileSystem.rename(temporary, target);
yield* fileSystem.chmod(target, 0o600);
```

Validate `connectionId` against a strict slug before path joining. On Windows, store under the same profile path and surface a non-secret platform warning instead of claiming POSIX mode enforcement.

- [ ] **Step 4: Implement the restart-volatile authorization attempt registry**

```ts
export type AuthorizationAttempt = {
  readonly id: string;
  readonly connectionId: string;
  readonly state: string;
  readonly redirectUrl: URL;
  readonly createdAt: number;
  codeVerifier: string | null;
};

export type AuthorizationAttemptRegistry = {
  readonly create: (connectionId: string, redirectUrl: URL) => AuthorizationAttempt;
  readonly saveVerifier: (attemptId: string, verifier: string) => void;
  readonly consume: (attemptId: string, state: string) => AuthorizationAttempt | null;
  readonly cancel: (attemptId: string) => void;
};

export declare function makeAuthorizationAttemptRegistry(
  options: { ttlMs: number },
): AuthorizationAttemptRegistry;
```

Generate ids and state values with `randomBytes(32)`, compare state with `timingSafeEqual`, expire attempts after ten minutes, and delete the entry on every consume attempt so replay cannot succeed.

- [ ] **Step 5: Implement the MCP SDK OAuth provider contract**

```ts
export function makeOAuthClientProvider(input: OAuthProviderInput): OAuthClientProvider {
  return {
    redirectUrl: input.redirectUrl,
    clientMetadata: input.clientMetadata,
    state: () => input.state,
    clientInformation: () => input.credentials.clientInformation(),
    saveClientInformation: (value) => input.credentials.saveClientInformation(value),
    tokens: () => input.credentials.tokens(),
    saveTokens: (value) => input.credentials.saveTokens(value),
    redirectToAuthorization: (url) => input.captureAuthorizationUrl(url),
    saveCodeVerifier: (value) => input.attempt.saveCodeVerifier(value),
    codeVerifier: () => input.attempt.codeVerifier(),
    invalidateCredentials: (scope) => input.credentials.invalidate(scope),
    validateResourceURL: (serverUrl, resource) => input.validateResource(serverUrl, resource),
  };
}
```

- [ ] **Step 6: Verify permissions, restart invalidation, state replay rejection, and redaction**

Run: `bun run --cwd apps/server test src/outboundMcp/Layers/OutboundMcpCredentials.test.ts src/outboundMcp/authorizationAttempts.test.ts src/outboundMcp/oauthProvider.test.ts`

Expected: PASS. An unfinished attempt exists only in memory and cannot be completed after constructing a new attempt registry.

- [ ] **Step 7: Commit private OAuth storage**

```bash
git add apps/server/src/outboundMcp
git commit -m "feat(mcp): store outbound OAuth credentials privately [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 4: Bounded Streamable HTTP client and consumer allowlists

**Files:**
- Create: `apps/server/src/outboundMcp/networkPolicy.ts`
- Create: `apps/server/src/outboundMcp/Services/McpToolClient.ts`
- Create: `apps/server/src/outboundMcp/Layers/McpToolClient.ts`
- Create: `apps/server/src/outboundMcp/consumerBinding.ts`
- Test: `apps/server/src/outboundMcp/networkPolicy.test.ts`
- Test: `apps/server/src/outboundMcp/Layers/McpToolClient.test.ts`

**Interfaces:**
- Produces: `validateOutboundMcpUrl(url, purpose)` and `makeBoundedMcpFetch(policy)`.
- Produces: `OutboundMcpNetworkPolicyError` with category and redacted origin only.
- Produces: `McpToolClientShape.validate(binding)`, `.call(binding, tool, args, signal)`, `.invalidate(connectionId)`, `.closeAll()`.
- Produces: `McpConsumerBinding<Operations>` with exact required/optional tool sets and per-operation decoders.

- [ ] **Step 1: Write failing network and tool-boundary tests**

```ts
expect(() => validateOutboundMcpUrl(new URL("http://example.com/mcp"), "resource")).toThrow();
expect(() => validateOutboundMcpUrl(new URL("https://user:pass@example.com/mcp"), "resource")).toThrow();
await expect(client.call(binding, "write_comment", {}, signal)).rejects.toThrow(
  "Tool is not allowed for this consumer",
);
```

Cover redirects to non-HTTPS URLs, access-token origin binding, a body larger than `2 * 1024 * 1024`, timeout, abort propagation, six concurrent calls, and two callers sharing one connection attempt.

- [ ] **Step 2: Run focused tests and confirm policy/client failures**

Run: `bun run --cwd apps/server test src/outboundMcp/networkPolicy.test.ts src/outboundMcp/Layers/McpToolClient.test.ts`

Expected: FAIL because policy and client do not exist.

- [ ] **Step 3: Implement the validated bounded fetch**

```ts
export const OUTBOUND_MCP_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const OUTBOUND_MCP_REQUEST_TIMEOUT_MS = 30_000;

export class OutboundMcpNetworkPolicyError extends Schema.TaggedErrorClass<OutboundMcpNetworkPolicyError>()(
  "OutboundMcpNetworkPolicyError",
  { category: Schema.String, origin: Schema.optional(Schema.String) },
) {}

export function validateOutboundMcpUrl(url: URL, purpose: "resource" | "authorization") {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new OutboundMcpNetworkPolicyError({ category: "invalid-url" });
  }
  return url;
}
```

The fetch wrapper sets `redirect: "manual"`, validates each `Location`, combines caller abort with the timeout signal, and rejects before buffering beyond the byte cap.

- [ ] **Step 4: Implement lazy MCP sessions with the official SDK**

```ts
const transport = new StreamableHTTPClientTransport(endpoint, {
  authProvider,
  fetch: boundedFetch,
  reconnectionOptions: {
    initialReconnectionDelay: 500,
    maxReconnectionDelay: 5_000,
    reconnectionDelayGrowFactor: 2,
    maxRetries: 2,
  },
});
const client = new Client({ name: "synara", version: APP_VERSION }, { capabilities: {} });
await client.connect(transport, { signal });
```

Guard connection creation and token refresh with keyed single-flight state, and tool calls with a six-permit semaphore. Close and remove the session after auth invalidation or disconnect.

- [ ] **Step 5: Validate tool catalogs and decode results inside bindings**

```ts
export type McpConsumerBinding<Operation extends string> = {
  readonly id: string;
  readonly presetIds: ReadonlySet<string>;
  readonly operations: Readonly<Record<Operation, {
    readonly tool: string;
    readonly decode: (result: unknown) => Effect.Effect<unknown, OutboundMcpDecodeError>;
  }>>;
};
```

Define `OutboundMcpDecodeError` as a tagged, non-secret error containing `consumerId`, `operation`, and a category but not the rejected payload. `validate(binding)` calls `listTools`, checks every required operation tool, and returns a stable fingerprint made from sorted tool names and schemas. `call` rejects any tool not reachable through `binding.operations`.

- [ ] **Step 6: Run concurrency, cancellation, response-cap, and allowlist tests**

Run: `bun run --cwd apps/server test src/outboundMcp/networkPolicy.test.ts src/outboundMcp/Layers/McpToolClient.test.ts`

Expected: PASS with fake transports; no test contacts Paraty.

- [ ] **Step 7: Commit the generic MCP client**

```bash
git add apps/server/src/outboundMcp
git commit -m "feat(mcp): add bounded outbound tool client [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 5: Connection lifecycle service and Paraty preset

**Files:**
- Create: `apps/server/src/outboundMcp/Services/McpConnectionService.ts`
- Create: `apps/server/src/outboundMcp/Layers/McpConnectionService.ts`
- Create: `apps/server/src/outboundMcp/presets/paraty.ts`
- Create: `apps/server/src/outboundMcp/presets/index.ts`
- Test: `apps/server/src/outboundMcp/Layers/McpConnectionService.test.ts`

**Interfaces:**
- Produces: `McpConnectionServiceShape.list`, `.beginAuthorization`, `.completeAuthorization`, `.disconnect`, `.invoke`, and `.subscribe`.
- Produces server-only `McpConnectionEvent` values `connected`, `credentials-invalidated`, and `disconnected`; no event contains credentials.
- Produces: preset `paraty` at `https://mcp-paraty-224371693889.europe-west1.run.app/mcp`.
- Consumes repository, credential store, OAuth provider, and `McpToolClient` from Tasks 2–4.

- [ ] **Step 1: Write failing lifecycle-state tests**

```ts
expect((yield* service.list())[0]?.status).toBe("disconnected");
const attempt = yield* service.beginAuthorization({ presetId: "paraty" });
expect(new URL(attempt.authorizationUrl).protocol).toBe("https:");
yield* service.completeAuthorization({ state, code: "code-1" });
expect((yield* service.list())[0]?.status).toBe("connected");
yield* service.disconnect({ connectionId: "paraty" });
expect(yield* credentials.read("paraty")).toBeNull();
```

Add cases for cancellation, state mismatch, missing tools (`incompatible`), revoked refresh (`reconnect-required`), transient network failure (`temporarily-unavailable`), and explicit disconnect clearing live clients.

Also subscribe a test listener and assert expiry emits `credentials-invalidated` while explicit disconnect emits `disconnected`; later consumers use that distinction to preserve stale cache on expiry and clear cache on user disconnect.

- [ ] **Step 2: Run the focused service test**

Run: `bun run --cwd apps/server test src/outboundMcp/Layers/McpConnectionService.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Define the preset outside the generic core**

```ts
export const PARATY_MCP_PRESET: OutboundMcpPreset = {
  id: "paraty",
  displayName: "Paraty MCP",
  endpoint: new URL("https://mcp-paraty-224371693889.europe-west1.run.app/mcp"),
  clientMetadata: {
    client_name: "Synara",
    redirect_uris: [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
};
```

Populate `redirect_uris` per authorization attempt with the loopback callback. Do not include a client secret. If discovery does not allow dynamic registration and the preset has no safe public client id, return `incompatible`.

- [ ] **Step 4: Implement one-time lifecycle orchestration**

```ts
readonly beginAuthorization: (input) =>
  Effect.gen(function* () {
    const preset = yield* presets.require(input.presetId);
    const attempt = yield* attempts.create(preset.id);
    const authorizationUrl = yield* oauth.begin({ preset, attempt });
    yield* repository.setStatus({ connectionId: preset.id, status: "authorizing" });
    return { attemptId: attempt.id, authorizationUrl: authorizationUrl.href };
  });
```

Completion consumes state once, exchanges the code through `finishAuth`, validates the catalog for registered consumers, persists only non-secret status, and disposes the attempt. Disconnect first attempts standards-based token revocation only when discovery advertises a revocation endpoint, then always deletes local credentials and closes transports even when remote revocation fails.

Publish connection events through an in-process subscription owned by the service:

```ts
export type McpConnectionEvent = {
  readonly connectionId: string;
  readonly type: "connected" | "credentials-invalidated" | "disconnected";
};

readonly subscribe: (listener: (event: McpConnectionEvent) => void) => Effect.Effect<() => void>;
```

- [ ] **Step 5: Verify all state transitions and secret boundaries**

Run: `bun run --cwd apps/server test src/outboundMcp/Layers/McpConnectionService.test.ts`

Expected: PASS; snapshots and errors contain only category-level failures.

- [ ] **Step 6: Commit connection orchestration**

```bash
git add apps/server/src/outboundMcp
git commit -m "feat(mcp): orchestrate authenticated connections [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 6: Loopback OAuth callback, authenticated RPCs, and runtime composition

**Files:**
- Create: `apps/server/src/outboundMcp/httpRoute.ts`
- Test: `apps/server/src/outboundMcp/httpRoute.test.ts`
- Modify: `apps/server/src/effectServer.ts`
- Modify: `apps/server/src/serverLayers.ts`
- Modify: `apps/server/src/wsRpc.ts`
- Modify: `apps/web/src/wsNativeApi.ts`
- Test: `apps/server/src/wsRpc.auth.test.ts`

**Interfaces:**
- Consumes `McpConnectionService` from Task 5.
- Produces loopback `GET /api/mcp/outbound/oauth/callback?code=…&state=…`.
- Produces working lifecycle WS handlers protected by the existing WS authentication/admission layer.

- [ ] **Step 1: Write failing callback security tests**

```ts
const response = await fetch(`${origin}/api/mcp/outbound/oauth/callback?code=c1&state=s1`, {
  headers: { Host: `127.0.0.1:${port}` },
});
expect(response.status).toBe(200);
expect(await response.text()).not.toContain("c1");

const replay = await fetch(`${origin}/api/mcp/outbound/oauth/callback?code=c1&state=s1`);
expect(replay.status).toBe(400);
```

Also mount with a non-loopback host and expect 404/disabled, test missing parameters, state mismatch, cancellation, and a response body without tokens/codes.

- [ ] **Step 2: Run route and WS tests to see missing-handler failures**

Run: `bun run --cwd apps/server test src/outboundMcp/httpRoute.test.ts src/wsRpc.auth.test.ts`

Expected: FAIL because the route and WS methods are unregistered.

- [ ] **Step 3: Mount the loopback-only callback route**

```ts
export const outboundMcpRouteLayer = HttpRouter.add(
  "GET",
  "/api/mcp/outbound/oauth/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const service = yield* McpConnectionService;
    yield* ensureLoopbackCallbackEnabled;
    const result = yield* service.completeAuthorization(readCallback(request.url));
    return HttpServerResponse.html(callbackPage(result), { status: result.ok ? 200 : 400 });
  }),
);
```

Merge `outboundMcpRouteLayer` in `effectServer.ts` and add `McpConnectionService` to `ServerShape.start` requirements.

- [ ] **Step 4: Compose the repository, credential, tool-client, and connection layers once**

```ts
const outboundMcpLayer = McpConnectionServiceLive.pipe(
  Layer.provideMerge(OutboundMcpRepositoryLive),
  Layer.provideMerge(OutboundMcpCredentialsLive),
  Layer.provideMerge(McpToolClientLive),
);
```

Merge the same layer instance into runtime services so HTTP and WS resolve the same attempt registry and transport cache.

- [ ] **Step 5: Register lifecycle WS handlers**

```ts
[WS_METHODS.serverListOutboundMcpConnections]: () =>
  rpcEffect(outboundMcp.list(), "Failed to load outbound MCP connections"),
[WS_METHODS.serverBeginOutboundMcpAuthorization]: (input) =>
  rpcEffect(outboundMcp.beginAuthorization(input), "Failed to start MCP authorization"),
[WS_METHODS.serverDisconnectOutboundMcpConnection]: (input) =>
  rpcEffect(outboundMcp.disconnect(input), "Failed to disconnect MCP service"),
```

The existing authenticated WebSocket route remains the only entry point for these mutations; do not add unauthenticated HTTP lifecycle endpoints.

- [ ] **Step 6: Verify callback replay defense and authenticated lifecycle RPCs**

Run: `bun run --cwd apps/server test src/outboundMcp/httpRoute.test.ts src/wsRpc.auth.test.ts src/outboundMcp/Layers/McpConnectionService.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit server exposure**

```bash
git add apps/server/src apps/web/src/wsNativeApi.ts
git commit -m "feat(mcp): expose secure outbound OAuth lifecycle [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 7: Settings information architecture and Paraty connection UI

**Files:**
- Create: `apps/web/src/lib/outboundMcpReactQuery.ts`
- Create: `apps/web/src/components/settings/OutboundMcpSettingsPanel.tsx`
- Test: `apps/web/src/components/settings/OutboundMcpSettingsPanel.test.tsx`
- Modify: `apps/web/src/components/settings/ExternalMcpSettingsPanel.tsx`
- Modify: `apps/web/src/routes/_chat.settings.tsx`
- Modify: `apps/web/src/settingsNavigation.ts`
- Modify: `apps/web/src/settingsSearchIndex.ts`
- Test: `apps/web/src/settingsSearchIndex.test.ts`

**Interfaces:**
- Consumes lifecycle Native API from Task 1 and live handlers from Task 6.
- Produces Settings groups “Services Synara uses” and “Agents connected to Synara”.
- Produces explicit Connect, Reconnect, and confirmed Disconnect actions for `Paraty MCP`.

- [ ] **Step 1: Write failing UI state tests**

```tsx
render(<OutboundMcpSettingsPanel active />);
expect(await screen.findByText("Services Synara uses")).toBeVisible();
expect(screen.getByRole("button", { name: "Connect Paraty MCP" })).toBeEnabled();

mockConnection({ status: "reconnect-required" });
expect(await screen.findByRole("button", { name: "Reconnect Paraty MCP" })).toBeEnabled();
expect(screen.queryByText(/access[_ -]?token/i)).toBeNull();
```

Add tests for authorizing disabled controls, incompatible explanation, transient retry, last validation time, cancel-safe popup behavior, and disconnect confirmation.

- [ ] **Step 2: Run focused web tests and confirm the missing panel failure**

Run: `bun run --cwd apps/web test src/components/settings/OutboundMcpSettingsPanel.test.tsx src/settingsSearchIndex.test.ts`

Expected: FAIL because the outbound panel/search entry are absent.

- [ ] **Step 3: Add stable query keys and lifecycle mutations**

```ts
export const outboundMcpQueryKeys = {
  all: ["outbound-mcp"] as const,
  connections: () => [...outboundMcpQueryKeys.all, "connections"] as const,
};

export const outboundMcpConnectionsQueryOptions = () =>
  queryOptions({
    queryKey: outboundMcpQueryKeys.connections(),
    queryFn: () => ensureNativeApi().server.listOutboundMcpConnections(),
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.connections.some(({ status }) => status === "authorizing")
        ? 1_000
        : false,
  });
```

Every successful lifecycle mutation invalidates `connections()`. Opening the returned authorization URL must occur directly from the user's click through `ensureNativeApi().shell.openExternal` so popup blockers do not treat it as background navigation.

- [ ] **Step 4: Split the Integrations panel by connection direction**

```tsx
<SettingsSection title="Services Synara uses">
  <OutboundMcpConnectionCard connection={paraty} />
</SettingsSection>
<SettingsSection title="Agents connected to Synara">
  <ExternalMcpSettingsPanel active={active} embedded />
</SettingsSection>
```

Keep the existing inbound flows and mounted-lifetime behavior intact. Update navigation copy to “Connect services to Synara and give coding agents scoped access.” Add searchable entries for “Paraty MCP” and “External agent MCP connections”.

- [ ] **Step 5: Render status-specific actions without secret details**

```ts
const action =
  status === "disconnected"
    ? { label: "Connect", kind: "connect" as const }
    : status === "reconnect-required"
      ? { label: "Reconnect", kind: "connect" as const }
      : status === "temporarily-unavailable"
        ? { label: "Retry", kind: "connect" as const }
        : null;
```

Use category-level copy for errors. Disconnect opens the repository's existing confirmation dialog primitive and explains that credentials/cache are removed but projects and pins remain.

- [ ] **Step 6: Verify the complete Settings surface**

Run: `bun run --cwd apps/web test src/components/settings/OutboundMcpSettingsPanel.test.tsx src/components/settings/externalMcpSetup.test.ts src/settingsSearchIndex.test.ts`

Expected: PASS with the inbound External MCP tests unchanged.

- [ ] **Step 7: Commit the Settings experience**

```bash
git add apps/web/src
git commit -m "feat(settings): manage outbound MCP services [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

### Task 8: Foundation integration verification and handoff

**Files:**
- Create: `apps/server/src/outboundMcp/testing/fakeMcpAuthority.ts`
- Create: `apps/server/src/outboundMcp/outboundMcp.e2e.test.ts`
- Modify: `docs/superpowers/plans/2026-08-31-outbound-mcp-foundation.md` (check completed boxes during execution only)

**Interfaces:**
- Produces a deterministic local OAuth + Streamable HTTP MCP fixture used again by phase 2.
- Proves the foundation connects, refreshes, validates tools, rejects undeclared tools, and disconnects without contacting Paraty.

- [ ] **Step 1: Build a fake authority with a minimal read-only tool catalog**

```ts
const authority = yield* makeFakeMcpAuthority({
  tools: [
    { name: "fixture_read", handler: () => ({ content: [{ type: "text", text: "ok" }] }) },
  ],
  accessTokenTtlMs: 1_000,
});
```

The fixture publishes protected-resource and authorization-server metadata, supports PKCE code exchange and refresh rotation, records received origins/headers, and binds to `127.0.0.1` on an ephemeral port.

- [ ] **Step 2: Write the end-to-end Effect test**

```ts
const attempt = yield* connections.beginAuthorization({ presetId: fixturePreset.id });
yield* authority.authorize(attempt.authorizationUrl);
yield* connections.completeAuthorization(authority.callbackParameters());
expect((yield* connections.list())[0]?.status).toBe("connected");
expect(yield* connections.invoke(fixtureBinding, "read", {})).toEqual("ok");
yield* connections.disconnect({ connectionId: fixturePreset.id });
expect(yield* credentials.read(fixturePreset.id)).toBeNull();
```

- [ ] **Step 3: Run the entire outbound MCP focused suite**

Run: `bun run --cwd apps/server test src/outboundMcp src/persistence/Migrations.test.ts && bun run --cwd packages/contracts test src/outboundMcp.test.ts && bun run --cwd apps/web test src/components/settings/OutboundMcpSettingsPanel.test.tsx src/wsNativeApi.test.ts`

Expected: PASS. No request reaches a non-loopback fixture or the real Paraty endpoint.

- [ ] **Step 4: Review secret and authority boundaries**

Run: `rg -n 'accessToken|refreshToken|authorizationCode|codeVerifier' apps/server/src/outboundMcp packages/contracts/src/outboundMcp.ts apps/web/src/components/settings/OutboundMcpSettingsPanel.tsx`

Expected: secret fields occur only in credential/OAuth internals and tests; they do not occur in contracts, WS handlers, public error shapes, settings props, logs, or diagnostics.

- [ ] **Step 5: Run branch-scoped review and record baseline limitations**

Use `changes-review`, `paraty-security`, and `backend-architecture`. Fix all findings. Record that the pre-feature full suite baseline had 48 failing web tests and 4138 passing tests; do not attribute those failures to this phase without reproducing a causal diff.

- [ ] **Step 6: Commit the foundation fixture and verification**

```bash
git add apps/server/src/outboundMcp docs/superpowers/plans/2026-08-31-outbound-mcp-foundation.md
git commit -m "test(mcp): verify authenticated outbound foundation [No clickup]" -m "Agents-Toolkit-Version: 6.10.2"
```

After this commit, begin `docs/superpowers/plans/2026-08-31-bitbucket-pull-request-provider.md`.
