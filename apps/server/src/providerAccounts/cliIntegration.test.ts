import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeCliIntegration } from "./cliIntegration";
import { makeDoctorReport } from "./doctorReport";
import { makeAccountStorage } from "./accountStorage";

const SHIM_NAMES = ["codex", "claude", "cursor-agent", "grok"];

describe("cliIntegration", () => {
  let root: string;
  let launcherEntry: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-cli-integration-"));
    mkdirSync(join(root, "launcher", "src"), { recursive: true });
    launcherEntry = join(root, "launcher", "src", "launcher.ts");
    writeFileSync(launcherEntry, "// launcher entry\n");
    writeFileSync(join(root, "launcher", "package.json"), JSON.stringify({ version: "1.2.3" }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const make = (options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) =>
    makeCliIntegration({
      root,
      launcherEntry,
      env: options?.env ?? { PATH: "" },
      ...(options?.platform !== undefined ? { platform: options.platform } : {}),
    });

  it("installs executable shims for every provider plus a version file", async () => {
    const integration = make();
    const status = await Effect.runPromise(integration.install);
    expect(status.launcherInstalled).toBe(true);
    expect(status.cliIntegrationEnabled).toBe(true);
    expect(status.launcherVersion).toBeDefined();
    expect(status.launcherEntryExists).toBe(true);
    expect(status.platformSupported).toBe(true);
    for (const name of SHIM_NAMES) {
      const contents = readFileSync(join(root, "bin", name), "utf8");
      expect(contents).toContain("#!/bin/sh");
      expect(contents).toContain(launcherEntry);
    }
  });

  it("shims run the TypeScript source entry under bun", async () => {
    const integration = make();
    await Effect.runPromise(integration.install);
    const contents = readFileSync(join(root, "bin", "codex"), "utf8");
    expect(contents).toContain(`exec bun '${launcherEntry}'`);
  });

  it("shims run a packaged .mjs launcher bundle under node", async () => {
    mkdirSync(join(root, "packaged", "bin"), { recursive: true });
    const packagedEntry = join(root, "packaged", "bin", "launcher.mjs");
    writeFileSync(packagedEntry, "// bundled launcher\n");
    writeFileSync(join(root, "packaged", "package.json"), JSON.stringify({ version: "4.5.6" }));
    const integration = makeCliIntegration({
      root,
      launcherEntry: packagedEntry,
      env: { PATH: "" },
    });
    const status = await Effect.runPromise(integration.install);
    expect(status.launcherVersion).toBe("4.5.6");
    const contents = readFileSync(join(root, "bin", "codex"), "utf8");
    expect(contents).toContain(`exec node '${packagedEntry}'`);
  });

  it("uninstall removes every shim, the version file, and the bin directory", async () => {
    const integration = make();
    await Effect.runPromise(integration.install);
    const status = await Effect.runPromise(integration.uninstall);
    expect(status.launcherInstalled).toBe(false);
    for (const name of [...SHIM_NAMES, "launcher-version"]) {
      expect(existsSync(join(root, "bin", name))).toBe(false);
    }
    expect(existsSync(join(root, "bin"))).toBe(false);
  });

  it("refuses to install on Windows", async () => {
    const integration = make({ platform: "win32" });
    const failure = await Effect.runPromise(Effect.flip(integration.install));
    expect(failure.detail).toMatch(/not supported on Windows/);
    const status = await Effect.runPromise(integration.getStatus);
    expect(status.platformSupported).toBe(false);
  });

  it("fails installation when the launcher entry file is missing", async () => {
    rmSync(launcherEntry);
    const integration = make();
    const failure = await Effect.runPromise(Effect.flip(integration.install));
    expect(failure.cause).toMatchObject({
      message: expect.stringContaining("Launcher entry point not found"),
    });
  });

  it("reports a missing launcher entry after installation", async () => {
    const integration = make();
    await Effect.runPromise(integration.install);
    rmSync(launcherEntry);
    const status = await Effect.runPromise(integration.getStatus);
    expect(status.launcherInstalled).toBe(true);
    expect(status.launcherEntryExists).toBe(false);
  });

  it("detects whether the shim directory is on PATH", async () => {
    const shimDir = join(root, "bin");
    const onPath = make({ env: { PATH: [shimDir, "/usr/bin"].join(delimiter) } });
    await Effect.runPromise(onPath.install);
    expect((await Effect.runPromise(onPath.getStatus)).shimDirOnPath).toBe(true);
    const offPath = make({ env: { PATH: "/usr/bin" } });
    expect((await Effect.runPromise(offPath.getStatus)).shimDirOnPath).toBe(false);
  });

  it("lists shims shadowed by earlier PATH entries", async () => {
    const shimDir = join(root, "bin");
    const shadowDir = join(root, "shadow");
    mkdirSync(shadowDir);
    writeFileSync(join(shadowDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const integration = make({ env: { PATH: [shadowDir, shimDir].join(delimiter) } });
    await Effect.runPromise(integration.install);
    await expect(Effect.runPromise(integration.listShadowedShims)).resolves.toEqual(["codex"]);
    const wellOrdered = make({ env: { PATH: [shimDir, shadowDir].join(delimiter) } });
    await expect(Effect.runPromise(wellOrdered.listShadowedShims)).resolves.toEqual([]);
  });

  describe("doctor cli-integration check", () => {
    const doctorCheck = async (integration: ReturnType<typeof makeCliIntegration>) => {
      const storage = makeAccountStorage({ root: join(root, "account-root") });
      await Effect.runPromise(storage.ensureRoot);
      const report = await Effect.runPromise(
        makeDoctorReport({ storage, cliIntegration: integration }).generate,
      );
      return report.checks.find((entry) => entry.id === "cli-integration");
    };

    it("errors when the launcher entry is missing after installation", async () => {
      const integration = make();
      await Effect.runPromise(integration.install);
      rmSync(launcherEntry);
      const result = await doctorCheck(integration);
      expect(result?.status).toBe("error");
      expect(result?.detail).toContain("launcher entry point is missing");
    });

    it("warns when the shim directory is not on PATH", async () => {
      const integration = make({ env: { PATH: "/usr/bin" } });
      await Effect.runPromise(integration.install);
      const result = await doctorCheck(integration);
      expect(result?.status).toBe("warning");
      expect(result?.detail).toContain("not on PATH");
    });

    it("warns when a shim is shadowed by an earlier PATH entry", async () => {
      const shimDir = join(root, "bin");
      const shadowDir = join(root, "shadow");
      mkdirSync(shadowDir);
      writeFileSync(join(shadowDir, "grok"), "#!/bin/sh\n", { mode: 0o755 });
      const integration = make({ env: { PATH: [shadowDir, shimDir].join(delimiter) } });
      await Effect.runPromise(integration.install);
      const result = await doctorCheck(integration);
      expect(result?.status).toBe("warning");
      expect(result?.detail).toContain("grok");
    });

    it("reports ok when shims are installed, on PATH, and resolve first", async () => {
      const shimDir = join(root, "bin");
      const integration = make({ env: { PATH: shimDir } });
      await Effect.runPromise(integration.install);
      const result = await doctorCheck(integration);
      expect(result?.status).toBe("ok");
    });
  });
});
