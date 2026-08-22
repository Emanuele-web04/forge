import { afterEach, assert, describe, it, vi } from "vitest";

import {
  getNavigatorPlatform,
  isLinuxPlatform,
  isMacNavigatorPlatform,
  isMacPlatform,
  isWindowsPlatform,
} from "./utils";

describe("isMacPlatform", () => {
  it("matches browser and Node.js macOS platform identifiers", () => {
    assert.isTrue(isMacPlatform("MacIntel"));
    assert.isTrue(isMacPlatform("darwin"));
  });

  it("does not match Windows or Linux", () => {
    assert.isFalse(isMacPlatform("Win32"));
    assert.isFalse(isMacPlatform("Linux x86_64"));
  });
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("isLinuxPlatform", () => {
  it("matches Linux platform identifiers", () => {
    assert.isTrue(isLinuxPlatform("Linux x86_64"));
    assert.isTrue(isLinuxPlatform("linux"));
  });

  it("does not match macOS or Windows", () => {
    assert.isFalse(isLinuxPlatform("MacIntel"));
    assert.isFalse(isLinuxPlatform("Win32"));
  });
});

describe("navigator platform helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the host platform, falling back to an empty string without a navigator", () => {
    vi.stubGlobal("navigator", undefined);
    assert.equal(getNavigatorPlatform(), "");

    vi.stubGlobal("navigator", { platform: "MacIntel" });
    assert.equal(getNavigatorPlatform(), "MacIntel");
  });

  it("detects macOS hosts, including the Node.js-style identifier", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    assert.isTrue(isMacNavigatorPlatform());

    vi.stubGlobal("navigator", { platform: "darwin" });
    assert.isTrue(isMacNavigatorPlatform());
  });

  it("is false on other hosts and without a navigator", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    assert.isFalse(isMacNavigatorPlatform());

    vi.stubGlobal("navigator", undefined);
    assert.isFalse(isMacNavigatorPlatform());
  });
});
