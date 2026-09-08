// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

import computerHelperBundle from "@synara/shared/computerHelperBundle" with { type: "json" };
import {
  COMPUTER_HELPER_BUNDLE_NAME,
  COMPUTER_HELPER_PACKAGED_BUNDLE_PATH,
  COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH,
  COMPUTER_HELPER_SOURCE_DIR_NAME,
} from "@synara/shared/computerHelperPaths";

export const MICROPHONE_USAGE_DESCRIPTION =
  "Synara needs microphone access so you can record voice notes and transcribe them into the chat composer.";
/**
 * Shared with the helper bundle's own Info.plist, which the build script writes
 * from the same JSON. macOS shows whichever plist belongs to the process that
 * asks, so the two must not drift into telling the user different things.
 */
export const SCREEN_RECORDING_USAGE_DESCRIPTION =
  computerHelperBundle.screenRecordingUsageDescription;
/**
 * The oldest macOS the app declares support for.
 *
 * Read from the helper manifest rather than written twice: the Swift helper is
 * built against a `macosx12.3` target because ScreenCaptureKit needs 12.3, and
 * an app that installs on 12.0 ships a helper that cannot launch there. One
 * number, and `probeAvailability` uses the same one as its floor.
 */
export const MAC_MINIMUM_SYSTEM_VERSION = computerHelperBundle.minimumMacosVersion;
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
/**
 * The entitlements the nested computer-use helper is re-signed against — an
 * empty dict. See the plist's own comment and `scripts/lib/mac-after-sign.cjs`.
 */
export const MAC_HELPER_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.helper.plist";
/** Where `build-desktop-artifact.ts` stages the `afterSign` hook inside the app stage. */
export const MAC_AFTER_SIGN_HOOK_DIR = "build-hooks";
export const MAC_AFTER_SIGN_HOOK_PATH = `${MAC_AFTER_SIGN_HOOK_DIR}/mac-after-sign.cjs`;
export const MAC_AFTER_SIGN_CONFIG_PATH = `${MAC_AFTER_SIGN_HOOK_DIR}/mac-after-sign.json`;
/** electron-builder resolves hook modules relative to the project dir and requires a `./` prefix. */
export const MAC_AFTER_SIGN_HOOK_REFERENCE = `./${MAC_AFTER_SIGN_HOOK_PATH}`;
export const MAC_AFTER_SIGN_HOOK_ASAR_EXCLUSION = `!${MAC_AFTER_SIGN_HOOK_DIR}/**`;
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
/** Where a packaged `Synara.app` keeps its native helpers. */
export const MAC_HELPERS_BUNDLE_DIR = "Contents/Helpers";
export const MAC_APPSNAP_HELPER_NAME = "synara-appsnap-helper";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = `${MAC_HELPERS_BUNDLE_DIR}/${MAC_APPSNAP_HELPER_NAME}`;
export const MAC_COMPUTER_HELPER_STAGE_DIR = "apps/desktop/native/computer-use/build";
export const MAC_COMPUTER_HELPER_STAGE_PATH = `${MAC_COMPUTER_HELPER_STAGE_DIR}/${COMPUTER_HELPER_BUNDLE_NAME}`;
export const MAC_COMPUTER_HELPER_ASAR_EXCLUSION = `!${MAC_COMPUTER_HELPER_STAGE_DIR}/**`;
export const MAC_COMPUTER_HELPER_BUNDLE_PATH = COMPUTER_HELPER_PACKAGED_BUNDLE_PATH;
export const MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH = COMPUTER_HELPER_PACKAGED_EXECUTABLE_PATH;
/**
 * The helper's Swift sources, staged beside the app rather than inside
 * `app.asar`.
 *
 * `apps/server/scripts/cli.ts` copies them into `dist` so the server's
 * source-build fallback survives packaging, but an archive is not a directory a
 * compiler can read: inside the asar the sources are visible to `stat` and
 * useless to `build.sh`, which is worse than absent because the fallback then
 * fails at compile time instead of declining up front. Staged here they are a
 * real directory the fallback can actually build, for the one case that needs
 * it — a shipped helper bundle lost to quarantine or a broken signature.
 */
export const MAC_COMPUTER_HELPER_SOURCES_STAGE_PATH = `apps/server/dist/${COMPUTER_HELPER_SOURCE_DIR_NAME}`;
export const MAC_COMPUTER_HELPER_SOURCES_RESOURCE_PATH = `Resources/${COMPUTER_HELPER_SOURCE_DIR_NAME}`;
export const MAC_COMPUTER_HELPER_SOURCES_ASAR_EXCLUSION = `!${MAC_COMPUTER_HELPER_SOURCES_STAGE_PATH}/**`;
/**
 * The one `x64ArchFiles` pattern for both Swift helpers. @electron/universal
 * takes a single glob, so the two paths are brace-expanded into it; both halves
 * are relative to `Contents/Helpers`, which is why the shared prefix is lifted
 * out rather than repeated.
 */
export const MAC_HELPER_X64_ARCH_FILES = [
  `${MAC_HELPERS_BUNDLE_DIR}/{`,
  [MAC_APPSNAP_HELPER_BUNDLE_PATH, MAC_COMPUTER_HELPER_EXECUTABLE_BUNDLE_PATH]
    .map((bundlePath) => bundlePath.slice(`${MAC_HELPERS_BUNDLE_DIR}/`.length))
    .join(","),
  "}",
].join("");

