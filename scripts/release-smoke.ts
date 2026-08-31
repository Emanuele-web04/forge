// FILE: release-smoke.ts
// Purpose: Smoke-tests release version alignment and merged macOS updater manifests.
// Layer: Release verification script
// Depends on: update-release-package-versions.ts and merge-mac-update-manifests.ts.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import {
  readReleaseUpdatePolicyConfig,
  resolveReleaseUpdatePolicy,
} from "./lib/release-update-policy.ts";
import {
  RELEASE_LOCKFILE_PATH,
  RELEASE_PATCHES_PATH,
  RELEASE_WORKSPACE_MANIFEST_PATHS,
} from "./lib/release-workspace-manifests.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function copyWorkspaceManifestFixture(targetRoot: string): void {
  for (const relativePath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const sourcePath = resolve(repoRoot, relativePath);
    const destinationPath = resolve(targetRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath);
  }
  cpSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), resolve(targetRoot, RELEASE_LOCKFILE_PATH));
  cpSync(resolve(repoRoot, RELEASE_PATCHES_PATH), resolve(targetRoot, RELEASE_PATCHES_PATH), {
    recursive: true,
  });
}

function writeMacManifestFixtures(targetRoot: string): { arm64Path: string; x64Path: string } {
  const assetDirectory = resolve(targetRoot, "release-assets");
  mkdirSync(assetDirectory, { recursive: true });

  const arm64Path = resolve(assetDirectory, "latest-mac.yml");
  const x64Path = resolve(assetDirectory, "latest-mac-x64.yml");

  writeFileSync(
    arm64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Synara-9.9.9-smoke.0-arm64.zip
    sha512: arm64zip
    size: 125621344
path: Synara-9.9.9-smoke.0-arm64.zip
sha512: arm64zip
releaseDate: '2026-03-08T10:32:14.587Z'
`,
  );

  writeFileSync(
    x64Path,
    `version: 9.9.9-smoke.0
files:
  - url: Synara-9.9.9-smoke.0-x64.zip
    sha512: x64zip
    size: 132000112
path: Synara-9.9.9-smoke.0-x64.zip
sha512: x64zip
releaseDate: '2026-03-08T10:36:07.540Z'
`,
  );

  return { arm64Path, x64Path };
}

function assertContains(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(message);
  }
}

function assertNotContains(haystack: string, needle: string, message: string): void {
  if (haystack.includes(needle)) {
    throw new Error(message);
  }
}

function verifyCanonicalIdentity(): void {
  const serverPackage = JSON.parse(
    readFileSync(resolve(repoRoot, "apps/server/package.json"), "utf8"),
  ) as { name?: string; bin?: Record<string, string> };
  if (serverPackage.name !== "@synara/cli") {
    throw new Error(`Expected CLI package @synara/cli, got ${serverPackage.name ?? "<missing>"}.`);
  }
  const expectedBinaries = {
    synara: "dist/index.mjs",
    "synara-restore-migration-backup": "dist/restoreMigrationBackup.mjs",
  };
  if (JSON.stringify(serverPackage.bin ?? {}) !== JSON.stringify(expectedBinaries)) {
    throw new Error(
      "Expected the CLI to expose only the Synara entry point and migration recovery binary.",
    );
  }
  if (SYNARA_PRODUCTION_BUNDLE_ID !== "com.emanueledipietro.synara") {
    throw new Error(`Unexpected production bundle ID: ${SYNARA_PRODUCTION_BUNDLE_ID}.`);
  }
  if (SYNARA_DESKTOP_UPDATE_CHANNEL !== "synara") {
    throw new Error(`Unexpected desktop update channel: ${SYNARA_DESKTOP_UPDATE_CHANNEL}.`);
  }

  const releasePolicy = readReleaseUpdatePolicyConfig(repoRoot);
  const resolvedPolicy = resolveReleaseUpdatePolicy("9.9.9", releasePolicy);
  if (
    resolvedPolicy.lane !== "clean" ||
    !resolvedPolicy.makeLatest ||
    resolvedPolicy.mirrorToStableChannel
  ) {
    throw new Error("Expected stable clean Synara releases to publish on GitHub Latest.");
  }
}

function verifyReleaseWorkflowSafety(): void {
  const workflow = readFileSync(
    resolve(repoRoot, ".github/workflows/release.yml"),
    "utf8",
  ).replaceAll("\r\n", "\n");
  assertContains(
    workflow,
    "\npermissions: {}\n",
    "Expected the release workflow to deny GITHUB_TOKEN permissions by default.",
  );
  assertNotContains(
    workflow,
    "permissions:\n  contents: write\n  id-token: write",
    "Release-wide publication permissions must not be inherited by every job.",
  );
  assertContains(
    workflow,
    "  preflight:\n    name: Preflight\n    runs-on: ubuntu-24.04\n    timeout-minutes: 15\n    permissions:\n      contents: read",
    "Expected preflight to receive read-only repository access.",
  );
  assertContains(
    workflow,
    "  build:\n    name: Build ${{ matrix.label }}\n    needs: preflight\n    runs-on: ${{ matrix.runner }}\n    timeout-minutes: 30\n    permissions:\n      contents: read",
    "Expected artifact builds to receive read-only repository access.",
  );
  assertContains(
    workflow,
    "    permissions:\n      contents: read\n      id-token: write\n    steps:",
    "Expected only CLI publication to combine repository reads with npm OIDC.",
  );
  assertContains(
    workflow,
    "  build_server_tarball:\n    name: Build server tarball\n    if: ${{ needs.preflight.outputs.publish_release == 'true' }}\n    needs: [preflight, build]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      contents: read",
    "Expected server tarball builds to receive read-only repository access.",
  );
  assertContains(
    workflow,
    "  release:\n    name: Publish GitHub Release\n    if: ${{ needs.preflight.outputs.publish_release == 'true' }}\n    needs: [preflight, build, build_server_tarball]\n    runs-on: ubuntu-24.04\n    timeout-minutes: 10\n    permissions:\n      contents: write",
    "Expected only GitHub release publication to receive contents write access.",
  );
  assertContains(
    workflow,
    "repositories: ${{ github.event.repository.name }}\n          permission-contents: write",
    "Expected release finalization to mint a repository-scoped contents token.",
  );
  assertContains(
    workflow,
    "publish_release:\n        description:",
    "Expected a manual publication opt-in input.",
  );
  assertContains(
    workflow,
    "default: false\n        type: boolean",
    "Expected manual release runs to default to build-only mode.",
  );
  assertContains(
    workflow,
    "publish_release: ${{ steps.release_mode.outputs.publish_release }}",
    "Expected preflight to expose the resolved publication mode.",
  );
  assertContains(
    workflow,
    "if: ${{ needs.preflight.outputs.publish_release == 'true' }}",
    "Expected GitHub publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "needs.preflight.outputs.publish_release == 'true' && vars.SYNARA_PUBLISH_CLI == '1'",
    "Expected CLI publication to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "needs.preflight.outputs.publish_release == 'true' && vars.SYNARA_FINALIZE_RELEASE == '1'",
    "Expected release finalization to require explicit publication mode.",
  );
  assertContains(
    workflow,
    "SYNARA_PUBLISH_RELEASE: ${{ needs.preflight.outputs.publish_release }}",
    "Expected artifact signing admission to know whether artifacts will be published.",
  );
  assertContains(
    workflow,
    "Publishing macOS artifacts requires every signing and notarization secret.",
    "Expected macOS publication to fail closed when signing is unavailable.",
  );
  assertContains(
    workflow,
    "Publishing Windows artifacts requires every Azure Trusted Signing secret.",
    "Expected Windows publication to fail closed when signing is unavailable.",
  );
  assertNotContains(
    workflow,
    "Windows signing is optional",
    "Windows publication must not retain the unsigned-installer fallback.",
  );
  assertContains(
    workflow,
    "node scripts/verify-release-source-provenance.ts",
    "Expected preflight to bind release source provenance before artifact jobs.",
  );
  assertContains(
    workflow,
    "source_commit: ${{ steps.source_provenance.outputs.source_commit }}",
    "Expected the verified source commit to be a preflight output.",
  );
  assertContains(
    workflow,
    "lockfile_sha256: ${{ steps.source_provenance.outputs.lockfile_sha256 }}",
    "Expected the verified lockfile digest to be a preflight output.",
  );
  assertContains(
    workflow,
    '--source-commit "$SOURCE_COMMIT"',
    "Expected desktop packaging to revalidate the verified source commit.",
  );
  assertContains(
    workflow,
    '--lockfile-sha256 "$LOCKFILE_SHA256"',
    "Expected desktop packaging to revalidate the verified lockfile digest.",
  );
  assertNotContains(
    workflow,
    "Align package versions to release version",
    "Release jobs must not mutate package versions after source provenance is established.",
  );
  assertContains(
    workflow,
    "node scripts/write-release-artifact-provenance.ts",
    "Expected every platform lane to prove collected artifacts before upload.",
  );
  assertContains(
    workflow,
    'mv release-publish/latest-mac.yml "release-publish/latest-mac-${{ matrix.arch }}.yml"',
    "Expected the x64 macOS matrix lane to preserve a distinct updater manifest for merging.",
  );
  assertContains(
    workflow,
    "APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}",
    "Expected macOS signing admission to pin the post-build Team ID.",
  );
  assertContains(
    workflow,
    "AZURE_TRUSTED_SIGNING_SUBJECT_DN: ${{ secrets.AZURE_TRUSTED_SIGNING_SUBJECT_DN }}",
    "Expected Windows signing admission to require the exact certificate subject DN.",
  );
  assertContains(
    workflow,
    '--expected-windows-subject-dn "$EXPECTED_WINDOWS_SUBJECT_DN"',
    "Expected Windows artifact provenance to verify the exact certificate subject DN.",
  );
  assertContains(
    workflow,
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME }}",
    "Expected the Windows build to receive the publisher identity that is pinned in the bundle.",
  );
  assertContains(
    workflow,
    "node scripts/verify-packaged-desktop-startup.ts",
    "Expected every native payload to pass isolated packaged startup before upload.",
  );

  const cliScript = readFileSync(resolve(repoRoot, "apps/server/scripts/cli.ts"), "utf8");
  assertContains(
    cliScript,
    "makeTempDirectoryScoped",
    "Expected CLI publication to build an exclusively owned temporary package tree.",
  );
  assertContains(
    cliScript,
    "cwd: stagedPackageDir",
    "Expected npm publication to run only from the isolated CLI stage.",
  );
  assertContains(
    cliScript,
    "Staged CLI bin target is missing its Node shebang",
    "Expected staged CLI commands to remain executable npm bin entries.",
  );
  assertNotContains(
    cliScript,
    ".publish-bak",
    "CLI publication must not mutate and restore source-tree assets.",
  );

  const desktopBuildConfig = readFileSync(
    resolve(repoRoot, "apps/desktop/tsdown.config.mts"),
    "utf8",
  );
  assertContains(
    desktopBuildConfig,
    "__SYNARA_WINDOWS_UPDATER_PUBLISHER__",
    "Expected the Windows updater publisher identity to be compiled into the main bundle.",
  );

  const updaterSecurity = readFileSync(
    resolve(repoRoot, "apps/desktop/src/electronUpdaterSecurity.ts"),
    "utf8",
  );
  assertNotContains(
    updaterSecurity,
    "return feedPublisherNames",
    "Runtime signature verification must not trust publisher names from mutable updater config.",
  );
}

function verifyDesktopStageLockAuthority(): void {
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-desktop-artifact.ts"), "utf8");
  const gitAttributes = readFileSync(resolve(repoRoot, ".gitattributes"), "utf8");
  assertContains(
    gitAttributes,
    "bun.lock text eol=lf",
    "Expected bun.lock to retain byte-identical LF endings on every release runner.",
  );
  assertContains(
    buildScript,
    "bun install --frozen-lockfile --ignore-scripts --linker hoisted",
    "Expected macOS and Linux desktop staging to install from the repository's frozen workspace lockfile.",
  );
  assertContains(
    buildScript,
    'if (platform === "win")',
    "Expected Windows staging to use its explicit Bun lockfile-workaround path.",
  );
  assertContains(
    buildScript,
    "bun install --omit=dev --ignore-scripts --linker hoisted",
    "Expected Windows staging to omit dev dependencies without Bun's implicitly frozen production mode.",
  );
  assertNotContains(
    buildScript,
    "--production --frozen-lockfile",
    "Desktop staging must avoid Bun's divergent frozen production-workspace lockfile resolution.",
  );
  assertNotContains(
    buildScript,
    "bun install --production",
    "Windows staging must not use Bun's production flag because it implicitly forces frozen mode.",
  );
  assertNotContains(
    buildScript,
    "--filter @synara/",
    "Desktop staging must not use Bun workspace filters because filtered hoisted installs can diverge from bun.lock.",
  );
  assertContains(
    buildScript,
    ")`npm rebuild node-pty --foreground-scripts`,",
    "Expected Linux desktop staging to build only node-pty after the script-free frozen install.",
  );
  assertNotContains(
    buildScript,
    "npm rebuild --foreground-scripts",
    "Desktop staging must never enable every dependency lifecycle script.",
  );
  assertNotContains(
    buildScript,
    "bun pm trust --all",
    "Desktop staging must never trust every dependency lifecycle script.",
  );
  assertContains(
    buildScript,
    'createRequire(new URL("./package.json", import.meta.url))',
    "Expected desktop packaging to resolve dependencies from the owning scripts workspace.",
  );
  assertContains(
    buildScript,
    'requireFromScriptsWorkspace.resolve("electron-builder/cli.js")',
    "Expected desktop packaging to resolve electron-builder across Bun hoisting layouts.",
  );
  assertContains(
    buildScript,
    "`${process.execPath} ${electronBuilderCliPath}",
    "Expected desktop packaging to invoke electron-builder through Node without platform-specific bin shims.",
  );
  assertNotContains(
    buildScript,
    "electron-builder.cmd",
    "Desktop packaging must not depend on a Windows bin shim that Bun may hoist elsewhere.",
  );
  assertContains(
    buildScript,
    "synaraCommitHash: commitHash",
    "Expected the staged package to carry its exact source commit.",
  );
  assertContains(
    buildScript,
    "synaraLockfileSha256: resolvedLockfileSha256",
    "Expected the staged package to carry its repository lockfile digest.",
  );
  assertContains(
    buildScript,
    "synaraWindowsPublisherSubject: resolvedBuildConfig.windowsPublisherSubject",
    "Expected signed Windows packages to carry the independently configured certificate subject DN.",
  );

  const lockfile = readFileSync(resolve(repoRoot, RELEASE_LOCKFILE_PATH), "utf8");
  const packagesSectionOffset = lockfile.indexOf('\n  "packages": {');
  if (packagesSectionOffset < 0) {
    throw new Error("Expected bun.lock to contain a packages section.");
  }
  const workspaceImporters = lockfile.slice(0, packagesSectionOffset);
  for (const manifestPath of RELEASE_WORKSPACE_MANIFEST_PATHS) {
    const workspacePath = manifestPath === "package.json" ? "" : dirname(manifestPath);
    if (!workspaceImporters.includes(`${JSON.stringify(workspacePath)}: {`)) {
      throw new Error(`Expected ${manifestPath} to have a matching importer in bun.lock.`);
    }
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), "synara-release-smoke-"));

