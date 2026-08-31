import { CommandId, ProjectId, ProjectSourceId } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider";
import { createEmptyReadModel } from "./projector";

describe("multi-source projects", () => {
  it("creates an ordered source set and keeps workspaceRoot as the primary mirror", async () => {
    const projectId = ProjectId.makeUnsafe("project-multi");
    const primarySourceId = ProjectSourceId.makeUnsafe("source-primary");
    const secondarySourceId = ProjectSourceId.makeUnsafe("source-secondary");
    const event = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("command-multi"),
          projectId,
          kind: "project",
          title: "Product",
          workspaceRoot: "/repos/frontend",
          sources: [
            { id: primarySourceId, path: "/repos/frontend" },
            { id: secondarySourceId, path: "/repos/backend" },
          ],
          primarySourceId,
          createdAt: "2026-08-30T20:00:00.000Z",
        },
        readModel: createEmptyReadModel("2026-08-30T20:00:00.000Z"),
      }),
    );
    const created = Array.isArray(event) ? event.at(-1)! : event;
    expect(created.type).toBe("project.created");
    if (created.type !== "project.created") throw new Error("Expected project.created");
    expect(created.payload.sources).toEqual([
      { id: primarySourceId, path: "/repos/frontend" },
      { id: secondarySourceId, path: "/repos/backend" },
    ]);
    expect(created.payload.primarySourceId).toBe(primarySourceId);
    expect(created.payload.workspaceRoot).toBe("/repos/frontend");
  });

  it("rejects a primary source that is not in the source list", async () => {
    const result = await Effect.runPromiseExit(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.makeUnsafe("command-invalid"),
          projectId: ProjectId.makeUnsafe("project-invalid"),
          kind: "project",
          title: "Invalid",
          workspaceRoot: "/repos/frontend",
          sources: [{ id: ProjectSourceId.makeUnsafe("source-primary"), path: "/repos/frontend" }],
          primarySourceId: ProjectSourceId.makeUnsafe("missing-source"),
          createdAt: "2026-08-30T20:00:00.000Z",
        },
        readModel: createEmptyReadModel("2026-08-30T20:00:00.000Z"),
      }),
    );
    expect(result._tag).toBe("Failure");
  });
});
