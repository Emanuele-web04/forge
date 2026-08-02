// FILE: startInPickerModel.ts
// Purpose: Pure selection model for the composer's "Start in" picker:
//          environment → that environment's projects → per-project workspace mode.
// Layer: Chat composer logic
// Exports: option building, filtering, readiness, and the resolved start target.
//
// Ownership is POSITIONAL: each environment option carries the projects that
// environment's own record holds. There is no ownership map to consult and no
// filter to forget — a project cannot appear under a host that did not report
// it, because the caller reads it out of that host's record in the first place.

import type { EnvironmentId, ProjectId, ServerProviderStatus } from "@synara/contracts";

import type { EnvironmentDirectoryEntry } from "../../environmentDirectory";

export interface StartInProject {
  readonly id: ProjectId;
  readonly name: string;
  readonly cwd: string;
}

/**
 * Whether a host can currently run a provider session.
 *
 * Three states, mirroring `ServerProviderStatus.authStatus`, because "we have
 * not heard yet" must not be reported as "not signed in". A freshly connected
 * host is `unknown` for as long as it takes its first status push to arrive,
 * and accusing it of being unauthenticated in that window would train the user
 * to ignore the message.
 */
export type StartInReadiness = "ready" | "not-authenticated" | "unavailable" | "unknown";

/**
 * Readiness from one environment's provider statuses.
 *
 * A host is ready when at least ONE provider is both available and
 * authenticated — that is the literal precondition for starting a thread there.
 *
 * The three not-ready answers are kept apart because each implies a DIFFERENT
 * ACTION, and the note's whole job is telling the user what to do. DO NOT
 * collapse them back together — each merge states something false:
 *
 * - `unavailable` into `not-authenticated` tells someone to sign in on a host
 *   whose provider CLI is not installed. It is not signed in BECAUSE it is not
 *   there, so signing in cannot help. Sending a user to perform an action that
 *   cannot fix their problem is the exact failure class this feature exists to
 *   remove, reintroduced one level down.
 * - `unknown` into `not-authenticated` accuses a host whose status has simply
 *   not arrived yet. `ServerProviderStatus.authStatus` is three-valued
 *   precisely so "we have not heard" stays distinguishable from "it said no";
 *   a false accusation here trains the user to ignore the line entirely, which
 *   costs us the case it exists for.
 */
export function resolveStartInReadiness(
  statuses: readonly ServerProviderStatus[] | undefined,
): StartInReadiness {
  if (statuses === undefined || statuses.length === 0) return "unknown";
  if (statuses.some((status) => status.available && status.authStatus === "authenticated")) {
    return "ready";
  }
  // Only say "not signed in" when a provider that is actually INSTALLED said
  // so — that is the case a sign-in fixes.
  if (statuses.some((status) => status.available && status.authStatus === "unauthenticated")) {
    return "not-authenticated";
  }
  // Everything reported, nothing is usable, and no installed provider blamed
  // authentication: the host has answered, so this is not "unknown" either.
  if (statuses.some((status) => !status.available)) return "unavailable";
  return "unknown";
}

/**
 * The provider to name in a sign-in prompt, or `null` when none can be named.
 *
 * Returns a name only when EXACTLY ONE installed provider is unauthenticated.
 * With several, naming one would send the user to sign in to an arbitrary
 * choice; with none identifiable, naming a guess is worse than naming nothing,
 * because a wrong provider name sends them somewhere that cannot help.
 */
export function signInProviderName(
  statuses: readonly ServerProviderStatus[] | undefined,
): string | null {
  const candidates = (statuses ?? []).filter(
    (status) => status.available && status.authStatus === "unauthenticated",
  );
  if (candidates.length !== 1) return null;
  const only = candidates[0];
  if (!only) return null;
  // `authLabel` is the human-facing name when the server supplies one; the
  // provider kind is the honest fallback. Never a hardcoded product name — a
  // host may have a different provider signed in entirely.
  return only.authLabel?.trim() || only.provider;
}

/**
 * The line shown under a host, or `null` when there is nothing worth saying.
 *
 * Silent for a ready host on purpose: a message that is always present is a
 * message nobody reads, and the whole value of this line is that its presence
 * means something. Names the action and where to take it, never the internals.
 */
export function startInReadinessNote(
  readiness: StartInReadiness,
  /** Provider to name, when exactly one is identifiable. */
  providerName?: string | null,
): string | null {
  switch (readiness) {
    case "ready":
      return null;
    case "not-authenticated":
      // Named when we can say WHICH provider — a specific action beats a
      // general one. Falls back to the unnamed line rather than guessing,
      // because naming the wrong provider is worse than naming none.
      return providerName
        ? `Sign in to ${providerName} on this host to start chats here.`
        : "No providers are signed in on this host yet — sign in there to start chats.";
    case "unavailable":
      return "No coding agents are installed on this host yet.";
    case "unknown":
      return "Checking what this host can run…";
  }
}

