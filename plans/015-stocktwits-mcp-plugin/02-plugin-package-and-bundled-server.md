# Workstream 2 - Plugin Package and Bundled Server

Status: DONE - reproducible hardened bundle and plugin package created
Depends on: Workstream 1

## Objective

Create a validation-ready personal plugin and a reproducible, Windows-safe MCP
runtime that starts locally without installing or compiling dependencies during
a Codex task.

## Implementation result

Created `stocktwits` version `0.1.0` with a pinned `mcp/server.mjs`, local
build inputs, upstream provenance, complete license notices, deterministic SVG
assets, and a plugin-relative stdio launch configuration. A fresh exact-commit
build reproduced bundle SHA-256
`A7FBE53CD55CE227E203A1DB825704C3646B6474CE1D6CE40C2D344DEE404454`.
The runtime dependency audit reports zero findings after the documented lock
repair.

## Scaffold

Run the current plugin-creator workflow:

```powershell
python C:\Users\roube\.codex\skills\.system\plugin-creator\scripts\create_basic_plugin.py `
  stocktwits `
  --with-skills `
  --with-scripts `
  --with-assets `
  --with-mcp `
  --with-marketplace
```

Expected outputs:

```text
C:\Users\roube\plugins\stocktwits
C:\Users\roube\.agents\plugins\marketplace.json
```

The outer directory and manifest `name` must both remain `stocktwits`. Append
the new personal marketplace entry; do not reorder or replace existing entries.

## Reproducible bundle

Create `scripts/upstream-lock.json` containing at minimum:

- Upstream repository URL.
- Full reviewed Git commit SHA.
- Source archive URL and SHA-256.
- Upstream package version.
- Node target.
- Exact bundler version and build flags.
- Output path and SHA-256.
- Identifiers for every local hardening patch.

Create `scripts/build-stocktwits-mcp.ps1` as a deterministic developer build,
not as an install-time hook. It must:

1. Create an isolated temporary directory and verify its resolved path before
   cleanup.
2. Download the archive for the exact full commit SHA.
3. Verify the archive hash before extracting or executing anything.
4. Run `npm ci --ignore-scripts` against the pinned lockfile.
5. Apply only the reviewed hardening patch set.
6. Bundle `src/index.ts` and runtime dependencies into one Node-targeted ESM
   file at `mcp/server.mjs` with a pinned bundler version.
7. Generate a metafile/software-bill-of-materials input for license review.
8. Copy the upstream MIT license and generate `THIRD_PARTY_NOTICES.md` for
   bundled runtime dependencies.
9. Run the local stdio smoke test before replacing the prior artifact.
10. Compute and update the output hash in `upstream-lock.json`.

Never run the upstream `prepare` or `build` script on Windows. The local build
does not need the executable bit because `.mcp.json` launches the result through
`node`.

## Minimal hardening patch

Keep local divergence small and documented. The patch should:

- Fix both network origins to the reviewed StockTwits HTTPS hosts.
- Add an `AbortSignal` timeout to every fetch, with one shared constant.
- Validate symbols against a conservative stock/ETF/crypto ticker grammar and
  normalize a leading `$` before constructing a URL path.
- Validate public usernames and reject path/control characters.
- Trim search queries and bound their length.
- Require finite integer message limits and clamp them to `1..30`.
- Add MCP read-only/destructive/idempotent annotations where supported by the
  pinned SDK without renaming tools or changing successful result shapes.
- Preserve stderr-only diagnostic logging.

Do not add retries by default. Automatic retries consume the shared public
rate budget and can amplify outages. If a single retry is later justified, use
server-directed delay or bounded exponential backoff only for transient network
errors and never for validation errors or HTTP 4xx responses.

## MCP configuration

Replace the scaffolded `.mcp.json` placeholder with:

```json
{
  "mcpServers": {
    "stocktwits": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "cwd": ".",
      "tool_timeout_sec": 30
    }
  }
}
```

Verify the current Codex plugin loader resolves `cwd: "."` against both the
source plugin and installed cache root. Do not use an absolute source path in
the shipped configuration.

Do not forward credentials or broad environment allowlists. The server needs
only inherited network/proxy/TLS behavior required by Node in the user's
environment. If explicit proxy certificate variables are needed, document the
smallest allowlist and test it rather than forwarding the full environment.

## Plugin manifest

Configure `.codex-plugin/plugin.json` with real, validator-accepted metadata:

- `name`: `stocktwits`
- `version`: `0.1.0`
- `description`: state that this is a local, read-only integration based on the
  official StockTwits MCP server.
- `author.name` and `interface.developerName`: the local plugin author, not
  `StockTwits`.
- `homepage`: the local integration documentation if one exists; otherwise
  omit it.
- `repository`: omit unless the plugin package itself has a repository.
- `license`: the chosen license for local wrapper material, compatible with the
  preserved upstream MIT license.
- `keywords`: `stocktwits`, `stocks`, `sentiment`, `market-data`, `mcp`.
- `skills`: `./skills/`
- `mcpServers`: `./.mcp.json`
- `interface.displayName`: `StockTwits`
- `interface.shortDescription`: a concise read-only market/social-data label.
- `interface.longDescription`: explain public data, source provenance, and
  sentiment limitations.
- `interface.category`: `Finance`
- `interface.capabilities`: only capabilities actually provided, such as
  `Read` and `Search`.
- `interface.websiteURL`: the upstream repository or StockTwits website.
- `interface.composerIcon`: `./assets/icon.png`
- `interface.logo`: `./assets/logo.png`
- At most three concise `interface.defaultPrompt` entries.

Suggested starter prompts:

1. `Show the price and recent sentiment for NVDA.`
2. `What symbols are trending on StockTwits?`
3. `Summarize recent StockTwits posts about AAPL.`

Keep `apps` out of the manifest; this server has no MCP App resource.

## Attribution and assets

Create `UPSTREAM.md` containing:

- The upstream repository and full reviewed commit.
- The build/artifact hash.
- A concise list of local hardening changes.
- The update procedure and date last reviewed.
- A clear statement that the local plugin is not an official StockTwits plugin
  publication.

Preserve the upstream MIT license and all required bundled dependency notices.

Use neutral market/sentiment artwork. Do not copy the StockTwits logo or trade
dress unless that use is explicitly permitted. Asset references must remain
inside the plugin root and render on both light and dark backgrounds.

## Exit criteria

- Plugin scaffolding contains no placeholder content.
- `mcp/server.mjs` is a standalone artifact with a recorded hash.
- A clean machine with Node 18+ can start the server without npm, npx, bun,
  Git, TypeScript, or network access during startup.
- The build recipe uses a full commit and verified archive hash.
- Local hardening changes are minimal, reviewable, and listed in `UPSTREAM.md`.
- Required upstream and dependency license notices ship with the plugin.
- `.mcp.json` resolves the bundle from both source and installed cache roots.
- The manifest contains no unsupported fields or false publisher claims.

## STOP conditions

- The bundle depends on undeclared files outside the plugin root.
- A clean startup attempts package installation or build-time network access.
- Bundling drops required MCP behavior or license attribution.
- Hardening requires a broad fork or changes the nine public tool semantics;
  propose changes upstream instead and revisit the packaging decision.
