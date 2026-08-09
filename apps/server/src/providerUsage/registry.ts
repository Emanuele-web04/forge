// FILE: providerUsage/registry.ts
// Purpose: Map each supported ProviderKind to its live usage fetcher. Adding a provider is a
// one-file change: implement a ProviderUsageFetcher and register it here.

import type { ProviderKind } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";

import { antigravityUsageFetcher } from "./providers/antigravity";
import { claudeUsageFetcher } from "./providers/claude";
import { codexUsageFetcher } from "./providers/codex";
import { cursorUsageFetcher } from "./providers/cursor";
import { grokUsageFetcher } from "./providers/grok";
import { droidUsageFetcher, piUsageFetcher } from "./providers/localCredential";
import { opencodeUsageFetcher } from "./providers/opencode";
import { devinUsageFetcher } from "./providers/devin";
import { unsupportedSnapshot } from "./parse";
import type { ProviderUsageFetcher } from "./types";

function unsupportedUsageFetcher(provider: ProviderKind): ProviderUsageFetcher {
  return {
    provider,
    fetch: async (ctx) =>
      unsupportedSnapshot(
        provider,
        ctx.nowMs,
        "synara-runtime",
        `No safe live limit source is configured for ${providerUsageDisplayName(provider)} yet. ` +
          "Synara activity and runtime-reported limits are shown separately.",
      ),
  };
}

export const PROVIDER_USAGE_FETCHERS: Record<ProviderKind, ProviderUsageFetcher> = {
  codex: codexUsageFetcher,
  claudeAgent: claudeUsageFetcher,
  cursor: cursorUsageFetcher,
  antigravity: antigravityUsageFetcher,
  grok: grokUsageFetcher,
  droid: droidUsageFetcher,
  opencode: opencodeUsageFetcher,
  pi: piUsageFetcher,
  devin: devinUsageFetcher,
};
