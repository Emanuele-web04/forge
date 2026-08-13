// FILE: startContainerChat.ts
// Purpose: Shared "ensure the hidden container project, then open a thread inside it" flow
//          used by both the home-chat and Studio new-chat hooks.
// Layer: Web orchestration helper
// Exports: Container-chat startup plus segment-aware fresh-chat dispatch.

import type { ProjectId, ThreadId } from "@synara/contracts";
import type { Project } from "../types";
import { isStudioContainerProject } from "./studioProjects";
import type { ServerWorkspacePaths } from "./serverWorkspacePaths";
import type { NewThreadOptions } from "./threadBootstrap";

export type StartContainerChatResult =
  | { ok: true; threadId: ThreadId | null }
  | { ok: false; error: string };

type StartFreshContainerChat = (options?: { fresh?: boolean }) => Promise<StartContainerChatResult>;

/**
 * Starts a fresh chat in the surface that owns the active project. Thread routes are shared by
 * Projects and Studio, so callers cannot infer the surface from the URL alone.
 */
export function startFreshChatForActiveSurface(input: {
  readonly activeProject: Pick<Project, "cwd" | "kind"> | null;
  readonly isStudioRoute: boolean;
  readonly paths: ServerWorkspacePaths;
  readonly handleNewChat: StartFreshContainerChat;
  readonly handleNewStudioChat: StartFreshContainerChat;
}): Promise<StartContainerChatResult> {
  const isStudio =
    input.isStudioRoute || isStudioContainerProject(input.activeProject, input.paths);
  const handler = isStudio ? input.handleNewStudioChat : input.handleNewChat;
  // Studio always mints a fresh draft; home chat reuses the stored draft thread
  // when one exists (so a draft typed in a new chat survives switching threads),
  // falling back to a fresh draft only when there is nothing to resume.
  return isStudio ? handler({ fresh: true }) : handler();
}

/**
 * Resolves (creating if needed) the backing container project, then starts a thread inside it.
 * Both home chats and Studio chats share this exact flow; only the container resolver and the
 * user-facing failure label vary.
 */
export async function startContainerChat(input: {
  readonly ensureProjectId: () => Promise<ProjectId | null>;
  readonly handleNewThread: (
    projectId: ProjectId,
    options?: NewThreadOptions,
  ) => Promise<ThreadId | null>;
  readonly fresh?: boolean | undefined;
  readonly forceLocalWorkspace?: boolean | undefined;
  readonly errorLabel: string;
}): Promise<StartContainerChatResult> {
  try {
    const projectId = await input.ensureProjectId();
    if (!projectId) {
      return { ok: false, error: input.errorLabel };
    }
    const threadOptions: NewThreadOptions | undefined =
      input.fresh === true || input.forceLocalWorkspace === true
        ? {
            ...(input.fresh === true ? { fresh: true } : {}),
            envMode: "local",
            branch: null,
            worktreePath: null,
          }
        : undefined;
    const threadId = await input.handleNewThread(projectId, threadOptions);
    return { ok: true, threadId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : input.errorLabel,
    };
  }
}
