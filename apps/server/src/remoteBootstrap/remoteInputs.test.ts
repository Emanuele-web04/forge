import { describe, expect, it } from "vitest";

import {
  containsControlCharacter,
  isValidReleaseId,
  isValidRemoteFileName,
  normalizeEnvironmentId,
  normalizeReleaseId,
  normalizeRemoteFileName,
} from "./remoteInputs";

describe("containsControlCharacter", () => {
  it.each([
    ["NUL", "\0"],
    ["a newline", "\n"],
    ["a carriage return", "\r"],
    ["a tab", "\t"],
    ["a vertical tab", "\v"],
    ["a form feed", "\f"],
    ["an escape", "\u001B"],
    ["DEL", "\u007F"],
  ])("detects %s", (_label, character) => {
    expect(containsControlCharacter(`/home/deploy/x${character}y`)).toBe(true);
  });

  it.each(["/home/deploy/.synara", "0.6.3-rc.1", "项目", "", " "])(
    "accepts %j as control-free",
    (value) => {
      expect(containsControlCharacter(value)).toBe(false);
    },
  );
});

describe("release id validation", () => {
  it.each(["0.6.3", "0.6.3-rc.1", "v1", "abc_123", "A-B.C"])("accepts %s", (value) => {
    expect(isValidReleaseId(value)).toBe(true);
    expect(normalizeReleaseId(` ${value} `)).toBe(value);
  });

  // Each of these is a distinct escape a mutation of the pattern would reopen.
  it.each([
    ["path traversal", ".."],
    ["nested traversal", "../../etc"],
    ["a bare dot", "."],
    ["a leading dot", ".hidden"],
    ["a path separator", "a/b"],
    ["a backslash", "a\\b"],
    ["a newline", "a\nb"],
    ["a carriage return", "a\rb"],
    ["a NUL byte", "a\0b"],
    ["a systemd specifier", "a%nb"],
    ["a shell metacharacter", "a;rm -rf /"],
    ["command substitution", "$(id)"],
    ["a space", "a b"],
    ["a quote", "a'b"],
    ["an empty string", ""],
    ["an over-long value", "a".repeat(65)],
  ])("refuses %s", (_label, value) => {
    expect(isValidReleaseId(value)).toBe(false);
    expect(() => normalizeReleaseId(value)).toThrow(/Invalid remote release id/);
  });

  it("refuses an embedded traversal that passes the character class", () => {
    expect(isValidReleaseId("a..b")).toBe(false);
  });
});

describe("normalizeRemoteFileName", () => {
  it.each(["node", "synara-server-0.6.3.tar.gz", "a", "v2_0.bin", "x".repeat(128)])(
    "accepts %j",
    (value) => {
      expect(isValidRemoteFileName(value)).toBe(true);
      expect(normalizeRemoteFileName(` ${value} `)).toBe(value);
    },
  );

  // Two distinct dangers: the value is joined onto a path, AND handed to tar as
  // an operand. A leading dash is a flag; a slash or `..` is an escape.
  it.each([
    ["a traversal", "../../../../tmp/pwned.tar.gz"],
    ["a bare traversal segment", ".."],
    ["a dot segment", "."],
    ["a path separator", "a/b"],
    ["an absolute path", "/etc/passwd"],
    ["a tar exec flag", "--checkpoint-action=exec=sh"],
    ["a tar to-command flag", "--to-command=sh"],
    ["a short flag", "-rf"],
    ["a leading dot", ".hidden"],
    ["a space", "a b"],
    ["a quote", "a'b"],
    ["a double quote", 'a"b'],
    ["a newline", "a\nb"],
    ["a NUL byte", "a\0b"],
    ["command substitution", "$(id)"],
    ["a backtick", "`id`"],
    ["a variable", "$HOME"],
    ["a pipe", "a|b"],
    ["a semicolon", "a;b"],
    ["a non-ASCII character", "unicodé.tar.gz"],
    ["a bidi override", "‮gnp.exe"],
    ["an empty string", ""],
    ["an over-long value", "x".repeat(129)],
  ])("refuses %s", (_label, value) => {
    expect(isValidRemoteFileName(value)).toBe(false);
    expect(() => normalizeRemoteFileName(value)).toThrow(/Invalid remote artifact file name/);
  });

  it("refuses an embedded traversal that passes the character class", () => {
    expect(isValidRemoteFileName("a..b")).toBe(false);
  });
});

describe("normalizeEnvironmentId", () => {
  it("accepts a UUID and lowercases it", () => {
    expect(normalizeEnvironmentId(" 6F9D0C6E-7A1F-4D2B-9A3C-0E5D1B2C3D4E ")).toBe(
      "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e",
    );
  });

  // An empty id would make the handshake's identity comparison vacuous.
  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["an unhyphenated UUID", "6f9d0c6e7a1f4d2b9a3c0e5d1b2c3d4e"],
    ["a non-hex character", "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3dzz"],
    ["a truncated UUID", "6f9d0c6e-7a1f-4d2b-9a3c"],
    ["a traversal", "../../etc"],
    ["a trailing newline injection", "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e\nx"],
  ])("refuses %s", (_label, value) => {
    expect(() => normalizeEnvironmentId(value)).toThrow(/Invalid remote environment id/);
  });
});
