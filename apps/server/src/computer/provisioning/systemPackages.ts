/**
 * The one privileged step of computer-use setup: installing distribution
 * packages through polkit.
 *
 * Everything else Synara provisions lands in the user's home directory and can
 * happen silently, but `kwin_wayland` and the toolchain that compiles the KWin
 * plugin come from the distribution. Installing them is a root operation, so it
 * runs through `pkexec` — the desktop's own authorization dialog — and only
 * from the explicit "Set up" request in the settings panel, never from a probe
 * or an availability read. One invocation covers the whole package set, so the
 * user authorizes at most once per setup.
 *
 * The sets name both the compositor and the build dependencies on purpose: a
 * machine that needs `kwin_wayland` installed has, with near certainty, never
 * compiled the plugin either, and every listed manager skips packages that are
 * already present, so over-asking costs nothing but covers the second failure
 * in the same authorization.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";

import { ComputerBackendError } from "../ComputerBackend.ts";

const execFileAsync = promisify(execFile);

/** apt alone can sit on a slow mirror for a while; the dialog is already answered. */
const PACKAGE_INSTALL_TIMEOUT_MS = 15 * 60 * 1_000;
const PKEXEC_DISMISSED_EXIT = 126;
const PKEXEC_NO_AGENT_EXIT = 127;

export interface SystemPackagePlan {
  /** The package manager binary, which is also how the distribution is named to the user. */
  readonly manager: string;
  /** Arguments after the manager, non-interactive and idempotent for every manager. */
  readonly args: readonly string[];
  readonly packages: readonly string[];
}

/**
 * Per-manager package sets. `kwin` is the nested compositor itself; the rest
 * is what `install-and-load.sh` needs to compile the plugin against the local
 * KWin headers: cmake, ECM, a C++ compiler, and ninja, which the script
 * configures CMake with (`-G Ninja`) and checks for before it starts.
 */
const PLANS: readonly SystemPackagePlan[] = [
  {
    manager: "pacman",
    args: ["-S", "--needed", "--noconfirm"],
    packages: ["kwin", "cmake", "extra-cmake-modules", "gcc", "make", "ninja"],
  },
  {
    manager: "apt-get",
    args: ["install", "-y"],
    packages: [
      "kwin-wayland",
      "kwin-dev",
      "cmake",
      "extra-cmake-modules",
      "g++",
      "make",
      "ninja-build",
    ],
  },
  {
    manager: "dnf",
    args: ["install", "-y"],
    packages: [
      "kwin-wayland",
      "kwin-devel",
      "cmake",
      "extra-cmake-modules",
      "gcc-c++",
      "make",
      "ninja-build",
    ],
  },
  {
    manager: "zypper",
    args: ["--non-interactive", "install"],
    packages: ["kwin6", "kwin6-devel", "cmake", "extra-cmake-modules", "gcc-c++", "make", "ninja"],
  },
];

/** Whether `command` resolves on PATH, the way the shell would resolve it. */
export function commandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  executable: (path: string) => boolean = isExecutableFile,
): boolean {
  const path = env.PATH;
  if (!path) return false;
  return path.split(delimiter).some((dir) => dir !== "" && executable(join(dir, command)));
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The plan for this machine, or `undefined` on a distribution whose package
 * manager none of the plans know. First match wins; a machine with two of
 * these managers installed (Arch with `pacman` plus a container's `dnf`) is
 * ordered so the distribution's native one is found first.
 */
export function planSystemPackageInstall(
  hasCommand: (command: string) => boolean = (command) => commandOnPath(command),
): SystemPackagePlan | undefined {
  return PLANS.find((plan) => hasCommand(plan.manager));
}

export type PrivilegedRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

const pkexecRunner: PrivilegedRunner = (command, args) =>
  execFileAsync("pkexec", [command, ...args], {
    timeout: PACKAGE_INSTALL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    // pkexec strips the environment anyway; DEBIAN_FRONTEND rides the argv
    // through `env` below when apt is the manager.
  });

/**
 * Installs the plan's packages through one polkit authorization, and returns
 * the sentence the settings card shows for this step.
 *
 * The two pkexec-specific exit codes are translated because they are the two
 * outcomes the user caused or can fix: 126 is the authorization dialog being
 * dismissed, 127 is no polkit agent to show one. Everything else is the
 * package manager failing, and its own words are the most actionable message
 * available.
 */
export async function installSystemPackages(
  plan: SystemPackagePlan,
  run: PrivilegedRunner = pkexecRunner,
): Promise<string> {
  const commandLine = [plan.manager, ...plan.args, ...plan.packages];
  // apt-get is the one manager here that can still stop to ask a debconf
  // question with `-y` alone.
  const argv =
    plan.manager === "apt-get"
      ? ["env", "DEBIAN_FRONTEND=noninteractive", ...commandLine]
      : commandLine;
  try {
    await run(argv[0]!, argv.slice(1));
  } catch (error) {
    throw describeInstallFailure(plan, error);
  }
  return `Installed ${plan.packages.join(", ")} with ${plan.manager}.`;
}

function describeInstallFailure(plan: SystemPackagePlan, error: unknown): ComputerBackendError {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    return new ComputerBackendError(
      "pkexec is not installed, so Synara cannot ask for authorization to install packages. " +
        `Install them yourself: sudo ${plan.manager} ${[...plan.args, ...plan.packages].join(" ")}`,
      { cause: error },
    );
  }
  if (code === PKEXEC_DISMISSED_EXIT) {
    return new ComputerBackendError(
      "The system authorization dialog was dismissed, so no packages were installed. " +
        "Click Set up again to retry.",
      { retryable: true, cause: error },
    );
  }
  if (code === PKEXEC_NO_AGENT_EXIT) {
    return new ComputerBackendError(
      "No polkit authentication agent answered, so Synara could not ask for authorization. " +
        `Install the packages yourself: sudo ${plan.manager} ${[...plan.args, ...plan.packages].join(" ")}`,
      { cause: error },
    );
  }
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const detail =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim().split("\n").at(-1)
      : error instanceof Error
        ? error.message
        : String(error);
  return new ComputerBackendError(`${plan.manager} failed to install packages: ${detail}`, {
    cause: error,
  });
}
