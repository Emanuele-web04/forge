import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("server CLI", () => {
  it("exposes build, publish, and pack as supported subcommands", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["scripts/cli.ts", "--help"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });

    expect(stdout).toMatch(/^  build\s/m);
    expect(stdout).toMatch(/^  publish\s/m);
    expect(stdout).toMatch(/^  pack\s/m);
  });
});
