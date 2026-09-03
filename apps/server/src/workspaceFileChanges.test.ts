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

  it("advances through missing parent directories until the requested file is created", async () => {
    const workspaceRoot = await makeWorkspace();
    const relativePath = "generated/report/output.md";
    const generatedPath = NodePath.join(workspaceRoot, "generated");
    const reportPath = NodePath.join(generatedPath, "report");
    const filePath = NodePath.join(reportPath, "output.md");
    let phase: "initial" | "generated" | "report" | "file" = "initial";
    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    let resolveGeneratedEvent!: () => void;
    const generatedEvent = new Promise<void>((resolve) => {
      resolveGeneratedEvent = resolve;
    });
    let resolveReportEvent!: () => void;
    const reportEvent = new Promise<void>((resolve) => {
      resolveReportEvent = resolve;
    });
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            resolveInitialEvent();
            if (event.type !== "deleted") return;
            if (phase === "generated") resolveGeneratedEvent();
            if (phase === "report") resolveReportEvent();
          }),
        ),
        Stream.takeUntil((event) => phase === "file" && event.type === "changed"),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      phase = "generated";
      await NodeFileSystem.mkdir(generatedPath);
      await Promise.race([
        generatedEvent,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("generated directory watch timed out")), 5_000),
        ),
      ]);
      phase = "report";
      await NodeFileSystem.mkdir(reportPath);
      await Promise.race([
        reportEvent,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("report directory watch timed out")), 5_000),
        ),
      ]);
      phase = "file";
      await NodeFileSystem.writeFile(filePath, "created\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("nested file watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.at(0)?.type).toBe("deleted");
      expect(events.at(-1)?.type).toBe("changed");
      expect(events.every((event) => event.relativePath === relativePath)).toBe(true);
    } finally {
      abortController.abort();
    }
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

  it("keeps watching when a symlink target is temporarily missing", async () => {
    const workspaceRoot = await makeWorkspace();
    const targetPath = NodePath.join(workspaceRoot, "targets/live.ts");
    const aliasPath = NodePath.join(workspaceRoot, "alias.ts");
    await NodeFileSystem.mkdir(NodePath.dirname(targetPath), { recursive: true });
    await NodeFileSystem.writeFile(targetPath, "first\n");
    await NodeFileSystem.symlink("targets/live.ts", aliasPath);

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "alias.ts" }).pipe(
        Stream.tap(() => Effect.sync(resolveInitialEvent)),
        Stream.take(3),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await NodeFileSystem.unlink(targetPath);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await NodeFileSystem.writeFile(targetPath, "restored\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("dangling symlink watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.map((event) => event.type)).toEqual(["changed", "deleted", "changed"]);
    } finally {
      abortController.abort();
    }
  });

  it("keeps watching an absolute target spelled through an aliased workspace root", async () => {
    const containerPath = await makeWorkspace();
    const realWorkspaceRoot = NodePath.join(containerPath, "real");
    const aliasedWorkspaceRoot = NodePath.join(containerPath, "workspace");
    await NodeFileSystem.mkdir(realWorkspaceRoot);
    await NodeFileSystem.symlink("real", aliasedWorkspaceRoot);
    const targetPath = NodePath.join(aliasedWorkspaceRoot, "targets/live.ts");
    const aliasPath = NodePath.join(aliasedWorkspaceRoot, "alias.ts");
    await NodeFileSystem.mkdir(NodePath.dirname(targetPath), { recursive: true });
    await NodeFileSystem.writeFile(targetPath, "first\n");
    await NodeFileSystem.symlink(targetPath, aliasPath);

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    let previousEventType: "changed" | "deleted" | null = null;
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: aliasedWorkspaceRoot, relativePath: "alias.ts" }).pipe(
        Stream.tap(() => Effect.sync(resolveInitialEvent)),
        Stream.filter((event) => {
          if (event.type === previousEventType) return false;
          previousEventType = event.type;
          return true;
        }),
        Stream.take(3),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await NodeFileSystem.unlink(targetPath);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await NodeFileSystem.writeFile(targetPath, "restored\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("aliased-root watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.map((event) => event.type)).toEqual(["changed", "deleted", "changed"]);
    } finally {
      abortController.abort();
    }
  });

  it("follows a symlink retargeted to a file that does not exist yet", async () => {
    const workspaceRoot = await makeWorkspace();
    const initialTargetPath = NodePath.join(workspaceRoot, "targets/initial.ts");
    const futureTargetPath = NodePath.join(workspaceRoot, "future/new.ts");
    const aliasPath = NodePath.join(workspaceRoot, "alias.ts");
    await NodeFileSystem.mkdir(NodePath.dirname(initialTargetPath), { recursive: true });
    await NodeFileSystem.writeFile(initialTargetPath, "initial\n");
    await NodeFileSystem.symlink("targets/initial.ts", aliasPath);

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    let resolveRetargetEvent!: () => void;
    const retargetEvent = new Promise<void>((resolve) => {
      resolveRetargetEvent = resolve;
    });
    let resolveDirectoryEvent!: () => void;
    const directoryEvent = new Promise<void>((resolve) => {
      resolveDirectoryEvent = resolve;
    });
    let phase: "initial" | "retargeted" | "directory-created" | "file-created" = "initial";
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "alias.ts" }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            resolveInitialEvent();
            if (event.type === "deleted") {
              if (phase === "retargeted") resolveRetargetEvent();
              if (phase === "directory-created") resolveDirectoryEvent();
            }
          }),
        ),
        Stream.takeUntil((event) => phase === "file-created" && event.type === "changed"),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await NodeFileSystem.unlink(aliasPath);
      phase = "retargeted";
      await NodeFileSystem.symlink("future/new.ts", aliasPath);
      await Promise.race([
        retargetEvent,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("symlink retarget event timed out")), 5_000),
        ),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      phase = "directory-created";
      await NodeFileSystem.mkdir(NodePath.dirname(futureTargetPath));
      await Promise.race([
        directoryEvent,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("symlink target directory event timed out")), 5_000),
        ),
      ]);
      phase = "file-created";
      await NodeFileSystem.writeFile(futureTargetPath, "created\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("retargeted symlink watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.at(0)?.type).toBe("changed");
      expect(events.some((event) => event.type === "deleted")).toBe(true);
      expect(events.at(-1)?.type).toBe("changed");
    } finally {
      abortController.abort();
    }
  });

  it("resolves dangling relative targets from a symlinked parent directory", async () => {
    const workspaceRoot = await makeWorkspace();
    const realParentPath = NodePath.join(workspaceRoot, "real/links");
    const targetPath = NodePath.join(workspaceRoot, "real/targets/live.ts");
    const aliasPath = NodePath.join(realParentPath, "alias.ts");
    const symlinkedParentPath = NodePath.join(workspaceRoot, "view");
    await NodeFileSystem.mkdir(realParentPath, { recursive: true });
    await NodeFileSystem.mkdir(NodePath.dirname(targetPath), { recursive: true });
    await NodeFileSystem.writeFile(targetPath, "first\n");
    await NodeFileSystem.symlink("../targets/live.ts", aliasPath);
    await NodeFileSystem.symlink("real/links", symlinkedParentPath);

    let resolveInitialEvent!: () => void;
    const initialEvent = new Promise<void>((resolve) => {
      resolveInitialEvent = resolve;
    });
    let previousEventType: "changed" | "deleted" | null = null;
    const abortController = new AbortController();
    const collectedEvents = Effect.runPromise(
      watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "view/alias.ts" }).pipe(
        Stream.tap(() => Effect.sync(resolveInitialEvent)),
        Stream.filter((event) => {
          if (event.type === previousEventType) return false;
          previousEventType = event.type;
          return true;
        }),
        Stream.take(3),
        Stream.runCollect,
      ),
      { signal: abortController.signal },
    );

    try {
      await initialEvent;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await NodeFileSystem.unlink(targetPath);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await NodeFileSystem.writeFile(targetPath, "restored\n");

      const events = Array.from(
        await Promise.race([
          collectedEvents,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("symlinked-parent watch timed out")), 5_000),
          ),
        ]),
      );

      expect(events.map((event) => event.type)).toEqual(["changed", "deleted", "changed"]);
    } finally {
      abortController.abort();
    }
  });
});
