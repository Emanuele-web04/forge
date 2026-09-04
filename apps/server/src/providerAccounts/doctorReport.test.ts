// Doctor report checks against real storage over temp account roots: each
// check id is driven through its ok, warning, and error states.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountRecord, ProviderAccountsDoctorReport } from "@synara/contracts";
import {
  accountJsonPath,
  activePointerPath,
  pendingDir,
  versionFilePath,
} from "@synara/shared/providerAccounts/accountPaths";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";
import { makeCliIntegration } from "./cliIntegration";
import { makeDoctorReport } from "./doctorReport";

const connectedRecord = (
  provider: ProviderAccountRecord["provider"],
  ordinal: number,
  authMethod: "oauth" | "apiKey" = "apiKey",
): ProviderAccountRecord => ({
  schemaVersion: 1,
  provider,
  ordinal,
  createdAt: new Date().toISOString(),
  agent: { generation: 1, state: "connected", authMethod },
});

describe("makeDoctorReport", () => {
  let root: string;
  let storage: AccountStorageShape;

  const generateReport = (): Promise<ProviderAccountsDoctorReport> => {
    const cliIntegration = makeCliIntegration({
      root,
      launcherEntry: join(root, "missing-launcher.ts"),
      env: { PATH: "" },
    });
    return Effect.runPromise(makeDoctorReport({ storage, cliIntegration }).generate);
  };

  const findCheck = (report: ProviderAccountsDoctorReport, id: string) => {
    const check = report.checks.find((entry) => entry.id === id);
    expect(check).toBeDefined();
    return check!;
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-doctor-"));
    storage = makeAccountStorage({ root });
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("account-root", () => {
    it("reports ok with the schema version on an initialized root", async () => {
      const check = findCheck(await generateReport(), "account-root");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("Schema version 1");
    });

    it("warns when the root is not initialized yet", async () => {
      rmSync(versionFilePath(root), { force: true });
      const check = findCheck(await generateReport(), "account-root");
      expect(check.status).toBe("warning");
      expect(check.detail).toContain("not initialized");
    });

    it("errors when the version file cannot be read", async () => {
      rmSync(versionFilePath(root), { force: true });
      mkdirSync(versionFilePath(root));
      const check = findCheck(await generateReport(), "account-root");
      expect(check.status).toBe("error");
      expect(check.detail).toContain("Failed to read");
    });
  });

  describe("active-pointer", () => {
    it("reports ok for the native account when no pointer exists", async () => {
      const check = findCheck(await generateReport(), "active-pointer-codex");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("Native account 0");
    });

    it("reports ok for a pointer at a connected managed account", async () => {
      await Effect.runPromise(storage.writeAccount(connectedRecord("codex", 1)));
      await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));
      const check = findCheck(await generateReport(), "active-pointer-codex");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("Managed account 1");
    });

    it("errors when the pointer targets a missing account", async () => {
      await Effect.runPromise(storage.writeActiveOrdinal("codex", 7));
      const check = findCheck(await generateReport(), "active-pointer-codex");
      expect(check.status).toBe("error");
      expect(check.detail).toContain("does not exist");
    });

    it("warns when the pointer targets an account whose agent binding is not connected", async () => {
      await Effect.runPromise(
        storage.writeAccount({
          ...connectedRecord("codex", 1),
          agent: { generation: 2, state: "needs-auth", authMethod: "apiKey" },
        }),
      );
      await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));
      const check = findCheck(await generateReport(), "active-pointer-codex");
      expect(check.status).toBe("warning");
      expect(check.detail).toContain("not connected");
    });

    it("errors when the pointer file is corrupted", async () => {
      writeFileSync(activePointerPath(root, "codex"), "banana");
      const check = findCheck(await generateReport(), "active-pointer-codex");
      expect(check.status).toBe("error");
      expect(check.detail).toContain("corrupted");
    });
  });

  describe("accounts", () => {
    it("reports ok with the managed account count", async () => {
      await Effect.runPromise(storage.writeAccount(connectedRecord("grok", 1)));
      await Effect.runPromise(storage.writeSecret("grok", 1, "agent", "xai-key"));
      await Effect.runPromise(storage.writeAccount(connectedRecord("grok", 2, "oauth")));
      const check = findCheck(await generateReport(), "accounts-grok");
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("2 managed account(s)");
    });

    it("errors when a record fails schema validation", async () => {
      mkdirSync(join(root, "accounts", "grok", "1"), { recursive: true });
      writeFileSync(accountJsonPath(root, "grok", 1), "{not json");
      const check = findCheck(await generateReport(), "accounts-grok");
      expect(check.status).toBe("error");
      expect(check.detail).toContain("missing or fails schema validation");
    });

    it("errors when a connected api-key account is missing its secret", async () => {
      await Effect.runPromise(storage.writeAccount(connectedRecord("grok", 1)));
      const check = findCheck(await generateReport(), "accounts-grok");
      expect(check.status).toBe("error");
      expect(check.detail).toContain("Missing API-key secret");
    });
  });

  describe("pending", () => {
    it("reports ok when no pending directories exist", async () => {
      const check = findCheck(await generateReport(), "pending-codex");
      expect(check.status).toBe("ok");
    });

    it("warns about orphaned pending directories", async () => {
      await Effect.runPromise(storage.createPendingDirectory("codex", "op-1"));
      const check = findCheck(await generateReport(), "pending-codex");
      expect(check.status).toBe("warning");
      expect(check.detail).toContain("1 orphaned pending directory");
    });

    it("errors when the pending directory cannot be inspected", async () => {
      mkdirSync(join(root, "pending"), { recursive: true });
      writeFileSync(pendingDir(root, "codex"), "not a directory");
      const check = findCheck(await generateReport(), "pending-codex");
      expect(check.status).toBe("error");
      expect(check.detail).toContain("Failed to inspect");
    });
  });

  describe("app-leases", () => {
    it("reports ok when a lease belongs to a live process", async () => {
      await Effect.runPromise(storage.writeAccount(connectedRecord("cursor", 1)));
      await Effect.runPromise(
        storage.writeAppLease({
          provider: "cursor",
          ordinal: 1,
          appGeneration: 1,
          pid: process.pid,
          processStartedAt: new Date().toISOString(),
        }),
      );
      const check = findCheck(await generateReport(), "app-leases-cursor");
      expect(check.status).toBe("ok");
    });

    it("warns about leases whose process is no longer running", async () => {
      await Effect.runPromise(storage.writeAccount(connectedRecord("cursor", 1)));
      // PIDs are recycled upward; 2^22 is beyond the default Linux pid_max.
      await Effect.runPromise(
        storage.writeAppLease({
          provider: "cursor",
          ordinal: 1,
          appGeneration: 1,
          pid: 4_194_304 - 1,
          processStartedAt: new Date().toISOString(),
        }),
      );
      const check = findCheck(await generateReport(), "app-leases-cursor");
      expect(check.status).toBe("warning");
      expect(check.detail).toContain("Stale lease(s) for account(s) 1");
    });
  });

  describe("cli-integration", () => {
    it("warns when shims are not installed", async () => {
      const check = findCheck(await generateReport(), "cli-integration");
      expect(check.status).toBe("warning");
      expect(check.detail).toContain("not installed");
    });
  });
});
