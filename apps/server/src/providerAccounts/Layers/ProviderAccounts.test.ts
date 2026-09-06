import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory";
import type { ProviderSessionDirectoryShape } from "../../provider/Services/ProviderSessionDirectory";
import { makeProviderAccounts } from "./ProviderAccounts";

const stubDirectory: ProviderSessionDirectoryShape = {
  upsert: () => Effect.void,
  getProvider: () => Effect.die("unused"),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
};

describe("ProviderAccounts live service", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-live-"));
    previousHome = process.env.SYNARA_ACCOUNT_HOME;
    process.env.SYNARA_ACCOUNT_HOME = root;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.SYNARA_ACCOUNT_HOME;
    } else {
      process.env.SYNARA_ACCOUNT_HOME = previousHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const makeService = () =>
    Effect.runPromise(
      makeProviderAccounts.pipe(Effect.provideService(ProviderSessionDirectory, stubDirectory)),
    );

  it("synthesizes the native account zero for every provider in the snapshot", async () => {
    const service = await makeService();
    const snapshot = await Effect.runPromise(service.getSnapshot);
    expect(snapshot.providers.map((entry) => entry.provider)).toEqual([
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
    ]);
    for (const entry of snapshot.providers) {
      expect(entry.activeOrdinal).toBe(0);
      expect(entry.accounts[0]).toMatchObject({
        ordinal: 0,
        agent: { state: "connected" },
      });
      expect(entry.capabilities.app.supportLevel).toBe("unsupported");
    }
  });

  it("keeps account zero first even alongside managed accounts", async () => {
    const service = await makeService();
    await Effect.runPromise(
      service.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "xai-test-1" }),
    );
    const snapshot = await Effect.runPromise(service.getSnapshot);
    const grok = snapshot.providers.find((entry) => entry.provider === "grok");
    expect(grok?.accounts.map((account) => account.ordinal)).toEqual([0, 1]);
    expect(grok?.activeOrdinal).toBe(1);
  });

  it("reports real CLI integration status instead of hard-coded stubs", async () => {
    const service = await makeService();
    const status = await Effect.runPromise(service.getIntegrationStatus);
    expect(status.shimDir).toBe(join(root, "bin"));
    expect(status.launcherInstalled).toBe(false);
    expect(typeof status.shimDirOnPath).toBe("boolean");
    expect(typeof status.launcherEntryExists).toBe("boolean");
    const doctor = await Effect.runPromise(service.getDoctorReport);
    expect(doctor.checks.some((check) => check.id === "cli-integration")).toBe(true);
  });

  it("surfaces an interrupted OAuth connect as failed after a service restart", async () => {
    // A pending directory with metadata left behind by a crashed process.
    const operationId = "11111111-2222-4333-8444-555555555555";
    const pendingDir = join(root, "pending", "codex", operationId);
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(
      join(pendingDir, "operation.json"),
      JSON.stringify({ operationId, provider: "codex", surface: "agent", authMethod: "oauth" }),
    );
    const restarted = await makeService();
    const status = await Effect.runPromise(restarted.getConnectStatus({ operationId }));
    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/interrupted by a server restart/);
    expect(existsSync(pendingDir)).toBe(false);
  });
});