try {
  verifyCanonicalIdentity();
  verifyReleaseWorkflowSafety();
  verifyDesktopStageLockAuthority();
  copyWorkspaceManifestFixture(tempRoot);

  execFileSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/update-release-package-versions.ts"),
      "9.9.9-smoke.0",
      "--root",
      tempRoot,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });

  const lockfile = readFileSync(resolve(tempRoot, "bun.lock"), "utf8");
  assertContains(
    lockfile,
    `"version": "9.9.9-smoke.0"`,
    "Expected bun.lock to contain the smoke version.",
  );

  const { arm64Path, x64Path } = writeMacManifestFixtures(tempRoot);
  execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/merge-mac-update-manifests.ts"), arm64Path, x64Path],
    {
      cwd: repoRoot,
      stdio: "inherit",
    },
  );

  const mergedManifest = readFileSync(arm64Path, "utf8");
  assertContains(
    mergedManifest,
    "Synara-9.9.9-smoke.0-arm64.zip",
    "Merged manifest is missing the arm64 asset.",
  );
  assertContains(
    mergedManifest,
    "Synara-9.9.9-smoke.0-x64.zip",
    "Merged manifest is missing the x64 asset.",
  );
  assertNotContains(
    mergedManifest,
    ".dmg",
    "macOS updater manifests must describe only the finalized ZIP artifacts.",
  );

  console.log("Release smoke checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
