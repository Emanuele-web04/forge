// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const SYNARA_DESKTOP_SCHEME = "synara";
export const SYNARA_DESKTOP_ORIGIN = `${SYNARA_DESKTOP_SCHEME}://app`;
export const SYNARA_DESKTOP_ENTRY_URL = `${SYNARA_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_DESKTOP_UPDATE_CHANNEL = "synara";
export const SYNARA_PRODUCTION_BUNDLE_ID = "com.emanueledipietro.synara";
export const SYNARA_DEVELOPMENT_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.dev`;
export const SYNARA_CANARY_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.canary`;
export const SYNARA_CANARY_DESKTOP_SCHEME = "synara-canary";
export const SYNARA_CANARY_DESKTOP_ORIGIN = `${SYNARA_CANARY_DESKTOP_SCHEME}://app`;
export const SYNARA_CANARY_DESKTOP_ENTRY_URL = `${SYNARA_CANARY_DESKTOP_ORIGIN}/index.html`;
export const SYNARA_SOURCE_DESKTOP_BUILD_MARKER = "synara-source-desktop-build-v2";
export const SYNARA_DESKTOP_SMOKE_USER_DATA_ENV = "SYNARA_DESKTOP_SMOKE_USER_DATA";

export type SynaraDesktopFlavor = "production" | "development" | "canary";

export interface SynaraDesktopIdentity {
  readonly flavor: SynaraDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveSynaraDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
  readonly allowDevelopmentOverride?: boolean | undefined;
}): SynaraDesktopFlavor {
  const requestedFlavor = input.requestedFlavor?.trim().toLowerCase();
  if (requestedFlavor === "canary") {
    return "canary";
  }
  if (
    requestedFlavor === "development" &&
    (input.isDevelopment || input.allowDevelopmentOverride === true)
  ) {
    return "development";
  }
  return input.isDevelopment ? "development" : "production";
}

export function synaraDesktopIdentity(flavor: SynaraDesktopFlavor): SynaraDesktopIdentity {
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: SYNARA_CANARY_DESKTOP_SCHEME,
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Synara (Dev)",
      bundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      scheme: SYNARA_DESKTOP_SCHEME,
      origin: SYNARA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-dev",
      defaultHomeDirectoryName: ".synara-dev",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "Synara",
    bundleId: SYNARA_PRODUCTION_BUNDLE_ID,
    scheme: SYNARA_DESKTOP_SCHEME,
    origin: SYNARA_DESKTOP_ORIGIN,
    entryUrl: SYNARA_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "synara",
    defaultHomeDirectoryName: ".synara",
    usesScriptedUpdates: false,
  };
}

export function synaraBundleId(isDevelopment: boolean): string {
  return synaraDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
