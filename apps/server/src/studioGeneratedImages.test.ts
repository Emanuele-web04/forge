import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
  EventId,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import {
  copyAndAttributeStudioGeneratedImage,
  copyGeneratedImageToStudioWorkspace,
  studioGeneratedImageFileName,
} from "./studioGeneratedImages";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "synara-studio-images-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function recordingEngine(
  commands: OrchestrationCommand[],
): Pick<OrchestrationEngineShape, "dispatch"> {
  return {
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  };
}

/** Creates a trusted "codex home" images root plus one source image inside it. */
async function trustedSourceImage(root: string, fileName: string, content: string) {
  const trustedRoot = path.join(root, "codex-home", "generated_images");
  const sourcePath = path.join(trustedRoot, fileName);
  await mkdir(trustedRoot, { recursive: true });
  await writeFile(sourcePath, content);
  return { trustedRoot, sourcePath };
}

describe("studioGeneratedImageFileName", () => {
  it("uses a readable UTC date and conventional numeric collision suffix", () => {
    expect(
      studioGeneratedImageFileName({
        sourcePath: "/codex/generated_images/exec-opaque.webp",
        createdAt: "2026-07-08T23:30:00+02:00",
        collisionNumber: 1,
      }),
    ).toBe("2026-07-08_generated-image.webp");
    expect(
      studioGeneratedImageFileName({
        sourcePath: "/codex/generated_images/exec-opaque.webp",
        createdAt: "2026-07-08T23:30:00+02:00",
        collisionNumber: 2,
      }),
    ).toBe("2026-07-08_generated-image-2.webp");
  });
});

describe("copyGeneratedImageToStudioWorkspace", () => {
  it("copies without moving the original, creates Outbox/Images, and leaves no temp files", async () => {
    const root = await temporaryRoot();
    const { trustedRoot, sourcePath } = await trustedSourceImage(root, "exec-1.png", "image bytes");
    const workspaceRoot = path.join(root, "Studio");

    const copied = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath,
        workspaceRoot,
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied?.relativePath).toBe("Outbox/Images/2026-07-08_generated-image.png");
    expect(await readFile(copied!.fullPath, "utf8")).toBe("image bytes");
    expect(await readFile(sourcePath, "utf8")).toBe("image bytes");
    const imagesEntries = await readdir(path.join(workspaceRoot, "Outbox", "Images"));
    expect(imagesEntries).toEqual(["2026-07-08_generated-image.png"]);
  });

  it("never overwrites a collision and advances to a numeric suffix", async () => {
    const root = await temporaryRoot();
    const { trustedRoot, sourcePath } = await trustedSourceImage(root, "source.png", "new image");
    const workspaceRoot = path.join(root, "Studio");
    const imagesDirectory = path.join(workspaceRoot, "Outbox", "Images");
    const firstCandidate = path.join(imagesDirectory, "2026-07-08_generated-image.png");
    await mkdir(imagesDirectory, { recursive: true });
    await writeFile(firstCandidate, "existing image");

    const copied = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath,
        workspaceRoot,
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied?.relativePath).toBe("Outbox/Images/2026-07-08_generated-image-2.png");
    expect(await readFile(firstCandidate, "utf8")).toBe("existing image");
    expect(await readFile(copied!.fullPath, "utf8")).toBe("new image");
  });

  it("reuses an existing deliverable with identical bytes instead of duplicating", async () => {
    const root = await temporaryRoot();
    const { trustedRoot, sourcePath } = await trustedSourceImage(root, "exec-2.png", "same bytes");
    const workspaceRoot = path.join(root, "Studio");

    const first = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath,
        workspaceRoot,
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );
    // A replayed completion (server restart, provider replay) copies the same bytes.
    const second = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath,
        workspaceRoot,
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(second?.relativePath).toBe(first?.relativePath);
    const imagesEntries = await readdir(path.join(workspaceRoot, "Outbox", "Images"));
    expect(imagesEntries).toEqual(["2026-07-08_generated-image.png"]);
  });

  it("ignores extensions outside the local-image allowlist", async () => {
    const root = await temporaryRoot();
    const { trustedRoot, sourcePath } = await trustedSourceImage(root, "source.txt", "not image");
    const workspaceRoot = path.join(root, "Studio");

    const copied = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath,
        workspaceRoot,
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied).toBeNull();
  });

  it("rejects sources outside the trusted generated-image roots", async () => {
    const root = await temporaryRoot();
    const trustedRoot = path.join(root, "codex-home", "generated_images");
    await mkdir(trustedRoot, { recursive: true });
    // A crafted provider payload pointing at an arbitrary local image must not be
    // copied into the user-visible Studio folder.
    const outsideSource = path.join(root, "elsewhere", "private.png");
    await mkdir(path.dirname(outsideSource), { recursive: true });
    await writeFile(outsideSource, "outside bytes");
    const workspaceRoot = path.join(root, "Studio");

    const copied = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath: outsideSource,
        workspaceRoot,
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied).toBeNull();
  });

  it("rejects missing sources", async () => {
    const root = await temporaryRoot();
    const trustedRoot = path.join(root, "codex-home", "generated_images");
    await mkdir(trustedRoot, { recursive: true });

    const copied = await Effect.runPromise(
      copyGeneratedImageToStudioWorkspace({
        sourcePath: path.join(trustedRoot, "never-written.png"),
        workspaceRoot: path.join(root, "Studio"),
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied).toBeNull();
  });
});

