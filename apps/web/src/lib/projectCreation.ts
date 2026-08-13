// FILE: projectCreation.ts
// Purpose: Shared project-create flow for UI entrypoints that need duplicate recovery.
// Layer: Web orchestration helper
// Exports: createOrRecoverProjectFromPath

import {
  type NativeApi,
  type OrchestrationShellSnapshot,
  type ProjectId,
  type SpaceId,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";

import { readActiveSpaceId } from "../spacesUiStore";
import {
  extractDuplicateProjectCreateProjectId,
  isDuplicateProjectCreateError,
  waitForRecoverableProjectForDuplicateCreate,
  waitForRecoverableProjectInReadModel,
} from "./projectCreateRecovery";
import { newCommandId, newProjectId } from "./utils";

const DEFAULT_PROJECT_CREATE_RECOVERY_MAX_ATTEMPTS = 6;
const DEFAULT_PROJECT_CREATE_RECOVERY_DELAY_MS = 50;
export const PROJECT_CREATE_EXISTING_SYNC_ERROR =
  "This folder is already linked, but the existing project has not synced into the sidebar yet. Try again in a moment.";
export const PROJECT_CREATE_SYNC_ERROR =
  "The project was created, but it has not synced into Synara yet. Try again in a moment.";

function buildProjectTitleFromWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? workspaceRoot;
}

// Creates a project row for a folder, recovering the existing server project when
// the create command races an already-linked workspace root.
export async function createOrRecoverProjectFromPath(input: {
  api: NativeApi;
  workspaceRoot: string;
  createIfMissing?: boolean;
  /** Overrides the active-space default; `null` files the project in Void. */
  spaceId?: SpaceId | null;
  loadSnapshot: () => Promise<OrchestrationShellSnapshot | null>;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<{
  projectId: ProjectId;
  project: OrchestrationShellSnapshot["projects"][number] | null;
  snapshot: OrchestrationShellSnapshot | null;
  created: boolean;
}> {
  const workspaceRoot = input.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw new Error("Project folder path is empty.");
  }

  const maxAttempts = input.maxAttempts ?? DEFAULT_PROJECT_CREATE_RECOVERY_MAX_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_PROJECT_CREATE_RECOVERY_DELAY_MS;
  const projectId = newProjectId();
  const createdAt = new Date().toISOString();
  const title = buildProjectTitleFromWorkspaceRoot(workspaceRoot);

  try {
    await input.api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: newCommandId(),
      projectId,
      kind: "project",
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: input.createIfMissing === true,
      defaultModelSelection: {
        provider: "codex",
        model: getDefaultModel("codex"),
      },
      // A project created while a space is active belongs to that space — filing it
      // afterwards would bounce the sidebar back to Void to follow the new project.
      // Callers with an explicit destination (the Create Project dialog) override it.
      spaceId: input.spaceId !== undefined ? input.spaceId : readActiveSpaceId(),
      createdAt,
    });

    const { project, snapshot } = await waitForRecoverableProjectInReadModel({
      projectId,
      loadSnapshot: input.loadSnapshot,
      maxAttempts,
      delayMs,
    });
    return {
      projectId,
      project,
      snapshot,
      created: true,
    };
  } catch (error) {
    const description =
      error instanceof Error ? error.message : "An error occurred while adding the project.";
    if (!isDuplicateProjectCreateError(description)) {
      throw error instanceof Error ? error : new Error(description);
    }

    const { project, snapshot } = await waitForRecoverableProjectForDuplicateCreate({
      message: description,
      workspaceRoot,
      loadSnapshot: input.loadSnapshot,
      maxAttempts,
      delayMs,
    });
    if (project && snapshot) {
      return {
        projectId: project.id,
        project,
        snapshot,
        created: false,
      };
    }

    const duplicateProjectId = extractDuplicateProjectCreateProjectId(description);
    if (duplicateProjectId) {
      return {
        projectId: duplicateProjectId as ProjectId,
        project: null,
        snapshot,
        created: false,
      };
    }

    throw new Error(PROJECT_CREATE_EXISTING_SYNC_ERROR, { cause: error });
  }
}
