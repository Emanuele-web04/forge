import { describe, expect, it } from "vitest";
import { isMindSecret } from "./secretPatterns";

describe("Mind secret guard", () => {
  it.each([
    "api_key=abcdefgh12345678",
    "AKIAABCDEFGHIJKLMNOP",
    "ASIAABCDEFGHIJKLMNOP",
    "eyJabc.eyJdef.abcdefgh",
    "ghp_abcdefgh12345678",
    "xoxb-abcdefgh12345678",
    "-----BEGIN PRIVATE KEY-----",
    "0x" + "a".repeat(64),
    'password="abcdefgh1234"',
  ])("detects %s on repeated calls", (text) => {
    expect(isMindSecret(text)).toBe(true);
    expect(isMindSecret(text)).toBe(true);
  });
  it.each([
    "password must be at least eight characters",
    "Bearer authentication uses a long token",
    "api_key=YOUR_API_KEY",
  ])("allows documentation text %s repeatedly", (text) => {
    expect(isMindSecret(text)).toBe(false);
    expect(isMindSecret(text)).toBe(false);
  });
});
