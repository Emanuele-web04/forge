import { assert, it } from "@effect/vitest";
import {
  MIND_MEMORY_PROJECT_CAP,
  MIND_RECALL_HYGIENE_NOTE,
  MindMemoryId,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Clock, Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { MindRepositoryLive } from "../persistence/Layers/MindRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  MindRepository,
  type InsertMindMemoryInput,
} from "../persistence/Services/MindRepository.ts";
import { MindServiceLive } from "../mind/Layers/MindService.ts";
import { MindService, type MindServiceShape } from "../mind/Services/MindService.ts";
import { makeAgentGatewayMemoryTools } from "./memoryTools.ts";
import { mcpToolResultError, type McpToolCallResult } from "./protocol.ts";
import { errorText, ToolInputError } from "./toolInput.ts";
import type { ToolContext, ToolEntry } from "./toolRuntime.ts";

const layer = it.layer(
  MindServiceLive.pipe(
    Layer.provideMerge(MindRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const NOW = "2026-09-01T00:00:00.000Z";

// The suite shares one in-memory database and one service instance, so every
// test owns a unique project (mirrors MindService.test.ts).
const PROJECTS = {
  surface: "project-memory-tools-surface",
  remember: "project-memory-tools-remember",
  resolveA: "project-memory-tools-resolve-a",
  resolveB: "project-memory-tools-resolve-b",
  secret: "project-memory-tools-secret",
  cap: "project-memory-tools-cap",
  idempotent: "project-memory-tools-idempotent",
  pureRead: "project-memory-tools-pure-read",
  confirm: "project-memory-tools-confirm",
  forget: "project-memory-tools-forget",
  status: "project-memory-tools-status",
  statusOther: "project-memory-tools-status-other",
  xproject: "project-memory-tools-xproject",
  xprojectOther: "project-memory-tools-xproject-other",
  invalid: "project-memory-tools-invalid",
  missing: "project-memory-tools-missing",
} as const;

const THREADS = {
  alpha: "thread-memory-alpha",
  beta: "thread-memory-beta",
  ghost: "thread-memory-ghost",
} as const;

function makeThreadShell(id: string, projectId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe(projectId),
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
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
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
  };
}

/** Builds the tool set with the caller shells bound to this test's projects. */
function makeTools(
  mindService: MindServiceShape,
  alphaProject: string,
  betaProject: string = PROJECTS.statusOther,
): {
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly byName: Map<string, ToolEntry>;
} {
  const shells = new Map<string, OrchestrationThreadShell>([
    [THREADS.alpha, makeThreadShell(THREADS.alpha, alphaProject)],
    [THREADS.beta, makeThreadShell(THREADS.beta, betaProject)],
  ]);
  const requireThreadShell = (threadId: string) =>
    shells.has(threadId)
      ? Effect.succeed(shells.get(threadId)!)
      : Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`));
  const tools = makeAgentGatewayMemoryTools({ mindService, requireThreadShell });
  return { tools, byName: new Map(tools.map((tool) => [tool.definition.name, tool])) };
}

function makeContext(
  threadId: string = THREADS.alpha,
  turnId: string | null = "turn-1",
): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:test",
      threadId,
      provider: "codex",
      turnId: turnId ?? "turn-1",
    },
    callerThreadId: threadId,
    callerSessionKey: "gateway-session:test",
    callerProvider: "codex",
    callerCapabilities: new Set(["memory:use"]),
    callerTurnId: turnId,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

/**
 * Invokes a handler the way mcpTransport.ts does, including its defect
 * conversion: a thrown ToolInputError reaches agents as an error result.
 */
const callTool = (
  byName: Map<string, ToolEntry>,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Effect.Effect<McpToolCallResult> => {
  const tool = byName.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  return tool
    .handler(args, context)
    .pipe(Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))));
};

/** Tool results are JSON text frames; errors arrive as {error: {code, message}}. */
const structuredPayload = (result: McpToolCallResult): Record<string, unknown> => {
  const text = result.content.find((entry) => entry.type === "text");
  return JSON.parse(text && text.type === "text" ? text.text : "{}") as Record<string, unknown>;
};

const errorPayload = (result: McpToolCallResult): { code: string; message: string } => {
  assert.isTrue(result.isError === true, "expected an error tool result");
  const payload = structuredPayload(result);
  const error = payload.error as { code: string; message: string };
  return { code: error.code, message: error.message };
};

/** Thrown ToolInputErrors surface as plain-text error results (mcpTransport behavior). */
const plainErrorText = (result: McpToolCallResult): string => {
  assert.isTrue(result.isError === true, "expected an error tool result");
  const text = result.content.find((entry) => entry.type === "text");
  return text && text.type === "text" ? text.text : "";
};

// Operation receipts reference projection_projects, so tests seed the project
// row before any tool call that records a receipt.
const ensureProjectRow = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id,
        title,
        workspace_root,
        scripts_json,
        created_at,
        updated_at
      )
      VALUES (
        ${projectId},
        'Memory tools test project',
        '/tmp/memory-tools-test',
        '[]',
        ${NOW},
        ${NOW}
      )
      ON CONFLICT (project_id) DO NOTHING
    `;
  });

let seedCounter = 0;
const seedMemory = (projectId: ProjectId, overrides: Partial<InsertMindMemoryInput> = {}) =>
  Effect.gen(function* () {
    const repository = yield* MindRepository;
    seedCounter += 1;
    const nowIso = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* repository.insert({
      memoryId: MindMemoryId.makeUnsafe(`seed-${seedCounter}`),
      projectId,
      text: `seed fact ${seedCounter}`,
      type: "semantic",
      textHash: `seed-hash-${seedCounter}`,
      peakWeight: 0.6,
      accessCount: 0,
      pinned: false,
      createdAt: nowIso,
      lastAccessedAt: nowIso,
      provenance: { kind: "user" },
      ...overrides,
    });
  });

layer("agent gateway memory tools", (it) => {
  it.effect(
    "exposes the five memory tools behind memory:use with the right turn and annotation hints",
    () =>
      Effect.gen(function* () {
        const mindService = yield* MindService;
        const { tools, byName } = makeTools(mindService, PROJECTS.surface);

        assert.deepEqual(
          tools.map((tool) => tool.definition.name),
          [
            "synara_remember",
            "synara_recall_memories",
            "synara_confirm_memory",
            "synara_forget_memory",
            "synara_memory_status",
          ],
        );
        assert.isTrue(tools.every((tool) => tool.requiredCapability === "memory:use"));

        // Mutations require an active turn; pure reads do not.
        assert.isTrue(byName.get("synara_remember")!.requiresActiveTurn === true);
        assert.isTrue(byName.get("synara_confirm_memory")!.requiresActiveTurn === true);
        assert.isTrue(byName.get("synara_forget_memory")!.requiresActiveTurn === true);
        assert.isTrue(byName.get("synara_recall_memories")!.requiresActiveTurn === undefined);
        assert.isTrue(byName.get("synara_memory_status")!.requiresActiveTurn === undefined);

        // Read/write annotation split per toolRuntime.ts.
        for (const name of ["synara_recall_memories", "synara_memory_status"]) {
          assert.isTrue(byName.get(name)!.definition.annotations?.readOnlyHint === true, name);
          assert.isTrue(byName.get(name)!.definition.annotations?.destructiveHint === false, name);
          assert.isTrue(byName.get(name)!.definition.annotations?.idempotentHint === true, name);
        }
        for (const name of ["synara_remember", "synara_confirm_memory", "synara_forget_memory"]) {
          assert.isTrue(byName.get(name)!.definition.annotations?.readOnlyHint === false, name);
          assert.isTrue(byName.get(name)!.definition.annotations?.destructiveHint === true, name);
        }

        // Agents never pass project ids: no input schema carries a projectId property.
        for (const tool of tools) {
          const properties = tool.definition.inputSchema.properties as Record<string, unknown>;
          assert.isFalse("projectId" in properties, tool.definition.name);
        }
      }),
  );

  it.effect("remember saves into the caller's own project with agent provenance", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.remember);
      const { byName } = makeTools(mindService, PROJECTS.remember);

      const result = yield* callTool(
        byName,
        "synara_remember",
        { text: "Use bun run test, never bun test.", type: "procedural" },
        makeContext(),
      );
      const payload = structuredPayload(result);
      assert.equal(payload.created, true);
      assert.equal(payload.reinforced, false);
      const memoryId = MindMemoryId.makeUnsafe(payload.memoryId as string);

      // The memory lands in the caller thread's project, and nowhere else.
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.remember) }),
        1,
      );
      const row = Option.getOrThrow(yield* repository.getById({ memoryId }));
      assert.strictEqual(row.projectId, ProjectId.makeUnsafe(PROJECTS.remember));
      assert.strictEqual(row.text, "Use bun run test, never bun test.");
      assert.strictEqual(row.type, "procedural");
      assert.strictEqual(row.provenance.kind, "agent");
      if (row.provenance.kind === "agent") {
        assert.strictEqual(row.provenance.provider, "codex");
        assert.strictEqual(row.provenance.threadId, ThreadId.makeUnsafe(THREADS.alpha));
      }
    }),
  );

  it.effect("remember resolves the project from the caller shell, never from arguments", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.resolveA);
      yield* ensureProjectRow(PROJECTS.resolveB);
      const { byName } = makeTools(mindService, PROJECTS.resolveA, PROJECTS.resolveB);

      // The same tool call from a different caller thread lands in that
      // thread's project.
      const fromBeta = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Beta project pins ports to 4100", type: "semantic" },
          makeContext(THREADS.beta),
        ),
      );
      assert.strictEqual(
        Option.getOrThrow(
          yield* repository.getById({
            memoryId: MindMemoryId.makeUnsafe(fromBeta.memoryId as string),
          }),
        ).projectId,
        ProjectId.makeUnsafe(PROJECTS.resolveB),
      );

      const fromAlpha = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Alpha project pins ports to 4200", type: "semantic" },
          makeContext(),
        ),
      );
      assert.strictEqual(
        Option.getOrThrow(
          yield* repository.getById({
            memoryId: MindMemoryId.makeUnsafe(fromAlpha.memoryId as string),
          }),
        ).projectId,
        ProjectId.makeUnsafe(PROJECTS.resolveA),
      );
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.resolveA) }),
        1,
      );
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.resolveB) }),
        1,
      );

      // An unknown caller thread fails the shell lookup before any write.
      const ghost = plainErrorText(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Should never be stored", type: "semantic" },
          makeContext(THREADS.ghost),
        ),
      );
      assert.isTrue(ghost.includes("was not found"));
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.resolveA) }),
        1,
      );
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.resolveB) }),
        1,
      );
    }),
  );

  it.effect("remember rejects secret-shaped text before any write", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.secret);
      const { byName } = makeTools(mindService, PROJECTS.secret);

      const error = errorPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "my key ghp_1234567890abcdef", type: "semantic" },
          makeContext(),
        ),
      );
      assert.equal(error.code, "memory_secret_rejected");
      assert.isTrue(error.message.includes("secret"));
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.secret) }),
        0,
      );
    }),
  );

  it.effect("remember rejects at the project cap with guidance", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.cap);
      const capProjectId = ProjectId.makeUnsafe(PROJECTS.cap);
      for (let index = 0; index < MIND_MEMORY_PROJECT_CAP; index++) {
        yield* seedMemory(capProjectId, {
          textHash: `cap-${index}`,
          text: `cap filler ${index}`,
        });
      }
      const { byName } = makeTools(mindService, PROJECTS.cap);

      const error = errorPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "one too many", type: "semantic" },
          makeContext(),
        ),
      );
      assert.equal(error.code, "memory_cap_reached");
      assert.isTrue(error.message.includes("forget or consolidate"));
      assert.equal(
        yield* repository.countByProject({ projectId: capProjectId }),
        MIND_MEMORY_PROJECT_CAP,
      );
    }),
  );

  it.effect(
    "remember is idempotent for the same turn and text, and reinforces on a later turn",
    () =>
      Effect.gen(function* () {
        const mindService = yield* MindService;
        const repository = yield* MindRepository;
        yield* runMigrations();
        yield* ensureProjectRow(PROJECTS.idempotent);
        const { byName } = makeTools(mindService, PROJECTS.idempotent);
        const text = "Deploy ports offset via SYNARA_PORT_OFFSET";

        const first = structuredPayload(
          yield* callTool(byName, "synara_remember", { text, type: "semantic" }, makeContext()),
        );
        assert.equal(first.created, true);

        // Retry in the same turn: the receipt replays the durable result — no
        // second row, no double bump.
        const retry = structuredPayload(
          yield* callTool(byName, "synara_remember", { text, type: "semantic" }, makeContext()),
        );
        assert.equal(retry.created, true);
        assert.equal(retry.memoryId, first.memoryId);
        assert.equal(
          yield* repository.countByProject({
            projectId: ProjectId.makeUnsafe(PROJECTS.idempotent),
          }),
          1,
        );
        const row = Option.getOrThrow(
          yield* repository.getById({
            memoryId: MindMemoryId.makeUnsafe(first.memoryId as string),
          }),
        );
        assert.equal(row.peakWeight, 0.6);
        assert.equal(row.accessCount, 0);

        // A later turn with the same text reinforces the existing memory.
        const later = structuredPayload(
          yield* callTool(
            byName,
            "synara_remember",
            { text, type: "semantic" },
            makeContext(THREADS.alpha, "turn-2"),
          ),
        );
        assert.equal(later.created, false);
        assert.equal(later.reinforced, true);
        assert.equal(later.memoryId, first.memoryId);
        const reinforced = Option.getOrThrow(
          yield* repository.getById({
            memoryId: MindMemoryId.makeUnsafe(first.memoryId as string),
          }),
        );
        assert.equal(reinforced.peakWeight, 0.75);
        assert.equal(reinforced.accessCount, 1);
      }),
  );

  it.effect("recall is a pure read framed by the hygiene note", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.pureRead);
      const projectId = ProjectId.makeUnsafe(PROJECTS.pureRead);
      const { byName } = makeTools(mindService, PROJECTS.pureRead);

      const a = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Use bun run test, never bun test.", type: "procedural" },
          makeContext(THREADS.alpha, "turn-pure-a"),
        ),
      );
      const b = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Mind pins survive decay", type: "semantic" },
          makeContext(THREADS.alpha, "turn-pure-b"),
        ),
      );
      const beforeA = Option.getOrThrow(
        yield* repository.getById({ memoryId: MindMemoryId.makeUnsafe(a.memoryId as string) }),
      );
      const beforeB = Option.getOrThrow(
        yield* repository.getById({ memoryId: MindMemoryId.makeUnsafe(b.memoryId as string) }),
      );

      const digest = structuredPayload(
        yield* callTool(byName, "synara_recall_memories", {}, makeContext()),
      );
      assert.equal(digest.note, MIND_RECALL_HYGIENE_NOTE);
      assert.equal((digest.items as ReadonlyArray<unknown>).length, 2);
      assert.isTrue(typeof digest.digest === "string" && digest.digest.length > 0);

      const queried = structuredPayload(
        yield* callTool(byName, "synara_recall_memories", { query: "bun" }, makeContext()),
      );
      assert.isTrue((queried.items as ReadonlyArray<unknown>).length >= 1);

      // Pure read: weights, access counts, and decay anchors never move.
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getById({ memoryId: MindMemoryId.makeUnsafe(a.memoryId as string) }),
        ),
        beforeA,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getById({ memoryId: MindMemoryId.makeUnsafe(b.memoryId as string) }),
        ),
        beforeB,
      );
      assert.equal(yield* repository.countByProject({ projectId }), 2);
    }),
  );

  it.effect("confirm bumps weight once and repeats in the same turn are no-ops", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.confirm);
      const { byName } = makeTools(mindService, PROJECTS.confirm);

      const remembered = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Confirm me once", type: "semantic" },
          makeContext(THREADS.alpha, "turn-confirm-create"),
        ),
      );
      const memoryId = remembered.memoryId as string;

      const confirmed = structuredPayload(
        yield* callTool(
          byName,
          "synara_confirm_memory",
          { memoryId },
          makeContext(THREADS.alpha, "turn-confirm-1"),
        ),
      );
      assert.equal(confirmed.weight, 0.75);
      assert.equal(confirmed.accessCount, 1);

      // Same turn again: durable no-op.
      const repeat = structuredPayload(
        yield* callTool(
          byName,
          "synara_confirm_memory",
          { memoryId },
          makeContext(THREADS.alpha, "turn-confirm-1"),
        ),
      );
      assert.equal(repeat.weight, 0.75);
      assert.equal(repeat.accessCount, 1);

      // A new turn confirms again.
      const again = structuredPayload(
        yield* callTool(
          byName,
          "synara_confirm_memory",
          { memoryId },
          makeContext(THREADS.alpha, "turn-confirm-2"),
        ),
      );
      assert.equal(again.accessCount, 2);
    }),
  );

  it.effect("forget deletes once and succeeds when already gone", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.forget);
      const projectId = ProjectId.makeUnsafe(PROJECTS.forget);
      const { byName } = makeTools(mindService, PROJECTS.forget);

      const remembered = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Forget me", type: "episodic" },
          makeContext(THREADS.alpha, "turn-forget-create"),
        ),
      );
      const memoryId = remembered.memoryId as string;

      const first = structuredPayload(
        yield* callTool(
          byName,
          "synara_forget_memory",
          { memoryId },
          makeContext(THREADS.alpha, "turn-forget-1"),
        ),
      );
      assert.equal(first.deleted, true);
      assert.equal(first.alreadyGone, false);
      assert.equal(yield* repository.countByProject({ projectId }), 0);

      // Idempotent: the second forget succeeds without an error.
      const second = structuredPayload(
        yield* callTool(
          byName,
          "synara_forget_memory",
          { memoryId },
          makeContext(THREADS.alpha, "turn-forget-2"),
        ),
      );
      assert.equal(second.deleted, false);
      assert.equal(second.alreadyGone, true);
    }),
  );

  it.effect("confirm and forget from another project cannot touch foreign memories", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.xproject);
      yield* ensureProjectRow(PROJECTS.xprojectOther);
      const { byName } = makeTools(mindService, PROJECTS.xproject, PROJECTS.xprojectOther);

      const remembered = structuredPayload(
        yield* callTool(
          byName,
          "synara_remember",
          { text: "Mine, not yours", type: "semantic" },
          makeContext(THREADS.alpha, "turn-xproject-create"),
        ),
      );
      const memoryId = remembered.memoryId as string;

      const confirmError = errorPayload(
        yield* callTool(
          byName,
          "synara_confirm_memory",
          { memoryId },
          makeContext(THREADS.beta, "turn-xproject-confirm"),
        ),
      );
      assert.equal(confirmError.code, "memory_not_found");

      const forgotten = structuredPayload(
        yield* callTool(
          byName,
          "synara_forget_memory",
          { memoryId },
          makeContext(THREADS.beta, "turn-xproject-forget"),
        ),
      );
      assert.equal(forgotten.deleted, false);
      assert.equal(forgotten.alreadyGone, true);
      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.xproject) }),
        1,
      );
    }),
  );

  it.effect("status reports the caller's project usage and nothing from other projects", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.status);
      yield* ensureProjectRow(PROJECTS.statusOther);
      const statusProjectId = ProjectId.makeUnsafe(PROJECTS.status);
      const seeded = yield* seedMemory(statusProjectId, { text: "status fact one" });
      yield* seedMemory(statusProjectId, { text: "status fact two" });
      yield* repository.setPinned({ memoryId: seeded.memoryId, pinned: true });
      const { byName } = makeTools(mindService, PROJECTS.status, PROJECTS.statusOther);

      const payload = structuredPayload(
        yield* callTool(byName, "synara_memory_status", {}, makeContext()),
      );
      assert.equal(payload.count, 2);
      assert.equal(payload.cap, MIND_MEMORY_PROJECT_CAP);
      assert.equal(payload.pinnedCount, 1);
      assert.isTrue((payload.digestChars as number) > 0);
      assert.isTrue((payload.oldestIdleDays as number) >= 0);

      // Project isolation: the beta caller sees its own (empty) project.
      const betaPayload = structuredPayload(
        yield* callTool(byName, "synara_memory_status", {}, makeContext(THREADS.beta)),
      );
      assert.equal(betaPayload.count, 0);
    }),
  );

  it.effect("rejects invalid input before touching the store", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      const repository = yield* MindRepository;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.invalid);
      const { byName } = makeTools(mindService, PROJECTS.invalid);

      const badType = plainErrorText(
        yield* callTool(byName, "synara_remember", { text: "A fact", type: "todo" }, makeContext()),
      );
      assert.isTrue(badType.includes('"type"'));
      const missingText = plainErrorText(
        yield* callTool(byName, "synara_remember", { type: "semantic" }, makeContext()),
      );
      assert.isTrue(missingText.includes('"text"'));
      const badLimit = plainErrorText(
        yield* callTool(byName, "synara_recall_memories", { limit: 0 }, makeContext()),
      );
      assert.isTrue(badLimit.includes("between 1 and 20"));
      const missingMemoryId = plainErrorText(
        yield* callTool(byName, "synara_confirm_memory", {}, makeContext()),
      );
      assert.isTrue(missingMemoryId.includes('"memoryId"'));

      assert.equal(
        yield* repository.countByProject({ projectId: ProjectId.makeUnsafe(PROJECTS.invalid) }),
        0,
      );
    }),
  );

  it.effect("maps a missing memory to memory_not_found while forget stays idempotent", () =>
    Effect.gen(function* () {
      const mindService = yield* MindService;
      yield* runMigrations();
      yield* ensureProjectRow(PROJECTS.missing);
      const { byName } = makeTools(mindService, PROJECTS.missing);

      const confirmMissing = errorPayload(
        yield* callTool(
          byName,
          "synara_confirm_memory",
          { memoryId: "memory-never-existed" },
          makeContext(THREADS.alpha, "turn-missing"),
        ),
      );
      assert.equal(confirmMissing.code, "memory_not_found");

      // Forgetting a missing id is a success, not an error.
      const forgetMissing = structuredPayload(
        yield* callTool(
          byName,
          "synara_forget_memory",
          { memoryId: "memory-never-existed" },
          makeContext(THREADS.alpha, "turn-missing"),
        ),
      );
      assert.equal(forgetMissing.alreadyGone, true);
    }),
  );
});
