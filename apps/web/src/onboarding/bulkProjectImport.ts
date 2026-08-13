import type {
  NativeApi,
  OrchestrationShellSnapshot,
  ProjectId,
  ServerExternalProjectCandidate,
  SpaceId,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

import {
  extractDuplicateProjectCreateProjectId,
  isDuplicateProjectCreateError,
} from "~/lib/projectCreateRecovery";
import { buildProjectTitleFromWorkspaceRoot } from "~/lib/projectCreation";
import { newCommandId, newProjectId } from "~/lib/utils";
import { readActiveSpaceId } from "~/spacesUiStore";

export type BulkProjectImportStatus = "created" | "existing" | "failed";

export interface BulkProjectImportResult {
  readonly workspaceRoot: string;
  readonly status: BulkProjectImportStatus;
  readonly projectId: ProjectId | null;
  readonly message?: string;
}

export async function bulkImportProjects(input: {
  api: NativeApi;
  candidates: ReadonlyArray<
    Pick<ServerExternalProjectCandidate, "workspaceRoot" | "existingProjectId">
  >;
  existingProjects: ReadonlyArray<{ readonly id: ProjectId; readonly cwd: string }>;
  spaceId?: SpaceId | null;
  onResult?: (result: BulkProjectImportResult) => void;
  applySnapshot?: (snapshot: OrchestrationShellSnapshot) => void;
}): Promise<ReadonlyArray<BulkProjectImportResult>> {
  const spaceId = input.spaceId !== undefined ? input.spaceId : readActiveSpaceId();
  const results: BulkProjectImportResult[] = [];

  const record = (result: BulkProjectImportResult) => {
    results.push(result);
    input.onResult?.(result);
  };

  for (const candidate of input.candidates) {
    const workspaceRoot = candidate.workspaceRoot.trim();
    if (!workspaceRoot) {
      continue;
    }

    const knownProject =
      (candidate.existingProjectId
        ? input.existingProjects.find((project) => project.id === candidate.existingProjectId)
        : undefined) ??
      input.existingProjects.find((project) => workspaceRootsEqual(project.cwd, workspaceRoot));
    if (knownProject || candidate.existingProjectId) {
      record({
        workspaceRoot,
        status: "existing",
        projectId: knownProject?.id ?? candidate.existingProjectId ?? null,
      });
      continue;
    }

    const projectId = newProjectId();
    try {
      await input.api.orchestration.dispatchCommand({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        kind: "project",
        title: buildProjectTitleFromWorkspaceRoot(workspaceRoot),
        workspaceRoot,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: {
          provider: "codex",
          model: getDefaultModel("codex"),
        },
        spaceId,
        createdAt: new Date().toISOString(),
      });
      record({ workspaceRoot, status: "created", projectId });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "An error occurred while adding the project.";
      if (isDuplicateProjectCreateError(message)) {
        const duplicateProjectId = extractDuplicateProjectCreateProjectId(message);
        record({
          workspaceRoot,
          status: "existing",
          projectId: duplicateProjectId ? (duplicateProjectId as ProjectId) : null,
        });
        continue;
      }
      record({ workspaceRoot, status: "failed", projectId: null, message });
    }
  }

  const snapshot = await input.api.orchestration.getShellSnapshot().catch(() => null);
  if (snapshot) {
    input.applySnapshot?.(snapshot);
  }

  return results;
}

export function summarizeBulkProjectImport(results: ReadonlyArray<BulkProjectImportResult>): {
  created: number;
  existing: number;
  failed: number;
} {
  return {
    created: results.filter((result) => result.status === "created").length,
    existing: results.filter((result) => result.status === "existing").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}
