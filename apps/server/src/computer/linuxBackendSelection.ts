/**
 * Which computer backend this Linux host gets, decided once at startup.
 *
 * One rule outranks everything here: **the agent never drives the seat the
 * human is sitting at.** Every backend this module can resolve gives the agent
 * a seat of its own — a compositor plugin's dedicated seat on a KDE session,
 * or a private nested compositor everywhere else. There is
 * no shared-seat backend: anything that attached virtual devices to the
 * human's own `wl_seat` would move their real cursor, so no such backend
 * exists in the tree to be selected, forced, or fallen back to.
 *
 * Beyond that rule, an explicit ordered resolution with **no fallback in any
 * direction**. Falling back from a nested session to the real desktop would
 * hand an agent the human's screen right after an operator asked for an
 * isolated one; falling the other way would hide a broken desktop behind a
 * session nobody can see. A tier that fails stays failed, and the backend it
 * produces explains why — on a host without `kwin_wayland`, the nested
 * backend's failure names the package to install rather than quietly picking
 * something that would touch the human's seat.
 *
 * The auto-detection asks the session bus who owns `org.kde.KWin` rather than
 * reading `XDG_CURRENT_DESKTOP`. The compositor is the thing that decides
 * whether the KWin plugin can load; the env var is a label a login manager sets
 * and a user can override, and on a KDE session started from a tty it is often
 * simply absent.
 */
import { KWIN_SERVICE } from "./kwinDbus.ts";
import { nestedSessionMode, type NestedSessionMode } from "./nestedKWinSession.ts";

/** Every backend `SYNARA_COMPUTER_BACKEND` can name, in the plan's spelling. */
export const LINUX_BACKEND_CHOICES = ["kwin", "nested", "nested-window"] as const;
export type LinuxBackendChoice = (typeof LINUX_BACKEND_CHOICES)[number];

export interface LinuxBackendSelection {
  readonly choice: LinuxBackendChoice;
  /**
   * The choice came from `SYNARA_COMPUTER_BACKEND`. A forced choice that then
   * fails must stay failed and say so: an operator who named a backend is
   * debugging that backend, and quietly giving them a different one wastes the
   * next hour of their life.
   */
  readonly forced: boolean;
  /** Why this backend, in one sentence, for the availability card and logs. */
  readonly reason: string;
}

export class InvalidComputerBackendOverrideError extends Error {
  constructor(readonly value: string) {
    super(
      `SYNARA_COMPUTER_BACKEND=${JSON.stringify(value)} is not a backend Synara has. ` +
        `Use one of: ${LINUX_BACKEND_CHOICES.join(", ")}.`,
    );
    this.name = "InvalidComputerBackendOverrideError";
  }
}

/**
 * The override, or `undefined` when none is set.
 *
 * A typo throws instead of being ignored. Every other env var here degrades to
 * a default on bad input, but this one names the backend: silently ignoring
 * `SYNARA_COMPUTER_BACKEND=protal` would boot the wrong tier and look like the
 * override does not work.
 */
export function parseComputerBackendOverride(
  value: string | undefined,
): LinuxBackendChoice | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  const match = LINUX_BACKEND_CHOICES.find((choice) => choice === lowered);
  if (!match) throw new InvalidComputerBackendOverrideError(trimmed);
  return match;
}

/** The nested mode a choice implies, or `undefined` for the non-nested tiers. */
export function nestedModeForChoice(choice: LinuxBackendChoice): NestedSessionMode | undefined {
  if (choice === "nested") return "virtual";
  if (choice === "nested-window") return "window";
  return undefined;
}

export interface LinuxBackendSelectionDependencies {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Whether a name is owned on the session bus. Rejects when the bus itself is
   * unreachable, which the caller distinguishes from an unowned name.
   */
  readonly busNameHasOwner: (name: string) => Promise<boolean>;
}

/**
 * Resolves the backend in order: override, nested opt-in, KWin presence, and
 * the headless nested compositor for every other desktop.
 */
export async function selectLinuxBackend(
  dependencies: LinuxBackendSelectionDependencies,
): Promise<LinuxBackendSelection> {
  const env = dependencies.env ?? process.env;

  const override = parseComputerBackendOverride(env.SYNARA_COMPUTER_BACKEND);
  if (override) {
    return {
      choice: override,
      forced: true,
      reason: `SYNARA_COMPUTER_BACKEND=${override} selected this backend explicitly, so no other backend is tried.`,
    };
  }

  const nested = nestedSessionMode(env);
  if (nested) {
    return {
      choice: nested === "window" ? "nested-window" : "nested",
      forced: false,
      reason: `SYNARA_COMPUTER_NESTED=${env.SYNARA_COMPUTER_NESTED} asked for a private compositor this process owns.`,
    };
  }

  try {
    if (await dependencies.busNameHasOwner(KWIN_SERVICE)) {
      return {
        choice: "kwin",
        forced: false,
        reason: `${KWIN_SERVICE} is owned on the session bus, so this is a KWin session and the KWin plugin applies.`,
      };
    }
  } catch (error) {
    // An unreachable session bus is not evidence that KWin is absent, but it
    // is proof that the KWin plugin cannot be reached: every call to it goes
    // over that bus. The nested compositor does not depend on it - the session
    // it starts brings a private `dbus-daemon` of its own - so a host without
    // an ambient bus (a headless server, CI, a service unit) gets the desktop
    // that can actually work rather than one that reports the dead bus.
    return {
      choice: "nested",
      forced: false,
      reason:
        `The session bus could not be asked who owns ${KWIN_SERVICE} ` +
        `(${error instanceof Error ? error.message : String(error)}), which rules out the KWin plugin; ` +
        "a headless nested compositor starts a bus of its own and does not need this one.",
    };
  }

  return {
    choice: "nested",
    forced: false,
    reason:
      `No process owns ${KWIN_SERVICE}, so this desktop has no seat to dedicate to the agent; ` +
      "a headless nested compositor gives it one of its own instead of sharing the human's, " +
      "with the Computer pane as its screen — nothing appears on this desktop.",
  };
}
