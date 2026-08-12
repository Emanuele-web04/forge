import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  SynaraCapabilitiesResult,
  SynaraCreateThreadsInput,
  SynaraCreateThreadsResult,
  SynaraGatewayErrorResult,
  SynaraWaitForThreadsInput,
  SynaraWaitForThreadsResult,
} from "./agentGateway";
import { DEFAULT_PROVIDER_PROFILE_ID } from "./providerProfile";

const decodeCreate = Schema.decodeUnknownSync(SynaraCreateThreadsInput);
const decodeWait = Schema.decodeUnknownSync(SynaraWaitForThreadsInput);

const thread = {
  prompt: "Explain this repository",
  target: {
    provider: "codex",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "gpt-5.6-terra",
    options: { reasoningEffort: "low" },
  },
} as const;

describe("agent gateway contracts", () => {
  it("accepts one through twenty exact creation entries", () => {
    assert.equal(decodeCreate({ requestId: "request-1", threads: [thread] }).threads.length, 1);
    assert.equal(
      decodeCreate({ requestId: "request-20", threads: Array.from({ length: 20 }, () => thread) })
        .threads.length,
      20,
    );
  });

  it("rejects empty and oversized creation plans", () => {
    assert.throws(() => decodeCreate({ requestId: "empty", threads: [] }));
    assert.throws(() =>
      decodeCreate({ requestId: "too-many", threads: Array.from({ length: 21 }, () => thread) }),
    );
  });

  it("requires a bounded request id", () => {
    assert.throws(() => decodeCreate({ requestId: "", threads: [thread] }));
    assert.throws(() => decodeCreate({ requestId: "x".repeat(257), threads: [thread] }));
  });

  it("accepts an exact Git base ref for detached worktree creation", () => {
    const decoded = decodeCreate({
      requestId: "detached-ref",
      threads: [{ ...thread, environment: "worktree", baseRef: "0123456789abcdef" }],
    });
    assert.equal(decoded.threads[0]?.baseRef, "0123456789abcdef");
  });

  it("decodes provider-specific model options without folding them into the slug", () => {
    const decoded = decodeCreate({ requestId: "terra-low", threads: [thread] });
    assert.deepEqual(decoded.threads[0]?.target, thread.target);
    assert.throws(() =>
      decodeCreate({
        requestId: "cross-provider-options",
        threads: [
          {
            prompt: "invalid",
            target: {
              provider: "claudeAgent",
              model: "claude-sonnet-5",
              options: { reasoningEffort: "low" },
            },
          },
        ],
      }),
    );
  });

  it("bounds wait targets and timeout", () => {
    assert.equal(decodeWait({ threadIds: ["thread-1"], timeoutMs: 60_000 }).timeoutMs, 60_000);
    assert.throws(() => decodeWait({ threadIds: [] }));
    assert.throws(() => decodeWait({ threadIds: ["thread-1"], timeoutMs: 60_001 }));
  });

  it("decodes typed capability, creation, wait, and error results", () => {
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(SynaraCapabilitiesResult)({
        targetConstruction: {
          codex: {
            modelValueSource: "providers[].models[].slug",
            primaryOptionKey: "reasoningEffort",
            alternativeOptionKeys: [],
            optionSelectionRule: "Use the model-specific rules when present.",
            providerOptions: [
              {
                key: "reasoningEffort",
                valueType: "string",
                allowedValues: ["low", "medium", "high"],
                allowedValuesSource: "provider-contract",
              },
            ],
            optionsByModel: {
              "gpt-5.5": [
                {
                  key: "reasoningEffort",
                  valueType: "string",
                  allowedValues: ["low", "high"],
                  allowedValuesSource: "model-discovery",
                },
              ],
            },
            exampleTarget: {
              provider: "codex",
              model: "gpt-5.5",
              options: { reasoningEffort: "low" },
            },
          },
        },
        providers: [
          {
            provider: "codex",
            defaultModel: "gpt-5.5",
            models: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
            enabled: true,
            available: true,
            authStatus: "authenticated",
          },
        ],
        limits: {
          maxThreadsPerOperation: 20,
          maxWaitMs: 60_000,
          oneCreationPlanPerActiveTurn: true,
        },
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(SynaraCreateThreadsResult)({
        operationId: "gateway:create:1",
        requestId: "request-1",
        requestedCount: 1,
        createdCount: 1,
        threadIds: ["thread-1"],
        threads: [
          {
            index: 0,
            threadId: "thread-1",
            projectId: "project-1",
            title: "Worker",
            target: thread.target,
            provider: "codex",
            model: "gpt-5.6-terra",
            runtimeMode: "approval-required",
            environment: "local",
            branch: null,
            worktreePath: null,
            status: "task_dispatched",
          },
        ],
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(SynaraWaitForThreadsResult)({
        callerThreadId: "thread-parent",
        runIds: ["turn-1"],
        allTerminal: true,
        timedOut: false,
        threads: [
          {
            threadId: "thread-1",
            runId: "turn-1",
            state: "completed",
            terminal: true,
            timedOut: false,
            summary: "Done",
            summaryTruncated: false,
            error: null,
            readThread: {
              tool: "synara_read_thread",
              arguments: { threadId: "thread-1" },
            },
          },
        ],
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(SynaraGatewayErrorResult)({
        error: { code: "creation_plan_locked", message: "A plan already exists." },
      }),
    );
  });
});
