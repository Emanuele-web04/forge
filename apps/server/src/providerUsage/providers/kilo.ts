// FILE: providerUsage/providers/kilo.ts
// Purpose: Live Kilo usage fetcher. Reads the Kilo CLI bearer token from
// ~/.local/share/kilo/auth.json (`kilo.access`) read-only, then calls the Kilo
// tRPC batch usage endpoints (credit blocks + Kilo Pass state + auto top-up)
// that the Kilo CLI itself uses. Token refresh is never attempted: the Kilo
// CLI owns credential rotation, and this fetcher only reads what is on disk.
//
// Verified against the public Kilo provider surface (CodexBar's Kilo usage
// data source) and live on a signed-in machine: the batch endpoint returns
// `user.getCreditBlocks`, `kiloPass.getState`, and
// `user.getAutoTopUpPaymentMethod` entries without extra headers.

import nodePath from "node:path";

import type { ServerProviderUsageLimit, ServerProviderUsageLine } from "@synara/contracts";

import { credentialFingerprint, readJsonFile } from "../credentials";
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
} from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

const SOURCE = "kilo-trpc-usage";
const API_BASE_URL = "https://app.kilo.ai/api/trpc";
// The CLI's own auth file shape: { "kilo": { "access": "<token>" } }.
const AUTH_FILE_RELATIVE = nodePath.join(".local", "share", "kilo", "auth.json");

const USAGE_PROCEDURES = [
  "user.getCreditBlocks",
  "kiloPass.getState",
  "user.getAutoTopUpPaymentMethod",
] as const;

interface KiloAuth {
  token: string;
  path: string;
}

function authFilePaths(ctx: ProviderUsageContext): string[] {
  const paths = [nodePath.join(ctx.homeDir, AUTH_FILE_RELATIVE)];
  if (ctx.env.KILO_DATA_DIR?.trim()) {
    paths.push(nodePath.join(ctx.env.KILO_DATA_DIR.trim(), "auth.json"));
  }
  return paths;
}

/** Test-only: verify the CLI auth file resolution order. */
export function __authFilePathsForTests(ctx: ProviderUsageContext): string[] {
  return authFilePaths(ctx);
}

async function readKiloAuth(ctx: ProviderUsageContext): Promise<KiloAuth | null> {
  for (const path of authFilePaths(ctx)) {
    const record = asRecord(await readJsonFile(path));
    const kilo = asRecord(record?.kilo);
    const token = asString(kilo?.access);
    if (token) {
      return { token, path };
    }
  }
  return null;
}

function kiloAuthCacheKey(ctx: ProviderUsageContext, auth: KiloAuth | null): string {
  return auth ? `${ctx.homeDir}:${credentialFingerprint(auth.token)}` : `${ctx.homeDir}:none`;
}

function buildBatchUrl(): URL {
  const procedures = USAGE_PROCEDURES.join(",");
  const input = Object.fromEntries(
    USAGE_PROCEDURES.map((procedure, index) => [String(index), { json: null }]),
  );
  const url = new URL(`${API_BASE_URL}/${procedures}`);
  url.searchParams.set("batch", "1");
  url.searchParams.set("input", JSON.stringify(input));
  return url;
}

function entryResult(entry: unknown): Record<string, unknown> | null {
  const record = asRecord(entry);
  return asRecord(record?.result);
}

function payloadFor(entry: unknown): Record<string, unknown> | null {
  const result = entryResult(entry);
  if (!result) {
    return null;
  }
  const data = asRecord(result.data);
  const json = asRecord(data?.json);
  return json ?? data;
}

function creditFields(payload: Record<string, unknown> | null): {
  usedUsd?: number;
  totalUsd?: number;
  remainingUsd?: number;
} {
  if (!payload) {
    return {};
  }
  const blocks = payload.creditBlocks;
  const usedMicro = asFiniteNumber(payload.totalBalance_mUsd);
  if (Array.isArray(blocks)) {
    let totalUsd: number | undefined;
    for (const block of blocks) {
      const blockRecord = asRecord(block);
      const amountMicro = asFiniteNumber(blockRecord?.amount_mUsd);
      if (amountMicro !== undefined && amountMicro > 0) {
        totalUsd = (totalUsd ?? 0) + amountMicro / 1_000_000;
      }
    }
    return {
      ...(totalUsd !== undefined ? { totalUsd } : {}),
      ...(usedMicro !== undefined ? { usedUsd: usedMicro / 1_000_000 } : {}),
      ...(totalUsd !== undefined && usedMicro !== undefined
        ? { remainingUsd: Math.max(0, totalUsd - usedMicro / 1_000_000) }
        : {}),
    };
  }
  return {
    ...(usedMicro !== undefined ? { usedUsd: usedMicro / 1_000_000 } : {}),
  };
}

