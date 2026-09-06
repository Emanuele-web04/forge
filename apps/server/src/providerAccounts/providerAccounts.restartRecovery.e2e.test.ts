import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountConnect } from "./accountConnect";
import { makeAccountStorage } from "./accountStorage";

const WORKER_ENTRY = resolve(import.meta.dirname, "e2eWorkers/oauthConnectWorker.ts");

const startOauthWorker = (root: string) =>
  new Promise<{ child: ChildProcess; operationId: string }>((resolveStart, rejectStart) => {
    const child = spawn("bun", [WORKER_ENTRY, root], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        const { operationId } = JSON.parse(stdout.slice(0, newline)) as { operationId: string };
        resolveStart({ child, operationId });
      }
    });
    child.on("error", rejectStart);
    child.on("close", (code) => {
      rejectStart(new Error(`oauthConnectWorker exited early with code ${code}: ${stderr}`));
    });
  });

const waitForExit = (child: ChildProcess) =>
  new Promise<void>((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveExit();
      return;
    }
    child.on("close", () => resolveExit());
  });

describe("provider accounts restart recovery end to end", () => {
  let root: string;
  let worker: ChildProcess | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-restart-e2e-"));
  });

  afterEach(() => {
    if (worker !== null && worker.exitCode === null && worker.signalCode === null) {
      worker.kill("SIGKILL");
    }
    worker = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("recovers a mid-OAuth connect as terminal after the service process is killed", async () => {
    const started = await startOauthWorker(root);
    worker = started.child;
    const { operationId } = started;

    // The pending directory exists on disk while the worker is alive.
    expect(existsSync(join(root, "pending", "codex", operationId))).toBe(true);

    // Kill the service process outright — no cleanup handlers run.
    worker.removeAllListeners("close");
    worker.kill("SIGKILL");
    await waitForExit(worker);

    // A new service process over the same account root recovers on startup.
    const restartedStorage = makeAccountStorage({ root });
    const restarted = makeAccountConnect({ storage: restartedStorage });
    await Effect.runPromise(restarted.recoverInterruptedOperations);

    const status = await Effect.runPromise(restarted.getConnectStatus(operationId));
    expect(status.state).toBe("failed");
    expect(status.provider).toBe("codex");
    expect(status.surface).toBe("agent");
    expect(status.error).toMatch(/interrupted by a server restart/);

    // The pending directory is cleaned and no ordinal or account leaked.
    await expect(
      Effect.runPromise(restartedStorage.listPendingOperations("codex")),
    ).resolves.toEqual([]);
    expect(existsSync(join(root, "pending", "codex"))).toBe(false);
    await expect(Effect.runPromise(restartedStorage.listOrdinals("codex"))).resolves.toEqual([]);
    await expect(Effect.runPromise(restartedStorage.readActiveOrdinal("codex"))).resolves.toBe(
      null,
    );
  }, 30_000);
});
