# Provider usage research

Reviewed 2026-08-08 against Synara’s current source and the current `main`
branches of [CodexBar](https://github.com/steipete/CodexBar) and
[OpenUsage](https://github.com/janekbaraniewski/openusage). Only public source,
project documentation, and the typed Synara provider metadata were read. No
local credential, cookie, Keychain, `auth.json`, `.env`, or settings file was
read.

## Current Synara scope

Synara’s typed provider contract has nine providers:
[Codex, Claude Agent, Cursor, Antigravity, Grok, Droid, Kilo, OpenCode, and
Pi](../packages/contracts/src/orchestration.ts#L56-L67). All nine are visible in
the usage panel. Codex, Claude Agent, Cursor, Kilo, and Antigravity have direct
live account fetchers; Grok, Droid, OpenCode, and Pi return an explicit
unsupported live-limit state while Synara activity and runtime-reported limits
remain visible.

Live-fetch verification on 2026-08-10 (local machine, signed-in CLIs):

- **Kilo** (`apps/server/src/providerUsage/providers/kilo.ts`): the Kilo CLI
  auth file `~/.local/share/kilo/auth.json` (`kilo.access`) authorizes the
  tRPC batch `user.getCreditBlocks,kiloPass.getState,user.getAutoTopUpPaymentMethod`
  on `https://app.kilo.ai/api/trpc`. Verified live: the batch returns credit
  blocks, `totalBalance_mUsd`, pass subscription, renewal, and auto top-up
  state. No refresh is attempted; the Kilo CLI owns credential rotation.
- **Antigravity** (`apps/server/src/providerUsage/providers/antigravity.ts`):
  the running `agy` CLI (or desktop language server) exposes gRPC-web JSON on a
  loopback port. Verified live on this machine: `GetUserStatus` returns
  `planName`, `monthlyPromptCredits`, `monthlyFlowCredits`, and per-model
  `quotaInfo.remainingFraction`; `RetrieveUserQuotaSummary` returns quota
  groups with weekly/5-hour buckets, `remainingFraction`, and `resetTime`. The
  fetcher discovers the listening port with `pgrep` + `lsof` (read-only) and
  pins all requests to `127.0.0.1`, accepting the self-signed loopback cert
  only there. No credential is read.
- **Grok** ACP billing (`x.ai/billing`) is compiled into grok 1.0.0 but is not
  registered on the `grok agent stdio` surface: a live initialize + billing
  probe returned JSON-RPC `-32601 Method not found` with both unescaped and
  escaped method names, and after `session/new`. CodexBar's test suite carries
  the same fixture, confirming the method is version-gated. Synara therefore
  keeps Grok live limits "unsupported" and adds machine activity from
  `~/.grok/sessions/**/signals.json` (`totalTokensBeforeCompaction` +
  `contextTokensUsed`, `primaryModelId`) instead of inventing quota.

“Tokens” below means counts read from a local transcript, hook, or provider
response. Synara's actual-usage card reads projected user-originated turns and
reports cost only when the adapter reported a per-turn or cumulative cost that
can be safely delta-calculated; it never turns missing cost into zero. A
subscription credit balance is not a per-call invoice. The provider cards also
expose a separate machine-activity plane for safe local readers: Codex and
Claude transcript totals, plus OpenCode/Kilo SQLite message history with
measured token breakdowns, recorded cost, sessions, and upstream-provider/model
grouping. These local totals do not change account-limit state.

## Synara providers

### `codex`

- **CodexBar:** App Auto uses OAuth API, then Codex app-server RPC/PTy; CLI Auto
  uses the optional ChatGPT web dashboard, then CLI RPC/PTy. The CLI path calls
  `account/read` and `account/rateLimits/read`. The OAuth implementation reads
  `GET https://chatgpt.com/backend-api/wham/usage`, or
  `GET <custom-base>/api/codex/usage`, with a Bearer token and optional
  `ChatGPT-Account-Id`. It exposes plan type, primary/secondary windows,
  credits, individual limits, and model-specific additional limits. See the
  [provider map](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md),
  [source selector](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Codex/CodexUsageDataSource.swift),
  and [OAuth fetcher](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Codex/CodexOAuth/CodexOAuthUsageFetcher.swift).
- **Local history and cost:** CodexBar scans `$CODEX_HOME` or `~/.codex`,
  including `sessions/**/*.jsonl` and sibling `archived_sessions` JSONL.
  Synara's bounded local fallback currently reads the recent `sessions` tree;
  it does not claim archived-session coverage. `codexbar cost --format json`
  exposes session and 30-day token/cost totals, daily
  input/output/cache-read/cache-creation/total tokens, models, and Codex
  project breakdowns. Local dollar cost is an estimate, not ChatGPT billing.
  The [CLI contract](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/cli.md)
  also says Codex history is cached in a WAL SQLite store capped at 25,000
  session entries and 256 MiB.
- **OpenUsage:** reads `~/.codex/sessions/**/*.jsonl`, `auth.json`,
  `config.toml`, and `version.json`; it parses the latest session, daily
  counts, per-model/per-client token totals, patch stats, and local session
  metadata. With a non-empty access token it performs the same live `GET`
  usage call and uses local `codex app-server` JSON-RPC
  `account/rateLimits/read` for individual credits when needed. The source
  confirms the request is `GET`, Bearer-authenticated, account-scoped, and
  body-limited to 1 MiB: [provider](https://github.com/janekbaraniewski/openusage/blob/main/internal/providers/codex/codex.go),
  [live reader](https://github.com/janekbaraniewski/openusage/blob/main/internal/providers/codex/live_usage.go),
  [session reader](https://github.com/janekbaraniewski/openusage/blob/main/internal/providers/codex/session_usage_read.go),
  and [official provider guide](https://openusage.sh/docs/providers/codex/).
- **Truth and caveats:** local sessions provide real token counters but no
  pricing; OpenUsage hides dollar cost by default for subscription plans.
  Missing or expired auth leaves local activity visible but removes live
  credits/rate limits. The public guide has one prose reference to POST while
  the endpoint list and source code use GET; GET is the verified method.

### `claudeAgent` (Claude Code)

- **CodexBar:** `api` means an Anthropic Admin key for organization spend and
  message summaries. Auto otherwise tries OAuth, Claude CLI PTY, then the web
  API; the source enum is `api`, `oauth`, `web`, and `cli`. Local cost scans
  `CLAUDE_CONFIG_DIR`, otherwise `~/.config/claude/projects`,
  `~/.claude/projects`, and nested Claude Desktop local-agent JSONL. See the
  [provider map](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md)
  and [source enum](https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Claude/ClaudeUsageDataSource.swift).
- **OpenUsage:** detects `claude` plus `~/.claude`; its documented local
  surface is daily activity, per-model tokens, five-hour billing blocks, burn
  rate, and API-equivalent cost. `session` and `blocks` reports are supported,
  as are Claude Code hooks/statusline integration. The public source tree
  exposes conversation-record, conversation-usage, telemetry, and usage-API
  readers, but does not give a stable filename/schema contract beyond the
  `~/.claude` root: [provider docs](https://raw.githubusercontent.com/janekbaraniewski/openusage/main/docs/providers.md),
  [source directory](https://github.com/janekbaraniewski/openusage/tree/main/internal/providers/claude_code).
- **Truth and caveats:** Admin API organization spend can be vendor data;
  local Claude cost is explicitly an API-equivalent estimate, not a Claude
  subscription charge. CodexBar OAuth token accounts require the `user:profile`
  scope. Web-cookie and Claude Keychain access are optional and platform
  dependent.

### `cursor`

- **CodexBar:** uses the Cursor web API with browser cookies, then a legacy
  stored session or Cursor.app local auth. `codexbar cost` uses the
  cookie-authenticated `cursor.com` dashboard API on macOS; its JSON includes
  model/token estimates and `meteredCostUSD`, the amount Cursor’s plan actually
  deducts, when available. See the [provider map](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md)
  and [cost contract](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/cli.md).
- **OpenUsage:** uses a hybrid Cursor dashboard API plus local SQLite reads. It
  tracks plan spend/limits, per-model aggregation, Composer sessions, and AI
  code scoring. Its API source builds
  `/aiserver.v1.DashboardService/<method>` calls; the documented local format
  is Cursor SQLite, but exact database filenames and schema are not part of the
  public provider contract. See [provider docs](https://raw.githubusercontent.com/janekbaraniewski/openusage/main/docs/providers.md),
  [API source](https://github.com/janekbaraniewski/openusage/blob/main/internal/providers/cursor/api.go),
  and [projection source](https://github.com/janekbaraniewski/openusage/blob/main/internal/providers/cursor/api_projection.go).
- **Truth and caveats:** OpenUsage says Cursor Composer cost is billable and
  AI code scoring is cached; CodexBar distinguishes Cursor’s metered plan
  deduction from its API-rate estimate. Browser-cookie import can require
  macOS Keychain access; Linux browser-backed CodexBar modes are unsupported.

### `antigravity`

- **CodexBar:** this is a local signed-in Antigravity surface, not Gemini API
  billing. It probes the local HTTPS language server, uses the `agy` CLI when
  the IDE is closed, and falls back to Google OAuth. The named methods are
  `RetrieveUserQuotaSummary`, `GetUserStatus`, and
  `GetCommandModelConfigs`; the result is quota/status/model-plan data.
  See [Antigravity’s provider entry](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md).
- **OpenUsage:** Antigravity is not in the 19-provider registered set in the
  current [provider contract](https://openusage.sh/docs/concepts/providers/)
  and has no matching provider package in the documented active list.
- **Synara implementation:** the local language server (running `agy` or the
  desktop app) exposes `GetUserStatus` and `RetrieveUserQuotaSummary` as
  gRPC-web JSON on a loopback port. Synara discovers the port read-only via
  `pgrep` + `lsof`, pins requests to `127.0.0.1`, and maps quota groups
  (weekly/5-hour buckets with `remainingFraction` and `resetTime`) plus
  `monthlyPromptCredits`/`monthlyFlowCredits` into the account-limit plane.
  Live-verified on a signed-in machine: plan `Pro`, per-model quota rows, and
  the quota summary all returned without reading credentials.

### `grok`

- **CodexBar:** this means the consumer Grok/SuperGrok account. It calls the
  `grok agent stdio` ACP JSON-RPC `x.ai/billing` method after `grok login`, then
  falls back to the grok.com billing gRPC-web endpoint through Chrome cookies.
  If billing is unavailable it aggregates token counts from
  `~/.grok/sessions/**/signals.json`. The scope is the signed-in consumer
  account/team and its subscription quota, not developer API billing. See
  [Grok’s provider entry](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md).
- **OpenUsage:** its documented `xAI` provider is a separate developer-platform
  API-key surface for rate limits and API-key information. It is not evidence
  that OpenUsage reads Grok consumer sessions or `signals.json`: [README](https://raw.githubusercontent.com/janekbaraniewski/openusage/main/README.md).
- **Auth/cost:** CodexBar’s browser fallback is explicit/opt-in and its cookie
  cache is Keychain-backed. No project documents a first-party Grok consumer
  invoice or local dollar-cost source.
- **Synara implementation:** live probing on grok 1.0.0 shows `x.ai/billing`
  (and `x.ai/auto-topup-rule`) compile into the binary but are not registered
  on the `grok agent stdio` surface — initialize + billing probes return
  JSON-RPC `-32601 Method not found` even after `session/new`, and CodexBar's
  own test fixtures carry the same error. Synara therefore keeps Grok live
  limits "unsupported" and reads provider-owned machine activity from
  `~/.grok/sessions/**/signals.json` (`totalTokensBeforeCompaction` +
  `contextTokensUsed`, `primaryModelId`) instead of inventing a quota.

### `droid`

- **CodexBar:** the Droid/Factory provider tries `FACTORY_API_KEY` or the
  configured key, then Factory cookies, bearer/stored tokens, local storage,
  and WorkOS refresh-token cookies. The source map identifies this as an
  account/web/API usage surface; it does not claim a local transcript cost
  reader. See [provider map](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md).
- **OpenUsage:** the README includes Droid in `session`/`blocks` reports and
  the source tree contains a `droid` package, but the current registered-19
  provider contract does not list it. Exact endpoints, local file format,
  account scope, and whether its cost is vendor-reported or estimated remain
  unresolved from the public sources reviewed.

### `kilo`

- **CodexBar:** uses the Kilo API token and usage API first, then CLI auth from
  `~/.local/share/kilo/auth.json` (`kilo.access`), normally created by `kilo
login`. The documented result is Kilo Pass usage/quota; no local token-cost
  history is promised. See [Kilo entry](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md).
- **OpenUsage:** the README includes Kilo Code in `session`/`blocks` reports
  and the source tree contains `kilocode`, but the current registered-19
  contract does not list it. Exact reader path, fields, limits, and billing
  semantics remain unresolved.
- **Synara implementation:** the Kilo CLI auth file (`~/.local/share/kilo/
auth.json`, `kilo.access`) authorizes the tRPC batch
  `user.getCreditBlocks,kiloPass.getState,user.getAutoTopUpPaymentMethod` on
  `https://app.kilo.ai/api/trpc`. Live-verified on a signed-in machine: credit
  blocks, `totalBalance_mUsd`, pass subscription/renewal, and auto top-up
  state all returned with the CLI token. No refresh is attempted; the Kilo CLI
  owns credential rotation. Kilo SQLite machine history remains a separate
  plane.

### `opencode`

- **CodexBar:** generic OpenCode uses the `opencode.ai` web dashboard through
  cookies. CodexBar separately names **OpenCode Go**: unscoped Auto first reads
  `~/.local/share/opencode/opencode.db` (SQLite), then web; the web surface
  exposes rolling five-hour, weekly, and optional monthly windows. This Go
  surface is not the same provider ID as Synara’s generic `opencode`. See
  [provider map](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md).
- **OpenUsage:** API-key polling calls `GET https://opencode.ai/zen/v1/models`
  for model availability and auth. Optional browser-session console RPCs
  (`server.queryBilling`) add balance, monthly usage/limit, reload settings,
  subscription, and payment metadata. The OpenCode integration posts per-turn
  model, token, and tool events to the local daemon; those events are tagged
  with the upstream provider (`anthropic`, `openai`, `google`, and so on), not
  automatically with `opencode`. It reads OpenCode’s
  `~/.local/share/opencode/auth.json` (or the XDG equivalent), with environment
  variables winning over adopted API keys. See the [official OpenCode guide](https://openusage.sh/docs/providers/opencode/).
- **Truth and caveats:** API polling alone gives no per-session spend. Plugin
  telemetry gives actual local event/token data; balance and monthly usage are
  console data. A workspace ID scopes console billing. CodexBar’s OpenCode Go
  SQLite history is a separate, provider-specific local path.

### `pi`

- **CodexBar:** Pi is not a first-class provider row. The cost CLI documents Pi
  and OMP **session mirrors** that are included unless
  `--provider-native-only` is used; those mirrors belong to Claude/Codex cost
  scans, not a Pi quota API. See [CLI docs](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/cli.md).
- **OpenUsage:** the source tree and provider navigation contain `pi`, but the
  README’s session/blocks table omits Pi and the registered-19 contract lists
  neither Pi nor its local path. Exact registration, history format, limits,
  and cost behavior remain unresolved.

## Additional provider coverage

### CodexBar

CodexBar’s provider map says it currently registers 67 IDs and intentionally
separates surfaces such as Codex/OpenAI API and OpenCode/OpenCode Go. Beyond
Synara’s nine (with Claude Agent corresponding to CodexBar’s Claude, and
Droid/Factory and Grok being grouped surfaces), the documented additions are:

- **API/account:** OpenAI Admin organization spend/usage or legacy balance;
  Azure OpenAI deployment probe; z.ai quota; GitHub Copilot’s
  `api.github.com/copilot_internal/user`; Warp GraphQL limits; ElevenLabs
  subscription; Synthetic five-hour/weekly/search-hourly lanes; OpenRouter
  credits, rate limits, and daily/weekly/monthly key spend; Doubao/Volcengine
  rate-limit headers; DeepSeek balance; DeepInfra billing checklist and
  monthly spend; Moonshot/Kimi balance; Codebuff usage; Crof credits/request
  quota; Venice balance; ClinePass five-hour/weekly/monthly limits; AWS Cost
  Explorer plus optional CloudWatch; GroqCloud Prometheus request/token/cache
  rates; LLM Proxy `/v1/quota-stats`; ClawRouter `/v1/usage`; LiteLLM
  `/key/info` then `/user/info` or `/team/info`; Deepgram usage; Chutes quota;
  Neuralwatt `/v1/quota`; ZenMux five-hour/seven-day/PAYG; ai& request-log
  spend; and xAI Management API balance/30-day spend.
- **CLI/local:** Gemini OAuth quota (`retrieveUserQuota` with
  `loadCodeAssist` tier detection); Kiro’s
  `kiro-cli chat --no-interactive "/usage"`; Vertex ADC plus Cloud Monitoring
  `consumer_quota`; JetBrains `AIAssistantQuotaManager2.xml`; Amp CLI/API/web;
  Windsurf browser localStorage plus `state.vscdb`; Ollama Cloud settings;
  and Zed Keychain plus `GET https://cloud.zed.dev/client/users/me`.
- **Web/cookie/account:** Alibaba Coding Plan console RPC and API-key
  fallback; Alibaba Token Plan `GetSubscriptionSummary` and quota windows;
  Qwen Cloud Token Plan APIs; Devin Chrome localStorage plus
  `/api/<org>/billing/quota/usage`; Manus `POST .../GetAvailableCredits`;
  additional coding plans; Kimi Code; a chat-service tRPC
  `getCustomerData`; ZoomMate credits; Perplexity credits; Xiaomi MiMo
  balance/token-plan endpoints; Sakana billing/pay-as-you-go; Abacus compute
  points/billing; Mistral billing/credits/Vibe; Command Code billing; Qoder
  dashboard credits; Notion AI workspace allowance; and Poe balance/history.
- **Other local gateways:** Wayfinder `/healthz`, `/router/models`,
  `/v1/savings`, `/metrics`, and sub2api `/v1/usage`.

The [CodexBar provider source map](https://raw.githubusercontent.com/steipete/CodexBar/main/docs/providers.md)
is the exact per-provider method/data reference. Its explicitly documented
local-history formats are limited: Codex and Claude JSONL, OpenCode Go SQLite,
Grok `signals.json`, Windsurf `state.vscdb`, JetBrains XML, Xiaomi’s opt-in
cache, and Vertex’s Claude-log-derived token cost. The remaining rows are
live API, CLI, web, browser-storage, or account surfaces rather than local
history readers. Local CodexBar cost history is only advertised for Codex,
Claude, Vertex AI, OpenAI, Mistral, and AWS Bedrock; it is local, 7/30-day,
estimated, and kept separate by currency.

### OpenUsage

The current [OpenUsage provider contract](https://openusage.sh/docs/concepts/providers/)
says the binary registers 19 providers and defines the exact source method as
the normalized `UsageProvider.Fetch(ctx, AccountConfig) -> UsageSnapshot`.
Its documented active set is:

- **Coding/local:** `claude_code`, `cursor`, `codex`, `copilot`, `gemini_cli`,
  `opencode`, and `ollama`.
- **API:** `openai`, `anthropic`, `openrouter`, `groq`, `mistral`, `deepseek`,
  `xai`, `gemini_api`, `alibaba_cloud`, `moonshot`, `zai`, and `perplexity`.

The additional active API surfaces therefore add OpenAI, Anthropic, OpenRouter,
Groq, Mistral, DeepSeek, xAI developer API, Gemini API, Alibaba Cloud,
Moonshot/Kimi, Z.AI, and Perplexity; the coding overlap is Codex, Claude Code,
Cursor, and OpenCode. Key data boundaries are:

- OpenAI is a single `GET /v1/models/{probe_model}` per poll, reading RPM/TPM
  headers, reset values, and auth status only. It provides no spend or token
  counts; the probe model scopes the reported limit. The default poll interval
  is 30 seconds: [official OpenAI provider guide](https://openusage.sh/docs/providers/openai/).
- OpenRouter exposes credits, activity, generation, and per-model data;
  Perplexity uses a browser session and console RPCs for tier, balance, spend,
  and 30-day analytics including input/output/reasoning tokens and search
  queries. Moonshot exposes cash/voucher balance, organization limits, tier,
  and regional API selection. Z.AI exposes coding-plan quota, model/tool usage,
  and daily trends. The source of truth is the [provider catalog](https://raw.githubusercontent.com/janekbaraniewski/openusage/main/docs/providers.md).
- Remote API platforms are periodic-only because they do not expose per-turn
  data. Coding-agent sessions, hooks, and local integrations provide the
  higher-resolution history. OpenUsage’s daemon stores that history in
  `~/.local/state/openusage/telemetry.db`; settings are in
  `~/.config/openusage/settings.json`. See the [FAQ](https://openusage.sh/docs/faq/)
  and [capability matrix](https://openusage.sh/docs/capability-matrix/).
- Browser-session auth is opt-in, scoped to one domain/cookie-name pair, stored
  with restrictive permissions, and not sent to OpenUsage. API keys are
  referenced by environment-variable name rather than copied into settings;
  the daemon service environment must be reinstalled after changing keys. No
  key values were inspected here.

The OpenUsage README also says “35 providers,” its website says “34,” and its
README `session`/`blocks` table advertises Amp, Codebuff, Crush, Droid, Goose,
Hermes, Kilo Code, OpenClaw, Roo Code, Zed, and others. The source tree contains
packages for those plus `kimi_cli`, `mux`, `pi`, and `qwen_cli`:
[provider directory](https://github.com/janekbaraniewski/openusage/tree/main/internal/providers).
Those are useful additional tool surfaces, but they are not all present in the
current registered-19 list. Do not treat a package directory or report-table
entry as a confirmed live provider until `internal/providers/registry.go` and
the matching reader are checked at a pinned revision.

## Limits, history, and privacy boundaries

- OpenUsage normally makes one or two provider requests per provider per 30
  seconds; most rate-limit providers use one header-only request. CodexBar’s
  `serve` defaults to a 60-second cache, 30-second request timeout, loopback
  binding, and last-good fallback. Non-loopback CodexBar data routes require a
  bearer token and explicit plain-HTTP acknowledgement.
- CodexBar browser cookies are opt-in, may require macOS Keychain/Safe Storage
  access, and are cached in Keychain. Its local scans read known paths only;
  they are not a filesystem crawl. OpenUsage has no hosted telemetry service;
  provider calls and the daemon socket/store stay local to the machine except
  for the provider requests the user has configured.
- Neither project can turn an absent provider field into authoritative cost.
  Codex/Claude local cost is estimated; OpenCode API polling has no per-turn
  spend; Cursor is the clearest Synara overlap with vendor-reported metered
  plan cost; direct API providers are authoritative only for the fields their
  own API returns.

## License and attribution

[CodexBar is MIT licensed](https://raw.githubusercontent.com/steipete/CodexBar/main/LICENSE),
copyright Peter Steinberger (2026). [OpenUsage is MIT licensed](https://raw.githubusercontent.com/janekbaraniewski/openusage/main/LICENSE),
copyright Jan Baraniewski (2026). This note copies no source code. If Synara
later copies or adapts implementation code, preserve the relevant MIT notice
and review the additional dependency notices declared in CodexBar’s
[Package.swift](https://raw.githubusercontent.com/steipete/CodexBar/main/Package.swift)
and OpenUsage’s [go.mod](https://raw.githubusercontent.com/janekbaraniewski/openusage/main/go.mod).
Provider names, endpoints, cookies, and quotas remain subject to each
provider’s own terms; this research grants no permission to access or publish
credentials.

## Unresolved facts

1. OpenUsage’s public counts conflict: docs say 17 in one page, the provider
   contract says 19, the website says 34, and the README says 35. The active
   registry and source revision should be pinned before implementing an
   importer.
2. OpenUsage’s public pages do not fully specify Claude transcript filenames or
   schemas, nor the exact local readers and fields for Droid, Kilo Code, Pi,
   Mux, Qwen CLI, and the other source-tree-only packages.
3. CodexBar groups some IDs into one table row and deliberately separates
   consumer, subscription, API, and workspace surfaces. The exact normalized
   ID mapping should be taken from its provider registry at the implementation
   revision, not inferred from display names.
4. Antigravity has no verified raw-token, local-history, or invoice-cost source
   in either project. Grok consumer billing and xAI developer billing are also
   separate surfaces and must not be merged.
5. Vendor API and subscription behavior changes quickly. Any implementation
   should re-check endpoint methods, scopes, and response fields against pinned
   source and live, non-secret test fixtures before shipping.
