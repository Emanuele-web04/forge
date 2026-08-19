// FILE: providerUsage/providers/grok.ts
// Purpose: Live Grok (SuperGrok) usage fetcher. Reads the OIDC bearer from the Grok CLI
// auth.json (`$GROK_HOME/auth.json` or `~/.grok/auth.json`) and calls the CLI-proxy
// billing API (`/v1/billing?format=credits`) for the SuperGrok / SuperGrok Heavy weekly pool.
//
// Access tokens last ~6 hours. Like Codex, file-sourced credentials are refreshed here
// with the care rotating refresh tokens demand: re-read the live auth.json right before
// redeeming (the CLI may have rotated it since we loaded), redeem at most once per fetch,
// and atomically persist the rotated pair back to the same file so the CLI's login
// survives. Never refresh when we cannot write the rotation back. API keys have no
// weekly pool — SuperGrok usage requires `grok login`. Team principals are unsupported.

import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import { createLogger } from "../../logger";
import {
  credentialFingerprint,
  decodeJwtExpMs,
  readJsonFile,
  refreshOAuthAccessToken,
  writeJsonFileAtomic,
  type OAuthRefreshResult,
} from "../credentials";
import { fetchJson, isAuthFailureStatus } from "../http";
import {
  asFiniteNumber,
  asRecord,
  asString,
  buildSnapshot,
  clampPercent,
  errorSnapshot,
  formatUsd,
  isoFromString,
  needsAuthSnapshot,
  unsupportedSnapshot,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const log = createLogger("provider-usage:grok");

const SOURCE = "grok-cli-proxy-credits";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const CLI_PROXY_ORIGIN = new URL(BILLING_URL).origin;
const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const PREFERRED_SCOPE_PREFIX = "https://auth.x.ai::";
const SIGN_IN_SCOPE = "https://accounts.x.ai/sign-in";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const SETTINGS_TIMEOUT_MS = 2_000;
const WELL_KNOWN_TIMEOUT_MS = 5_000;
const WEEKLY_WINDOW_MINS = 10_080;

const REFRESH_TOKEN_DEAD_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "refresh_token_expired",
  "refresh_token_invalidated",
]);
const REFRESH_TOKEN_REUSED_CODE = "refresh_token_reused";

interface GrokOAuthState {
  kind: "oauth";
  /** Absolute auth.json path; rotations are written back here. */
  path: string;
  /** Full parsed auth.json map, kept for a field-preserving write-back after rotation. */
  root: Record<string, unknown>;
  /** Map key of the selected credential entry (scope URL). */
  scope: string;
  entry: Record<string, unknown>;
  accessToken: string;
  refreshToken: string | undefined;
  expiresAtMs: number | undefined;
  clientId: string | undefined;
  issuer: string | undefined;
  principalType: string | undefined;
}

type GrokAuth = GrokOAuthState | { kind: "api-key" };

function grokAuthFilePath(ctx: ProviderUsageContext): string {
  const grokHome = asString(ctx.env.GROK_HOME);
  if (grokHome) {
    return nodePath.join(grokHome, "auth.json");
  }
  return nodePath.join(ctx.homeDir, ".grok", "auth.json");
}

function grokEnvHasApiKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(asString(env.XAI_API_KEY) || asString(env.GROK_CODE_XAI_API_KEY));
}

function isTeamPrincipal(principalType: string | undefined): boolean {
  return principalType?.toLowerCase() === "team";
}

function entryAccessToken(
  value: unknown,
): { entry: Record<string, unknown>; accessToken: string } | null {
  const entry = asRecord(value);
  const accessToken = asString(entry?.key);
  return entry && accessToken ? { entry, accessToken } : null;
}

function pickAuthEntry(
  root: Record<string, unknown>,
): { scope: string; entry: Record<string, unknown>; accessToken: string } | null {
  for (const [scope, value] of Object.entries(root)) {
    if (!scope.startsWith(PREFERRED_SCOPE_PREFIX)) {
      continue;
    }
    const picked = entryAccessToken(value);
    if (picked) {
      return { scope, ...picked };
    }
  }

  const signIn = entryAccessToken(root[SIGN_IN_SCOPE]);
  if (signIn) {
    return { scope: SIGN_IN_SCOPE, ...signIn };
  }

  for (const [scope, value] of Object.entries(root)) {
    const picked = entryAccessToken(value);
    if (picked) {
      return { scope, ...picked };
    }
  }
  return null;
}

