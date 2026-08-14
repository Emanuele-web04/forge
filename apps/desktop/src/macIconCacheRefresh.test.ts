import { describe, expect, it } from "vitest";

import {
  parseLastLaunchVersion,
  resolveLaunchVersionRecordPath,
  resolveMacAppBundlePath,
  serializeLaunchVersionRecord,
  shouldRefreshIconCache,
} from "./macIconCacheRefresh";

describe("resolveLaunchVersionRecordPath", () => {
  it("places the record file inside the userData directory", () => {
    expect(resolveLaunchVersionRecordPath("/home/me/AppData/Synara")).toBe(
      "/home/me/AppData/Synara/last-launch-version.json",
    );
  });
});

describe("parseLastLaunchVersion", () => {
  it("returns null for a missing record", () => {
    expect(parseLastLaunchVersion(null)).toBeNull();
  });

  it("reads the version from a well-formed record", () => {
    expect(parseLastLaunchVersion('{"version":"0.3.4"}')).toBe("0.3.4");
  });

  it("round-trips with serializeLaunchVersionRecord", () => {
    expect(parseLastLaunchVersion(serializeLaunchVersionRecord("1.2.3"))).toBe("1.2.3");
  });

  it("returns null for corrupt JSON", () => {
    expect(parseLastLaunchVersion("{ not json")).toBeNull();
  });

  it("returns null when version is missing or not a string", () => {
    expect(parseLastLaunchVersion("{}")).toBeNull();
    expect(parseLastLaunchVersion('{"version":42}')).toBeNull();
    expect(parseLastLaunchVersion("null")).toBeNull();
    expect(parseLastLaunchVersion('"0.3.4"')).toBeNull();
  });
});

describe("shouldRefreshIconCache", () => {
  it("refreshes when the version changed across launches", () => {
    expect(shouldRefreshIconCache("0.3.3", "0.3.4")).toBe(true);
  });

  it("treats a missing previous record as a change (covers the rollout)", () => {
    expect(shouldRefreshIconCache(null, "0.3.4")).toBe(true);
  });

  it("does nothing when the version is unchanged", () => {
    expect(shouldRefreshIconCache("0.3.4", "0.3.4")).toBe(false);
  });
});

describe("resolveMacAppBundlePath", () => {
  it("resolves the .app bundle from the Electron executable on macOS", () => {
    expect(
      resolveMacAppBundlePath("/Applications/Synara.app/Contents/MacOS/Synara", "darwin"),
    ).toBe("/Applications/Synara.app");
  });

  it("returns null off macOS", () => {
    expect(
      resolveMacAppBundlePath("/Applications/Synara.app/Contents/MacOS/Synara", "linux"),
    ).toBeNull();
  });

  it("returns null when the executable is not inside a .app bundle", () => {
    expect(resolveMacAppBundlePath("/usr/local/bin/synara", "darwin")).toBeNull();
  });
});