function passFields(payload: Record<string, unknown> | null): {
  planName?: string;
  usedUsd?: number;
  remainingUsd?: number;
  totalUsd?: number;
  resetsAt?: string;
} {
  if (!payload) {
    return {};
  }
  const subscription = asRecord(payload.subscription);
  const planName = asString(subscription?.name ?? subscription?.displayName ?? payload.planName);
  const usedMicro = asFiniteNumber(payload.used_mUsd ?? subscription?.used_mUsd);
  const remainingMicro = asFiniteNumber(payload.remaining_mUsd ?? subscription?.remaining_mUsd);
  const totalMicro = asFiniteNumber(payload.total_mUsd ?? subscription?.total_mUsd);
  const resetsAt = isoFromString(payload.renewalAt ?? subscription?.renewalAt);
  return {
    ...(planName !== undefined ? { planName } : {}),
    ...(usedMicro !== undefined ? { usedUsd: usedMicro / 1_000_000 } : {}),
    ...(remainingMicro !== undefined
      ? { remainingUsd: remainingMicro / 1_000_000 }
      : totalMicro !== undefined && usedMicro !== undefined
        ? { remainingUsd: Math.max(0, (totalMicro - usedMicro) / 1_000_000) }
        : {}),
    ...(totalMicro !== undefined ? { totalUsd: totalMicro / 1_000_000 } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function autoTopUpPayload(payload: Record<string, unknown> | null): {
  enabled?: boolean;
  amountCents?: number;
} {
  if (!payload) {
    return {};
  }
  const amountCents = asFiniteNumber(payload.amountCents);
  return {
    ...(typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : {}),
    ...(amountCents !== undefined ? { amountCents } : {}),
  };
}

export function parseKiloUsage(input: {
  entries: unknown;
  nowMs: number;
}): ReturnType<typeof buildSnapshot> {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const creditPayload = payloadFor(entries[0]);
  const passPayload = payloadFor(entries[1]);
  const topUpPayload = payloadFor(entries[2]);
  const credits = creditFields(creditPayload);
  const pass = passFields(passPayload);
  const topUp = autoTopUpPayload(topUpPayload);

  const limits: ServerProviderUsageLimit[] = [];
  const usageLines: ServerProviderUsageLine[] = [];

  const totalUsd = credits.totalUsd ?? pass.totalUsd;
  const usedUsd = credits.usedUsd ?? pass.usedUsd;
  if (totalUsd !== undefined && totalUsd > 0 && usedUsd !== undefined) {
    limits.push({
      window: "Credits",
      usedPercent: clampPercent((usedUsd / totalUsd) * 100),
      ...(pass.resetsAt ? { resetsAt: pass.resetsAt } : {}),
    });
  }

  if (totalUsd !== undefined && usedUsd !== undefined) {
    usageLines.push({
      label: "Credits",
      value: `${formatUsd(Math.max(0, totalUsd - usedUsd))} of ${formatUsd(totalUsd)} remaining`,
      ...(pass.resetsAt
        ? { subtitle: `Resets ${new Date(pass.resetsAt).toLocaleDateString()}` }
        : {}),
    });
  } else if (usedUsd !== undefined) {
    usageLines.push({
      label: "Credits",
      value: `${formatUsd(usedUsd)} used`,
    });
  }

  if (pass.planName) {
    usageLines.push({
      label: "Plan",
      value: pass.planName,
    });
  }
  if (pass.remainingUsd !== undefined && pass.totalUsd !== undefined && pass.totalUsd > 0) {
    usageLines.push({
      label: "Kilo Pass",
      value: `${formatUsd(pass.remainingUsd)} of ${formatUsd(pass.totalUsd)} remaining`,
      ...(pass.resetsAt
        ? { subtitle: `Resets ${new Date(pass.resetsAt).toLocaleDateString()}` }
        : {}),
    });
  }
  if (topUp.enabled === true && topUp.amountCents !== undefined) {
    usageLines.push({
      label: "Auto top-up",
      value: `${formatUsd(topUp.amountCents / 100)} when credits run out`,
    });
  }

  return buildSnapshot({
    provider: "kilo",
    nowMs: input.nowMs,
    status: "ok",
    source: SOURCE,
    limits,
    usageLines,
    ...(pass.planName ? { planName: pass.planName } : {}),
  });
}

export const kiloUsageFetcher: ProviderUsageFetcher = {
  provider: "kilo",
  cacheKey: async (ctx) => kiloAuthCacheKey(ctx, await readKiloAuth(ctx)),
  fetch: async (ctx) => {
    const auth = await readKiloAuth(ctx);
    if (!auth) {
      return buildSnapshot({
        provider: "kilo",
        nowMs: ctx.nowMs,
        status: "needs-auth",
        source: SOURCE,
        detail: "Sign in with `kilo login` to see Kilo usage.",
      });
    }
    try {
      const result = await fetchJson({
        service: "provider-usage-kilo",
        url: buildBatchUrl().toString(),
        allowedOrigins: ["https://app.kilo.ai"],
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
        },
      });
      if (isAuthFailureStatus(result.status)) {
        return buildSnapshot({
          provider: "kilo",
          nowMs: ctx.nowMs,
          status: "needs-auth",
          source: SOURCE,
          detail: "Kilo rejected the stored token. Run `kilo login` to re-authenticate.",
        });
      }
      if (!result.ok) {
        return errorSnapshot(
          "kilo",
          ctx.nowMs,
          SOURCE,
          `Kilo usage API returned HTTP ${result.status}.`,
        );
      }
      return parseKiloUsage({ entries: result.json, nowMs: ctx.nowMs });
    } catch {
      return errorSnapshot("kilo", ctx.nowMs, SOURCE, "Kilo usage is temporarily unavailable.");
    }
  },
};
