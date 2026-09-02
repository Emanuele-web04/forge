// FILE: effectRpcWebSocketMock.ts
// Purpose: Tiny browser-test adapter for Effect RPC's JSON WebSocket frames.
// Layer: Web test utility
// Exports: helpers for request parsing plus Exit/Chunk/Pong responses.

import {
  WS_BOOTSTRAP_METHOD,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_SERVER_CAPABILITIES,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";

export interface EffectRpcWebSocketClient {
  readonly send: (data: string) => void;
  readonly url?: URL;
}

export interface EffectRpcRequest {
  readonly id: string;
  readonly tag: string;
  readonly payload: unknown;
}

export type EffectRpcReadResult =
  | { readonly kind: "request"; readonly request: EffectRpcRequest }
  | { readonly kind: "handled" }
  | { readonly kind: "ignored" };

export function readEffectRpcClientMessage(
  client: EffectRpcWebSocketClient,
  data: string,
): EffectRpcReadResult {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return { kind: "ignored" };
  }

  if (!message || typeof message !== "object") {
    return { kind: "ignored" };
  }

  const frame = message as Record<string, unknown>;
  if (frame._tag === "Ping") {
    client.send(JSON.stringify({ _tag: "Pong" }));
    return { kind: "handled" };
  }

  if (frame._tag === "Request" && typeof frame.id === "string" && typeof frame.tag === "string") {
    if (frame.tag === WS_BOOTSTRAP_METHOD) {
      sendEffectRpcExit(client, frame.id, {
        protocolEpoch: WS_PROTOCOL_EPOCH,
        negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
        serverBuild: "browser-test",
        serverInstanceId: "browser-test-server",
        capabilities: [...WS_SERVER_CAPABILITIES],
      });
      return { kind: "handled" };
    }

    return {
      kind: "request",
      request: {
        id: frame.id,
        tag: frame.tag,
        payload: frame.payload ?? {},
      },
    };
  }

  if (
    frame._tag === "Ack" ||
    frame._tag === "Interrupt" ||
    frame._tag === "Eof" ||
    frame._tag === "Pong"
  ) {
    return { kind: "handled" };
  }

  return { kind: "ignored" };
}

export function sendEffectRpcExit(
  client: EffectRpcWebSocketClient,
  requestId: string,
  value: unknown,
): void {
  client.send(
    JSON.stringify({
      _tag: "Exit",
      requestId,
      exit: {
        _tag: "Success",
        value,
      },
    }),
  );
}

export function sendEffectRpcChunk(
  client: EffectRpcWebSocketClient,
  requestId: string,
  value: unknown,
): void {
  client.send(
    JSON.stringify({
      _tag: "Chunk",
      requestId,
      values: [value],
    }),
  );
}

export function flattenEffectRpcRequestPayload(
  tag: string,
  payload: unknown,
): { readonly _tag: string; readonly [key: string]: unknown } {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return { _tag: tag, ...(payload as Record<string, unknown>) };
  }
  return { _tag: tag, value: payload };
}

export function createShellSnapshotFromReadModel(
  snapshot: OrchestrationReadModel,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    spaces: snapshot.spaces
      .filter((space) => space.deletedAt === null)
      .map(({ deletedAt: _deletedAt, ...space }) => space),
    projects: snapshot.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => ({
        id: project.id,
        kind: project.kind,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        defaultModelSelection: project.defaultModelSelection,
        scripts: project.scripts,
        spaceId: project.spaceId,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      })),
    threads: snapshot.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => ({
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        interactionMode: thread.interactionMode,
        runtimeMode: thread.runtimeMode,
        envMode: thread.envMode,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        associatedWorktreePath: thread.associatedWorktreePath ?? null,
        associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
        associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
        parentThreadId: thread.parentThreadId ?? null,
        subagentAgentId: thread.subagentAgentId ?? null,
        subagentNickname: thread.subagentNickname ?? null,
        subagentRole: thread.subagentRole ?? null,
        forkSourceThreadId: thread.forkSourceThreadId ?? null,
        sidechatSourceThreadId: thread.sidechatSourceThreadId ?? null,
        sidechatLastActivityAt: thread.sidechatLastActivityAt ?? null,
        sidechatExpiredAt: thread.sidechatExpiredAt ?? null,
        latestTurn: thread.latestTurn,
        latestUserMessageAt: thread.latestUserMessageAt ?? null,
        hasPendingApprovals: thread.hasPendingApprovals ?? false,
        hasPendingUserInput: thread.hasPendingUserInput ?? false,
        hasActionableProposedPlan: thread.hasActionableProposedPlan ?? false,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archivedAt: thread.archivedAt ?? null,
        handoff: thread.handoff ?? null,
        session: thread.session,
      })),
    updatedAt: snapshot.updatedAt,
  };
}
