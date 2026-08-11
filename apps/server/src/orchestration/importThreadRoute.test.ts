import assert from "node:assert/strict";
import {
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  type ProviderSession,
  ThreadId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import { makeImportThreadHandler } from "./importThreadRoute";

const threadId = ThreadId.makeUnsafe("thread-import");
const projectId = ProjectId.makeUnsafe("project-import");
const importedAt = "2026-08-09T12:00:00.000Z";

function makeCodexThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Imported thread",
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    createdAt: importedAt,
    updatedAt: importedAt,
    archivedAt: null,
    settledAt: null,
    deletedAt: null,
    handoff: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

it.effect("imports Codex history through a provider-owned fork", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const externalId = "019fbe83-572e-7092-a84e-5ba7285ca2c5";
    const dispatchedCommands: OrchestrationCommand[] = [];
    const session: ProviderSession = {
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      threadId,
      resumeCursor: { threadId: "forked-codex-thread" },
      createdAt: importedAt,
      updatedAt: importedAt,
    };
    const startSession = vi.fn(() => Effect.succeed(session));
    const readThread = vi.fn(() =>
      Effect.succeed({
        threadId: "forked-codex-thread",
        turns: [],
      }),
    );

    const handler = makeImportThreadHandler({
      fileSystem,
      path,
      platform: process.platform,
      orchestrationEngine: {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatchedCommands.push(command);
            return { sequence: dispatchedCommands.length };
          }),
      } as unknown as OrchestrationEngineShape,
      projectionSnapshotQuery: {
        getThreadDetailById: () => Effect.succeed(Option.some(makeCodexThread())),
        getProjectShellById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQueryShape,
      providerAdapterRegistry: {
        getByProvider: () =>
          Effect.succeed({
            readThread,
          } as never),
      } as unknown as ProviderAdapterRegistryShape,
      providerService: {
        startSession,
        stopSession: () => Effect.void,
      } as unknown as ProviderServiceShape,
    });

    const result = yield* handler({ threadId, externalId });

    assert.deepEqual(result, { threadId });
    assert.deepEqual(startSession.mock.calls[0], [
      threadId,
      {
        threadId,
        provider: "codex",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        forkSourceResumeCursor: { threadId: externalId },
        runtimeMode: "full-access",
      },
    ]);
    assert.deepEqual(readThread.mock.calls, [[threadId]]);
    assert.equal(dispatchedCommands.at(-1)?.type, "thread.session.set");
  }).pipe(Effect.provide(NodeServices.layer)),
);