describe("copyAndAttributeStudioGeneratedImage", () => {
  it("directly attributes the copied workspace-relative path to the runtime turn", async () => {
    const root = await temporaryRoot();
    const { trustedRoot, sourcePath } = await trustedSourceImage(
      root,
      "exec-image.jpeg",
      "jpeg bytes",
    );
    const workspaceRoot = path.join(root, "Studio");
    const commands: OrchestrationCommand[] = [];

    const copied = await Effect.runPromise(
      copyAndAttributeStudioGeneratedImage({
        orchestrationEngine: recordingEngine(commands),
        sourcePath,
        workspaceRoot,
        threadId: ThreadId.makeUnsafe("studio-thread"),
        turnId: TurnId.makeUnsafe("studio-turn"),
        eventId: EventId.makeUnsafe("image-event"),
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied?.relativePath).toBe("Outbox/Images/2026-07-08_generated-image.jpeg");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.activity.append",
      threadId: "studio-thread",
      activity: {
        kind: STUDIO_OUTPUTS_ACTIVITY_KIND,
        turnId: "studio-turn",
        payload: {
          itemType: "studio_outputs",
          data: {
            files: [{ path: "Outbox/Images/2026-07-08_generated-image.jpeg" }],
            generatedImage: {
              origin: CODEX_GENERATED_IMAGE_ARTIFACT_ORIGIN,
              sourcePath,
              fullPath: copied?.fullPath,
            },
          },
        },
      },
    });
  });

  it("skips attribution when the copy is rejected", async () => {
    const root = await temporaryRoot();
    const trustedRoot = path.join(root, "codex-home", "generated_images");
    await mkdir(trustedRoot, { recursive: true });
    const outsideSource = path.join(root, "outside.png");
    await writeFile(outsideSource, "outside bytes");
    const commands: OrchestrationCommand[] = [];

    const copied = await Effect.runPromise(
      copyAndAttributeStudioGeneratedImage({
        orchestrationEngine: recordingEngine(commands),
        sourcePath: outsideSource,
        workspaceRoot: path.join(root, "Studio"),
        threadId: ThreadId.makeUnsafe("studio-thread"),
        turnId: TurnId.makeUnsafe("studio-turn"),
        eventId: EventId.makeUnsafe("image-event"),
        createdAt: "2026-07-08T10:00:00.000Z",
        trustedSourceRoots: [trustedRoot],
      }),
    );

    expect(copied).toBeNull();
    expect(commands).toHaveLength(0);
  });
});