function readExpiresAtMs(entry: Record<string, unknown>): number | undefined {
  const text = asString(entry.expires_at);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const numeric = asFiniteNumber(entry.expires_at);
  if (numeric === undefined) {
    return undefined;
  }
  return numeric > 1e12 ? numeric : numeric * 1000;
}

function readGrokAuthState(
  path: string,
  root: Record<string, unknown> | null,
  preferredScope?: string,
): GrokOAuthState | null {
  if (!root) {
    return null;
  }

  let picked: { scope: string; entry: Record<string, unknown>; accessToken: string } | null = null;
  if (preferredScope) {
    const preferred = entryAccessToken(root[preferredScope]);
    if (preferred) {
      picked = { scope: preferredScope, ...preferred };
    }
  }
  picked ??= pickAuthEntry(root);
  if (!picked) {
    return null;
  }

  return {
    kind: "oauth",
    path,
    root,
    scope: picked.scope,
    entry: picked.entry,
    accessToken: picked.accessToken,
    refreshToken: asString(picked.entry.refresh_token),
    expiresAtMs: readExpiresAtMs(picked.entry),
    clientId: asString(picked.entry.oidc_client_id),
    issuer: asString(picked.entry.oidc_issuer),
    principalType: asString(picked.entry.principal_type),
  };
}

async function reloadGrokAuth(state: GrokOAuthState): Promise<GrokOAuthState | null> {
  return readGrokAuthState(state.path, asRecord(await readJsonFile(state.path)), state.scope);
}

async function resolveGrokAuth(ctx: ProviderUsageContext): Promise<GrokAuth | null> {
  const path = grokAuthFilePath(ctx);
  const state = readGrokAuthState(path, asRecord(await readJsonFile(path)));
  if (state) {
    return state;
  }
  return grokEnvHasApiKey(ctx.env) ? { kind: "api-key" } : null;
}

function grokAuthCacheKey(ctx: ProviderUsageContext, auth: GrokAuth | null): string {
  if (!auth || auth.kind === "api-key") {
    return `${ctx.homeDir}:none`;
  }
  return `${ctx.homeDir}:${credentialFingerprint(auth.refreshToken ?? auth.accessToken)}`;
}

/** Refresh once the access token is within 5 minutes of `expires_at` or its JWT `exp`. */
function grokAuthNeedsRefresh(state: GrokOAuthState, nowMs: number): boolean {
  const jwtExpMs = decodeJwtExpMs(state.accessToken);
  const candidates: number[] = [];
  if (state.expiresAtMs !== undefined) {
    candidates.push(state.expiresAtMs);
  }
  if (jwtExpMs !== null) {
    candidates.push(jwtExpMs);
  }
  if (candidates.length === 0) {
    return false;
  }
  return Math.min(...candidates) - nowMs <= ACCESS_TOKEN_REFRESH_WINDOW_MS;
}

const refreshLocks = new Map<string, Promise<unknown>>();
function withRefreshLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = refreshLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  refreshLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

const tokenEndpointCache = new Map<string, string>();

async function resolveTokenUrl(issuer: string | undefined): Promise<string> {
  const normalized = (issuer ?? DEFAULT_ISSUER).replace(/\/$/u, "");
  if (normalized === DEFAULT_ISSUER) {
    return DEFAULT_TOKEN_URL;
  }

  const cached = tokenEndpointCache.get(normalized);
  if (cached) {
    return cached;
  }

  try {
    const wellKnownUrl = `${normalized}/.well-known/openid-configuration`;
    const result = await fetchJson({
      service: "provider-usage-grok-oidc",
      url: wellKnownUrl,
      allowedOrigins: [new URL(wellKnownUrl).origin],
      headers: { Accept: "application/json", "User-Agent": "Synara" },
      timeoutMs: WELL_KNOWN_TIMEOUT_MS,
    });
    const tokenEndpoint = asString(asRecord(result.json)?.token_endpoint);
    if (result.ok && tokenEndpoint) {
      tokenEndpointCache.set(normalized, tokenEndpoint);
      return tokenEndpoint;
    }
  } catch {
    // Fall back to the SpaceXAI token endpoint.
  }

  return DEFAULT_TOKEN_URL;
}

