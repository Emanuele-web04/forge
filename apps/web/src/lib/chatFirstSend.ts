import { DEFAULT_MODEL_BY_PROVIDER, type ModelSelection } from "@synara/contracts";
import { workspaceRootsEqual } from "@synara/shared/threadWorkspace";

import type { Project } from "../types";
import { buildChatWorkspaceFolderPath } from "./chatWorkspaceFolders";

export interface FirstSendProjectTarget {
  targetProjectId: Project["id"];
  targetProjectKind: Project["kind"];
  targetProjectCwd: string;
  targetProjectScripts: Project["scripts"];
  targetProjectDefaultModelSelection: ModelSelection | null;
}

export interface FirstSendProjectCreation {
  workspaceRoot: string;
  title: string;
  kind: Project["kind"];
  createWorkspaceRootIfMissing: boolean;
  defaultModelSelection: ModelSelection;
}

export type FirstSendTargetResolution =
  | { kind: "current"; target: FirstSendProjectTarget }
  | { kind: "existing-project"; target: FirstSendProjectTarget }
  | { kind: "create-project"; creation: FirstSendProjectCreation };

function buildProjectTarget(project: Project): FirstSendProjectTarget {
  return {
    targetProjectId: project.id,
    targetProjectKind: project.kind,
    targetProjectCwd: project.cwd,
    targetProjectScripts: project.kind === "project" ? project.scripts : [],
    targetProjectDefaultModelSelection: project.defaultModelSelection ?? null,
  };
}

function buildProjectTitleFromWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? workspaceRoot;
}

export function resolveFirstSendTarget(input: {
  activeProject: Project;
  chatWorkspaceRoot: string | null;
  createdAt: Date;
  defaultModelSelection?: ModelSelection;
  isFirstMessage: boolean;
  isHomeChatContainer: boolean;
  isStudioContainer: boolean;
  projects: readonly Project[];
  selectedWorkspaceRoot: string | null;
  title: string;
  titleSeed: string;
}): FirstSendTargetResolution {
  const createDefaultModelSelection =
    input.defaultModelSelection ??
    ({
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    } satisfies ModelSelection);
  const {
    activeProject,
    chatWorkspaceRoot,
    createdAt,
    isFirstMessage,
    isHomeChatContainer,
    isStudioContainer,
    projects,
    selectedWorkspaceRoot,
    title,
    titleSeed,
  } = input;

  if (!isFirstMessage || (!isHomeChatContainer && !isStudioContainer)) {
    return {
      kind: "current",
      target: buildProjectTarget(activeProject),
    };
  }

  // Studio chats never leave the Studio container: a picked folder stays attached to the
  // thread as its workspace root instead of becoming (or joining) a Projects entry.
  if (isStudioContainer) {
    return {
      kind: "current",
      target: buildProjectTarget(activeProject),
    };
  }

  // Home-chat folder mentions intentionally escape the generic-chat workspace and become
  // normal projects.
  if (!selectedWorkspaceRoot) {
    if (!chatWorkspaceRoot) {
      return {
        kind: "current",
        target: buildProjectTarget(activeProject),
      };
    }

    return {
      kind: "create-project",
      creation: {
        workspaceRoot: buildChatWorkspaceFolderPath({
          chatWorkspaceRoot,
          createdAt,
          existingWorkspaceRoots: projects.map((project) => project.cwd),
          titleSeed,
        }),
        title,
        kind: "chat",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: createDefaultModelSelection,
      },
    };
  }

  const existingProject = projects.find(
    (project) =>
      project.kind === "project" && workspaceRootsEqual(project.cwd, selectedWorkspaceRoot),
  );
  if (existingProject) {
    return {
      kind: "existing-project",
      target: buildProjectTarget(existingProject),
    };
  }

  return {
    kind: "create-project",
    creation: {
      workspaceRoot: selectedWorkspaceRoot,
      title: buildProjectTitleFromWorkspaceRoot(selectedWorkspaceRoot),
      kind: "project",
      createWorkspaceRootIfMissing: false,
      defaultModelSelection: createDefaultModelSelection,
    },
  };
}
