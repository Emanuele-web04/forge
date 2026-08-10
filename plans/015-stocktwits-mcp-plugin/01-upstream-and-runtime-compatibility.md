# Workstream 1 - Upstream and Runtime Compatibility

Status: DONE - pinned audit and Windows-safe runtime contract verified
Depends on: None

## Objective

Freeze the exact upstream revision, review its source and dependency boundary,
capture the MCP contract, and prove the Windows packaging route before creating
the personal marketplace entry.

## Implementation result

Completed against commit
`3c3f6de9192eb910612f5e3d701872adc8ee524b`, authored and committed at
`2026-04-21T11:00:03-04:00`. The Windows `npx` and commit-pinned `bunx` routes
failed as anticipated, so the accepted route is a reviewed standalone ESM
bundle targeting Node.js 18. Git object IDs, downloaded archive SHA-256,
package and license hashes, dependency versions, license texts, audit results,
and the nine-tool MCP contract are recorded in
[IMPLEMENTATION-REPORT.md](./IMPLEMENTATION-REPORT.md).

## Reviewed baseline

Use this full commit unless a newer revision is deliberately selected and this
plan is updated first:

```text
3c3f6de9192eb910612f5e3d701872adc8ee524b
```

Record at implementation time:

- Full Git commit SHA and commit timestamp.
- SHA-256 of the downloaded GitHub source archive.
- `package.json` and lockfile hashes.
- Declared runtime and development dependency versions.
- License files for the upstream server and every dependency included in the
  standalone bundle.
- `npm audit --omit=dev` results against the pinned lockfile.

Do not substitute the Git branch name `main`, a short SHA, or an unversioned
GitHub npm spec in reproducibility metadata.

## Source audit

Re-read all tracked upstream files. The reviewed repository currently contains
only one source file plus package/build metadata, so a full audit is practical.

Confirm that the revision:

1. Uses `StdioServerTransport` and writes protocol responses only to stdout.
2. Sends network requests only to the two documented StockTwits HTTPS origins.
3. Performs only GET requests and contains no account authentication or write
   actions.
4. Does not read local files, enumerate the environment, start subprocesses,
   or persist data after startup.
5. Keeps startup logs and errors on stderr so JSON-RPC framing is not corrupted.
6. Does not introduce postinstall/prepare behavior beyond the reviewed build.
7. Does not add telemetry or a new third-party data recipient.

The `STOCKTWITS_API_BASE` environment override must not silently redirect the
installed plugin. Prefer hard-coding the reviewed official API origin in the
bundled artifact. If exact-source bundling is required instead, explicitly set
and verify the official value in the launcher and document that exception.

## Expected tool contract

Capture `initialize` and `tools/list` output from the built artifact and compare
it to this reviewed contract:

| Tool | Inputs | Expected upstream requests | Notes |
| --- | --- | ---: | --- |
| `get_stock_price` | `symbol` | 1 | Quote and fundamentals from `ql.stocktwits.com` |
| `get_symbol_info` | `symbol` | 2 | Public symbol stream plus optional quote/fundamental enrichment |
| `get_symbol_messages` | `symbol`, `limit=15` | 1 | Maximum 30 recent messages |
| `get_trending` | none | 1 | Current public trending-symbol list |
| `search_symbols` | `query` | 1 | Symbol/name search |
| `get_symbol_sentiment` | `symbol` | 1 | Counts over at most 30 recent messages |
| `get_user_profile` | `username` | 1 | Public profile metadata |
| `get_user_messages` | `username`, `limit=20` | 1 | Maximum 30 recent messages |
| `get_user_sentiment` | `username` | 1 | Per-symbol counts from at most 30 recent messages |

All nine tools must remain read-only. If live discovery adds tools, do not
expose them automatically; review their implementation and data boundary first.

## Reproduce the Windows launch issue

Run the upstream documented command once in an isolated smoke environment:

```powershell
npx -y github:stocktwits/stocktwits-mcp
```

On the reviewed Windows environment, installation exited because the package's
`prepare` path reaches `tsc && chmod +x dist/index.js`, while npm's default
script shell has no `chmod`. Record stdout, stderr, npm/node versions, and exit
code. Do not "fix" the user's global npm `script-shell` setting.

Also verify whether a commit-pinned npm command now works. Even if upstream
fixes Windows installation, keep the local bundle as the default unless a
pinned release artifact provides equivalent reproducibility and startup
reliability.

## Packaging gate

Choose exactly one route and record it in the implementation report:

### Route A - Pinned upstream release artifact

Use only if StockTwits publishes an immutable versioned artifact that:

- is tied to a reviewed Git commit;
- contains the compiled MCP entry point;
- installs on Windows without shell-specific lifecycle steps; and
- can be integrity-pinned without following a mutable branch or tag.

### Route B - Locally bundled pinned source

This is the current preferred route. Build a standalone ESM artifact from the
reviewed commit, include required notices, and launch it with plugin-relative
`node`. Workstream 2 defines the build and package.

Do not use a floating `npx github:stocktwits/stocktwits-mcp` command as the
installed plugin route.

## Protocol smoke test

Before marketplace installation, start the chosen artifact directly and send:

1. `initialize` with a protocol version supported by the current host.
2. `notifications/initialized`.
3. `tools/list`.
4. One low-cost `get_trending` call.
5. One known-symbol `get_stock_price` call.

Verify:

- Initialization completes within 2 seconds after Node starts on a warm disk.
- Exactly nine tools are listed with the expected names and schemas.
- Tool results are valid MCP text content containing parseable JSON.
- No startup log appears on stdout.
- The process exits cleanly when stdin closes.
- Live calls consume no more than the expected request count.

## Exit criteria

- Full revision and artifact provenance are recorded.
- Source and dependency review has no unexplained executable behavior or data
  recipient.
- The Windows `npx` limitation is either reproduced or demonstrably fixed
  upstream.
- One packaging route is selected with evidence.
- The built candidate passes initialization, tool discovery, and two bounded
  live calls.

## STOP conditions

- A dependency audit reports an applicable high or critical runtime
  vulnerability without a reviewed mitigation.
- Source or lockfile content differs from the recorded revision/hash.
- The server performs writes, requires credentials, or sends data to an
  unreviewed origin.
- A tool can escape the fixed StockTwits origins through crafted symbol,
  username, query, or environment input.
- JSON-RPC output is mixed with non-protocol stdout content.
