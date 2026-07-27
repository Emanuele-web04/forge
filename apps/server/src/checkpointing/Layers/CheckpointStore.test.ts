// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { CheckpointRef } from "@synara/contracts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CheckpointStoreLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.promise(() => addGate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" }));
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() => execute.mock.calls.some(([call]) => call.args.join(" ") === "add -A -- .")),
        );
        const second = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        expect(
          execute.mock.calls.filter(([call]) => call.args.join(" ") === "add -A -- ."),
        ).toHaveLength(1);

        releaseAdd?.();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        addCalls += 1;
        if (addCalls === 1) {
          return Effect.never;
        }
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => addCalls === 1));
        const waiter = yield* store.captureCheckpoint(input).pipe(
          Effect.map(() => "completed" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
          Effect.forkChild,
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        yield* Fiber.interrupt(first);
        // The owner's interruption must surface to waiters as a typed store
        // error, not replay as the waiter's own fiber being interrupted.
        const waiterResult = yield* Fiber.join(waiter);
        expect(waiterResult).toBe("CheckpointInvariantError");

        const thirdResult = yield* store
          .captureCheckpoint(input)
          .pipe(Effect.timeoutOption("100 millis"));
        expect(Option.isSome(thirdResult)).toBe(true);
        expect(addCalls).toBe(2);
      }),
    );
  });

  it("skips the capture when skipIfExists is set and the ref already exists", async () => {
    const existingRef = "refs/synara-checkpoints/thread/existing";
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${existingRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "existing-commit\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const captureArgs = (args: string) =>
          execute.mock.calls.filter(([call]) => call.args.join(" ") === args);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(existingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(0);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(1);
        expect(captureArgs(`update-ref ${missingRef} commit-oid`)).toHaveLength(1);
      }),
    );
  });

  it("restores the worktree patch when resetting the index fails during file undo", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
    const commands: string[] = [];
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "from-oid\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "to-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "turn patch", stderr: "" });
      }
      if (args === "diff --name-only --no-renames -z from-oid to-oid") {
        return Effect.succeed({ code: 0, stdout: "src/file.ts\0", stderr: "" });
      }
      if (input.args[0] === "apply" && input.args[1] === "--reverse") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "reset --quiet from-oid -- src/file.ts") {
        return Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: args,
            cwd: input.cwd,
            detail: "reset failed",
          }),
        );
      }
      if (input.args[0] === "apply" && input.args[1] === "--whitespace=nowarn") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .reverseCheckpointDiff({
            cwd: "/repo",
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      }),
    );

    expect(result).toBe("GitCommandError");
    expect(commands.filter((command) => command.startsWith("apply "))).toHaveLength(2);
    expect(commands.at(-1)).toMatch(/^apply --whitespace=nowarn -- /);
  });

  it("fails when a checkpoint ref cannot be deleted", async () => {
    const lockedRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/locked");
    const deletableRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/ok");
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `update-ref -d ${lockedRef}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "cannot lock ref\n" });
      }
      if (args === `update-ref -d ${deletableRef}`) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({ cwd: "/repo", checkpointRefs: [deletableRef, lockedRef] })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    // Every ref is still attempted; one loser must not abandon the batch.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).not.toBe("success");
    expect(result).toContain(lockedRef);
    expect(result).toContain("cannot lock ref");
    expect(result).not.toContain(deletableRef);
  });

  it("tolerates deleting checkpoint refs that are already absent", async () => {
    // `git update-ref -d` exits 0 for a ref that does not exist, so the
    // exit-code check must not turn best-effort cleanup into a hard failure.
    const missingRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/gone");
    const execute = vi.fn<GitCoreShape["execute"]>(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({ cwd: "/repo", checkpointRefs: [missingRef] })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    expect(result).toBe("success");
  });
});
