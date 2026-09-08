/**
 * The one place that decides "this is the OS withholding a grant", and which
 * grants those are.
 *
 * The same fact reaches the tool surface three different ways, and before this
 * module only the first of them raised the chat's setup card:
 *
 *   1. A **thrown** `ComputerBackendError` marked `setupRequired` — the helper
 *      refused an action with its permission-denied code.
 *   2. A **successful** result whose availability is `permission-required` — a
 *      perception read that completed and reported the desktop cannot be driven.
 *      This is the shape the user hit: the agent received a well-formed answer
 *      saying "Synara needs Accessibility", no card appeared, and the model was
 *      left to explain TCC in prose.
 *   3. A grant the backend knows is missing while nothing has failed yet —
 *      Screen Recording, which leaves the desktop driveable but unseeable, so
 *      the availability stays `available` and no call has to fail for the user
 *      to be owed the card.
 *
 * Classifying in one place is what keeps those three answering identically, and
 * what keeps an ordinary action failure — a window that moved, an undelivered
 * keystroke, arguments the desktop refused — from raising a card the user cannot
 * act on.
 *
 * @module computerSetupSignal
 */
import type {
  ComputerAvailability,
  ComputerBuildSignature,
  ComputerPermission,
} from "@synara/contracts";
import {
  computerPermissionsBlockControl,
  listComputerPermissions,
} from "@synara/shared/computerPermissions";
import { SYNARA_DESKTOP_BUNDLE_ID_ENV } from "@synara/shared/desktopIdentity";

import { ComputerBackendError } from "./ComputerBackend.ts";

/**
 * The app the OS files this server's TCC decisions against, or undefined when
 * nothing is responsible for it.
 *
 * Read here rather than passed down from the backend because it is a property
 * of the *process*, not of a tool call or a helper: the desktop shell sets it on
 * the environment it starts the server in, and a server started any other way —
 * a bare `bun run`, a remote host — genuinely has no responsible app. Its
 * absence is the meaningful case, and it is why the card's recovery advice is
 * withheld rather than printed against a guessed identifier that would reset a
 * different Synara's grants.
 */
export function responsibleDesktopBundleId(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = env[SYNARA_DESKTOP_BUNDLE_ID_ENV]?.trim();
  return value ? value : undefined;
}

/**
 * A missing-grant state worth putting in front of the user, with the grants
 * named where the backend could name them. `missing` may be empty: a helper can
 * refuse without saying which permission it wanted, and that is still a setup
 * problem — the card simply falls back to the general wording.
 */
export interface ComputerSetupSignal {
  readonly missing: readonly ComputerPermission[];
  /**
   * Whether the missing grant stops the desktop being driven, or only degrades
   * it.
   *
   * The signal used to carry only "something is missing", and the note it
   * produced told the model to stop and wait. A declined Screen Recording grant
   * blocks nothing — the window list, the accessibility tree and every input
   * still work — so for the rest of the session every *successful* call came
   * back carrying "Stop desktop automation… do not retry", and agents stopped
   * mid-task over a grant that had cost them only the screenshots.
   */
  readonly blocking: boolean;
  /**
   * How the backend's build is signed, when it could say. Carried alongside the
   * grants because an ad-hoc build has a second explanation for a missing one —
   * the grant is pinned to a cdhash a rebuild replaced — and the card cannot
   * offer it without this.
   */
  readonly buildSignature?: ComputerBuildSignature;
  /**
   * The app the missing grant is filed against, when this server has one behind
   * it. Carried with the signal rather than resolved by the card because only
   * the server knows which flavor of Synara is running, and the card's advice
   * has to name that one or none at all.
   */
  readonly bundleId?: string;
}

/**
 * Whether this failure is the OS withholding a grant rather than the desktop
 * misbehaving. Unwraps one level of `cause` so a failure that travelled inside
 * another error is still recognised.
 */
