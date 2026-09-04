// Locates the real provider binary on PATH, excluding the Synara shim
// directory and the launcher itself.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ResolveRealBinaryInput {
  readonly command: string;
  readonly pathEnv: string | undefined;
  /** Directories containing Synara shims; excluded from the search. */
  readonly shimDir: string | readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly pathExtEnv?: string | undefined;
}

function canonicalize(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

// Marker written by cliIntegration's shim scripts. A shim copied outside the
// shim directories would exec the launcher again, recursing forever; detect
// the signature and skip such candidates.
const SHIM_SIGNATURE = /^SYNARA_LAUNCHER_SHIM=\S+ exec /m;

function isSynaraShimScript(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const head = buffer.subarray(0, bytesRead).toString("utf8");
      return head.startsWith("#!") && SHIM_SIGNATURE.test(head);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    // Windows has no executable bit; PATHEXT-based extension matching (done
    // by the caller when building candidates) is the executability check.
    if (platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches PATH for the first executable named `command`, skipping the shim
 * directory and any candidate that canonicalizes into it (so a shim symlinked
 * elsewhere never launches itself). Honors Windows `PATHEXT`.
 */
export function resolveRealBinary(input: ResolveRealBinaryInput): string | null {
  const platform = input.platform ?? process.platform;
  const shimDirs = typeof input.shimDir === "string" ? [input.shimDir] : input.shimDir;
  const shimDirsReal = shimDirs.map((dir) => canonicalize(dir) ?? path.resolve(dir));
  // PATH entry separator follows the target platform, not the host runtime.
  const delimiter = platform === "win32" ? ";" : ":";
  const searchDirs = (input.pathEnv ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .filter((dir) => {
      const real = canonicalize(dir) ?? path.resolve(dir);
      return !shimDirsReal.includes(real);
    });

  const extensions =
    platform === "win32"
      ? (input.pathExtEnv ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext.length > 0)
      : [""];

  for (const dir of searchDirs) {
    // PATHEXT entries are conventionally uppercase but files on disk may use
    // either case; try both on the case-sensitivity-agnostic side.
    const suffixes = [...new Set(extensions.flatMap((ext) => [ext, ext.toLowerCase()]))];
    for (const suffix of suffixes) {
      const candidate = path.join(dir, input.command + suffix);
      const real = canonicalize(candidate);
      if (real === null) continue;
      if (shimDirsReal.includes(path.dirname(real))) continue;
      if (isSynaraShimScript(real)) continue;
      if (isExecutableFile(real, platform)) return real;
    }
  }
  return null;
}
