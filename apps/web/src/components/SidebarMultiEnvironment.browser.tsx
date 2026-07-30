// FILE: SidebarMultiEnvironment.browser.tsx
// Purpose: Proves the sidebar renders threads aggregated across two environments.
// Layer: Browser UI test

import "../index.css";

import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { LOCAL_ENVIRONMENT_ID } from "../environmentIdentity";
import { createShellAggregator } from "../shellAggregation";
import { useStore } from "../store";
import { createSidebarThreadSummariesSelector } from "../storeSelectors";
import { initialState } from "../storeState";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("bbbbbbbb-2222-4222-8222-222222222222");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const LOCAL_THREAD_ID = ThreadId.makeUnsafe("thread-local-1");
const REMOTE_THREAD_ID = ThreadId.makeUnsafe("thread-remote-1");

function makeSnapshot(
  snapshotSequence: number,
  threadId: ThreadId,
  title: string,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    updatedAt: "2026-02-27T00:01:00.000Z",
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: { provider: "codex", model: "gpt-5.3-codex" },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        scripts: [],
        spaceId: null,
      },
    ],
    threads: [
      {
        id: threadId,
        projectId: PROJECT_ID,
        title,
        modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
        runtimeMode: "danger-full-access",
        interactionMode: "agent",
        envMode: "local",
        branch: null,
        worktreePath: null,
        forkSourceThreadId: null,
        sidechatSourceThreadId: null,
        latestTurn: null,
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:30.000Z",
        handoff: null,
        session: null,
      },
    ],
  } as unknown as OrchestrationShellSnapshot;
}

/** Renders the sidebar rows the store currently holds, in store order. */
function SidebarThreadList() {
  const summaries = useStore(createSidebarThreadSummariesSelector());
  return (
    <div>
      {summaries.map((thread) => (
        <SidebarThreadRowContent
          key={thread.id}
          thread={thread}
          terminalEntryPoint={false}
          terminalStatus={null}
          terminalCount={0}
          isActive={false}
          variant="pinned"
          pendingStatusColorClass="text-amber-600"
        />
      ))}
    </div>
  );
}

describe("sidebar aggregation across environments", () => {
  afterEach(() => {
    useStore.setState(initialState);
    document.body.innerHTML = "";
  });

  it("renders threads from two environments that both emit snapshot sequence 1", async () => {
    // The exact failure this guards: snapshot sequences are per-server
    // autoincrement values, so two servers both starting at 1 is normal. A
    // shared fence would drop B's snapshot as stale, and a shared prune would
    // delete A's thread — either way one row silently disappears.
    useStore.setState(initialState);

    const aggregator = createShellAggregator({
      syncServerShellSnapshot: (snapshot, environmentId) =>
        useStore.getState().syncServerShellSnapshot(snapshot, environmentId),
    });

    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot(1, LOCAL_THREAD_ID, "Local server thread"),
        LOCAL_ENVIRONMENT_ID,
      );
    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot(1, REMOTE_THREAD_ID, "Remote server thread"),
        REMOTE_ENVIRONMENT_ID,
      );

    const screen = await render(<SidebarThreadList />);

    await expect
      .element(screen.getByTestId(`thread-title-${LOCAL_THREAD_ID}`))
      .toHaveTextContent("Local server thread");
    await expect
      .element(screen.getByTestId(`thread-title-${REMOTE_THREAD_ID}`))
      .toHaveTextContent("Remote server thread");

    // Ownership is recorded so later snapshots prune only their own server's rows.
    expect(useStore.getState().environmentIdByThreadId?.[REMOTE_THREAD_ID]).toBe(
      REMOTE_ENVIRONMENT_ID,
    );
    aggregator.detachAll();
  });

  it("keeps the other environment's row when one environment resyncs without it", async () => {
    useStore.setState(initialState);

    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot(1, LOCAL_THREAD_ID, "Local server thread"),
        LOCAL_ENVIRONMENT_ID,
      );
    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot(1, REMOTE_THREAD_ID, "Remote server thread"),
        REMOTE_ENVIRONMENT_ID,
      );
    // The local server resyncs at a higher sequence and does not list the remote
    // thread — it has no authority over it.
    useStore
      .getState()
      .syncServerShellSnapshot(
        makeSnapshot(9, LOCAL_THREAD_ID, "Local server thread renamed"),
        LOCAL_ENVIRONMENT_ID,
      );

    const screen = await render(<SidebarThreadList />);

    await expect
      .element(screen.getByTestId(`thread-title-${REMOTE_THREAD_ID}`))
      .toHaveTextContent("Remote server thread");
    await expect
      .element(screen.getByTestId(`thread-title-${LOCAL_THREAD_ID}`))
      .toHaveTextContent("Local server thread renamed");
  });
});
