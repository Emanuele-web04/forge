// FILE: check-windows-runtime-boundary.ts
// Purpose: Prevents application/provider code from reintroducing Windows process workarounds.

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const scopedRoots = [
  "apps/server/src/provider",
  "apps/server/src/git",
  "apps/desktop/src",
] as const;
const scopedFiles = ["apps/server/src/open.ts", "apps/server/src/processRunner.ts"] as const;

function walk(relativeRoot: string): string[] {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  return fs.readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) return walk(relativePath);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [relativePath] : [];
  });
}

function isTestOrFixture(file: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|fixtures|testing)(?:\/|$)/.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

function isProviderOrGit(file: string): boolean {
  return file.startsWith("apps/server/src/provider/") || file.startsWith("apps/server/src/git/");
}

function ownsNodeSpawnPolicy(file: string): boolean {
  return (
    isProviderOrGit(file) ||
    file === "apps/server/src/open.ts" ||
    file === "apps/server/src/processRunner.ts" ||
    file === "apps/desktop/src/voiceTranscription.ts" ||
    file === "apps/desktop/src/electronUpdaterSecurity.ts"
  );
}

const files = [...new Set([...scopedRoots.flatMap(walk), ...scopedFiles])]
  .filter((file) => !isTestOrFixture(file))
  .toSorted();

const violations: string[] = [];
const report = (file: string, rule: string) => violations.push(`${file}: ${rule}`);

for (const file of files) {
  const source = fs.readFileSync(path.join(repoRoot, file), "utf8");

  if (/from\s+["']@synara\/shared\/windowsProcess["']/.test(source)) {
    report(file, "import the platform-neutral process runtime instead of windowsProcess");
  }
  if (/\bprepareWindowsSafeProcess\b/.test(source)) {
    report(file, "Windows command preparation belongs to platformProcess/processRuntime");
  }
  if (/\bwindowsVerbatimArguments\b/.test(source)) {
    report(file, "windowsVerbatimArguments is owned by the shared process runtime");
  }
  if (/\b(?:where\.exe|taskkill)\b/i.test(source)) {
    report(file, "Windows executable/tree commands belong to the platform boundary");
  }
  if (/\b(?:parseWindowsWslUncPath|resolveWindowsWslExe|resolveWindowsComSpec)\b/.test(source)) {
    report(file, "WSL and Windows shell translation belong to the shared platform boundary");
  }

  if (ownsNodeSpawnPolicy(file) && /\bwindowsHide\b/.test(source)) {
    report(file, "windowsHide is selected by processRuntime");
  }

  if (isProviderOrGit(file)) {
    const importsNodeRuntime =
      /import\s+(?:\*\s+as\s+\w+|\{[\s\S]*?\b(?:spawn|spawnSync|exec|execFile)\b[\s\S]*?\})\s+from\s+["']node:child_process["']/.test(
        source,
      );
    if (importsNodeRuntime) {
      report(file, "production process creation must use processRuntime/effectProcessRuntime");
    }
    if (/\bChildProcess\.make\s*\(/.test(source)) {
      report(file, "Effect commands must be created through makeEffectProcessCommand");
    }
    if (
      file !== "apps/server/src/provider/skillsCatalog.ts" &&
      /process\.platform\s*[!=]==?\s*["']win32["']/.test(source)
    ) {
      report(file, "provider/Git process policy must not branch on win32");
    }
  }
}

if (violations.length > 0) {
  console.error("Windows runtime boundary violations:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(`Windows runtime boundary verified across ${files.length} application source files.`);
}
