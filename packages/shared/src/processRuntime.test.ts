import { describe, expect, it } from "vitest";

import { spawnProcess } from "./processRuntime";

function run(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawnProcess(process.execPath, args, {
    stdio: "pipe",
    requireExecutable: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("processRuntime", () => {
  it("runs a normal process and preserves UTF-8 stdout/stderr", async () => {
    await expect(
      run(["-e", "process.stdout.write('ok 日本語'); process.stderr.write('diagnostic €')"]),
    ).resolves.toEqual({ stdout: "ok 日本語", stderr: "diagnostic €", code: 0 });
  });

  it("reports the real non-zero exit code without a shell wrapper", async () => {
    await expect(run(["-e", "process.exit(7)"])).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 7,
    });
  });
});
