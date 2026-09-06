import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { accountDir, pendingPath } from "@synara/shared/providerAccounts/accountPaths";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FINALIZE_MARKER_FILE,
  makeAccountStorage,
  type AccountStorageShape,
} from "./accountStorage";

const renameControl = vi.hoisted(() => ({
  override: null as
    | null
    | ((
        actual: (from: string, to: string) => Promise<void>,
        from: string,
        to: string,
      ) => Promise<void>),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const rename = (from: string, to: string) =>
    renameControl.override === null
      ? actual.rename(from, to)
      : renameControl.override((f, t) => actual.rename(f, t), from, to);
  return { ...actual, rename };
});

// Emulates Windows rename semantics: renaming onto an existing path fails
// instead of replacing it (POSIX directory replacement is not available).
const windowsRename = async (
  actual: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
) => {
  if (existsSync(to)) {
    const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
    (error as NodeJS.ErrnoException).code = "EPERM";
    throw error;
  }
  await actual(from, to);
};

describe("accountStorage finalization", () => {
  let root: string;
  let storage: AccountStorageShape;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-"));
    storage = makeAccountStorage({ root });
    renameControl.override = null;
  });

  afterEach(() => {
    renameControl.override = null;
    rmSync(root, { recursive: true, force: true });
  });

  const seedPending = async (operationId: string) => {
    await Effect.runPromise(storage.ensureRoot);
    await Effect.runPromise(storage.createPendingDirectory("codex", operationId));
    const pending = pendingPath(root, "codex", operationId);
    writeFileSync(join(pending, "agent", "home", "auth.json"), '{"token":"t"}');
    writeFileSync(join(pending, "operation.json"), "{}");
    return pending;
  };

  it("finalizes under Windows rename semantics (destination never replaced)", async () => {
    const pending = await seedPending("op-win");
    renameControl.override = windowsRename;
    const ordinal = await Effect.runPromise(storage.finalizePendingDirectory("codex", "op-win"));
    expect(ordinal).toBe(1);
    const target = accountDir(root, "codex", 1);
    expect(readFileSync(join(target, "agent", "home", "auth.json"), "utf8")).toBe('{"token":"t"}');
    expect(existsSync(join(target, FINALIZE_MARKER_FILE))).toBe(false);
    expect(existsSync(join(target, "operation.json"))).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });

  it("rolls a partially moved finalize back into the pending directory", async () => {
    const pending = await seedPending("op-fail");
    writeFileSync(join(pending, "extra.bin"), "credential");
    let forwardMoves = 0;
    renameControl.override = async (actual, from, to) => {
      if (from.startsWith(pending)) {
        forwardMoves += 1;
        if (forwardMoves === 2) {
          const error = new Error("EIO: i/o error");
          (error as NodeJS.ErrnoException).code = "EIO";
          throw error;
        }
      }
      await actual(from, to);
    };
    const failure = await Effect.runPromise(
      Effect.flip(storage.finalizePendingDirectory("codex", "op-fail")),
    );
    expect(failure.operation).toBe("accountStorage.finalizePendingDirectory");
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
    expect(existsSync(join(pending, "agent", "home", "auth.json"))).toBe(true);
    expect(existsSync(join(pending, "extra.bin"))).toBe(true);
  });

  it("removes an incomplete finalization left behind by a crash", async () => {
    await Effect.runPromise(storage.ensureRoot);
    const orphan = accountDir(root, "codex", 1);
    mkdirSync(join(orphan, "agent", "home"), { recursive: true });
    writeFileSync(join(orphan, FINALIZE_MARKER_FILE), JSON.stringify({ operationId: "op-x" }));
    await Effect.runPromise(storage.recoverIncompleteFinalizations("codex"));
    expect(existsSync(orphan)).toBe(false);
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([]);
  });

  it("keeps a completed account and only removes a stale marker", async () => {
    await Effect.runPromise(storage.ensureRoot);
    const done = accountDir(root, "codex", 2);
    mkdirSync(done, { recursive: true });
    writeFileSync(join(done, "account.json"), "{}");
    writeFileSync(join(done, FINALIZE_MARKER_FILE), JSON.stringify({ operationId: "op-y" }));
    await Effect.runPromise(storage.recoverIncompleteFinalizations("codex"));
    expect(existsSync(join(done, "account.json"))).toBe(true);
    expect(existsSync(join(done, FINALIZE_MARKER_FILE))).toBe(false);
  });

  it("leaves a live sibling's in-flight finalize alone", async () => {
    let sibling: ChildProcess | undefined;
    try {
      sibling = spawn("sleep", ["30"]);
      await Effect.runPromise(storage.ensureRoot);
      const inFlight = accountDir(root, "codex", 3);
      mkdirSync(inFlight, { recursive: true });
      writeFileSync(
        join(inFlight, FINALIZE_MARKER_FILE),
        JSON.stringify({ operationId: "op-z", pid: sibling.pid }),
      );
      await Effect.runPromise(storage.recoverIncompleteFinalizations("codex"));
      expect(existsSync(join(inFlight, FINALIZE_MARKER_FILE))).toBe(true);
    } finally {
      sibling?.kill();
    }
  });
});
