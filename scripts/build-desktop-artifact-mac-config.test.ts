import { assert, describe, it } from "@effect/vitest";

import {
  createDesktopPlatformBuildConfig,
  MAC_AFTER_SIGN_CONFIG_PATH,
  MAC_AFTER_SIGN_HOOK_ASAR_EXCLUSION,
  MAC_AFTER_SIGN_HOOK_PATH,
  MAC_AFTER_SIGN_HOOK_REFERENCE,
  MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
  MAC_APPSNAP_HELPER_BUNDLE_PATH,
  MAC_APPSNAP_HELPER_NAME,
  MAC_APPSNAP_HELPER_STAGE_PATH,
  MAC_COMPUTER_HELPER_ASAR_EXCLUSION,
  MAC_COMPUTER_HELPER_BUNDLE_PATH,
  MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH,
  MAC_COMPUTER_HELPER_SOURCES_ASAR_EXCLUSION,
  MAC_COMPUTER_HELPER_SOURCES_RESOURCE_PATH,
  MAC_COMPUTER_HELPER_SOURCES_STAGE_PATH,
  MAC_COMPUTER_HELPER_STAGE_PATH,
  MAC_DEVICE_HELPER_ASAR_EXCLUSION,
  MAC_DEVICE_HELPER_RESOURCE_PATH,
  MAC_DEVICE_HELPER_STAGE_PATH,
  MAC_ENTITLEMENTS_PATH,
  MAC_HELPER_ENTITLEMENTS_PATH,
  MAC_INHERITED_ENTITLEMENTS_PATH,
  MAC_MINIMUM_SYSTEM_VERSION,
  MICROPHONE_USAGE_DESCRIPTION,
  MAC_HELPER_X64_ARCH_FILES,
  NODE_PTY_ASAR_UNPACK_GLOBS,
  NON_MAC_FILES,
  SCREEN_RECORDING_USAGE_DESCRIPTION,
  validateDesktopNativeBuildHost,
  WINDOWS_INSTALLER_GUID,
} from "./lib/desktop-platform-build-config.ts";
import {
  COMPUTER_HELPER_BUNDLE_IDENTIFIER,
  COMPUTER_HELPER_BUNDLE_NAME,
  COMPUTER_HELPER_MINIMUM_MACOS_VERSION,
  COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH,
} from "@synara/shared/computerHelperPaths";
import { SYNARA_PRODUCTION_BUNDLE_ID } from "@synara/shared/desktopIdentity";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

/** The desktop's plain-`node` helper build script, which ships no types. */
async function loadComputerHelperBuildScript(): Promise<{
  readonly computerHelperBundleIdentifier: string;
}> {
  const specifier = pathToFileURL(
    join(import.meta.dirname, "../apps/desktop/scripts/build-computer-helper.mjs"),
  ).href;
  return (await import(specifier)) as { readonly computerHelperBundleIdentifier: string };
}