function expiresAtIso(refreshed: Extract<OAuthRefreshResult, { ok: true }>): string | undefined {
  if (refreshed.expiresAtMs !== undefined) {
    return new Date(refreshed.expiresAtMs).toISOString();
  }
  const jwtExpMs = decodeJwtExpMs(refreshed.accessToken);
  return jwtExpMs !== null ? new Date(jwtExpMs).toISOString() : undefined;
}

/** Apply a token-endpoint rotation to the in-memory state and persist it back to auth.json.
 * Persistence failures are logged loudly but don't fail the fetch: the refreshed token still
 * works for this pass, while the stranded rotation is the thing worth surfacing. */
async function persistRotatedGrokAuth(
  state: GrokOAuthState,
  refreshed: Extract<OAuthRefreshResult, { ok: true }>,
): Promise<GrokOAuthState> {
  const liveRoot = asRecord(await readJsonFile(state.path)) ?? state.root;
  const liveEntry = asRecord(liveRoot[state.scope]) ?? state.entry;
  const entry: Record<string, unknown> = {
    ...liveEntry,
    key: refreshed.accessToken,
  };
  if (refreshed.refreshToken) {
    entry.refresh_token = refreshed.refreshToken;
  }
  const expiresAt = expiresAtIso(refreshed);
  if (expiresAt) {
    entry.expires_at = expiresAt;
  }
  const root: Record<string, unknown> = {
    ...liveRoot,
    [state.scope]: entry,
  };
  try {
    await writeJsonFileAtomic(state.path, root);
  } catch (cause) {
    log.error(
      "failed to persist rotated grok credentials; the CLI may need a re-login if the old refresh token is gone",
      { message: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  return {
    ...state,
    root,
    entry,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? state.refreshToken,
    expiresAtMs:
      refreshed.expiresAtMs ?? decodeJwtExpMs(refreshed.accessToken) ?? state.expiresAtMs,
  };
}

type GrokRefreshOutcome =
  | { kind: "updated"; state: GrokOAuthState; redeemed: boolean }
  | { kind: "needs-auth" }
  | { kind: "unavailable" };

/**
 * Bring a stale/rejected credential up to date. Order matters: adopt an out-of-band rotation
 * from the live file first (redeeming our stale copy would trip `refresh_token_reused`), then
 * redeem the refresh token ourselves at most once (`allowRedeem`), persisting the rotation.
 */
async function refreshGrokAuth(
  ctx: ProviderUsageContext,
  state: GrokOAuthState,
  options: { allowRedeem: boolean },
): Promise<GrokRefreshOutcome> {
  return withRefreshLock(state.path, async () => {
    try {
      const live = (await reloadGrokAuth(state)) ?? state;
      if (live.accessToken !== state.accessToken && !grokAuthNeedsRefresh(live, ctx.nowMs)) {
        return { kind: "updated", state: live, redeemed: false };
      }
      if (!options.allowRedeem) {
        return live.accessToken !== state.accessToken
          ? { kind: "updated", state: live, redeemed: false }
          : { kind: "needs-auth" };
      }
      // Rotating refresh tokens must not be redeemed unless we can write the new pair back.
      if (!live.refreshToken || !live.clientId) {
        return { kind: "needs-auth" };
      }

      let refreshUrl: string;
      try {
        refreshUrl = await resolveTokenUrl(live.issuer);
      } catch {
        log.warn("grok token endpoint discovery failed; continuing with the stored access token");
        return { kind: "unavailable" };
      }

      const refreshed = await refreshOAuthAccessToken({
        service: "provider-usage-grok-refresh",
        refreshUrl,
        allowedOrigins: [new URL(refreshUrl).origin],
        refreshToken: live.refreshToken,
        clientId: live.clientId,
        bodyFormat: "form",
      });
      if (refreshed.ok) {
        return {
          kind: "updated",
          state: await persistRotatedGrokAuth(live, refreshed),
          redeemed: true,
        };
      }
      if (refreshed.errorCode === REFRESH_TOKEN_REUSED_CODE) {
        const rotated = await reloadGrokAuth(state);
        if (rotated && rotated.accessToken !== live.accessToken) {
          return { kind: "updated", state: rotated, redeemed: false };
        }
        log.warn("grok refresh token already redeemed and no rotated credential found on disk");
        return { kind: "needs-auth" };
      }
      if (refreshed.errorCode && REFRESH_TOKEN_DEAD_CODES.has(refreshed.errorCode)) {
        log.warn("grok refresh token rejected; re-login required", {
          errorCode: refreshed.errorCode,
        });
        return { kind: "needs-auth" };
      }
      log.warn(
        "grok token refresh unavailable; continuing with the stored access token",
        refreshed.status !== undefined ? { status: refreshed.status } : undefined,
      );
      return { kind: "unavailable" };
    } catch (cause) {
      log.warn("grok token refresh unavailable; continuing with the stored access token", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return { kind: "unavailable" };
    }
  });
}

function grokHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "Synara",
  };
}

function protoVal(value: unknown): number | undefined {
  const direct = asFiniteNumber(value);
  if (direct !== undefined) {
    return direct;
  }
  return asFiniteNumber(asRecord(value)?.val);
}

/** CLI-proxy amounts are integer cents (Cursor-style); fractional values are already dollars. */
function usdFromCentsish(amount: number): string {
  return formatUsd(Number.isInteger(amount) ? amount / 100 : amount);
}

function compactLetters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/gu, "");
}

