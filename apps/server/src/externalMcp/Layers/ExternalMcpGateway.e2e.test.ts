import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ServerProviderStatus,
} from "@synara/contracts";
import { MessageId, ProjectId, TurnId } from "@synara/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { AgentGatewayOperationRepositoryLive } from "../../agentGateway/Layers/AgentGatewayOperationRepository.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { serveExternalMcpStdio, writeExternalMcpClientCredential } from "../bridge.ts";
import {
  computeExternalMcpRuntimeProof,
  EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER,
} from "../runtimeProof.ts";
import { ExternalMcpGateway } from "../Services/ExternalMcpGateway.ts";
import { ExternalMcpService } from "../Services/ExternalMcpService.ts";
import { ExternalMcpRepositoryLive } from "./ExternalMcpRepository.ts";
import { ExternalMcpGatewayLive } from "./ExternalMcpGateway.ts";
import { ExternalMcpServiceLive } from "./ExternalMcpService.ts";

const temporaryDirectories: string[] = [];
const NOW = "2026-07-20T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-external-e2e");
const TURN_ID = TurnId.makeUnsafe("turn-external-e2e");
const RUNTIME_SECRET = "external-mcp-e2e-runtime-secret-0001";

function projectShell(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    kind: "project",
    title: "External MCP project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function emptyThreadDetail(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    pinnedMessages: [],
    threadMarkers: [],
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

function toolPayload(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as { readonly content?: ReadonlyArray<{ readonly text: string }> };
  return JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function writeRuntimeState(baseDir: string): void {
  const runtimeDirectory = path.join(baseDir, "userdata");
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(runtimeDirectory, 0o700);
  const runtimePath = path.join(runtimeDirectory, "server-runtime.json");
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: 3773,
      origin: "http://127.0.0.1:3773",
      startedAt: NOW,
      externalMcpRuntimeSecret: RUNTIME_SECRET,
    }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") fs.chmodSync(runtimePath, 0o600);
}

async function waitForOutput(
  lines: ReadonlyArray<Record<string, unknown>>,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (lines.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (lines.length < count) throw new Error(`Timed out waiting for stdio response ${count}.`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("external MCP gateway stdio flow", () => {
  it("pairs, filters tools, creates one safe task, waits, reads, and audits without prompt leakage", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-external-e2e-"));
    temporaryDirectories.push(baseDir);
    const workspaceRoot = path.join(baseDir, "project");
    const worktreesDir = path.join(baseDir, "worktrees");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(worktreesDir, { recursive: true });

    const project = projectShell(workspaceRoot);
    const threads = new Map<string, OrchestrationThreadShell>();
    const details = new Map<string, OrchestrationThread>();
    const dispatched: OrchestrationCommand[] = [];
    const worktreeCreates: Array<{ readonly path?: string }> = [];

    const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [project],
          threads: [...threads.values()],
          updatedAt: NOW,
        }),
      getProjectShellById: (projectId: string) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      getThreadShellById: (threadId: string) =>
        Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
      getThreadDetailById: (threadId: string) =>
        Effect.succeed(Option.fromNullishOr(details.get(threadId))),
    } as never);

    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          if (command.type === "thread.create") {
            const shell = {
              id: command.threadId,
              projectId: command.projectId,
              title: command.title,
              modelSelection: command.modelSelection,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              envMode: command.envMode,
              branch: command.branch,
              worktreePath: command.worktreePath,
              associatedWorktreePath: command.associatedWorktreePath ?? null,
              associatedWorktreeBranch: command.associatedWorktreeBranch ?? null,
              associatedWorktreeRef: command.associatedWorktreeRef ?? null,
              createBranchFlowCompleted: false,
              isPinned: false,
              parentThreadId: null,
              subagentAgentId: null,
              subagentNickname: null,
              subagentRole: null,
              forkSourceThreadId: null,
              sidechatSourceThreadId: null,
              lastKnownPr: null,
              latestTurn: null,
              latestUserMessageAt: null,
              creationSource: command.creationSource,
              gatewayOperationId: command.gatewayOperationId,
              gatewayOperationIndex: command.gatewayOperationIndex,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
              archivedAt: null,
              handoff: null,
              session: null,
            } as OrchestrationThreadShell;
            threads.set(shell.id, shell);
            details.set(shell.id, emptyThreadDetail(shell));
          }
          if (command.type === "thread.turn.start") {
            const prior = threads.get(command.threadId);
            if (!prior) throw new Error("Turn dispatched before thread creation.");
            const assistantMessageId = MessageId.makeUnsafe("message-external-e2e-result");
            const shell: OrchestrationThreadShell = {
              ...prior,
              latestTurn: {
                turnId: TURN_ID,
                state: "completed",
                requestedAt: command.createdAt,
                startedAt: command.createdAt,
                completedAt: command.createdAt,
                assistantMessageId,
              },
              latestUserMessageAt: command.createdAt,
              updatedAt: command.createdAt,
            };
            threads.set(shell.id, shell);
            details.set(shell.id, {
              ...emptyThreadDetail(shell),
              messages: [
                {
                  id: command.message.messageId,
                  role: "user",
                  text: command.message.text,
                  attachments: [],
                  dispatchMode: command.dispatchMode,
                  dispatchOrigin: command.dispatchOrigin,
                  turnId: TURN_ID,
                  streaming: false,
                  source: "native",
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
                {
                  id: assistantMessageId,
                  role: "assistant",
                  text: "Finished from external MCP.",
                  turnId: TURN_ID,
                  streaming: false,
                  source: "native",
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                },
              ],
            });
          }
          return { sequence: dispatched.length };
        }),
    } as never);

    const gitLayer = Layer.succeed(GitCore, {
      withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      execute: () =>
        Effect.succeed({
          code: 0,
          stdout: "0123456789abcdef0123456789abcdef01234567\n",
          stderr: "",
        }),
      createDetachedWorktree: (input: {
        readonly path?: string;
        readonly ref: string;
        readonly newBranch?: string;
      }) =>
        Effect.sync(() => {
          worktreeCreates.push(input);
          return {
            worktree: {
              path: input.path ?? path.join(worktreesDir, "generated"),
              ref: input.ref,
              branch: input.newBranch ?? null,
            },
          };
        }),
      recordWorktreeOwnership: (input: {
        readonly path: string;
        readonly branch: string | null;
        readonly token: string;
      }) =>
        Effect.succeed({
          token: input.token,
          gitDir: path.join(baseDir, "git-admin", input.token),
          branch: input.branch,
          head: "0123456789abcdef0123456789abcdef01234567",
        }),
      listBranches: () => Effect.succeed({ isRepo: true, hasOriginRemote: false, branches: [] }),
      verifyWorktreeOwnership: () => Effect.succeed({ verified: true, reason: null }),
      removeWorktree: () => Effect.void,
      deleteBranchIfUnchanged: () => Effect.void,
    } as never);

    const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
      listModels: ({ provider }: { readonly provider: string }) =>
        Effect.succeed({
          models: provider === "codex" ? [{ slug: "gpt-5.5", name: "GPT-5.5" }] : [],
          source: "test",
        }),
    } as never);
    const providerStatuses: ReadonlyArray<ServerProviderStatus> = [
      "codex",
      "claudeAgent",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "opencode",
      "pi",
    ].map((provider) => ({
      provider: provider as ServerProviderStatus["provider"],
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: NOW,
    }));
    const providerHealthLayer = Layer.succeed(ProviderHealth, {
      getStatuses: Effect.succeed(providerStatuses),
      refresh: Effect.succeed(providerStatuses),
      updateProvider: () => Effect.die("not used"),
      streamChanges: Stream.empty,
    } as never);
    const projectionTurnsLayer = Layer.succeed(ProjectionTurnRepository, {
      getManyWaitSnapshot: () =>
        Effect.succeed({ existingThreadIds: [...threads.keys()], turns: [] }),
    } as never);
    const configLayer = Layer.succeed(ServerConfig, {
      baseDir,
      worktreesDir,
      host: "127.0.0.1",
      publicUrl: undefined,
    } as never);

    const repositoryLayer = ExternalMcpRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const operationLayer = AgentGatewayOperationRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const serviceLayer = ExternalMcpServiceLive.pipe(
      Layer.provideMerge(repositoryLayer),
      Layer.provide(snapshotLayer),
      Layer.provide(configLayer),
    );
    const gatewayLayer = ExternalMcpGatewayLive.pipe(
      Layer.provideMerge(serviceLayer),
      Layer.provideMerge(repositoryLayer),
      Layer.provide(snapshotLayer),
      Layer.provide(engineLayer),
      Layer.provide(gitLayer),
      Layer.provide(providerDiscoveryLayer),
      Layer.provide(providerHealthLayer),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(projectionTurnsLayer),
      Layer.provide(operationLayer),
      Layer.provide(configLayer),
    );
    const testLayer = Layer.mergeAll(gatewayLayer, serviceLayer, SqlitePersistenceMemory);

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ExternalMcpService;
        const gateway = yield* ExternalMcpGateway;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${PROJECT_ID}, ${project.title}, ${project.workspaceRoot}, '[]', ${NOW}, ${NOW}, NULL
          )
        `;
        const issued = yield* service.createIntegration({
          name: "Codex e2e",
          projectIds: [PROJECT_ID],
          capabilities: ["projects:read", "tasks:create", "tasks:wait", "tasks:read"],
          expiresInDays: 30,
        });
        const paired = yield* service.pair(
          issued.pairingCode,
          "syn_mcp_v1_e2e-client-generated-secret",
        );
        writeRuntimeState(baseDir);
        writeExternalMcpClientCredential(baseDir, paired);

        const stdin = new PassThrough();
        const outputLines: Record<string, unknown>[] = [];
        let outputBuffer = "";
        const stdout = new Writable({
          write(chunk, _encoding, done) {
            outputBuffer += String(chunk);
            const lines = outputBuffer.split("\n");
            outputBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) outputLines.push(JSON.parse(line) as Record<string, unknown>);
            }
            done();
          },
        });
        const errors: string[] = [];
        const stderr = new Writable({
          write(chunk, _encoding, done) {
            errors.push(String(chunk));
            done();
          },
        });
        const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
          if (String(url).endsWith("/api/mcp/external/runtime-challenge")) {
            const nonce = new Headers(init?.headers).get(EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER)!;
            return Response.json({
              proof: computeExternalMcpRuntimeProof(RUNTIME_SECRET, nonce),
            });
          }
          const response = await Effect.runPromise(
            gateway.handlePost({
              authorizationHeader: new Headers(init?.headers).get("authorization") ?? undefined,
              body: JSON.parse(String(init?.body ?? "null")),
            }),
          );
          return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        };
        const serving = serveExternalMcpStdio({
          baseDir,
          stdin,
          stdout,
          stderr,
          fetchImpl,
        });

        stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`,
        );
        yield* Effect.promise(() => waitForOutput(outputLines, 1));
        const listedTools = (
          outputLines[0]!.result as {
            tools: Array<{
              name: string;
              inputSchema: { properties?: Record<string, unknown> };
            }>;
          }
        ).tools;
        expect(listedTools.map((tool) => tool.name)).toEqual([
          "synara_overview",
          "synara_capabilities",
          "synara_list_allowed_projects",
          "synara_create_task",
          "synara_wait_for_task",
          "synara_read_task",
        ]);
        const readTaskProperties = listedTools.find((tool) => tool.name === "synara_read_task")
          ?.inputSchema.properties;
        expect(readTaskProperties?.maxMessageChars).toMatchObject({
          type: "integer",
          minimum: 50,
          maximum: 10_000,
        });
        expect(readTaskProperties?.messageIndex).toMatchObject({
          type: "integer",
          minimum: 0,
        });
        expect(readTaskProperties?.messageOffsetChars).toMatchObject({
          type: "integer",
          minimum: 0,
        });
        expect(readTaskProperties?.messageId).toMatchObject({ type: "string" });
        expect(readTaskProperties?.messageVersion).toMatchObject({ type: "string" });

        const prompt = "Implement the external MCP end-to-end proof.";
        stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "synara_create_task",
              arguments: {
                requestId: "external-e2e-request",
                projectId: PROJECT_ID,
                provider: "codex",
                model: "gpt-5.5",
                prompt,
              },
            },
          })}\n`,
        );
        yield* Effect.promise(() => waitForOutput(outputLines, 2));
        const created = toolPayload(outputLines[1]!);
        const threadId = (created.threadIds as string[])[0]!;
        expect((created.threads as Array<Record<string, unknown>>)[0]).toMatchObject({
          threadId,
          projectId: PROJECT_ID,
          environment: "worktree",
          runtimeMode: "approval-required",
        });
        expect(worktreeCreates).toHaveLength(1);
        const createCommand = dispatched.find((command) => command.type === "thread.create");
        expect(createCommand).toMatchObject({
          creationSource: "external_mcp",
          envMode: "worktree",
          runtimeMode: "approval-required",
        });
        expect(createCommand).not.toHaveProperty("sourceThreadId");
        expect(createCommand).not.toHaveProperty("sourceTurnId");

        stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "synara_wait_for_task",
              arguments: { threadId, timeoutMs: 1_000 },
            },
          })}\n`,
        );
        yield* Effect.promise(() => waitForOutput(outputLines, 3));
        expect(toolPayload(outputLines[2]!)).toMatchObject({
          threadId,
          runId: TURN_ID,
          state: "completed",
          terminal: true,
          timedOut: false,
          summary: "Finished from external MCP.",
        });

        const longText = Array.from({ length: 25_007 }, (_, index) => String(index % 10)).join("");
        const currentDetail = details.get(threadId)!;
        details.set(threadId, {
          ...currentDetail,
          messages: currentDetail.messages.map((message) =>
            message.role === "assistant" ? { ...message, text: longText } : message,
          ),
        });

        stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: { name: "synara_read_task", arguments: { threadId } },
          })}\n`,
        );
        yield* Effect.promise(() => waitForOutput(outputLines, 4));
        const summaryMessages = toolPayload(outputLines[3]!).messages as Array<{
          index: number;
          messageId: string;
          messageVersion: string;
        }>;
        const assistantSummary = summaryMessages.find((message) => message.index === 1)!;

        for (const [index, messageOffsetChars] of [0, 10_000, 20_000].entries()) {
          stdin.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: index + 5,
              method: "tools/call",
              params: {
                name: "synara_read_task",
                arguments: {
                  threadId,
                  messageIndex: 1,
                  messageOffsetChars,
                  messageId: assistantSummary.messageId,
                  messageVersion: assistantSummary.messageVersion,
                  maxMessageChars: 10_000,
                },
              },
            })}\n`,
          );
        }
        stdin.end();
        yield* Effect.promise(() => serving);
        expect(errors).toEqual([]);
        const responseById = new Map(outputLines.map((response) => [response.id, response]));
        const messagePages = [5, 6, 7].map((id) => toolPayload(responseById.get(id)!));
        expect(messagePages.map((page) => page.effectiveMaxMessageChars)).toEqual([
          10_000, 10_000, 10_000,
        ]);
        expect(
          messagePages
            .map((page) => (page.messages as Array<{ text: string }>)[0]?.text ?? "")
            .join(""),
        ).toBe(longText);
        expect(messagePages.map((page) => page.messagePage)).toEqual([
          {
            index: 1,
            messageId: "message-external-e2e-result",
            messageVersion: assistantSummary.messageVersion,
            offsetChars: 0,
            endOffsetChars: 10_000,
            totalChars: 25_007,
            nextOffsetChars: 10_000,
          },
          {
            index: 1,
            messageId: "message-external-e2e-result",
            messageVersion: assistantSummary.messageVersion,
            offsetChars: 10_000,
            endOffsetChars: 20_000,
            totalChars: 25_007,
            nextOffsetChars: 20_000,
          },
          {
            index: 1,
            messageId: "message-external-e2e-result",
            messageVersion: assistantSummary.messageVersion,
            offsetChars: 20_000,
            endOffsetChars: 25_007,
            totalChars: 25_007,
          },
        ]);

        const interruptedWait = yield* gateway
          .handlePost({
            authorizationHeader: "Bearer syn_mcp_v1_e2e-client-generated-secret",
            body: {
              jsonrpc: "2.0",
              id: "interrupted-wait",
              method: "tools/call",
              params: {
                name: "synara_wait_for_task",
                arguments: { threadId, runId: "turn-not-projected", timeoutMs: 60_000 },
              },
            },
          })
          .pipe(Effect.forkChild);
        yield* Effect.sleep(20);
        yield* Fiber.interrupt(interruptedWait);

        const restricted = yield* service.createIntegration({
          name: "Restricted audit",
          projectIds: [PROJECT_ID],
          capabilities: ["projects:read"],
          expiresInDays: 30,
        });
        const restrictedCredential = "syn_mcp_v1_restricted-audit-secret";
        yield* service.pair(restricted.pairingCode, restrictedCredential);
        const denied = yield* gateway.handlePost({
          authorizationHeader: `Bearer ${restrictedCredential}`,
          body: {
            jsonrpc: "2.0",
            id: "denied",
            method: "tools/call",
            params: { name: "synara_create_task", arguments: {} },
          },
        });
        expect(JSON.stringify(denied.body)).toContain("capability_denied");

        const overview = yield* gateway.handlePost({
          authorizationHeader: `Bearer ${restrictedCredential}`,
          body: {
            jsonrpc: "2.0",
            id: "overview",
            method: "tools/call",
            params: { name: "synara_overview", arguments: {} },
          },
        });
        const overviewJson = JSON.stringify(overview.body);
        expect(overview.status).toBe(200);
        expect(overviewJson).toContain(PROJECT_ID);
        expect(overviewJson).toContain("External MCP project");
        expect(overviewJson).toContain('\\"projectScope\\": \\"selected\\"');
        // Thread titles stay behind tasks:read-project; projects:read alone
        // gets counts only.
        expect(overviewJson).not.toContain("recentThreads");
        const overviewPayload = toolPayload(overview.body as Record<string, unknown>);
        expect(overviewPayload.nextSteps).toEqual([
          "Call synara_capabilities with a projectId to list the exact provider/model targets available to this integration.",
        ]);

        const auditRows = yield* sql<{
          readonly requestId: string | null;
          readonly projectId: string | null;
          readonly runtimeMode: string | null;
          readonly environment: string | null;
          readonly createdTaskIdsJson: string;
          readonly detail: string | null;
          readonly outcome: string;
        }>`
          SELECT request_id AS "requestId", project_id AS "projectId",
            runtime_mode AS "runtimeMode", environment,
            created_task_ids_json AS "createdTaskIdsJson", detail, outcome
          FROM external_mcp_audit_log
          ORDER BY created_at ASC, audit_id ASC
        `;
        expect(auditRows).toHaveLength(9);
        expect(auditRows.find((row) => row.requestId === "external-e2e-request")).toMatchObject({
          projectId: PROJECT_ID,
          runtimeMode: "approval-required",
          environment: "worktree",
          createdTaskIdsJson: JSON.stringify([threadId]),
          detail: null,
        });
        expect(JSON.stringify(auditRows)).not.toContain(prompt);
        expect(auditRows.some((row) => row.detail?.includes("Capability denied"))).toBe(true);
        expect(auditRows.some((row) => row.outcome === "started")).toBe(false);
        const operationPlans = yield* sql<{ readonly planJson: string }>`
          SELECT plan_json AS "planJson" FROM external_mcp_operations
          WHERE integration_id = ${issued.integration.integrationId}
        `;
        expect(operationPlans).toHaveLength(1);
        expect(operationPlans[0]!.planJson).not.toContain(prompt);

        yield* sql`
          CREATE TRIGGER reject_external_mcp_gateway_audit_finish
          BEFORE UPDATE ON external_mcp_audit_log
          BEGIN
            SELECT RAISE(FAIL, 'gateway audit finish rejected');
          END
        `;
        const successfulDespiteAuditFailure = yield* gateway.handlePost({
          authorizationHeader: "Bearer syn_mcp_v1_e2e-client-generated-secret",
          body: {
            jsonrpc: "2.0",
            id: "audit-failure-does-not-replace-result",
            method: "tools/call",
            params: { name: "synara_list_allowed_projects", arguments: {} },
          },
        });
        expect(successfulDespiteAuditFailure.status).toBe(200);
        expect(JSON.stringify(successfulDespiteAuditFailure.body)).toContain(PROJECT_ID);
        expect(JSON.stringify(successfulDespiteAuditFailure.body)).not.toContain('"isError":true');
        yield* sql`DROP TRIGGER reject_external_mcp_gateway_audit_finish`;
      }).pipe(Effect.provide(testLayer)),
    );
  });
});
