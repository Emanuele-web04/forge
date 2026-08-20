// FILE: providerUsage/providers/localCredential.ts
// Purpose: Usage fetchers for providers that expose a local login but no
// individual live quota API (Droid, Kilo, Pi). Connected accounts still appear
// in Settings → Usage; unsigned ones stay needs-auth.

import nodePath from "node:path";

import type { ProviderKind } from "@synara/contracts";

import { getDroidApiKeyEnv } from "../../provider/acp/DroidAcpSupport";
import { resolveOpenCodeCompatibleAuthPaths } from "../../provider/openCodeAuthPaths";
import { credentialFingerprint, readJsonFile } from "../credentials";
import { asRecord, buildSnapshot, needsAuthSnapshot } from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

async function jsonObjectHasKeys(path: string): Promise<boolean> {
  const parsed = asRecord(await readJsonFile(path));
  return parsed !== null && Object.keys(parsed).length > 0;
}

async function resolveDroidSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const apiKey = getDroidApiKeyEnv(ctx.env);
  if (apiKey) return `api:${credentialFingerprint(apiKey)}`;
  const factoryHome = nodePath.join(ctx.homeDir, ".factory");
  for (const fileName of ["auth.json", "session.json", "credentials.json"]) {
    const filePath = nodePath.join(factoryHome, fileName);
    if (await jsonObjectHasKeys(filePath)) {
      return `file:${fileName}`;
    }
  }
  return null;
}

async function resolveOpenCodeCompatibleSignedIn(
  ctx: ProviderUsageContext,
  dataDirectoryName: string,
): Promise<string | null> {
  for (const authPath of resolveOpenCodeCompatibleAuthPaths({
    homeDir: ctx.homeDir,
    env: ctx.env,
    platform: ctx.platform,
    dataDirectoryName,
  })) {
    if (await jsonObjectHasKeys(authPath)) return `file:${authPath}`;
  }
  return null;
}

async function resolvePiSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const authPath = nodePath.join(ctx.homeDir, ".pi", "agent", "auth.json");
  if (await jsonObjectHasKeys(authPath)) return "file:pi";
  return null;
}

function localCredentialFetcher(input: {
  provider: ProviderKind;
  source: string;
  detail: string;
  resolveSignedIn: (ctx: ProviderUsageContext) => Promise<string | null>;
}): ProviderUsageFetcher {
  return {
    provider: input.provider,
    async cacheKey(ctx) {
      return (await input.resolveSignedIn(ctx)) ?? `${ctx.homeDir}:none`;
    },
    async fetch(ctx) {
      const signedIn = await input.resolveSignedIn(ctx);
      if (!signedIn) {
        return needsAuthSnapshot(input.provider, ctx.nowMs, input.source);
      }
      return buildSnapshot({
        provider: input.provider,
        nowMs: ctx.nowMs,
        status: "ok",
        source: input.source,
        usageLines: [{ label: "Limits", value: input.detail }],
      });
    },
  };
}

export const droidUsageFetcher = localCredentialFetcher({
  provider: "droid",
  source: "droid-local",
  detail:
    "Droid is signed in locally. Individual rate limits stay in the Droid `/limits` command; Factory has no public personal quota API.",
  resolveSignedIn: resolveDroidSignedIn,
});

export const kiloUsageFetcher = localCredentialFetcher({
  provider: "kilo",
  source: "kilo-local",
  detail:
    "Kilo is signed in locally. It does not expose a live personal quota API, so remaining limits stay in the Kilo CLI.",
  resolveSignedIn: (ctx) => resolveOpenCodeCompatibleSignedIn(ctx, "kilo"),
});

export const piUsageFetcher = localCredentialFetcher({
  provider: "pi",
  source: "pi-local",
  detail:
    "Pi is signed in locally. Remaining limits stay with each configured model provider; Pi has no single quota API.",
  resolveSignedIn: resolvePiSignedIn,
});
