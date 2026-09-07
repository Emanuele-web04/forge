import { describe, expect, it } from "vitest";

import {
  buildSubagentIdentityDirectory,
  collectSubagentProviderThreadIds,
  decodeSubagentAgentStates,
  decodeSubagentReceiverAgents,
  decodeSubagentReceiverThreadIds,
  extractSubagentIdentityHints,
  isWorkerTierSubagentRole,
  resolveSubagentIdentityFromDirectory,
} from "./subagents";

describe("decodeSubagentAgentStates alias normalization", () => {
  it.each([
    {
      label: "object-map camel aliases and direct-value precedence",
      item: {
        agentsStates: {
          " child-map ": {
            threadId: "ignored-thread-id",
            agentId: " direct-agent ",
            agent_id: "fallback-agent",
            agentNickname: " Camel Nick ",
            agent_nickname: "Snake Nick",
            agentRole: " worker-high ",
            model: " direct-model ",
            modelName: "model-name",
            requestedModel: "requested-model",
            prompt: " direct prompt ",
            task: "task fallback",
            status: " running ",
            state: "completed",
            summary: " summary wins ",
            message: "message fallback",
            latestUpdate: "latest fallback",
          },
          "   ": {
            threadId: " fallback-thread ",
            status: " queued ",
          },
        },
      },
      expected: {
        "child-map": {
          threadId: "child-map",
          agentId: "direct-agent",
          nickname: "Camel Nick",
          model: "direct-model",
          prompt: "direct prompt",
          status: "running",
          message: "summary wins",
        },
        "fallback-thread": {
          threadId: "fallback-thread",
          status: "queued",
        },
      },
    },
    {
      label: "array snake aliases and requested-value fallbacks",
      item: {
        agent_statuses: [
          {
            thread_id: " child-array ",
            agent_id: " snake-agent ",
            receiver_agent_nickname: " Snake Nick ",
            receiver_agent_role: " reviewer ",
            requested_model: " requested-model ",
            task: " task prompt ",
            state: " completed ",
            message: " message chosen ",
            latest_update: "latest fallback",
          },
        ],
      },
      expected: {
        "child-array": {
          threadId: "child-array",
          agentId: "snake-agent",
          nickname: "Snake Nick",
          role: "reviewer",
          model: "requested-model",
          prompt: "task prompt",
          status: "completed",
          message: "message chosen",
        },
      },
    },
  ])("decodes $label", ({ item, expected }) => {
    expect(decodeSubagentAgentStates(item)).toEqual(expected);
  });
});

describe("decodeSubagentReceiverThreadIds", () => {
  it.each([
    ["legacy receiver array", { receiverThreadIds: ["child-provider-1"] }],
    ["current receiver id", { receiverThreadId: "child-provider-1" }],
    ["current spawned thread id", { newThreadId: "child-provider-1" }],
  ])("decodes the %s shape", (_label, item) => {
    expect(decodeSubagentReceiverThreadIds(item)).toEqual(["child-provider-1"]);
  });
});

describe("collectSubagentProviderThreadIds", () => {
  it("includes thread ids discovered from receiverAgents, agentStates, and source thread_spawn payloads", () => {
    expect(
      collectSubagentProviderThreadIds({
        receiverAgents: [
          {
            threadId: "child-provider-1",
            agentNickname: "Locke",
          },
        ],
        agentStates: {
          "child-provider-2": {
            status: "completed",
          },
        },
        source: {
          subAgent: {
            thread_spawn: {
              threadId: "child-provider-3",
            },
          },
        },
      }),
    ).toEqual(["child-provider-1", "child-provider-2", "child-provider-3"]);
  });
});

describe("decodeSubagentReceiverAgents", () => {
  it("marks top-level requested model values as hints for child rows", () => {
    expect(
      decodeSubagentReceiverAgents(
        {
          receiverAgents: [
            {
              threadId: "child-provider-1",
              agentNickname: "Locke",
            },
          ],
          requestedModel: "gpt-5.4-mini",
          prompt: "Inspect the sidebar tree",
        },
        ["child-provider-1"],
      ),
    ).toEqual([
      {
        providerThreadId: "child-provider-1",
        nickname: "Locke",
        model: "gpt-5.4-mini",
        modelIsRequestedHint: true,
        prompt: "Inspect the sidebar tree",
      },
    ]);
  });

  it("carries flat effort and background hints onto the child row", () => {
    expect(
      decodeSubagentReceiverAgents(
        {
          agentType: "worker-high",
          agentNickname: "Deep audit",
          model: "sonnet",
          effort: "high",
          background: true,
        },
        ["child-provider-1"],
      ),
    ).toEqual([
      {
        providerThreadId: "child-provider-1",
        nickname: "Deep audit",
        // Worker-tier agent types are internal effort carriers, never a role.
        model: "sonnet",
        modelIsRequestedHint: true,
        effort: "high",
        background: true,
      },
    ]);
  });
});

