// FILE: chatIndexRoute.logic.ts
// Purpose: The "/" landing's restore policy — which remembered thread route the home-chat
//          surface may reopen, and under which Space.
// Layer: Route UI logic helpers
// Exports: home-chat restore-route resolution.

import type { ProjectId, SpaceId, ThreadId } from "@synara/contracts";

import { resolveRestorableThreadRoute, type LastThreadRoute } from "../chatRouteRestore";
import type { ServerWorkspacePaths } from "../lib/serverWorkspacePaths";
import { isThreadReachableFromSpace } from "../lib/spaceNavigation";
import type { Project } from "../types";

/**
 * Set only when "/" was reached by *selecting* a Space. The landing then restores threads that
 * Space can reach and nothing else. Without it — cold start, a deep link, a plain refresh — the
 * remembered route decides the Space instead: `activeSpaceId` lives in sessionStorage and is
 * empty on a fresh launch, while the remembered route lives in localStorage and survives, so
 * scoping unconditionally would drop the user out of the Space they left the app in.
 */
export interface ChatIndexLandingSpace {
  readonly spaceId: SpaceId | null;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly workspacePaths: ServerWorkspacePaths;
}

export function resolveChatIndexRestoreRoute(input: {
  readonly lastThreadRoute: LastThreadRoute | null;
  readonly availableSplitViewIds: ReadonlySet<string>;
  readonly threadIds: readonly ThreadId[];
  readonly sidebarThreadSummaryById: Readonly<
    Record<
      string,
      | {
          readonly projectId: ProjectId;
          readonly sidechatSourceThreadId?: ThreadId | null;
        }
      | undefined
    >
  >;
  readonly studioProjectIds: ReadonlySet<ProjectId>;
  /**
   * Still-unsent chat drafts. They have a route id but no sidebar summary yet, so the summary
   * lookup below never matches them — mirrors the /studio landing's draft handling so a cold
   * start on "/" can reopen an unsent draft instead of always minting a new one.
   */
  readonly draftProjectIdByThreadId: ReadonlyMap<string, ProjectId>;
  /**
   * Populated panes from the split named by `lastThreadRoute`. `undefined` means the current
   * client state could not resolve that split, so a Space-scoped restore must fail closed.
   */
  readonly rememberedSplitViewThreadIds: readonly ThreadId[] | undefined;
  readonly landingSpace: ChatIndexLandingSpace | null;
}): LastThreadRoute | null {
  const { draftProjectIdByThreadId, landingSpace, sidebarThreadSummaryById, studioProjectIds } =
    input;

  const availableThreadIds = new Set<string>();
  for (const threadId of [...input.threadIds, ...draftProjectIdByThreadId.keys()]) {
    // Fail closed: a thread we can't classify is not restorable from "/". Summaries are built
    // from the same snapshot as threadIds, so this only ever excludes a thread if that invariant
    // breaks — and then a fresh draft beats restoring into the wrong segment.
    const threadSummary = sidebarThreadSummaryById[threadId];
    if (threadSummary?.sidechatSourceThreadId) continue;
    const projectId = threadSummary?.projectId ?? draftProjectIdByThreadId.get(threadId);
    if (projectId === undefined) continue;
    // Studio threads belong to the /studio surface; restoring one from "/" would silently
    // switch the user into that segment.
    if (studioProjectIds.has(projectId)) continue;
    if (
      landingSpace &&
      !isThreadReachableFromSpace({
        project: landingSpace.projectById.get(projectId),
        spaceId: landingSpace.spaceId,
        paths: landingSpace.workspacePaths,
      })
    ) {
      continue;
    }
    availableThreadIds.add(threadId);
  }

  const restorableRoute = resolveRestorableThreadRoute({
    lastThreadRoute: input.lastThreadRoute,
    availableThreadIds,
    availableSplitViewIds: input.availableSplitViewIds,
  });
  if (!landingSpace || !restorableRoute?.splitViewId) {
    return restorableRoute;
  }

  const splitThreadIds = input.rememberedSplitViewThreadIds;
  if (
    splitThreadIds === undefined ||
    splitThreadIds.length === 0 ||
    splitThreadIds.some((threadId) => !availableThreadIds.has(threadId))
  ) {
    return { threadId: restorableRoute.threadId };
  }

  return restorableRoute;
}
