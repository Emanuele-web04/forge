import { describe, expect, it } from "vitest";

import { type AppSettings, AppSettingsSchema } from "~/appSettings";

import {
  createProviderInstallResetPatch,
  isProviderInstallSettingsDirty,
} from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});

describe("isProviderInstallSettingsDirty", () => {
  it("covers every provider install text and boolean field", () => {
    const dirtyPatches = [
      { codexBinaryPath: "/opt/codex" },
      { codexHomePath: "/tmp/codex-home" },
      { claudeBinaryPath: "/opt/claude" },
      { cursorBinaryPath: "/opt/cursor" },
      { cursorApiEndpoint: "https://cursor.example" },
      { devinBinaryPath: "/opt/devin" },
      { antigravityBinaryPath: "/opt/agy" },
      { grokBinaryPath: "/opt/grok" },
      { droidBinaryPath: "/opt/droid" },
      { openCodeBinaryPath: "/opt/opencode" },
      { openCodeServerUrl: "http://127.0.0.1:5001" },
      { openCodeExperimentalWebSockets: true },
      { piBinaryPath: "/opt/pi" },
      { piAgentDir: "/tmp/pi-agent" },
    ] satisfies ReadonlyArray<Partial<AppSettings>>;

    expect(isProviderInstallSettingsDirty(defaults, defaults)).toBe(false);
    for (const patch of dirtyPatches) {
      expect(isProviderInstallSettingsDirty({ ...defaults, ...patch }, defaults)).toBe(true);
    }
  });

  it("uses configured flags instead of unreadable password values", () => {
    expect(
      isProviderInstallSettingsDirty({ ...defaults, openCodeServerPassword: "secret" }, defaults),
    ).toBe(false);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, openCodeServerPasswordConfigured: true },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("createProviderInstallResetPatch", () => {
  it("resets every configured field and writes password values so configured flags clear", () => {
    const patch = createProviderInstallResetPatch({
      ...defaults,
      openCodeServerPassword: "",
    });

    expect(Object.keys(patch).sort()).toEqual(
      [
        "antigravityBinaryPath",
        "claudeBinaryPath",
        "codexBinaryPath",
        "codexHomePath",
        "cursorApiEndpoint",
        "cursorBinaryPath",
        "devinBinaryPath",
        "droidBinaryPath",
        "grokBinaryPath",
        "openCodeBinaryPath",
        "openCodeExperimentalWebSockets",
        "openCodeServerPassword",
        "openCodeServerUrl",
        "piAgentDir",
        "piBinaryPath",
      ].sort(),
    );
    expect(patch.openCodeServerPassword).toBe("");
  });
});
