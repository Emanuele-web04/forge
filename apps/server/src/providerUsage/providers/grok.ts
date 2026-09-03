// FILE: providerUsage/providers/grok.ts
// Purpose: Live Grok usage fetcher. SuperGrok CLI logins (`~/.grok/auth.json`) call the
// Grok CLI-proxy billing REST API. Short-lived OIDC tokens are refreshed and written back
// the same way Codex does. An xAI API key still proves a connected account when no
// SuperGrok session is present.

import nodePath from "node:path";

import type { ServerProviderUsageLine, ServerProviderUsageLimit } from "@synara/contracts";

import { getGrokApiKeyEnv } from "../../provider/acp/GrokAcpSupport";
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
  titleCase,
  toUsedPercent,
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "grok-xai";
const API_KEY_URL = "https://api.x.ai/v1/api-key";
const CLI_PROXY_ORIGIN = "https://cli-chat-proxy.grok.com";
const BILLING_URL = `${CLI_PROXY_ORIGIN}/v1/billing?format=credits`;
const SETTINGS_URL = `${CLI_PROXY_ORIGIN}/v1/settings`;
const DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const AUTH_ISSUER_PREFIX = "https://auth.x.ai";
const LEGACY_SIGN_IN = "https://accounts.x.ai/sign-in";
const SETTINGS_TIMEOUT_MS = 2_000;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WEEKLY_WINDOW_MINS = 10_080;
const REFRESH_TOKEN_REUSED_CODE = "refresh_token_reused";

export interface GrokSession {
  accessToken: string;
  email?: string;
  plan?: string;
  expiresAt?: string;
  principalType?: string;
  refreshToken?: string;
  clientId?: string;
  path?: string;
  scope?: string;
  root?: Record<string, unknown>;
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

function grokAuthPath(ctx: ProviderUsageContext): string {
  const grokHome = ctx.env.GROK_HOME?.trim() || nodePath.join(ctx.homeDir, ".grok");
  return nodePath.join(grokHome, "auth.json");
}

function asUsdAmount(value: unknown): number | undefined {
  const direct = asFiniteNumber(value);
  if (direct !== undefined) return direct;
  const nested = asRecord(value);
  return nested ? asFiniteNumber(nested.val) : undefined;
}

function grokProxyHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "x-xai-token-auth": "xai-grok-cli",
    Accept: "application/json",
  };
}

function grokPlanFromAuthMode(authMode: string | undefined): string | undefined {
  if (!authMode) return undefined;
  const lower = authMode.toLowerCase();
  if (lower === "oauth" || lower === "oidc" || lower === "supergrok") return "SuperGrok";
  return titleCase(authMode);
}

function grokPlanName(raw: string | undefined): string | undefined {
  const trimmed = asString(raw);
  if (!trimmed) return undefined;
  const compact = trimmed.toLowerCase().replace(/[^a-z]/gu, "");
  if (compact.includes("supergrokheavy") || compact === "heavy") return "SuperGrok Heavy";
  if (compact.includes("supergrok")) return "SuperGrok";
  return trimmed;
}

