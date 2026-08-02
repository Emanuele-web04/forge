// FILE: environmentCapabilities.ts
// Purpose: What a given environment can and cannot do, and the exact copy shown
//          when it cannot — so a refusal is explicit rather than a silent local
//          fallback.
// Layer: Web environment UX
// Exports: capability ids, refusal resolution, and unreachable/skew messaging.

import type { ExecutionEnvironmentDescriptor } from "@synara/contracts";

/**
 * Features whose availability differs between the local machine and a remote
 * host. Each one has a reason it cannot silently degrade:
 *
 * - `desktop-dialogs` needs the Electron bridge, which only the local machine has.
 * - `local-filesystem-browse` browses the machine the user is sitting at; on a
 *   remote thread it would show the WRONG machine's files under the right name.
 * - `external-mcp` is refused server-side on any remote-reachable deployment
 *   (`LOCAL_ONLY_WS_METHODS`), so offering it would produce an opaque RPC error.
 * - `editor-launch` opens an editor process on the machine running the server;
 *   on a remote host there is no display to open it on.
 */
export const ENVIRONMENT_CAPABILITIES = [
  "desktop-dialogs",
  "local-filesystem-browse",
  "external-mcp",
  "editor-launch",
] as const;

export type EnvironmentCapability = (typeof ENVIRONMENT_CAPABILITIES)[number];

/** Capabilities that exist only on the environment serving this page. */
export const LOCAL_ONLY_ENVIRONMENT_CAPABILITIES: ReadonlySet<EnvironmentCapability> =
  new Set<EnvironmentCapability>([
    "desktop-dialogs",
    "local-filesystem-browse",
    "external-mcp",
    "editor-launch",
  ]);

export interface EnvironmentCapabilityRefusal {
  readonly capability: EnvironmentCapability;
  /** What is unavailable. Names the feature, not the mechanism. */
  readonly title: string;
  /** What to do next. Never merely restates the failure. */
  readonly description: string;
}

const REFUSAL_COPY: Record<
  EnvironmentCapability,
  (environmentLabel: string) => EnvironmentCapabilityRefusal["description"]
> = {
  "desktop-dialogs": (label) =>
    `Folder and file pickers open on the machine you are sitting at, so they cannot choose a path on ${label}. Type the remote path instead, or add the project from a terminal on ${label}.`,
  "local-filesystem-browse": (label) =>
    `Browsing shows this machine's files, not ${label}'s — opening it here would list the wrong folders under the right names. Use the file search inside a chat on ${label} instead.`,
  "external-mcp": (label) =>
    `${label} refuses MCP integration management: those connections grant access to the machine running the server, so they are configured only on the host itself. Manage them from Synara running directly on ${label}.`,
  "editor-launch": (label) =>
    `There is no desktop session on ${label} to open an editor in. Open the file in Synara's built-in editor, or check the repository out locally.`,
};

const REFUSAL_TITLES: Record<EnvironmentCapability, string> = {
  "desktop-dialogs": "Folder picker is not available on this host",
  "local-filesystem-browse": "File browsing is not available on this host",
  "external-mcp": "MCP integrations are managed on the host itself",
  "editor-launch": "Opening an editor is not available on this host",
};

/**
 * The refusal for `capability` on a non-local environment, or `null` when the
 * capability is available there.
 *
 * Callers MUST surface the returned refusal. Falling through to the local
 * implementation would run the feature against the wrong machine, which is the
 * same bug class as the dispatch gap.
 */
export function resolveEnvironmentCapabilityRefusal(input: {
  readonly capability: EnvironmentCapability;
  readonly isLocalEnvironment: boolean;
  readonly environmentLabel: string;
}): EnvironmentCapabilityRefusal | null {
  if (input.isLocalEnvironment) return null;
  if (!LOCAL_ONLY_ENVIRONMENT_CAPABILITIES.has(input.capability)) return null;
  return {
    capability: input.capability,
    title: REFUSAL_TITLES[input.capability],
    description: REFUSAL_COPY[input.capability](input.environmentLabel),
  };
}

export interface EnvironmentVersionSkew {
  readonly localVersion: string;
  readonly remoteVersion: string;
}

/**
 * Copy for a host running a different Synara build than this page.
 *
 * The remote server is authoritative for its own threads, so the actionable
 * instruction is to bring the HOST to this version — not to downgrade here.
 */
export function environmentVersionSkewMessage(input: {
  readonly environmentLabel: string;
  readonly skew: EnvironmentVersionSkew;
}): string {
  return `${input.environmentLabel} runs Synara ${input.skew.remoteVersion}; this app is ${input.skew.localVersion}. Features added since ${input.skew.remoteVersion} will be missing or fail there. Update ${input.environmentLabel} from Settings → Remote hosts to bring it to ${input.skew.localVersion}.`;
}

/** Version skew between this page's build and a remote descriptor, or null. */
export function detectEnvironmentVersionSkew(input: {
  readonly localVersion: string;
  readonly descriptor: Pick<ExecutionEnvironmentDescriptor, "serverVersion">;
}): EnvironmentVersionSkew | null {
  if (input.descriptor.serverVersion === input.localVersion) return null;
  return {
    localVersion: input.localVersion,
    remoteVersion: input.descriptor.serverVersion,
  };
}

/**
 * Copy for a host that is registered but not reachable.
 *
 * Names the two things a user can actually do, in the order they should try
 * them: the tunnel Synara manages, then the machine itself.
 */
export function environmentUnreachableMessage(environmentLabel: string): string {
  return `Synara cannot reach ${environmentLabel}. Its SSH connection is down — check that the machine is awake and that \`ssh\` to it still works from a terminal, then reconnect it from Settings → Remote hosts.`;
}

/**
 * Runs `action` only if the capability is available here, otherwise reports the
 * refusal. Returns whether the action ran.
 *
 * The refusal predicate was well tested and both call sites could still skip
 * it: deleting the `if (refusal) return` at either one left 1129 component
 * tests passing while the guard disappeared. A predicate a caller may simply
 * not consult is not a guard, and a UI call site inside a large component is
 * exactly where nothing reaches to notice.
 *
 * Funnelling both through one function makes the refusal the DEFAULT path
 * rather than an early return someone has to remember to write: `action` is
 * unreachable when a refusal exists, so a caller cannot forget the check
 * without deleting the call itself, which is a visible edit rather than a
 * silent one.
 */
export function withEnvironmentCapability(input: {
  readonly capability: EnvironmentCapability;
  readonly isLocalEnvironment: boolean;
  readonly environmentLabel: string;
  readonly onRefused: (refusal: EnvironmentCapabilityRefusal) => void;
  readonly action: () => void;
}): boolean {
  const refusal = resolveEnvironmentCapabilityRefusal({
    capability: input.capability,
    isLocalEnvironment: input.isLocalEnvironment,
    environmentLabel: input.environmentLabel,
  });
  if (refusal) {
    input.onRefused(refusal);
    return false;
  }
  input.action();
  return true;
}