function grokPlanName(raw: string | undefined): string | undefined {
  const trimmed = asString(raw);
  if (!trimmed) {
    return undefined;
  }
  const compact = compactLetters(trimmed);
  if (compact.includes("supergrokheavy") || compact === "heavy") {
    return "SuperGrok Heavy";
  }
  if (compact.includes("supergrok")) {
    return "SuperGrok";
  }
  return trimmed;
}

function readSettingsPlanName(json: unknown): string | undefined {
  const root = asRecord(json);
  if (!root) {
    return undefined;
  }
  return (
    asString(root.subscription_tier_display) ??
    asString(asRecord(root.settings)?.subscription_tier_display) ??
    asString(asRecord(root.config)?.subscription_tier_display)
  );
}

export function parseGrokUsage(input: { billing: unknown; planName?: string; nowMs: number }) {
  const root = asRecord(input.billing);
  const config = asRecord(root?.config) ?? root;
  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];
  const planName = grokPlanName(input.planName);

  if (config) {
    const currentPeriod = asRecord(config.currentPeriod);
    const periodType = asString(currentPeriod?.type) ?? "";
    const isUnified = config.isUnifiedBillingUser === true;
    const isWeekly = /weekly/iu.test(periodType) || (periodType.length === 0 && isUnified);

    let usedPercent = clampPercent(asFiniteNumber(config.creditUsagePercent));
    if (usedPercent === undefined) {
      const onDemandUsed = protoVal(config.onDemandUsed);
      const onDemandCap = protoVal(config.onDemandCap);
      if (onDemandUsed !== undefined && onDemandCap !== undefined && onDemandCap > 0) {
        usedPercent = clampPercent((onDemandUsed / onDemandCap) * 100);
      } else if (currentPeriod) {
        usedPercent = 0;
      }
    }

    const resetsAt = isoFromString(currentPeriod?.end) ?? isoFromString(config.billingPeriodEnd);
    if (usedPercent !== undefined || resetsAt) {
      limits.push({
        window: isWeekly ? "Weekly" : "Current",
        ...(usedPercent !== undefined ? { usedPercent } : {}),
        ...(resetsAt ? { resetsAt } : {}),
        ...(isWeekly ? { windowDurationMins: WEEKLY_WINDOW_MINS } : {}),
      });
    }

    const prepaid = protoVal(config.prepaidBalance);
    if (prepaid !== undefined && prepaid > 0) {
      usageLines.push({ label: "Credits", value: `${usdFromCentsish(prepaid)} remaining` });
    }

    const onDemandCap = protoVal(config.onDemandCap);
    if (onDemandCap !== undefined && onDemandCap > 0) {
      const onDemandUsed = protoVal(config.onDemandUsed);
      usageLines.push({
        label: "On-demand",
        value:
          onDemandUsed !== undefined
            ? `${usdFromCentsish(onDemandUsed)} of ${usdFromCentsish(onDemandCap)}`
            : `${usdFromCentsish(onDemandCap)} limit`,
      });
    }
  }

  return buildSnapshot({
    provider: "grok",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(planName ? { planName } : {}),
  });
}

