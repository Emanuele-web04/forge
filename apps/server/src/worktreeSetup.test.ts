import type { ProjectScript } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./processRunner.ts", () => ({
  runProcess: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

import { runProcess } from "./processRunner.ts";
import { findWorktreeSetupScript, runWorktreeSetupScript } from "./worktreeSetup.ts";

const scripts: ProjectScript[] = [
  {
    id: "test",
    name: "Test",
    command: "bun run test",
    icon: "test",
    runOnWorktreeCreate: false,
  },
  {
    id: "setup",
    name: "Setup",
    command: "bun install",
    icon: "configure",
    runOnWorktreeCreate: true,
  },
];

describe("worktree setup", () => {
  beforeEach(() => vi.mocked(runProcess).mockClear());

  it("selects and runs the configured setup script in the new worktree", async () => {
    expect(findWorktreeSetupScript(scripts)?.id).toBe("setup");

    await runWorktreeSetupScript(scripts, "/tmp/new-worktree");

    expect(runProcess).toHaveBeenCalledOnce();
    const [shell, args, options] = vi.mocked(runProcess).mock.calls[0]!;
    expect(shell.length).toBeGreaterThan(0);
    expect(args).toContain("bun install");
    expect(options).toMatchObject({ cwd: "/tmp/new-worktree" });
  });

  it("does not expose provider or Synara credentials to repository setup code", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-secret");
    vi.stubEnv("SYNARA_AUTH_TOKEN", "control-plane-secret");

    try {
      await runWorktreeSetupScript(scripts, "/tmp/new-worktree");

      const [, , options] = vi.mocked(runProcess).mock.calls[0]!;
      expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options?.env?.SYNARA_AUTH_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forwards the abort signal so interruption can kill the setup process", async () => {
    const controller = new AbortController();

    await runWorktreeSetupScript(scripts, "/tmp/new-worktree", controller.signal);

    const [, , options] = vi.mocked(runProcess).mock.calls[0]!;
    expect(options?.signal).toBe(controller.signal);
  });

  it("does nothing when no setup script is configured", async () => {
    await runWorktreeSetupScript(
      scripts.filter((script) => !script.runOnWorktreeCreate),
      "/tmp",
    );
    expect(runProcess).not.toHaveBeenCalled();
  });
});
