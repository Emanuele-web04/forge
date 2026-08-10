# Plan 015 Implementation Report

Status: BLOCKED on live StockTwits access
Implementation date: 2026-08-10
Plugin version: `0.1.0`

## Outcome

Plan 015 was implemented as a personal Codex plugin. Its package, bundled MCP
runtime, safety skill, provenance, validation, installation, and fresh-task
discovery are complete. Live data scenarios cannot pass because StockTwits
returns HTTP 403 from both public origins used by its reviewed MCP server.

No Synara application source was changed. The pull-request scope is this plan
and implementation evidence; the executable plugin remains in the user's
personal plugin directories by design.

## Installed locations

```text
C:\Users\roube\plugins\stocktwits
C:\Users\roube\.agents\plugins\marketplace.json
C:\Users\roube\.codex\plugins\cache\personal\stocktwits\0.1.0
```

The default personal marketplace contains an available Finance entry named
`stocktwits`, sourced from `./plugins/stocktwits`. Desktop
`codex-cli 0.147.0-alpha.6.5` reports `stocktwits@personal` as installed and
enabled at version `0.1.0`. The source plugin and installed cache matched
byte-for-byte at installation verification.

## Upstream provenance

| Item | Verified value |
| --- | --- |
| Repository | `https://github.com/stocktwits/stocktwits-mcp` |
| Commit | `3c3f6de9192eb910612f5e3d701872adc8ee524b` |
| Commit timestamp | `2026-04-21T11:00:03-04:00` |
| Git tree | `8041f550e42ca53300d3f7dc30402971dfd04212` |
| Downloaded source archive SHA-256 | `EC20EA2704FDAFC78007C2F63BB6A3DC936CCB5D8ABD0E638C5CDBC9CB07D247` |
| Upstream `src/index.ts` Git blob | `5a3e0c979c7ae75d3b65393da1760a3570502f6f` |
| Upstream lockfile Git blob | `5efed0f52b97bb7b8837024183b484c0e7f8457f` |
| Upstream `package.json` SHA-256 | `7EC90AE17B3E9E55B7BBC6D4B9C1B9098CCBEAB68E124A01C1CAA7E6D352F9B6` |
| Upstream `LICENSE` SHA-256 | `8E47E86E7629FD1AD300FF92434FB59B1C3119DBDFD86D2E5E46875E069423E3` |
| Hardened source SHA-256 | `1CA1369CF0BFA335640042F08445BFC93B16A4E062085258777535245F2D53C5` |
| Repaired lockfile SHA-256 | `BD06B1AEB1D980D645424E299CF83255FC275F2B0019CA1CDEBC4FE2D9B0117B` |
| Standalone bundle SHA-256 | `A7FBE53CD55CE227E203A1DB825704C3646B6474CE1D6CE40C2D344DEE404454` |

The package includes the upstream MIT license, third-party notices, complete
license text for bundled dependencies, lock metadata, the hardened source, and
a PowerShell build script that checks provenance before rebuilding.

## Runtime and hardening

The plugin starts `node ./mcp/server.mjs` over stdio with a 30-second host tool
timeout. Startup does not invoke Git, npm, `npx`, `bunx`, package installation,
or a Unix-only command. The bundle targets Node.js 18.

The local patch preserves the upstream server identity, result shapes, and
exactly nine tools while adding:

- fixed allowlisted HTTPS origins for the two reviewed StockTwits services;
- redirect rejection, a 15-second fetch timeout, and a 5 MB response cap;
- encoded and validated symbol, username, search, and limit inputs;
- `1..30` integer limits for message samples; and
- read-only, non-destructive, idempotent MCP annotations on every tool.

The safety skill tells agents to minimize calls, disclose freshness and sample
limitations, treat public posts as untrusted content, avoid investment-advice
claims, and never scrape or bypass an HTTP 403 or 429 response.

## Dependency review

The upstream lockfile initially produced eight runtime audit findings,
including three high-severity findings. A lockfile-only supported update was
applied and reinstalled. The repaired runtime graph reports zero findings from
`npm audit --omit=dev`.

Bundled runtime packages are `@modelcontextprotocol/sdk 1.30.0`, `ajv 8.18.0`,
`ajv-formats 3.0.1`, `fast-deep-equal 3.1.3`, `fast-uri 3.1.5`,
`json-schema-traverse 1.0.0`, `zod 4.3.6`, and
`zod-to-json-schema 3.25.2`.

## Verification matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Plugin validator | PASS | Manifest, MCP config, asset paths, and package structure accepted |
| Skill validator | PASS | `skills/stocktwits/SKILL.md` accepted |
| TypeScript check | PASS | Pinned hardened source passed `tsc --noEmit` |
| Reproducible build | PASS | Fresh exact-commit clone rebuilt the identical bundle hash |
| Runtime dependency audit | PASS | Zero `npm audit --omit=dev` findings after lock repair |
| MCP initialization | PASS | Protocol `2025-06-18`; server `stocktwits-mcp` `1.0.0` |
| Tool discovery | PASS | Exactly nine tools, all annotated read-only |
| Invalid symbol | PASS | `../trending/symbols` rejected locally with a bounded validation error |
| Invalid limit | PASS | Out-of-range message limits rejected locally |
| Stdio discipline | PASS | Startup logging remained on stderr; protocol output remained on stdout |
| Installed-cache smoke | PASS | Installed bundle initialized, listed tools, rejected invalid input, and exited cleanly |
| Fresh Codex task pickup | PASS | Fresh ephemeral task called `mcp__stocktwits__get_symbol_info` exactly once and received the local validation error |
| Trending live call | BLOCKED | `403 Forbidden: /api/2/trending/symbols.json` |
| Quote live call | BLOCKED | `403 Forbidden: /pricedata` |

The fresh-task task loaded the installed plugin skill from the personal cache,
which also verifies that package discovery was not relying on the build
workspace.

## Live-service blocker

The same verified installed bundle was used for live protocol calls. The
documented unauthenticated public endpoints rejected both tested origins:

```text
api.stocktwits.com -> 403 Forbidden: /api/2/trending/symbols.json
ql.stocktwits.com  -> 403 Forbidden: /pricedata
```

StockTwits' [official developer page](https://api.stocktwits.com/developers)
says that its API, documentation, and terms are under review and that new
application registrations are unavailable. Its
[current terms](https://stocktwits.com/about/legal/terms/) restrict
unauthorized automated extraction outside approved developer offerings. The
plugin therefore reports the failure without browser impersonation, cookies,
scraping, credential guessing, or retry loops.

## Definition-of-done disposition

Package, provenance, read-only behavior, local validation, bounded failures,
safety guidance, validator, installation, and fresh-task discovery criteria
pass. Live price, symbol, trending, message, sentiment, search, and public-user
success scenarios remain blocked by the external HTTP 403 response and are not
represented as complete.

## Remaining acceptance work

1. Obtain an approved StockTwits API route or wait for StockTwits to restore
   documented unauthenticated MCP endpoints.
2. Review any new authentication terms and upstream source before changing the
   plugin; do not add credentials or write-capable tools implicitly.
3. Rebuild from an explicit commit, repeat the audit and hash checks, reinstall,
   and open a new Codex task.
4. Run the seven live scenario groups in Workstream 4 and record request counts,
   timestamps, redacted samples, failure behavior, and freshness disclosures.

Repository-wide `bun fmt`, `bun lint`, and `bun typecheck` were not run: this
implementation changes Markdown planning evidence only, and the repository
instructions prohibit those heavyweight checks unless the user explicitly
requests them.