describe("extractSubagentIdentityHints", () => {
  it("extracts identity metadata from nested source.subAgent thread_spawn payloads", () => {
    expect(
      extractSubagentIdentityHints({
        source: {
          subAgent: {
            thread_spawn: {
              threadId: "child-provider-1",
              agentId: "agent-1",
              name: "Locke",
              agentType: "explorer",
            },
          },
        },
      }),
    ).toContainEqual({
      providerThreadId: "child-provider-1",
      agentId: "agent-1",
      nickname: "Locke",
      role: "explorer",
    });
  });

  it("drops worker-tier agent types from role hints while keeping real roles", () => {
    const hints = extractSubagentIdentityHints({
      receiverAgents: [
        {
          threadId: "child-provider-1",
          agentNickname: "Locke",
          agentType: "worker-low",
          effort: "low",
        },
        {
          threadId: "child-provider-2",
          agentNickname: "Hume",
          agentType: "explorer",
        },
      ],
    });

    expect(
      resolveSubagentIdentityFromDirectory(buildSubagentIdentityDirectory(hints), {
        providerThreadId: "child-provider-1",
      }),
    ).toMatchObject({
      nickname: "Locke",
      effort: "low",
    });
    expect(
      resolveSubagentIdentityFromDirectory(buildSubagentIdentityDirectory(hints), {
        providerThreadId: "child-provider-1",
      })?.role,
    ).toBeUndefined();
    expect(
      resolveSubagentIdentityFromDirectory(buildSubagentIdentityDirectory(hints), {
        providerThreadId: "child-provider-2",
      }),
    ).toMatchObject({
      nickname: "Hume",
      role: "explorer",
    });
  });

  it("drops worker-tier agent types from agent state hints", () => {
    const hints = extractSubagentIdentityHints({
      agentStates: {
        "child-provider-1": {
          agentRole: "worker-xhigh",
          status: "running",
        },
      },
    });

    const resolved = resolveSubagentIdentityFromDirectory(buildSubagentIdentityDirectory(hints), {
      providerThreadId: "child-provider-1",
    });
    expect(resolved?.status).toBe("running");
    expect(resolved?.role).toBeUndefined();
  });
});

describe("isWorkerTierSubagentRole", () => {
  it.each(["worker-low", "worker-medium", "worker-high", "worker-xhigh", " Worker-Low "])(
    "recognizes %s as a worker tier",
    (role) => {
      expect(isWorkerTierSubagentRole(role)).toBe(true);
    },
  );
  it.each(["explorer", "worker", "worker-", "worker-extreme", null, undefined])(
    "keeps %s as a real role",
    (role) => {
      expect(isWorkerTierSubagentRole(role)).toBe(false);
    },
  );
});

describe("resolveSubagentIdentityFromDirectory", () => {
  it("preserves richer nickname and role metadata when later hints only include status updates", () => {
    const hints = extractSubagentIdentityHints({
      receiverAgents: [
        {
          threadId: "child-provider-1",
          agentId: "agent-1",
          agentNickname: "Locke",
          agentRole: "explorer",
        },
      ],
      agentStates: {
        "child-provider-1": {
          status: "completed",
          summary: "Done",
        },
      },
    });

    expect(
      resolveSubagentIdentityFromDirectory(buildSubagentIdentityDirectory(hints), {
        providerThreadId: "child-provider-1",
      }),
    ).toMatchObject({
      providerThreadId: "child-provider-1",
      agentId: "agent-1",
      nickname: "Locke",
      role: "explorer",
      status: "completed",
      message: "Done",
    });
  });

  it("links thread and agent identifiers through the same merged directory entry", () => {
    const directory = buildSubagentIdentityDirectory([
      {
        providerThreadId: "child-provider-1",
        agentId: "agent-1",
        nickname: "Harper",
      },
      {
        agentId: "agent-1",
        role: "reviewer",
      },
    ]);

    expect(directory.byProviderThreadId.get("child-provider-1")).toMatchObject({
      providerThreadId: "child-provider-1",
      agentId: "agent-1",
      nickname: "Harper",
      role: "reviewer",
    });
  });
});
