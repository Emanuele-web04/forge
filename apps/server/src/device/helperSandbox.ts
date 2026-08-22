/**
 * Seatbelt confinement for the native device helper.
 *
 * The helper dlopens private CoreSimulator/SimulatorKit frameworks and injects
 * HID events driven by a model, with no need for the user's files or the
 * network. `device-helper.sb` takes those away; this module is the single place
 * that knows how to apply it, so the long-lived RPC process and the one-shot
 * `--probe` run are confined identically. Preflighting under different
 * privileges than the real run would let a broken rule pass the checklist and
 * then hang on attach.
 *
 * Every profile parameter is resolved at spawn time rather than hard-coded,
 * because the ones that matter move per machine: Xcode can be a beta or live
 * outside /Applications, and the helper cache is keyed per toolchain.
 *
 * @module device/helperSandbox
 */
import { access, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

/** Set to skip confinement entirely. Logged loudly wherever it is honoured. */
export const SANDBOX_OPT_OUT_ENV = "SYNARA_DEVICE_HELPER_NO_SANDBOX";

export const SANDBOX_PROFILE_NAME = "device-helper.sb";

export interface HelperSandboxContext {
  /** The helper binary about to be run. */
  readonly binaryPath: string;
  /** Absolute path to `apps/server/native/device-helper`. */
  readonly helperSourceDir: string;
  /** `DEVELOPER_DIR` for this run, resolved the way the helper resolves it. */
  readonly developerDir: string | null;
  readonly env?: NodeJS.ProcessEnv;
}

export interface HelperSandboxCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Null when the helper runs unconfined, for the message that says so. */
  readonly profilePath: string | null;
}

/**
 * The Xcode *bundle* for a developer dir.
 *
 * `DEVELOPER_DIR` points at `Xcode.app/Contents/Developer`, but the helper
 * mmaps frameworks from all over the bundle, so the profile has to cover the
 * `.app` itself. CommandLineTools has no enclosing bundle; its developer dir is
 * returned unchanged and `/Library/Developer` in the profile covers it.
 */
export function xcodeAppRoot(developerDir: string): string {
  const marker = `${path.sep}Contents${path.sep}Developer`;
  const index = developerDir.indexOf(marker);
  return index === -1 ? developerDir : developerDir.slice(0, index);
}

/**
 * Resolve symlinks for a path used in a profile parameter.
 *
 * Seatbelt matches on the real path, and the ones here are routinely symlinks:
 * `$TMPDIR` is `/var/folders/...`, which is really `/private/var/folders/...`.
 * A parameter left unresolved matches nothing and denies silently. Missing
 * paths are returned as-is so a not-yet-created directory cannot break a spawn.
 */
async function resolved(target: string): Promise<string> {
  return await realpath(target).catch(() => target);
}

/** Whether the opt-out is set in the environment governing this run. */
export function sandboxDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[SANDBOX_OPT_OUT_ENV]?.trim();
  return value !== undefined && value.length > 0 && value !== "0" && value !== "false";
}

/**
 * Wrap `argv` in `sandbox-exec`, or hand it back untouched.
 *
 * Falls back to running unconfined when the profile is missing rather than
 * refusing to start: a packaging mistake should cost the confinement, not the
 * feature. The caller logs the fallback, and `profilePath` is null so a later
 * timeout message can tell the two apart.
 */
export async function sandboxedHelperCommand(
  argv: readonly string[],
  context: HelperSandboxContext,
): Promise<HelperSandboxCommand> {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("sandboxedHelperCommand needs a command");
  const plain: HelperSandboxCommand = { command, args, profilePath: null };

  if (process.platform !== "darwin") return plain;
  if (sandboxDisabled(context.env ?? process.env)) return plain;

  const profilePath = path.join(context.helperSourceDir, SANDBOX_PROFILE_NAME);
  const readable = await access(profilePath, fsConstants.R_OK).then(
    () => true,
    () => false,
  );
  if (!readable) return plain;

  const home = homedir();
  const [helperBundle, userHome, coreSimHome, coreSimLogs, darwinTmp, xcodeApp] = await Promise.all(
    [
      resolved(path.dirname(context.binaryPath)),
      resolved(home),
      resolved(path.join(home, "Library", "Developer", "CoreSimulator")),
      resolved(path.join(home, "Library", "Logs", "CoreSimulator")),
      resolved(tmpdir()),
      // No developer dir yet (Xcode missing) still needs a syntactically valid
      // parameter; the run will fail on its own terms rather than on the profile.
      resolved(xcodeAppRoot(context.developerDir ?? "/Applications/Xcode.app")),
    ],
  );

  return {
    command: "/usr/bin/sandbox-exec",
    args: [
      "-f",
      profilePath,
      "-D",
      `HELPER_BUNDLE=${helperBundle}`,
      "-D",
      `USER_HOME=${userHome}`,
      "-D",
      `CORESIM_HOME=${coreSimHome}`,
      "-D",
      `CORESIM_LOGS=${coreSimLogs}`,
      "-D",
      `DARWIN_TMP=${darwinTmp}`,
      "-D",
      `XCODE_APP=${xcodeApp}`,
      command,
      ...args,
    ],
    profilePath,
  };
}

/**
 * Append the sandbox to a failure message when it is a plausible cause.
 *
 * A denied rule does not raise; CoreSimulator swallows it and the helper simply
 * never answers. That looks exactly like a hung helper, so a timeout under
 * confinement has to name the sandbox and the way out, or the next person spends
 * the afternoon debugging CoreSimulator instead of a profile line.
 */
export function describeSandboxSuspicion(profilePath: string | null): string {
  if (profilePath === null) return "";
  return (
    ` The helper runs under the Seatbelt profile at ${profilePath}, and a missing rule there` +
    ` stalls it instead of erroring. Set ${SANDBOX_OPT_OUT_ENV}=1 to run it unconfined and` +
    ` confirm whether the profile is the cause.`
  );
}
