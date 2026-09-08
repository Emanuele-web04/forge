import { describe, expect, it } from "vitest";

import { spawnClipboardCommand, type ClipboardCommandSpec } from "./wlClipboard.ts";

/**
 * The process primitive is exercised against real children, because everything
 * it has to get right — a forking child that keeps stderr open, a kill on the
 * output cap, a kill on the deadline — only happens with real pipes. Node runs
 * the children so the suite depends on nothing but the runtime it already has.
 */
function node(source: string, options: Partial<ClipboardCommandSpec> = {}) {
  return spawnClipboardCommand({
    command: process.execPath,
    args: ["-e", source],
    ...options,
  });
}

describe("spawnClipboardCommand", () => {
  it("collects output and the exit status of a command that does not fork", async () => {
    await expect(
      node("process.stdout.write('paste me'); process.stderr.write('noise'); process.exit(3)"),
    ).resolves.toEqual({ outcome: "exited", code: 3, stdout: "paste me", stderr: "noise" });
  });

  it("feeds the payload through stdin", async () => {
    const input = "line one\nline two";
    await expect(node("process.stdin.pipe(process.stdout)", { input })).resolves.toMatchObject({
      outcome: "exited",
      code: 0,
      stdout: input,
    });
  });

  /**
   * wl-copy forks a child that serves the selection and inherits stderr, so the
   * pipes stay open long after the parent is gone. Waiting for them would pin
   * the turn until the next clipboard change.
   */
  it("resolves on parent exit when the command leaves a child holding stderr", async () => {
    const started = Date.now();
    const result = await node(
      "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: ['ignore', 'ignore', 2] }); child.unref(); process.exit(0);",
      { forks: true },
    );
    expect(result).toMatchObject({ outcome: "exited", code: 0 });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("kills a command that passes the output cap", async () => {
    await expect(
      node("process.stdout.write('a'.repeat(64)); setTimeout(() => {}, 4000);", {
        maxOutputBytes: 8,
      }),
    ).resolves.toMatchObject({ outcome: "output-limit" });
  });

  it("kills a command that outlives the deadline", async () => {
    await expect(node("setTimeout(() => {}, 4000)", { timeoutMs: 50 })).resolves.toMatchObject({
      outcome: "timed-out",
      code: null,
    });
  });

  it("rejects with the spawn error when the binary is missing", async () => {
    await expect(
      spawnClipboardCommand({ command: "synara-absent-clipboard-binary", args: [] }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