export function computerFailureNeedsSetup(error: unknown): boolean {
  if (error instanceof ComputerBackendError) return error.setupRequired;
  const cause: unknown = (error as { readonly cause?: unknown } | null)?.cause;
  return cause instanceof ComputerBackendError && cause.setupRequired;
}

/**
 * The setup state behind a tool call, or undefined when there is nothing for
 * the user to do.
 *
 * `availability` outranks the rest because it is the most specific answer
 * available: it names every missing grant, including ones no call has tripped
 * over yet.
 */
export function computerSetupSignal(input: {
  /** A thrown failure, if the call failed. */
  readonly error?: unknown;
  /** Availability carried by a successful result, when it carries one. */
  readonly availability?: ComputerAvailability | undefined;
  /** Grants the backend currently lacks, freshly established. */
  readonly missing?: readonly ComputerPermission[] | undefined;
  /**
   * How the backend's build is signed, when it has an answer. Used only when the
   * availability did not carry one of its own, which it does whenever it reports
   * a blocking grant.
   */
  readonly buildSignature?: ComputerBuildSignature | undefined;
  /**
   * The responsible app, defaulted from the environment. A parameter only so
   * tests can drive both branches; nothing else passes it.
   */
  readonly bundleId?: string | undefined;
}): ComputerSetupSignal | undefined {
  const resolvedBundleId = input.bundleId?.trim() || responsibleDesktopBundleId();
  const app = resolvedBundleId === undefined ? {} : { bundleId: resolvedBundleId };
  if (input.availability?.kind === "permission-required") {
    // The backend already decided this one blocks: an availability that reports
    // `permission-required` is the desktop saying it cannot be driven.
    return {
      missing: input.availability.missing,
      blocking: true,
      buildSignature: input.availability.buildSignature,
      ...app,
    };
  }
  const signature =
    input.buildSignature === undefined ? {} : { buildSignature: input.buildSignature };
  const missing = input.missing ?? [];
  if (input.error !== undefined && computerFailureNeedsSetup(input.error)) {
    // A call that actually failed for want of a grant is blocking whatever the
    // grant was: whichever one it needed, it did not get it and did not run.
    return { missing, blocking: true, ...signature, ...app };
  }
  return missing.length > 0
    ? { missing, blocking: computerPermissionsBlockControl(missing), ...signature, ...app }
    : undefined;
}

/**
 * What the *model* is told, as opposed to what the user is shown.
 *
 * Deliberately terse and free of instructions the model could try to follow: the
 * remedy is a dialog the OS has already put in front of the human, so the
 * agent's whole job here is to stop and say so. Handed the long user-facing
 * availability message instead, models wrote paragraphs explaining macOS privacy
 * to a user who was already looking at the prompt.
 *
 * The tense matters. Detecting a missing grant is now what asks the OS for it
 * (`MacComputerBackend.requestMissingPermissions`), so by the time this note
 * reaches the model the dialog is on screen — telling the model to instruct the
 * user through System Settings would talk over it.
 */
export function computerSetupToolNote(signal: ComputerSetupSignal): string {
  const labels = listComputerPermissions(signal.missing);
  const needed = labels.length > 0 ? labels : "a macOS privacy permission";
  const asked = `macOS is asking the user right now for ${needed}, and Synara has shown them a setup card.`;
  if (signal.blocking) {
    return (
      `${asked} Nothing on the desktop can be driven without it. ` +
      "Stop desktop automation, say in one sentence that you are waiting for the user to grant it, " +
      "and do not retry or work around it until the user says it is granted."
    );
  }
  // Deliberately the opposite instruction, and it has to be explicit: handed the
  // blocking wording, models abandoned tasks that were still perfectly doable.
  return (
    `${asked} This one does not block desktop control — only the pictures: screenshots and the ` +
    "computer pane will fail while it is missing, and the window list, the accessibility state " +
    "and every input still work. Do not stop. Carry on with those, say once that you cannot see " +
    "the screen until the user grants it, and target controls by label rather than by coordinates."
  );
}
