/**
 * The macOS privacy grants desktop control needs, in the words the user reads.
 *
 * Three surfaces have to agree on this copy — the server backend's availability
 * message, the desktop app's send-time preflight, and the web card and settings
 * panel — and they used to spell it out separately, which is how "Screen
 * Recording and Accessibility" and "Accessibility and Screen Recording" ended up
 * describing the same state in the same session. One ordering, one label per
 * grant, one place that knows what to say about a stale ad-hoc grant.
 *
 * @module computerPermissions
 */
import type { ComputerBuildSignature, ComputerPermission } from "@synara/contracts";

/**
 * Fixed order, most consequential first: without Accessibility nothing can be
 * driven, while without Screen Recording the desktop is merely unseeable.
 */
export const COMPUTER_PERMISSIONS: readonly ComputerPermission[] = [
  "accessibility",
  "screenRecording",
];

/**
 * The grants without which the desktop cannot be driven at all.
 *
 * The distinction is the difference between "stop and wait for the user" and
 * "carry on with one hand tied": Accessibility gates every synthetic event and
 * every accessibility read, so nothing works without it, while Screen Recording
 * only takes away the pictures — the window list, the accessibility tree, and
 * every input still work. Telling an agent to stop because it cannot take a
 * screenshot costs the user the whole task for a grant that blocked none of it.
 */
export const COMPUTER_BLOCKING_PERMISSIONS: readonly ComputerPermission[] = ["accessibility"];

/** Whether any of these missing grants stops the desktop being driven at all. */
export function computerPermissionsBlockControl(
  permissions: readonly ComputerPermission[],
): boolean {
  return permissions.some((permission) => COMPUTER_BLOCKING_PERMISSIONS.includes(permission));
}

/** Exactly what System Settings › Privacy & Security calls each grant. */
export const COMPUTER_PERMISSION_LABELS: Readonly<Record<ComputerPermission, string>> = {
  accessibility: "Accessibility",
  screenRecording: "Screen Recording",
};

/**
 * The service name `tccutil` files each grant under, which is not the label:
 * Screen Recording is `ScreenCapture` on the command line, and a user who types
 * the label instead gets an error rather than a reset.
 *
 * Exported because the macOS backend resets the app's own stale ad-hoc rows
 * before asking for a grant, and it has to name the services the same way this
 * copy does — two spellings of `ScreenCapture` is exactly the class of bug this
 * module exists to prevent.
 */
export const TCC_SERVICE_NAMES: Readonly<Record<ComputerPermission, string>> = {
  accessibility: "Accessibility",
  screenRecording: "ScreenCapture",
};

/** The missing grants in `COMPUTER_PERMISSIONS` order, deduplicated. */
export function sortComputerPermissions(
  permissions: readonly ComputerPermission[],
): readonly ComputerPermission[] {
  return COMPUTER_PERMISSIONS.filter((permission) => permissions.includes(permission));
}

/** "Accessibility", or "Accessibility and Screen Recording". */
export function listComputerPermissions(permissions: readonly ComputerPermission[]): string {
  const labels = sortComputerPermissions(permissions).map(
    (permission) => COMPUTER_PERMISSION_LABELS[permission],
  );
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * What to tell a user whose System Settings already shows Synara switched on
 * while the helper still reports the grant missing — or null when that cannot be
 * what happened.
 *
 * macOS pins an ad-hoc signature's grant to the binary's cdhash, so a local
 * rebuild invalidates it without changing anything the user can see. A
 * Developer ID signature keys on identifier plus team and survives rebuilds, so
 * this advice would be a red herring on a release build and is withheld there.
 * The grant is filed against the app, not the helper bundle it spawns, which is
 * why the reset names the app's identifier.
 *
 * The server now removes that stale row itself before it asks macOS
 * (`MacComputerBackend.requestMissingPermissions`), so the user's part is a
 * dialog rather than a Terminal command. The command survives here only as the
 * fallback for the case where no dialog arrives at all.
 *
 * `bundleId` is the *responsible* app's identifier — the Synara the grant is
 * actually filed against, which `.dev` and `.canary` builds do not share with a
 * released one. It is optional because nothing can derive it: a server started
 * outside the desktop shell has no app behind it, and the desktop tells the
 * backend which flavor it is through
 * `SYNARA_DESKTOP_BUNDLE_ID_ENV`. When it is unknown the whole `tccutil`
 * sentence is withheld rather than printed with a guess, because the guess a
 * user would paste into Terminal resets a *different* Synara's grants — the one
 * they have installed — and leaves this one exactly as broken as before.
 */
export function computerStaleGrantAdvice(
  permissions: readonly ComputerPermission[],
  buildSignature: ComputerBuildSignature,
  bundleId?: string | undefined,
): string | null {
  if (buildSignature !== "adhoc") return null;
  const sorted = sortComputerPermissions(permissions);
  if (sorted.length === 0) return null;
  const base =
    "This is a locally built copy of Synara, so macOS may already list it with the switch on from " +
    "an earlier build — that grant no longer applies to this one. Synara has cleared the stale " +
    "entry and asked again, so allow the dialog when it appears.";
  const responsibleBundleId = bundleId?.trim();
  if (!responsibleBundleId) return base;
  const commands = sorted
    .map((permission) => `tccutil reset ${TCC_SERVICE_NAMES[permission]} ${responsibleBundleId}`)
    .join(", then ");
  return `${base} If none appears, run \`${commands}\` in Terminal and try again.`;
}

/**
 * The whole user-facing explanation for a missing grant: what is needed, where
 * to give it, and — on an ad-hoc build only — why the switch may already look on.
 */
export function computerPermissionSetupMessage(
  permissions: readonly ComputerPermission[],
  buildSignature: ComputerBuildSignature,
  bundleId?: string | undefined,
): string {
  const labels = listComputerPermissions(permissions);
  const base =
    labels.length > 0
      ? `Synara needs ${labels} to control this Mac. Turn Synara on in System Settings › Privacy & Security › ${labels}, then try again.`
      : "Synara needs a macOS privacy permission to control this Mac. Grant it in System Settings › Privacy & Security, then try again.";
  const advice = computerStaleGrantAdvice(permissions, buildSignature, bundleId);
  return advice ? `${base} ${advice}` : base;
}
