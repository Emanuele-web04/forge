import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROVIDER_PROFILE_ID,
  CommandId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
  type NativeApi,
} from "@synara/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";
import { isDuplicateThreadCreateError, promoteThreadCreate } from "./threadCreatePromotion";

const initialStoreState = useStore.getState();
const initialComposerDraftState = useComposerDraftStore.getState();

afterEach(() => {
  useStore.setState(initialStoreState, true);
  useComposerDraftStore.setState(initialComposerDraftState, true);
});

function makeApi(input: {
  dispatchCommand: ReturnType<typeof vi.fn>;
  getShellSnapshot?: ReturnType<typeof vi.fn>;
}): NativeApi {
  return {
    orchestration: {
      dispatchCommand: input.dispatchCommand,
      getShellSnapshot: input.getShellSnapshot ?? vi.fn(),
    },
  } as unknown as NativeApi;
}

function makeThreadCreateCommand(threadId = "thread-promote") {
  return {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`cmd-${threadId}`),
    threadId: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-promote"),
    title: "Promoted thread",
    modelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    createdAt: "2026-05-06T20:00:00.000Z",
  } satisfies Extract<ClientOrchestrationCommand, { type: "thread.create" }>;
}

describe("threadCreatePromotion", () => {
  it("recognizes duplicate thread.create invariant errors", () => {
    expect(
      isDuplicateThreadCreateError(
        new Error(
          "Orchestration command invariant failed (thread.create): Thread 'thread-promote' already exists and cannot be created twice.",
        ),
        ThreadId.makeUnsafe("thread-promote"),
      ),
    ).toBe(true);
  });

  it("joins concurrent promotions for the same thread id", async () => {
    let resolveDispatch: (() => void) | null = null;
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          resolveDispatch = () => resolve({ sequence: 1 });
        }),
    );
    const api = makeApi({ dispatchCommand });
    const command = makeThreadCreateCommand("thread-concurrent");

    const first = promoteThreadCreate(command, api);
    const second = promoteThreadCreate(
      { ...command, commandId: CommandId.makeUnsafe("cmd-thread-concurrent-second") },
      api,
    );
    expect(resolveDispatch).not.toBeNull();
    (resolveDispatch as unknown as () => void)();

    await expect(first).resolves.toBe("created");
    await expect(second).resolves.toBe("exists");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it("marks the draft as promoted when the thread already exists locally", async () => {
    const threadId = ThreadId.makeUnsafe("thread-existing-local");
    const projectId = ProjectId.makeUnsafe("project-promote");
    useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId);
    useStore.getState().syncServerShellSnapshot({
      snapshotSequence: 1,
      spaces: [],
      projects: [
        {
          id: projectId,
          kind: "project",
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-05-06T20:00:00.000Z",
          updatedAt: "2026-05-06T20:00:00.000Z",
        },
      ],
      threads: [
        {
          id: threadId,
          projectId,
          title: "Promoted thread",
          modelSelection: {
            provider: "codex",
            profileId: DEFAULT_PROVIDER_PROFILE_ID,
            model: "gpt-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
          createBranchFlowCompleted: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: null,
          sidechatSourceThreadId: null,
          lastKnownPr: null,
          latestTurn: null,
          createdAt: "2026-05-06T20:00:00.000Z",
          updatedAt: "2026-05-06T20:00:00.000Z",
          archivedAt: null,
          handoff: null,
          session: null,
        },
      ],
      updatedAt: "2026-05-06T20:00:00.000Z",
    });
    const api = makeApi({ dispatchCommand: vi.fn() });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
  });

  it("recovers duplicate promotions by syncing the shell snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-duplicate-recovered");
    const projectId = ProjectId.makeUnsafe("project-promote");
    const dispatchCommand = vi.fn(() =>
      Promise.reject(
        new Error(
          `Orchestration command invariant failed (thread.create): Thread '${threadId}' already exists and cannot be created twice.`,
        ),
      ),
    );
    const getShellSnapshot = vi.fn(() =>
      Promise.resolve({
        snapshotSequence: 1,
        spaces: [],
        projects: [
          {
            id: projectId,
            kind: "project",
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-05-06T20:00:00.000Z",
            updatedAt: "2026-05-06T20:00:00.000Z",
          },
        ],
        threads: [
          {
            id: threadId,
            projectId,
            title: "Promoted thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
            associatedWorktreePath: null,
            associatedWorktreeBranch: null,
            associatedWorktreeRef: null,
            createBranchFlowCompleted: false,
            parentThreadId: null,
            subagentAgentId: null,
            subagentNickname: null,
            subagentRole: null,
            forkSourceThreadId: null,
            sidechatSourceThreadId: null,
            lastKnownPr: null,
            latestTurn: null,
            createdAt: "2026-05-06T20:00:00.000Z",
            updatedAt: "2026-05-06T20:00:00.000Z",
            archivedAt: null,
            handoff: null,
            session: null,
          },
        ],
        updatedAt: "2026-05-06T20:00:00.000Z",
      }),
    );
    const api = makeApi({ dispatchCommand, getShellSnapshot });

    await expect(promoteThreadCreate(makeThreadCreateCommand(threadId), api)).resolves.toBe(
      "exists",
    );
    expect(getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(getThreadFromState(useStore.getState(), threadId)?.id).toBe(threadId);
  });
});
