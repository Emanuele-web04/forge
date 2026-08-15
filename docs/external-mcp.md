# External MCP integrations

External MCP lets another local application—such as Codex, Claude Code, or an MCP-capable desktop
client—create and inspect restricted Synara tasks through a user-approved integration.

It is separate from the internal Agent Gateway injected into supported provider sessions already
running inside Synara.

## Internal gateway or external integration

| Surface       | Caller                                  | Authority model                                                                            |
| ------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Agent Gateway | A provider session inside a Synara task | Thread-scoped capabilities and caller-turn authority                                       |
| External MCP  | Another paired local application        | User-created integration with selected projects, scopes, limits, and revocable credentials |

Use External MCP when work begins outside Synara but should execute through Synara's durable task
and worktree pipeline.

## Create the integration

1. Start Synara and open **Settings → Integrations**.
2. Name the connection and choose whether it may use every current and future project (the default)
   or only selected projects. Safe execution defaults restrict it to tasks it creates, isolated
   managed worktrees, and approval-required execution. Higher-impact permissions are under
   **Advanced permissions**.
3. Choose **Create integration**.
4. For Codex, Claude Code, or another agentic MCP client, copy the generated setup prompt into the
   client. The prompt guides that agent through the one-time pairing, installs the correct local
   stdio configuration, and verifies the connection with `synara_overview`. For Claude Desktop or a
   client that cannot run the setup prompt, complete pairing in Synara and use the copy-ready JSON
   configuration instead. Synara uses the exact executable and data directory of the running
   installation; no global `synara` command, project ID, model slug, request ID, or credential
   path is required from the user.
5. Synara moves from **Waiting for pairing** to **Paired** after the local credential exchange, then
   to **Connected** after the client makes its first request.

If the page is reloaded or the pairing code expires, use **Resume pairing** beside the integration.
For an already paired integration, **Continue setup** restores the setup prompt. A new pairing code
never replaces an already paired credential.

The generated prompt is the recommended path for agentic clients. The commands and configuration
below document the equivalent manual setup for Claude Desktop and other clients that cannot run the
guided setup automatically.

The guided flow avoids asking the user for project IDs, provider/model slugs, request IDs, data paths,
or credentials. The generated launcher is structurally equivalent to:

```sh
/absolute/path/to/runtime /absolute/path/to/synara-server mcp serve --integration mcp_int_REDACTED --home-dir "$HOME/.synara"
```

The Codex copy action generates:

```sh
codex mcp add synara [--env ELECTRON_RUN_AS_NODE=1] -- /absolute/runtime /absolute/server mcp serve --integration mcp_int_REDACTED --home-dir "$HOME/.synara"
```

The Claude Code copy action generates a user-scoped configuration:

```sh
claude mcp add --scope user synara [-e ELECTRON_RUN_AS_NODE=1] -- /absolute/runtime /absolute/server mcp serve --integration mcp_int_REDACTED --home-dir "$HOME/.synara"
```

The equivalent manual Codex `config.toml` is:

```toml
[mcp_servers.synara]
command = "/absolute/path/to/runtime"
args = ["/absolute/path/to/synara-server", "mcp", "serve", "--integration", "mcp_int_REDACTED", "--home-dir", "/absolute/path/to/synara-data"]
# Desktop builds also include: env = { ELECTRON_RUN_AS_NODE = "1" }
```

For clients that use JSON MCP configuration:

```json
{
  "mcpServers": {
    "synara": {
      "command": "/absolute/path/to/runtime",
      "args": [
        "/absolute/path/to/synara-server",
        "mcp",
        "serve",
        "--integration",
        "mcp_int_REDACTED",
        "--home-dir",
        "/absolute/path/to/synara-data"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Synara always includes its actual data directory in generated setup, so multiple installations do not
silently connect to the wrong runtime. A manually written bridge configuration should do the same:

```json
{
  "command": "/absolute/path/to/runtime",
  "args": [
    "/absolute/path/to/synara-server",
    "mcp",
    "serve",
    "--integration",
    "mcp_int_REDACTED",
    "--home-dir",
    "/absolute/path/to/synara-data"
  ],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

The raw integration credential is not placed in MCP client configuration. The pairing command first
creates the credential locally and persists a private pending record, then exchanges the short-lived
code with the running loopback server. A lost response or local write failure can therefore be retried
without consuming a different secret. The final credential is written to
`<Synara home>/mcp/credentials/<integration-id>.json`. Synara creates its parent directory with mode `0700`
and the file with mode `0600` on POSIX systems. On Windows the file remains under the current user
profile, but Windows does not provide the same POSIX mode guarantee; protect the account and Synara
data directory accordingly.

When exactly one credential is stored, the bridge can select it automatically. When more
than one is stored, pass `--integration`; the bridge fails instead of guessing which external
principal to use.

## External tools

The advertised catalog is filtered by the integration's granted scopes. It exposes:

- `synara_overview` — orient in one call with allowed projects, paths and activity, provider
  availability, granted scopes, safe defaults, limits, and suggested next steps.
- `synara_capabilities` — provider/model construction and safety limits for an allowed project.
- `synara_list_allowed_projects` — only projects selected by the user.
- `synara_create_task` — one task per stable `requestId`.
- `synara_wait_for_task` — wait for an authorized task without changing it.
- `synara_read_task` — read tasks created by the integration. Reading other tasks requires the
  separate `tasks:read-project` scope.

Creation requires an explicit `projectId`, `provider`, `model`, `prompt`, and stable `requestId`.
The default environment is a managed worktree and the default runtime is approval-required. Local
checkout execution and full-access execution are independent, explicit scopes.

## Security and lifecycle

- `/mcp/external` is available only while Synara itself is loopback-only. Configuring remote or
  published access disables the external endpoint instead of exposing it remotely.
- External credentials have the fixed `synara.external-mcp` audience. They are opaque, expiring,
  revocable, stored as SHA-256 hashes in the server database, and cannot authenticate browser,
  WebSocket, server-token, or internal provider-session paths.
- Expiry and revocation are checked at request ingress and again while long-running create/wait
  operations continue.
- Every integration has project, capability, per-minute call, and active-agent-task limits. A slot
  is reserved transactionally while creation is in progress, remains occupied while the owned
  task's current turn is pending or running, and is released when creation fails or that turn
  becomes terminal. An idempotent retry of the same `requestId` never consumes another slot.
- Audit rows record integration identity, tool, request ID, project, environment, runtime, outcome,
  and created task IDs. Full prompts are not copied into audit rows or durable recovery plans.
  Rate-limit rejections are aggregated per integration/window and old audit history is pruned.
- Reusing a `requestId` with the same plan replays the durable result. Reusing it with a different
  plan is rejected.
- Revoke an integration from **Settings → Integrations**. Revocation takes effect immediately; pair
  a newly created integration before using the bridge again.

The stdio bridge re-reads Synara's private runtime-state file on each request and requires the
loopback process to answer a fresh HMAC challenge before it sends a credential or pairing code. It
retries discovery briefly across a server restart or port change, bounds and aborts hung HTTP calls,
and processes several stdio requests concurrently so a long wait does not block ping or read calls.
It fails clearly when no instance, multiple instances, an unauthenticated endpoint, an unsafe
credential file, or a revoked/expired credential is found.