export interface StartInEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly reachability: EnvironmentDirectoryEntry["reachability"];
  /**
   * Projects this environment reported. Empty is a real state for a freshly
   * added host, and reads differently from "unreachable" — the picker says so.
   */
  readonly projects: readonly StartInProject[];
  /**
   * Whether a thread may be started here right now. An unreachable host is
   * shown but not selectable: hiding it would look like the host was forgotten,
   * and enabling it would queue a dispatch that cannot land.
   */
  readonly selectable: boolean;
  /** Why it is not selectable, for the row's secondary line. */
  readonly disabledReason: string | null;
  /**
   * Whether the host can run a provider session. Deliberately does NOT affect
   * `selectable`: the requirement is to tell the user, not to stop them. A host
   * they are about to authenticate is still a host they may pick.
   */
  readonly readiness: StartInReadiness;
  readonly readinessNote: string | null;
}

/** One environment's contribution to the picker, read from its own record. */
export interface StartInEnvironmentInput {
  readonly environment: EnvironmentDirectoryEntry;
  /** The projects THIS environment reported. */
  readonly projects: readonly StartInProject[];
  /** That environment's provider statuses, or `undefined` if none have arrived. */
  readonly providerStatuses: readonly ServerProviderStatus[] | undefined;
}

/**
 * Builds one option per connected environment, each carrying only ITS OWN
 * projects.
 *
 * A project must never appear under an environment that did not report it: the
 * user would pick a directory the chosen host does not have, and the thread
 * would be created against a path that does not exist there.
 */
export function buildStartInEnvironmentOptions(
  inputs: readonly StartInEnvironmentInput[],
): readonly StartInEnvironmentOption[] {
  return inputs.map(({ environment, projects, providerStatuses }) => {
    const unreachable = environment.reachability === "unreachable";
    const checking = environment.reachability === "checking";
    // An unreachable host has not told us anything about its providers, and
    // whatever it last said is stale. Reporting readiness there would be a
    // claim about a machine we cannot currently see.
    const readiness: StartInReadiness = unreachable
      ? "unknown"
      : resolveStartInReadiness(providerStatuses);
    return {
      environmentId: environment.environmentId,
      label: environment.label,
      isLocal: environment.isLocal,
      reachability: environment.reachability,
      projects,
      selectable: !unreachable && !checking,
      disabledReason: unreachable
        ? "Not reachable — reconnect it in Settings → Remote hosts"
        : checking
          ? "Connecting…"
          : null,
      readiness,
      // Suppressed while the host is unselectable: `disabledReason` already
      // occupies that line with the more urgent fact, and two competing
      // explanations of why a row is unusable is worse than one.
      readinessNote:
        unreachable || checking
          ? null
          : startInReadinessNote(readiness, signInProviderName(providerStatuses)),
    };
  });
}

export interface StartInTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface StartInRefusal {
  readonly title: string;
  readonly description: string;
}

/**
 * Resolves a click into a start target, or an explicit refusal.
 *
 * Returning a refusal rather than silently substituting the local environment
 * is the whole point: a substituted environment starts the user's work on the
 * wrong machine and looks like it succeeded.
 */
export function resolveStartInSelection(input: {
  readonly option: StartInEnvironmentOption;
  readonly projectId: ProjectId;
}): { readonly target: StartInTarget } | { readonly refusal: StartInRefusal } {
  if (!input.option.selectable) {
    return {
      refusal: {
        title: `Cannot start a chat on ${input.option.label}`,
        description:
          input.option.reachability === "checking"
            ? `Synara is still connecting to ${input.option.label}. Wait for it to come online, then start the chat again.`
            : `Synara cannot reach ${input.option.label} right now. Check that the machine is awake and that \`ssh\` to it still works, then reconnect it from Settings → Remote hosts.`,
      },
    };
  }
  if (!input.option.projects.some((project) => project.id === input.projectId)) {
    return {
      refusal: {
        title: "That folder is not on this host",
        description: `${input.option.label} has not reported this project, so a chat started there would point at a path it does not have. Pick one of ${input.option.label}'s own folders, or add the folder on ${input.option.label} first.`,
      },
    };
  }
  return { target: { environmentId: input.option.environmentId, projectId: input.projectId } };
}

/** Case-insensitive filter over environment labels and their project names. */
export function filterStartInOptions(
  options: readonly StartInEnvironmentOption[],
  query: string,
): readonly StartInEnvironmentOption[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return options;
  return options.flatMap((option) => {
    if (option.label.toLowerCase().includes(needle)) return [option];
    const projects = option.projects.filter(
      (project) =>
        project.name.toLowerCase().includes(needle) || project.cwd.toLowerCase().includes(needle),
    );
    return projects.length > 0 ? [{ ...option, projects }] : [];
  });
}