export const MAC_DEVICE_HELPER_STAGE_PATH = "apps/server/dist/device-helper";
export const MAC_DEVICE_HELPER_RESOURCE_PATH = "Resources/device-helper";
/**
 * The device helper's sources are staged under `Resources/device-helper` by
 * `extraFiles`, and the desktop points the backend at exactly that copy
 * (`DEVICE_HELPER_SOURCE_DIR_ENV`). Left in the asar as well they were shipped
 * twice — once as a directory a compiler can read and once inside an archive
 * where nothing can — for no gain but the bytes.
 */
export const MAC_DEVICE_HELPER_ASAR_EXCLUSION = `!${MAC_DEVICE_HELPER_STAGE_PATH}/**`;
/**
 * The macOS computer-use helper's Swift sources and its `HEADER.md` exist for
 * the source-build fallback, which is macOS-only. A Windows or Linux artifact
 * carrying them ships a compiler input for an OS it will never run on.
 */
export const NON_MAC_FILES = ["**/*", MAC_COMPUTER_HELPER_SOURCES_ASAR_EXCLUSION] as const;
export const WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;

export interface DesktopPlatformBuildConfig {
  /** electron-builder hook module, relative to the staged project directory. */
  readonly afterSign?: string;
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly dmg?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly platform: "linux" | "mac" | "win";
  readonly target: string;
  /**
   * Sign the artifact with whatever identity is discoverable (`CSC_NAME`,
   * `CSC_LINK`, or the login keychain). Independent of `notarize`: a locally
   * signed build wants a stable designated requirement so TCC grants survive a
   * rebuild, and has no Developer ID to notarize with.
   */
  readonly signed?: boolean;
  readonly macSigningIdentity?: string;
  readonly windowsAzureSignOptions?: Record<string, string>;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include native Swift AppSnap and computer-use helpers.",
      `Build mac/${input.arch} on macOS so the helpers can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const nativePackaging = { asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS] };

  if (input.platform === "mac") {
    const mac = {
      target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
      icon: MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      hardenedRuntime: input.signed === true,
      // Even a local build needs a sealed app with Synara's bundle identity.
      // Skipping signing leaves Electron's linker signature behind; TCC then
      // treats the executable as a path and cannot grant the app Accessibility.
      ...(input.macSigningIdentity
        ? { identity: input.macSigningIdentity }
        : input.signed === true
          ? {}
          : { identity: "-" }),
      // Never electron-builder's, on any build. `notarizeIfProvided` runs
      // inside its signing step, i.e. before `afterSign`, and the hook re-signs
      // the nested helper and re-seals the app there — so a ticket stapled by
      // electron-builder would describe a code directory hash the shipped app
      // no longer has. The hook submits instead, once the app is final; whether
      // it does so at all is carried in its own JSON sidecar, which is why
      // notarization is not a parameter of this function.
      notarize: false,
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      // The AppSnap helper is a bare executable; the computer-use helper is an
      // app bundle, and a bundle is the unit macOS signs and TCC identifies, so
      // that is what is named here rather than the executable buried in it.
      // @electron/osx-sign walks the packaged `Contents/` and already collects
      // nested `.app` directories, so this is a statement of intent more than a
      // discovery mechanism — `assertPackagedMacComputerHelper` is what proves
      // the signature actually landed.
      binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH, MAC_COMPUTER_HELPER_BUNDLE_PATH],
      // The universal build stages the same pre-lipo'd helpers in both app trees.
      // @electron/universal needs this pattern to preserve those existing fat
      // binaries. Composed from the same constants the paths above use so a
      // bundle rename cannot leave the glob pointing at the old name.
      x64ArchFiles: MAC_HELPER_X64_ARCH_FILES,
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
        NSScreenCaptureUsageDescription: SCREEN_RECORDING_USAGE_DESCRIPTION,
      },
    } satisfies Record<string, unknown>;

    return {
      ...nativePackaging,
      // Strips the inherited entitlements from `Contents/Helpers/<helper>.app`,
      // re-seals the app around the new helper signature, and — because that
      // re-seal happens after electron-builder's own notarization point —
      // performs the notarization too.
      afterSign: MAC_AFTER_SIGN_HOOK_REFERENCE,
      dmg: {
        sign: input.signed === true,
        // The signed release flow notarizes and staples the DMG after electron-builder exits.
        // Do not emit a blockmap/update entry whose hashes would describe the pre-stapled image;
        // macOS auto-updates use the separately finalized ZIP artifact.
        writeUpdateInfo: false,
      },
      files: [
        "**/*",
        MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
        MAC_COMPUTER_HELPER_ASAR_EXCLUSION,
        MAC_COMPUTER_HELPER_SOURCES_ASAR_EXCLUSION,
        MAC_DEVICE_HELPER_ASAR_EXCLUSION,
        MAC_AFTER_SIGN_HOOK_ASAR_EXCLUSION,
      ],
      extraFiles: [
        {
          from: MAC_APPSNAP_HELPER_STAGE_PATH,
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
      ],
      mac,
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      files: [...NON_MAC_FILES],
      linux: {
        target: [input.target],
        executableName: "synara",
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "synara",
          },
        },
      },
    };
  }

  return {
    ...nativePackaging,
    files: [...NON_MAC_FILES],
    // Keep the Windows product registration stable while the public app ID changes.
    // This lets NSIS updates replace the existing installation and own its uninstaller.
    nsis: {
      guid: WINDOWS_INSTALLER_GUID,
    },
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions
        ? {
            publisherName: input.windowsAzureSignOptions.publisherName,
            azureSignOptions: input.windowsAzureSignOptions,
          }
        : {}),
    },
  };
}
