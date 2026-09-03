// FILE: workspaceFileChanges.test.ts
// Purpose: Verifies bounded file watching across replace/delete/recreate saves.
// Layer: Server filesystem utility tests

import * as NodeFileSystem from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Effect, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspacePathOutsideRootError } from "./workspace/Services/WorkspacePaths";
import { watchWorkspaceFile } from "./workspaceFileChanges";

const temporaryRoots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await NodeFileSystem.mkdtemp(
    NodePath.join(NodeOs.tmpdir(), "synara-file-watch-"),
  );
  temporaryRoots.push(workspaceRoot);
  return workspaceRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((workspaceRoot) => NodeFileSystem.rm(workspaceRoot, { recursive: true, force: true })),
  );
});

describe("watchWorkspaceFile", () => {
  it("emits the initial state and survives delete-and-recreate saves", async () => {
    const workspaceRoot = await makeWorkspace();
    const relativePath = "src/example.ts";
    const absolutePath = NodePath.join(workspaceRoot, relativePath);
    await NodeFileSystem.mkdir(NodePath.dirname(absolutePath), { recursive: true });
    await NodeFileSystem.writeFile(absolutePath, "first\n");

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath }).pipe(
        Stream.tap(() => Effect.sync(resolveInitialEvent)),
        Stream.take(3),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await NodeFileSystem.rm(absolutePath);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await NodeFileSystem.writeFile(absolutePath, "second\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("file watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.map((event) => event.type)).toEqual(["changed", "deleted", "changed"]);
      expect(events.every((event) => event.relativePath === relativePath)).toBe(true);
    } finally {
      abortController.abort();
    }
  });

  it("rejects paths outside the workspace root before opening a watcher", async () => {
    const workspaceRoot = await makeWorkspace();
    const error = await Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "../outside.ts" }).pipe(
        Stream.runHead,
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(WorkspacePathOutsideRootError);
  });

  it("watches both a symlink entry and its current in-workspace target", async () => {
    const workspaceRoot = await makeWorkspace();
    const firstTarget = NodePath.join(workspaceRoot, "targets/first.ts");
    const secondTarget = NodePath.join(workspaceRoot, "targets/second.ts");
    const aliasPath = NodePath.join(workspaceRoot, "alias.ts");
    await NodeFileSystem.mkdir(NodePath.dirname(firstTarget), { recursive: true });
    await NodeFileSystem.writeFile(firstTarget, "first\n");
    await NodeFileSystem.writeFile(secondTarget, "second\n");
    await NodeFileSystem.symlink("targets/first.ts", aliasPath);

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "alias.ts" }).pipe(
        Stream.tap(() => Effect.sync(resolveInitialEvent)),
        Stream.take(4),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await NodeFileSystem.writeFile(firstTarget, "first changed\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
      await NodeFileSystem.unlink(aliasPath);
      await NodeFileSystem.symlink("targets/second.ts", aliasPath);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await NodeFileSystem.writeFile(secondTarget, "second changed\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("symlink file watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events).toHaveLength(4);
      expect(events.every((event) => event.type === "changed")).toBe(true);
      expect(events.every((event) => event.relativePath === "alias.ts")).toBe(true);
    } finally {
      abortController.abort();
    }
  });
});