function readSessionEntry(value: unknown): Omit<GrokSession, "path" | "scope" | "root"> | null {
  const record = asRecord(value);
  const accessToken = asString(record?.key);
  if (!record || !accessToken) return null;
  const email = asString(record.email);
  const plan = grokPlanFromAuthMode(asString(record.auth_mode));
  const expiresAt = isoFromString(record.expires_at);
  const principalType = asString(record.principal_type);
  const refreshToken = asString(record.refresh_token);
  const clientId = asString(record.oidc_client_id);
  return {
    accessToken,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(principalType ? { principalType } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(clientId ? { clientId } : {}),
  };
}

export function parseGrokAuthRecord(value: unknown, path?: string): GrokSession | null {
  const record = asRecord(value);
  if (!record) return null;
  const preferredKey =
    Object.keys(record).find((key) => key.startsWith(AUTH_ISSUER_PREFIX)) ??
    Object.keys(record).find((key) => key === LEGACY_SIGN_IN);
  const tryKey = (scope: string): GrokSession | null => {
    const picked = readSessionEntry(record[scope]);
    if (!picked) return null;
    return {
      ...picked,
      ...(path ? { path, scope, root: record } : {}),
    };
  };
  if (preferredKey) {
    const preferred = tryKey(preferredKey);
    if (preferred) return preferred;
  }
  for (const scope of Object.keys(record)) {
    const session = tryKey(scope);
    if (session) return session;
  }
  return null;
}

function sessionFromOauthToken(env: NodeJS.ProcessEnv): GrokSession | null {
  const token = env.GROK_OAUTH_TOKEN?.trim();
  return token ? { accessToken: token, plan: "SuperGrok" } : null;
}

function grokSessionNeedsRefresh(session: GrokSession, nowMs: number): boolean {
  const jwtExpMs = decodeJwtExpMs(session.accessToken);
  if (jwtExpMs !== null) return jwtExpMs <= nowMs + REFRESH_BUFFER_MS;
  if (!session.expiresAt) return false;
  const expiresAtMs = Date.parse(session.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs + REFRESH_BUFFER_MS;
}

async function persistRotatedGrokSession(
  session: GrokSession,
  refreshed: Extract<OAuthRefreshResult, { ok: true }>,
): Promise<GrokSession> {
  const expiresAt =
    refreshed.expiresAtMs !== undefined
      ? new Date(refreshed.expiresAtMs).toISOString()
      : session.expiresAt;
  const refreshToken = refreshed.refreshToken ?? session.refreshToken;
  const next: GrokSession = {
    ...session,
    accessToken: refreshed.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
  if (!session.path || !session.root || !session.scope) return next;
  const previousEntry = asRecord(session.root[session.scope]) ?? {};
  const root = {
    ...session.root,
    [session.scope]: {
      ...previousEntry,
      key: refreshed.accessToken,
      ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
      ...(expiresAt ? { expires_at: expiresAt } : {}),
    },
  };
  await writeJsonFileAtomic(session.path, root);
  return { ...next, root };
}

async function refreshGrokSession(
  session: GrokSession,
  options: { allowRedeem: boolean },
): Promise<GrokSession | "needs-auth" | null> {
  if (!session.path || !session.refreshToken || !session.clientId) return null;
  if (!options.allowRedeem) return null;
  return withRefreshLock(session.path, async () => {
    const live = parseGrokAuthRecord(await readJsonFile(session.path!), session.path) ?? session;
    if (live.accessToken !== session.accessToken && !grokSessionNeedsRefresh(live, Date.now())) {
      return live;
    }
    const refreshed = await refreshOAuthAccessToken({
      service: "provider-usage-grok-refresh",
      refreshUrl: DEFAULT_TOKEN_URL,
      allowedOrigins: [new URL(DEFAULT_TOKEN_URL).origin],
      refreshToken: live.refreshToken ?? session.refreshToken!,
      clientId: live.clientId ?? session.clientId!,
      bodyFormat: "form",
    });
    if (refreshed.ok) {
      return persistRotatedGrokSession(live, refreshed);
    }
    if (refreshed.errorCode === REFRESH_TOKEN_REUSED_CODE) {
      const rotated = parseGrokAuthRecord(await readJsonFile(session.path!), session.path);
      if (rotated && rotated.accessToken !== live.accessToken) return rotated;
      return "needs-auth";
    }
    if (refreshed.status && refreshed.status >= 400 && refreshed.status < 500) {
      return "needs-auth";
    }
    return null;
  });
}

export function parseGrokBilling(input: {
  billing: unknown;
  settings?: unknown;
  session?: GrokSession;
  nowMs: number;
}) {
  const billing = asRecord(input.billing);
  const config = asRecord(billing?.config) ?? billing;
  const usage = asRecord(billing?.usage) ?? asRecord(config?.usage);
  const billingCycle = asRecord(billing?.billingCycle) ?? asRecord(config?.billingCycle);
  const currentPeriod = asRecord(config?.currentPeriod) ?? asRecord(billing?.currentPeriod);

  const monthlyLimit = asUsdAmount(billing?.monthlyLimit) ?? asUsdAmount(config?.monthlyLimit);
  const totalUsed = asUsdAmount(usage?.totalUsed);
  const onDemandUsed = asUsdAmount(config?.onDemandUsed) ?? asUsdAmount(billing?.onDemandUsed);
  const onDemandCap = asUsdAmount(config?.onDemandCap) ?? asUsdAmount(billing?.onDemandCap);
  const creditUsagePercent = toUsedPercent(
    asFiniteNumber(config?.creditUsagePercent) ?? asFiniteNumber(billing?.creditUsagePercent),
  );

  let usedPercent = creditUsagePercent;
  if (
    usedPercent === undefined &&
    monthlyLimit !== undefined &&
    monthlyLimit > 0 &&
    totalUsed !== undefined
  ) {
    usedPercent = clampPercent((totalUsed / monthlyLimit) * 100);
  }
  if (
    usedPercent === undefined &&
    onDemandCap !== undefined &&
    onDemandCap > 0 &&
    onDemandUsed !== undefined
  ) {
    usedPercent = clampPercent((onDemandUsed / onDemandCap) * 100);
  }

  const resetsAt =
    isoFromString(currentPeriod?.end) ??
    isoFromString(config?.billingPeriodEnd) ??
    isoFromString(billingCycle?.billingPeriodEnd) ??
    isoFromString(billing?.billingPeriodEnd);

  const periodType = asString(currentPeriod?.type) ?? "";
  const isWeekly =
    /weekly/iu.test(periodType) ||
    (periodType.length === 0 && config?.isUnifiedBillingUser === true);
  const window = isWeekly ? "Weekly" : "Credits";

  const settings = asRecord(input.settings);
  const planName =
    grokPlanName(asString(settings?.subscription_tier_display)) ??
    input.session?.plan ??
    "SuperGrok";

  const limits: ServerProviderUsageLimit[] = [];
  if (usedPercent !== undefined || resetsAt) {
    limits.push({
      window,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      ...(isWeekly ? { windowDurationMins: WEEKLY_WINDOW_MINS } : {}),
    });
  }

  const usageLines: ServerProviderUsageLine[] = [];
  if (input.session?.email) {
    usageLines.push({ label: "Account", value: input.session.email });
  }
  if (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined) {
    usageLines.push({
      label: "On-demand",
      value: `${formatUsd(onDemandUsed)} of ${formatUsd(onDemandCap)}`,
    });
  }

  return buildSnapshot({
    provider: "grok",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    planName,
  });
}

export function parseGrokApiKeyIdentity(input: { payload: unknown; nowMs: number }) {
  const payload = asRecord(input.payload);
  const name = asString(payload?.name);
  const blocked = payload?.api_key_blocked === true || payload?.api_key_disabled === true;
  const usageLines: ServerProviderUsageLine[] = [
    ...(name ? [{ label: "Key", value: name }] : []),
    {
      label: "Credits",
      value: blocked
        ? "This API key is disabled."
        : "Prepaid credits need SuperGrok (`grok login`) or an xAI Management key.",
    },
  ];
  return buildSnapshot({
    provider: "grok",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    usageLines,
    planName: "API key",
  });
}

function sessionIdentitySnapshot(session: GrokSession, nowMs: number, detail: string) {
  return buildSnapshot({
    provider: "grok",
    nowMs,
    status: "ok",
    source: SOURCE,
    usageLines: [
      ...(session.email ? [{ label: "Account", value: session.email }] : []),
      { label: "Credits", value: detail },
    ],
    planName: session.plan ?? "SuperGrok",
  });
}

async function resolveGrokSession(ctx: ProviderUsageContext): Promise<GrokSession | null> {
  const path = grokAuthPath(ctx);
  const fromFile = parseGrokAuthRecord(await readJsonFile(path), path);
  if (fromFile) return fromFile;
  return sessionFromOauthToken(ctx.env);
}

function grokCacheKey(apiKey: string | undefined, session: GrokSession | null): string {
  if (session)
    return `session:${credentialFingerprint(session.refreshToken ?? session.accessToken)}`;
  if (apiKey) return `api:${credentialFingerprint(apiKey)}`;
  return "none";
}

async function fetchSessionBilling(session: GrokSession, ctx: ProviderUsageContext) {
  let state = session;
  let allowRedeem = true;
  if (grokSessionNeedsRefresh(state, ctx.nowMs)) {
    const refreshed = await refreshGrokSession(state, { allowRedeem });
    if (refreshed === "needs-auth") return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
    if (refreshed) {
      allowRedeem = refreshed.accessToken === state.accessToken;
      state = refreshed;
    }
  }

  try {
    let billing = await fetchJson({
      service: "provider-usage-grok",
      url: BILLING_URL,
      allowedOrigins: [CLI_PROXY_ORIGIN],
      headers: grokProxyHeaders(state.accessToken),
    });
    if (isAuthFailureStatus(billing.status) && allowRedeem) {
      const refreshed = await refreshGrokSession(state, { allowRedeem: true });
      if (refreshed === "needs-auth") return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
      if (refreshed && refreshed.accessToken !== state.accessToken) {
        state = refreshed;
        billing = await fetchJson({
          service: "provider-usage-grok",
          url: BILLING_URL,
          allowedOrigins: [CLI_PROXY_ORIGIN],
          headers: grokProxyHeaders(state.accessToken),
        });
      }
    }
    if (isAuthFailureStatus(billing.status)) {
      return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
    }
    if (!billing.ok) {
      const teamPrincipal = state.principalType?.toLowerCase() === "team";
      return sessionIdentitySnapshot(
        state,
        ctx.nowMs,
        teamPrincipal
          ? "Grok team usage is unavailable from the current billing surface."
          : `Grok usage request failed (${billing.status}).`,
      );
    }

    let settingsJson: unknown;
    try {
      const settings = await fetchJson({
        service: "provider-usage-grok",
        url: SETTINGS_URL,
        allowedOrigins: [CLI_PROXY_ORIGIN],
        headers: grokProxyHeaders(state.accessToken),
        timeoutMs: SETTINGS_TIMEOUT_MS,
      });
      if (settings.ok) settingsJson = settings.json;
    } catch {
      settingsJson = undefined;
    }

    return parseGrokBilling({
      billing: billing.json,
      settings: settingsJson,
      session: state,
      nowMs: ctx.nowMs,
    });
  } catch {
    return sessionIdentitySnapshot(state, ctx.nowMs, "Could not reach Grok billing.");
  }
}

export const grokUsageFetcher: ProviderUsageFetcher = {
  provider: "grok",
  async cacheKey(ctx) {
    const session = await resolveGrokSession(ctx);
    return grokCacheKey(getGrokApiKeyEnv(ctx.env), session);
  },
  async fetch(ctx) {
    const apiKey = getGrokApiKeyEnv(ctx.env);
    const session = await resolveGrokSession(ctx);
    if (!apiKey && !session) {
      return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
    }

    if (session) {
      return fetchSessionBilling(session, ctx);
    }

    try {
      const result = await fetchJson({
        service: "provider-usage-grok",
        url: API_KEY_URL,
        allowedOrigins: [new URL(API_KEY_URL).origin],
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (isAuthFailureStatus(result.status)) {
        return needsAuthSnapshot("grok", ctx.nowMs, SOURCE);
      }
      if (!result.ok) {
        return errorSnapshot(
          "grok",
          ctx.nowMs,
          SOURCE,
          `Grok API key request failed (${result.status}).`,
        );
      }
      return parseGrokApiKeyIdentity({ payload: result.json, nowMs: ctx.nowMs });
    } catch {
      return errorSnapshot("grok", ctx.nowMs, SOURCE, "Could not reach the xAI API.");
    }
  },
};
