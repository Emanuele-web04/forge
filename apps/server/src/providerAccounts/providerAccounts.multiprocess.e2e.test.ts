import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAccountConnect, type AccountConnectShape } from "./accountConnect";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";

const WORKER_ENTRY = resolve(import.meta.dirname, "e2eWorkers/connectWorker.ts");

interface WorkerResult {
  readonly apiKey: string;
  readonly state: string;
  readonly ordinal: number | null;
}

const runConnectWorker = (root: string, apiKeys: readonly string[]) =>
  new Promise<ReadonlyArray<WorkerResult>>((resolveWorker, rejectWorker) => {
    const child = spawn("bun", [WORKER_ENTRY, root, ...apiKeys], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", rejectWorker);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectWorker(new Error(`connectWorker exited with code ${code}: ${stderr}`));
        return;
      }
      resolveWorker(JSON.parse(stdout) as ReadonlyArray<WorkerResult>);
    });
  });

describe("provider accounts multi-process end to end", () => {
  let root: string;
  let storage: AccountStorageShape;
  let connect: AccountConnectShape;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-mp-e2e-"));
    storage = makeAccountStorage({ root });
    connect = makeAccountConnect({ storage });
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("gives concurrent connects from two OS processes distinct ordinals with no overwrites", async () => {
    const localKeys = ["sk-local-0", "sk-local-1", "sk-local-2"];
    const workerKeys = ["sk-worker-0", "sk-worker-1", "sk-worker-2"];

    const [workerResults, ...localOperations] = await Promise.all([
      runConnectWorker(root, workerKeys),
      ...localKeys.map((apiKey) =>
        Effect.runPromise(
          connect.beginConnect({ kind: "agent-api-key", provider: "codex", apiKey }),
        ),
      ),
    ]);

    const localResults: Array<WorkerResult> = [];
    for (const [index, { operationId }] of localOperations.entries()) {
      const status = await Effect.runPromise(connect.getConnectStatus(operationId));
      localResults.push({
        apiKey: localKeys[index]!,
        state: status.state,
        ordinal: status.ordinal ?? null,
      });
    }

    const allResults = [...localResults, ...workerResults];
    for (const result of allResults) {
      expect(result.state).toBe("succeeded");
      expect(result.ordinal).not.toBeNull();
    }

    // Every connect must own a unique ordinal: 1..6 with no gaps or reuse.
    const ordinals = allResults.map((result) => result.ordinal!).toSorted((a, b) => a - b);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([
      1, 2, 3, 4, 5, 6,
    ]);

    // Each ordinal's secret and record must match the connect that owns it —
    // no cross-process overwrites of secrets or account records.
    for (const result of allResults) {
      await expect(
        Effect.runPromise(storage.readSecret("codex", result.ordinal!, "agent")),
      ).resolves.toBe(result.apiKey);
      const record = await Effect.runPromise(storage.readAccount("codex", result.ordinal!));
      expect(record?.agent).toMatchObject({ state: "connected", authMethod: "apiKey" });
      expect(record?.identity?.hint).toBe(`API key ending ${result.apiKey.slice(-4)}`);
    }

    // Exactly one process won the activate-if-first race; the pointer is a
    // valid connected ordinal.
    const active = await Effect.runPromise(storage.readActiveOrdinal("codex"));
    expect(ordinals).toContain(active);
  }, 30_000);
});
