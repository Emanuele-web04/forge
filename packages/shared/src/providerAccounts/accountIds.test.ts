import { describe, expect, it } from "vitest";

import {
  accountDirName,
  accountId,
  activePointerFileName,
  ordinalFromAccountDir,
  secretName,
  validateOrdinal,
} from "./accountIds";

describe("accountId", () => {
  it("joins provider and ordinal", () => {
    expect(accountId("codex", 3)).toBe("codex:3");
    expect(accountId("claudeAgent", 0)).toBe("claudeAgent:0");
  });

  it("rejects invalid ordinals", () => {
    expect(() => accountId("codex", -1)).toThrow(RangeError);
    expect(() => accountId("codex", 1.5)).toThrow(RangeError);
    expect(() => accountId("codex", Number.NaN)).toThrow(RangeError);
  });
});

describe("accountDirName", () => {
  it("stringifies the ordinal", () => {
    expect(accountDirName(7)).toBe("7");
  });
});

describe("activePointerFileName", () => {
  it("uses the provider name", () => {
    expect(activePointerFileName("codex")).toBe("codex");
    expect(activePointerFileName("grok")).toBe("grok");
  });
});

describe("secretName", () => {
  it("builds the provider-account secret name", () => {
    expect(secretName("codex", 3, "agent")).toBe("provider-account-codex-3-agent");
    expect(secretName("cursor", 2, "app")).toBe("provider-account-cursor-2-app");
  });
});

describe("ordinalFromAccountDir", () => {
  it("parses valid integer directory names", () => {
    expect(ordinalFromAccountDir("0")).toBe(0);
    expect(ordinalFromAccountDir("12")).toBe(12);
  });

  it("rejects malformed directory names", () => {
    expect(() => ordinalFromAccountDir("01")).toThrow(RangeError);
    expect(() => ordinalFromAccountDir("-1")).toThrow(RangeError);
    expect(() => ordinalFromAccountDir("1.5")).toThrow(RangeError);
    expect(() => ordinalFromAccountDir("abc")).toThrow(RangeError);
    expect(() => ordinalFromAccountDir("")).toThrow(RangeError);
  });
});

describe("validateOrdinal", () => {
  it("returns valid ordinals unchanged", () => {
    expect(validateOrdinal(0)).toBe(0);
    expect(validateOrdinal(42)).toBe(42);
  });
});
