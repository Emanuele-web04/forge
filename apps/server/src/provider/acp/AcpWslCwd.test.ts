// FILE: AcpWslCwd.test.ts
// Purpose: Verifies ACP protocol cwd normalization for WSL workspaces.
// Layer: Provider ACP runtime tests

import { describe, expect, it } from "vitest";

import { resolveAcpSessionCwd } from "./AcpSessionRuntime.ts";

describe("resolveAcpSessionCwd", () => {
  it("converts modern WSL UNC paths to Linux paths on Windows", () => {
    expect(
      resolveAcpSessionCwd("\\\\wsl.localhost\\Ubuntu-24.04\\home\\dev\\synara", "win32"),
    ).toBe("/home/dev/synara");
  });

  it("converts legacy wsl$ UNC paths to Linux paths on Windows", () => {
    expect(resolveAcpSessionCwd("\\\\wsl$\\Debian\\home\\dev\\repo", "win32")).toBe(
      "/home/dev/repo",
    );
  });

  it("keeps ordinary Windows workspaces unchanged", () => {
    expect(resolveAcpSessionCwd("C:\\src\\synara", "win32")).toBe("C:\\src\\synara");
  });

  it("does not reinterpret WSL-looking strings on non-Windows hosts", () => {
    const cwd = "\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo";
    expect(resolveAcpSessionCwd(cwd, "linux")).toBe(cwd);
  });
});
