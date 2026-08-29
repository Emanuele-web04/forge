import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  disableGitHooksForInvocationArgs,
  gitHardenedConfigEnvironment,
  hardenGitInvocationArgs,
} from "./gitInvocationSecurity.ts";

function readFsmonitor(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", [...args, "config", "--get", "core.fsmonitor"], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

describe("Git invocation security", () => {
  it("disables repository hooks for a single managed invocation", () => {
    expect(disableGitHooksForInvocationArgs(["worktree", "add", "/tmp/example"])).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "/tmp/example",
    ]);
  });

  it("overrides a repository-configured fsmonitor for direct Git commands", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "synara-git-security-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd });
      execFileSync("git", ["config", "core.fsmonitor", "malicious-monitor"], { cwd });

      expect(readFsmonitor(cwd, hardenGitInvocationArgs([]))).toBe("false");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies the same override to descendant Git commands through the environment", () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "synara-git-security-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd });
      execFileSync("git", ["config", "core.fsmonitor", "malicious-monitor"], { cwd });

      expect(readFsmonitor(cwd, [], gitHardenedConfigEnvironment())).toBe("false");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("appends to inherited Git configuration environment entries", () => {
    expect(
      gitHardenedConfigEnvironment({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/repo",
      }),
    ).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
  });
});