describe("createDesktopPlatformBuildConfig", () => {
  it("seals local macOS apps with an ad-hoc identity without requiring a certificate", () => {
    const local = createDesktopPlatformBuildConfig({ platform: "mac", target: "dmg" });
    assert.equal(local.mac?.identity, "-");
    assert.equal(local.mac?.hardenedRuntime, false);
    assert.equal(local.mac?.notarize, false);
    const release = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    assert.equal(release.mac?.identity, undefined);
    const explicit = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      macSigningIdentity: "Local Developer",
    });
    assert.equal(explicit.mac?.identity, "Local Developer");
  });

  it("adds explicit microphone entitlements to macOS builds", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    const dmg = config.dmg as Record<string, unknown>;
    const extendInfo = mac.extendInfo as Record<string, unknown>;

    assert.deepStrictEqual(mac.target, ["dmg", "zip"]);
    assert.equal(mac.icon, "icon.icns");
    assert.deepStrictEqual(config.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(mac.hardenedRuntime, true);
    // Never electron-builder's own notarization: it runs inside the signing
    // step, before `afterSign` re-signs the nested helper and re-seals the app,
    // so a ticket stapled there would describe a hash the shipped app no longer
    // has. The hook owns the submission.
    assert.equal(mac.notarize, false);
    assert.equal(config.afterSign, MAC_AFTER_SIGN_HOOK_REFERENCE);
    assert.equal(MAC_AFTER_SIGN_HOOK_REFERENCE, `./${MAC_AFTER_SIGN_HOOK_PATH}`);
    assert.equal(MAC_AFTER_SIGN_HOOK_PATH, "build-hooks/mac-after-sign.cjs");
    assert.equal(MAC_AFTER_SIGN_CONFIG_PATH, "build-hooks/mac-after-sign.json");
    assert.equal(dmg.sign, true);
    assert.equal(dmg.writeUpdateInfo, false);
    assert.equal(mac.entitlements, MAC_ENTITLEMENTS_PATH);
    assert.equal(mac.entitlementsInherit, MAC_INHERITED_ENTITLEMENTS_PATH);
    // The app installs no lower than the helper can launch: below 12.3 there is
    // no ScreenCaptureKit and the helper dies in dyld.
    assert.equal(mac.minimumSystemVersion, MAC_MINIMUM_SYSTEM_VERSION);
    assert.equal(MAC_MINIMUM_SYSTEM_VERSION, COMPUTER_HELPER_MINIMUM_MACOS_VERSION);
    assert.equal(MAC_MINIMUM_SYSTEM_VERSION, "12.3");
    assert.equal(MAC_APPSNAP_HELPER_BUNDLE_PATH, "Contents/Helpers/synara-appsnap-helper");
    // The packaged helper path is the shared constant the desktop main process
    // resolves at runtime, not a second spelling of it: a bundle rename that
    // only reached one of them is exactly the failure this pins.
    assert.equal(
      MAC_COMPUTER_HELPER_BUNDLE_PATH,
      `Contents/Helpers/${COMPUTER_HELPER_BUNDLE_NAME}`,
    );
    assert.equal(
      MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH,
      COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH,
    );
    // The signable unit for the computer-use helper is its `.app`, because that
    // is the identity macOS files its Screen Recording and Accessibility grants
    // under. The AppSnap helper is a bare executable and stays one.
    assert.deepStrictEqual(mac.binaries, [
      MAC_APPSNAP_HELPER_BUNDLE_PATH,
      MAC_COMPUTER_HELPER_BUNDLE_PATH,
    ]);
    // @electron/universal takes one glob; both helper paths must survive into it.
    assert.equal(mac.x64ArchFiles, MAC_HELPER_X64_ARCH_FILES);
    assert.ok(MAC_HELPER_X64_ARCH_FILES.includes(MAC_APPSNAP_HELPER_NAME));
    assert.ok(
      MAC_HELPER_X64_ARCH_FILES.includes(
        MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH.slice("Contents/Helpers/".length),
      ),
    );
    assert.equal(
      MAC_APPSNAP_HELPER_STAGE_PATH,
      "apps/desktop/native/appsnap/build/synara-appsnap-helper",
    );
    assert.equal(MAC_APPSNAP_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/appsnap/build/**");
    assert.equal(MAC_COMPUTER_HELPER_ASAR_EXCLUSION, "!apps/desktop/native/computer-use/build/**");
    assert.equal(
      MAC_COMPUTER_HELPER_STAGE_PATH,
      `apps/desktop/native/computer-use/build/${COMPUTER_HELPER_BUNDLE_NAME}`,
    );
    // The helper's Swift sources are staged beside the app, never into the
    // asar: a compiler cannot read an archive, so a source dir inside it makes
    // the server's fallback fail rather than decline.
    assert.equal(MAC_COMPUTER_HELPER_SOURCES_STAGE_PATH, "apps/server/dist/computer-use-macos");
    assert.equal(MAC_COMPUTER_HELPER_SOURCES_RESOURCE_PATH, "Resources/computer-use-macos");
    assert.equal(
      MAC_COMPUTER_HELPER_SOURCES_ASAR_EXCLUSION,
      "!apps/server/dist/computer-use-macos/**",
    );
    assert.deepStrictEqual(config.files, [
      "**/*",
      MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
      MAC_COMPUTER_HELPER_ASAR_EXCLUSION,
      MAC_COMPUTER_HELPER_SOURCES_ASAR_EXCLUSION,
      // The device helper is staged under `Resources/device-helper` and the
      // desktop points the backend at that copy, so a second copy inside the
      // asar — where no compiler can read it — is pure weight.
      MAC_DEVICE_HELPER_ASAR_EXCLUSION,
      MAC_AFTER_SIGN_HOOK_ASAR_EXCLUSION,
    ]);
    assert.equal(MAC_DEVICE_HELPER_ASAR_EXCLUSION, "!apps/server/dist/device-helper/**");
    assert.equal(MAC_AFTER_SIGN_HOOK_ASAR_EXCLUSION, "!build-hooks/**");
    assert.deepStrictEqual(config.extraFiles, [
      {
        from: "apps/desktop/native/appsnap/build/synara-appsnap-helper",
        to: "Helpers/synara-appsnap-helper",
      },
      {
        from: MAC_COMPUTER_HELPER_STAGE_PATH,
        to: `Helpers/${COMPUTER_HELPER_BUNDLE_NAME}`,
      },
      {
        from: MAC_COMPUTER_HELPER_SOURCES_STAGE_PATH,
        to: MAC_COMPUTER_HELPER_SOURCES_RESOURCE_PATH,
      },
      {
        from: MAC_DEVICE_HELPER_STAGE_PATH,
        to: MAC_DEVICE_HELPER_RESOURCE_PATH,
      },
    ]);
    assert.equal(extendInfo.NSMicrophoneUsageDescription, MICROPHONE_USAGE_DESCRIPTION);
    assert.equal(extendInfo.NSScreenCaptureUsageDescription, SCREEN_RECORDING_USAGE_DESCRIPTION);
  });

  it("signs without notarizing when asked only to sign", () => {
    // The point of the split: a self-signed local identity gives the app a
    // stable designated requirement, so macOS stops discarding the helper's
    // Accessibility and Screen Recording grants on every rebuild. It has no
    // Team ID and cannot be notarized, and demanding both together is what made
    // that impossible before.
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: true,
    });
    const mac = config.mac as Record<string, unknown>;
    assert.equal(mac.hardenedRuntime, true);
    assert.equal(mac.notarize, false);
    assert.deepStrictEqual(config.dmg, { sign: true, writeUpdateInfo: false });
    // The hook still runs: stripping the helper's inherited entitlements is not
    // a release-only concern, and an unnotarized signed build re-seals the same
    // way.
    assert.equal(config.afterSign, MAC_AFTER_SIGN_HOOK_REFERENCE);
  });

  it("ships an empty entitlements plist for the nested computer-use helper", () => {
    // Electron's inherited set turns off library validation and allows unsigned
    // executable memory, for its renderer and GPU helpers. The computer-use
    // helper needs neither, and it is the process holding Accessibility and
    // Screen Recording — so its entitlements file must stay empty. A key added
    // here grants it to the process that can see and drive the whole desktop.
    const plist = readFileSync(
      join(import.meta.dirname, "..", MAC_HELPER_ENTITLEMENTS_PATH),
      "utf8",
    );
    assert.equal(
      MAC_HELPER_ENTITLEMENTS_PATH,
      "apps/desktop/resources/entitlements.mac.helper.plist",
    );
    assert.deepStrictEqual(
      [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]),
      [],
    );
    assert.ok(/<dict\s*\/>/.test(plist), "the helper entitlements must be an empty dict");
  });

  it("keeps the afterSign hook where the staged build config points at it", () => {
    // electron-builder resolves the hook against the staged project directory,
    // and `build-desktop-artifact.ts` copies this exact file there. A rename
    // that reached only one of the two fails the build several minutes in.
    assert.ok(
      readFileSync(join(import.meta.dirname, "lib/mac-after-sign.cjs"), "utf8").includes(
        "exports.default",
      ),
    );
  });

  it("builds the helper against the same macOS floor the app declares", () => {
    // build.sh cannot read the shared manifest — a staged copy of these sources
    // has no `packages/` beside it — so its literal is pinned here instead.
    const buildScript = readFileSync(
      join(import.meta.dirname, "../apps/server/native/computer-use-macos/build.sh"),
      "utf8",
    );
    const triple = /apple-macosx([\d.]+)/.exec(buildScript)?.[1];
    assert.equal(triple, COMPUTER_HELPER_MINIMUM_MACOS_VERSION);
  });

  it("leaves the DMG container unsigned for build-only macOS artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "mac",
      target: "dmg",
      signed: false,
    });

    assert.deepStrictEqual(config.dmg, { sign: false, writeUpdateInfo: false });
  });

  it("leaves non-macOS platform configs unchanged", () => {
    const linux = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
    });
    const win = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
      windowsAzureSignOptions: { publisherName: "Synara" },
    });

    assert.equal(linux.mac, undefined);
    assert.equal(linux.extraFiles, undefined);
    assert.equal(linux.afterSign, undefined);
    assert.equal(win.afterSign, undefined);
    // The macOS helper's Swift sources and HEADER.md exist for a source-build
    // fallback that only runs on macOS; a Windows or Linux artifact carrying
    // them ships compiler input for an OS it will never run on.
    assert.deepStrictEqual(linux.files, [...NON_MAC_FILES]);
    assert.deepStrictEqual(win.files, [...NON_MAC_FILES]);
    assert.deepStrictEqual([...NON_MAC_FILES], ["**/*", "!apps/server/dist/computer-use-macos/**"]);
    assert.deepStrictEqual(linux.asarUnpack, ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(linux.linux, {
      target: ["AppImage"],
      executableName: "synara",
      icon: "icon.png",
      category: "Development",
      desktop: {
        entry: {
          StartupWMClass: "synara",
        },
      },
    });

    assert.equal(win.mac, undefined);
    assert.equal(win.extraFiles, undefined);
    assert.deepStrictEqual(win.asarUnpack, ["node_modules/node-pty/**"]);
    assert.equal(WINDOWS_INSTALLER_GUID, "368107a8-afe6-5db5-ab3b-d4f331684868");
    assert.deepStrictEqual(win.nsis, {
      guid: WINDOWS_INSTALLER_GUID,
    });
    assert.deepStrictEqual(win.win, {
      target: ["nsis"],
      icon: "icon.ico",
      publisherName: "Synara",
      azureSignOptions: { publisherName: "Synara" },
    });
  });

  it("omits Azure signing options for unsigned build-only artifacts", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "win",
      target: "nsis",
    });

    assert.deepStrictEqual(config.win, {
      target: ["nsis"],
      icon: "icon.ico",
    });
  });

  it("keeps node-pty unpacked from ASAR in generated build config", () => {
    const config = createDesktopPlatformBuildConfig({
      platform: "linux",
      target: "AppImage",
    });

    assert.deepStrictEqual([...NODE_PTY_ASAR_UNPACK_GLOBS], ["node_modules/node-pty/**"]);
    assert.deepStrictEqual(config.asarUnpack, [...NODE_PTY_ASAR_UNPACK_GLOBS]);
  });

  it("blocks unsupported or non-matching Linux native build hosts", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "x64",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      null,
    );

    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "linux",
        arch: "universal",
        hostPlatform: "linux",
        hostArch: "x64",
      }),
      "Linux desktop artifacts support x64 or arm64 builds, not universal builds.",
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "linux",
      arch: "x64",
      hostPlatform: "darwin",
      hostArch: "arm64",
    });

    assert.ok(issue?.includes("Build linux/x64 on a matching Linux host"));
  });

  it("requires a macOS host for the native Swift AppSnap helper", () => {
    assert.equal(
      validateDesktopNativeBuildHost({
        platform: "mac",
        arch: "universal",
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
      null,
    );

    const issue = validateDesktopNativeBuildHost({
      platform: "mac",
      arch: "arm64",
      hostPlatform: "linux",
      hostArch: "arm64",
    });
    assert.ok(issue?.includes("Build mac/arm64 on macOS"));
  });

  it("derives the computer-use helper's bundle identifier from the app's own", async () => {
    // One source. The helper's TCC grants live under this identifier, and the
    // packaging config, the Node build script and the Swift helper each used to
    // spell a piece of it out by hand.
    assert.equal(
      COMPUTER_HELPER_BUNDLE_IDENTIFIER,
      `${SYNARA_PRODUCTION_BUNDLE_ID}.computer-use-helper`,
    );
    // `build-computer-helper.mjs` writes the helper's Info.plist under plain
    // `node` and cannot import the TypeScript constant, so it re-derives the
    // identifier. The two derivations must agree.
    const { computerHelperBundleIdentifier } = await loadComputerHelperBuildScript();
    assert.equal(computerHelperBundleIdentifier, COMPUTER_HELPER_BUNDLE_IDENTIFIER);
  });

  it("keeps the Swift helper's self-recognition guard on Synara's real bundle ID", () => {
    // Windows.swift refuses to drive any window owned by Synara itself by
    // matching this prefix. A rebrand that moved SYNARA_PRODUCTION_BUNDLE_ID
    // without it would leave the agent able to click on Synara's own UI, so the
    // Swift literal is pinned here rather than trusted to stay in step.
    const windowsSwift = readFileSync(
      join(import.meta.dirname, "../apps/server/native/computer-use-macos/Sources/Windows.swift"),
      "utf8",
    );
    const hostBundlePrefix = /hostBundlePrefix\s*=\s*"([^"]+)"/.exec(windowsSwift)?.[1];
    assert.equal(hostBundlePrefix, SYNARA_PRODUCTION_BUNDLE_ID);
  });

  it("keeps separate macOS sources for solid and rounded icons", () => {
    assert.equal(BRAND_ASSET_PATHS.productionMacIconPng, "assets/prod/black-macos-1024.png");
    assert.equal(
      BRAND_ASSET_PATHS.productionMacLegacyIconPng,
      "assets/prod/black-macos-legacy-1024.png",
    );
  });
});
