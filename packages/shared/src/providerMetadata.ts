// FILE: providerMetadata.ts
// Purpose: Exhaustive non-secret provider identity and presentation metadata.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";

export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly available: boolean;
  /**
   * True when the provider runtime can inject a user message into a live turn
   * without interrupting it (Codex `turn/steer`, Pi `session.steer`, Claude
   * streaming-input prompt queue). Mirrors the adapter's
   * `supportsTurnSteering` capability so the pure decider and the web client
   * can route steers without a runtime round-trip; keep the two in sync.
   */
  readonly supportsNativeTurnSteering: boolean;
  /** Synara docs page covering install, sign-in, and verification for this runtime. */
  readonly setupDocsHref: string;
  readonly usage: {
    readonly signInCommand: string;
    readonly learnMoreHref: string;
  } | null;
}

type ExhaustiveProviderDescriptors<Descriptors extends readonly ProviderDescriptor[]> =
  Exclude<ProviderKind, Descriptors[number]["kind"]> extends never ? Descriptors : never;

function defineProviderDescriptors<const Descriptors extends readonly ProviderDescriptor[]>(
  descriptors: ExhaustiveProviderDescriptors<Descriptors>,
): Descriptors {
  return descriptors;
}

export const PROVIDER_DESCRIPTORS = defineProviderDescriptors([
  {
    kind: "codex",
    displayName: PROVIDER_DISPLAY_NAMES.codex,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/codex",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "codex login",
      learnMoreHref: "https://platform.openai.com/usage",
    },
  },
  {
    kind: "claudeAgent",
    displayName: PROVIDER_DISPLAY_NAMES.claudeAgent,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/claude-code",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "claude",
      learnMoreHref: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
    },
  },
  {
    kind: "cursor",
    displayName: PROVIDER_DISPLAY_NAMES.cursor,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/cursor",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "cursor-agent login",
      learnMoreHref: "https://cursor.com/dashboard",
    },
  },
  {
    kind: "antigravity",
    displayName: PROVIDER_DISPLAY_NAMES.antigravity,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/antigravity",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "agy",
      learnMoreHref: "https://antigravity.google",
    },
  },
  {
    kind: "grok",
    displayName: PROVIDER_DISPLAY_NAMES.grok,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/grok",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "grok login",
      learnMoreHref: "https://console.x.ai",
    },
  },
  {
    kind: "droid",
    displayName: PROVIDER_DISPLAY_NAMES.droid,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/factory-droid",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "droid",
      learnMoreHref: "https://docs.factory.ai/pricing",
    },
  },
  {
    kind: "opencode",
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/opencode",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "opencode auth login",
      learnMoreHref: "https://opencode.ai",
    },
  },
  {
    kind: "pi",
    displayName: PROVIDER_DISPLAY_NAMES.pi,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/pi",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "pi",
      learnMoreHref: "https://pi.dev",
    },
  },
  {
    kind: "devin",
    displayName: PROVIDER_DISPLAY_NAMES.devin,
    available: true,
    setupDocsHref: "https://trysynara.com/docs/providers/devin",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "devin auth login",
      learnMoreHref: "https://app.devin.ai/usage",
    },
  },
] as const satisfies readonly ProviderDescriptor[]);

export const PROVIDER_DESCRIPTOR_BY_KIND = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor]),
) as Record<ProviderKind, (typeof PROVIDER_DESCRIPTORS)[number]>;

// Accepts plain strings so projection-sourced provider names can be checked
// without casts; unknown providers are simply not steerable.
export const providerSupportsNativeTurnSteering = (kind: string): boolean =>
  PROVIDER_DESCRIPTORS.some(
    (descriptor) => descriptor.kind === kind && descriptor.supportsNativeTurnSteering,
  );
