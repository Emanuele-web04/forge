import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { copyGeneratedImageToStudioWorkspace } from "./studioGeneratedImages";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("Studio generated-image path containment", () => {
  it("accepts dot-prefixed children without accepting parent escapes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synara-studio-dot-image-"));
    temporaryRoots.push(root);
    const trustedRoot = path.join(root, "generated_images");
    const sourceDirectory = path.join(trustedRoot, "..session");
    const sourcePath = path.join(sourceDirectory, "image.png");
    const outsidePath = path.join(root, "outside.png");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourcePath, "trusted image");
    await writeFile(outsidePath, "outside image");

    const copied = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath,
        workspaceRoot: path.join(root, "Studio"),
        createdAt: "2026-08-31T12:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );
    const escaped = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath: outsidePath,
        workspaceRoot: path.join(root, "Other Studio"),
        createdAt: "2026-08-31T12:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied).not.toBeNull();
    expect(await readFile(copied!.fullPath, "utf8")).toBe("trusted image");
    expect(escaped).toBeNull();
  });
});
