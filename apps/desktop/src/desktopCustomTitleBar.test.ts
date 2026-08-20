import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCustomTitleBarPreference,
  readCustomTitleBarPreference,
  resolveDesktopCustomTitleBarState,
  resolveDesktopTitleBarFrameOptions,
  writeCustomTitleBarPreference,
} from "./desktopCustomTitleBar";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseCustomTitleBarPreference", () => {
  it("accepts versioned boolean payloads and rejects malformed ones", () => {
    expect(parseCustomTitleBarPreference({ version: 1, enabled: true })).toEqual({
      version: 1,
      enabled: true,
    });
    expect(parseCustomTitleBarPreference({ version: 1, enabled: false })).toEqual({
      version: 1,
      enabled: false,
    });
    expect(parseCustomTitleBarPreference({ version: 2, enabled: true })).toBeNull();
    expect(parseCustomTitleBarPreference({ enabled: true })).toBeNull();
    expect(parseCustomTitleBarPreference(null)).toBeNull();
  });
});

describe("custom title bar preference filesystem", () => {
  it("round-trips the preference and returns null for missing files", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-title-bar-"));
    temporaryDirectories.push(directory);
    const filePath = Path.join(directory, "nested", "custom-title-bar.json");

    expect(readCustomTitleBarPreference(filePath)).toBeNull();

    writeCustomTitleBarPreference(filePath, false);
    expect(readCustomTitleBarPreference(filePath)).toBe(false);

    writeCustomTitleBarPreference(filePath, true);
    expect(readCustomTitleBarPreference(filePath)).toBe(true);
  });
});

describe("resolveDesktopTitleBarFrameOptions", () => {
  it("returns frameless options when the preference resolves active", () => {
    expect(resolveDesktopTitleBarFrameOptions({ platform: "linux", preference: true })).toEqual({
      frame: false,
    });
    expect(resolveDesktopTitleBarFrameOptions({ platform: "win32", preference: null })).toEqual({
      frame: false,
    });
  });

  it("returns an empty object for native frames", () => {
    expect(resolveDesktopTitleBarFrameOptions({ platform: "linux", preference: false })).toEqual(
      {},
    );
    expect(resolveDesktopTitleBarFrameOptions({ platform: "darwin", preference: true })).toEqual(
      {},
    );
  });
});

describe("resolveDesktopCustomTitleBarState", () => {
  it("marks restart required when preference and active diverge", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "linux",
        preference: true,
        active: false,
      }),
    ).toEqual({
      supported: true,
      preference: true,
      active: false,
      restartRequired: true,
    });
  });

  it("is unsupported on macOS", () => {
    expect(
      resolveDesktopCustomTitleBarState({
        platform: "darwin",
        preference: true,
        active: false,
      }),
    ).toEqual({
      supported: false,
      preference: false,
      active: false,
      restartRequired: false,
    });
  });
});
