import { describe, expect, it } from "vitest";

import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it("reports live stdout and stderr chunks while retaining the final output", async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await runProcess(
      "node",
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      {
        onStdoutChunk: (chunk) => stdoutChunks.push(chunk),
        onStderrChunk: (chunk) => stderrChunks.push(chunk),
      },
    );

    expect(stdoutChunks.join("")).toBe("out");
    expect(stderrChunks.join("")).toBe("err");
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it("keeps output observers isolated from the child-process lifecycle", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('ok')"], {
      onStdoutChunk: () => {
        throw new Error("observer failed");
      },
    });

    expect(result.stdout).toBe("ok");
    expect(result.code).toBe(0);
  });

  it("rejects without spawning when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProcess("node", ["-e", "process.exit(99)"], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("terminates a running child on abort and clears its later timeout", async () => {
    const controller = new AbortController();
    const running = runProcess("node", ["-e", "setInterval(() => {}, 1_000)"], {
      signal: controller.signal,
      timeoutMs: 150,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    // Cross the original deadline: the cleared timeout must not produce a second failure or keep
    // the test process alive after the aborted child has closed.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it("keeps timeout failures distinct from explicit aborts", async () => {
    const timedOut = runProcess("node", ["-e", "setInterval(() => {}, 1_000)"], {
      timeoutMs: 30,
    });

    await expect(timedOut).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining("timed out"),
    });
  });

  it("keeps the timeout classification when abort arrives after the deadline", async () => {
    const controller = new AbortController();
    const outcome = runProcess("node", ["-e", "setInterval(() => {}, 1_000)"], {
      signal: controller.signal,
      timeoutMs: 30,
    }).catch((error: unknown) => error);

    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();

    expect(await outcome).toMatchObject({
      name: "Error",
      message: expect.stringContaining("timed out"),
    });
  });
});