function fetchGrokBilling(accessToken: string) {
  return fetchJson({
    service: "provider-usage-grok",
    url: BILLING_URL,
    allowedOrigins: [CLI_PROXY_ORIGIN],
    headers: grokHeaders(accessToken),
  });
}

async function fetchGrokPlanName(accessToken: string): Promise<string | undefined> {
  try {
    const result = await fetchJson({
      service: "provider-usage-grok",
      url: SETTINGS_URL,
      allowedOrigins: [CLI_PROXY_ORIGIN],
      headers: grokHeaders(accessToken),
      timeoutMs: SETTINGS_TIMEOUT_MS,
    });
    if (!result.ok) {
      return undefined;
    }
    return grokPlanName(readSettingsPlanName(result.json));
  } catch {
    return undefined;
  }
}

export const grokUsageFetcher: ProviderUsageFetcher = {
  provider: "grok",
  async cacheKey(ctx) {
    return grokAuthCacheKey(ctx, await resolveGrokAuth(ctx));
  },
  async fetch(ctx) {
    try {
      const auth = await resolveGrokAuth(ctx);
      if (!auth) {
        return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
      }
      if (auth.kind === "api-key") {
        return unsupportedSnapshot(
          "grok",
          ctx.nowMs,
          SOURCE,
          "SuperGrok usage requires `grok login`. API keys have no weekly pool.",
        );
      }
      if (isTeamPrincipal(auth.principalType)) {
        return unsupportedSnapshot(
          "grok",
          ctx.nowMs,
          SOURCE,
          "Grok team-account usage is unavailable.",
        );
      }

      let state = auth;
      // At most one token-endpoint redemption per fetch: if a just-refreshed token still comes
      // back 401, a second redemption can only burn credentials, not fix anything.
      let allowRedeem = true;

      if (grokAuthNeedsRefresh(state, ctx.nowMs)) {
        const outcome = await refreshGrokAuth(ctx, state, { allowRedeem });
        if (outcome.kind === "needs-auth") {
          return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
        }
        if (outcome.kind === "updated") {
          allowRedeem = allowRedeem && !outcome.redeemed;
          state = outcome.state;
        }
      }

      let result = await fetchGrokBilling(state.accessToken);
      if (isAuthFailureStatus(result.status)) {
        const outcome = await refreshGrokAuth(ctx, state, { allowRedeem });
        if (outcome.kind === "updated" && outcome.state.accessToken !== state.accessToken) {
          state = outcome.state;
          result = await fetchGrokBilling(state.accessToken);
        }
      }
      if (isAuthFailureStatus(result.status)) {
        log.warn("grok usage request unauthorized after refresh", { status: result.status });
        return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
      }
      if (!result.ok) {
        log.warn("grok usage request failed", { status: result.status });
        return errorSnapshot(
          "grok",
          ctx.nowMs,
          SOURCE,
          `Grok usage request failed (${result.status}).`,
        );
      }

      const planName = await fetchGrokPlanName(state.accessToken);
      return parseGrokUsage({
        billing: result.json,
        nowMs: ctx.nowMs,
        ...(planName ? { planName } : {}),
      });
    } catch (cause) {
      log.warn("grok usage endpoint unreachable", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return errorSnapshot("grok", ctx.nowMs, SOURCE, "Could not reach the Grok usage endpoint.");
    }
  },
};
