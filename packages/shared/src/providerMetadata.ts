// FILE: providerMetadata.ts
// Purpose: Exhaustive non-secret provider identity and presentation metadata.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";

export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly available: boolean;
  readonly usage: {
    readonly signInCommand: string;
    readonly learnMoreHref: string;
  } | null;
}

export const PROVIDER_DESCRIPTORS = [
  {
    kind: "codex",
    displayName: PROVIDER_DISPLAY_NAMES.codex,
    available: true,
    usage: {
      signInCommand: "codex login",
      learnMoreHref: "https://platform.openai.com/usage",
    },
  },
  {
    kind: "claudeAgent",
    displayName: PROVIDER_DISPLAY_NAMES.claudeAgent,
    available: true,
    usage: {
      signInCommand: "claude",
      learnMoreHref: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
    },
  },
  {
    kind: "cursor",
    displayName: PROVIDER_DISPLAY_NAMES.cursor,
    available: true,
    usage: {
      signInCommand: "cursor-agent login",
      learnMoreHref: "https://cursor.com/dashboard",
    },
  },
  {
    kind: "antigravity",
    displayName: PROVIDER_DISPLAY_NAMES.antigravity,
    available: true,
    usage: null,
  },
  { kind: "grok", displayName: PROVIDER_DISPLAY_NAMES.grok, available: true, usage: null },
  { kind: "droid", displayName: PROVIDER_DISPLAY_NAMES.droid, available: true, usage: null },
  { kind: "kilo", displayName: PROVIDER_DISPLAY_NAMES.kilo, available: true, usage: null },
  {
    kind: "opencode",
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    available: true,
    usage: null,
  },
  { kind: "pi", displayName: PROVIDER_DISPLAY_NAMES.pi, available: true, usage: null },
  { kind: "omp", displayName: PROVIDER_DISPLAY_NAMES.omp, available: true, usage: null },
] as const satisfies readonly ProviderDescriptor[];

export const PROVIDER_DESCRIPTOR_BY_KIND = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor]),
) as Record<ProviderKind, (typeof PROVIDER_DESCRIPTORS)[number]>;
