import { describe, expect, it } from "vitest";

import { quotePosixShellArgument, quotePosixShellCommand } from "./posixShell";

describe("quotePosixShellArgument", () => {
  it("returns empty single quotes for an empty string", () => {
    expect(quotePosixShellArgument("")).toBe("''");
  });

  it("leaves safe tokens unquoted", () => {
    expect(quotePosixShellArgument("project")).toBe("project");
    expect(quotePosixShellArgument("/Users/dev/code/my-project")).toBe(
      "/Users/dev/code/my-project",
    );
    expect(quotePosixShellArgument("a_b.c-d/e+f@g%h:i,j=k")).toBe("a_b.c-d/e+f@g%h:i,j=k");
  });

  it("wraps tokens with whitespace in single quotes", () => {
    expect(quotePosixShellArgument("/Users/dev/My Code/proj")).toBe("'/Users/dev/My Code/proj'");
  });

  it("wraps tokens that contain shell metacharacters", () => {
    expect(quotePosixShellArgument("foo;rm -rf /")).toBe("'foo;rm -rf /'");
    expect(quotePosixShellArgument("a$(echo b)")).toBe("'a$(echo b)'");
    expect(quotePosixShellArgument("a&b|c")).toBe("'a&b|c'");
    expect(quotePosixShellArgument("a*b?c[d]")).toBe("'a*b?c[d]'");
  });

  it("escapes embedded single quotes using the close/escape/open idiom", () => {
    expect(quotePosixShellArgument("it's")).toBe(`'it'\\''s'`);
    expect(quotePosixShellArgument("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });

  it("preserves unicode characters inside single quotes", () => {
    expect(quotePosixShellArgument("/Users/dev/项目")).toBe("'/Users/dev/项目'");
  });
});

describe("quotePosixShellCommand", () => {
  it("joins an argv into a shell word list", () => {
    expect(quotePosixShellCommand(["ls", "-la", "/var/log"])).toBe("ls -la /var/log");
  });

  // This is the invariant `ssh host <command>` depends on: every argv element
  // must stay exactly one token on the far side, however hostile its content.
  it.each([
    ["a separator", "a; rm -rf /"],
    ["a substitution", "$(id)"],
    ["a backtick", "`id`"],
    ["a pipe", "a|b"],
    ["a newline", "a\nb"],
    ["a space", "my file"],
    ["a glob", "*"],
    ["a variable", "$HOME"],
  ])("keeps %s as a single token", (_label, hostile) => {
    const encoded = quotePosixShellCommand(["cat", hostile]);
    expect(encoded.slice("cat ".length)).toMatch(/^'(?:[^']|'\\'')*'$/);
  });

  it("encodes an empty argument as an explicit empty token", () => {
    expect(quotePosixShellCommand(["cmd", ""])).toBe("cmd ''");
  });

  // Mutation guard: an empty argv would encode to an empty string, which `ssh`
  // turns into an interactive login shell rather than a no-op.
  it("refuses an empty argv rather than producing an empty command", () => {
    expect(() => quotePosixShellCommand([])).toThrow(/empty argv/);
  });
});
