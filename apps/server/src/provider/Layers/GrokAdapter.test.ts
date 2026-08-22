// FILE: GrokAdapter.test.ts
// Purpose: Covers Grok-specific adapter guards that keep resumed ACP replay out of live turns.
// Layer: Provider adapter tests
// Depends on: GrokAdapter helper exports and shared contract ids.

import { TurnId } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import {
  extractGrokUserInputQuestions,
  extractGrokExitPlanMarkdown,
  GROK_ASK_USER_QUESTION_METHODS,
  GROK_EXIT_PLAN_MODE_METHODS,
  GrokAskUserQuestionRequest,
  GrokExitPlanModeRequest,
  makeGrokExitPlanModeApprovedResponse,
  makeGrokExitPlanModeCapturedResponse,
  makeGrokQuestionResponse,
} from "../acp/GrokAcpExtension.ts";

import {
  buildGrokPromptMeta,
  buildGrokTurnPromptText,
  extractGrokTerminalPlanMarkdown,
  isGrokContextCompactionToolCall,
  isRenderableGrokAssistantDelta,
  mergeGrokModelDescriptors,
  parseXaiLanguageModelDescriptors,
  selectGrokDiscoveredModelGroups,
  resolveGrokPlanHookResponse,
  resolveGrokRuntimeModelSettings,
  scopeGrokRuntimeItemIdForTurn,
  scopeGrokToolCallStateForTurn,
  takeGrokSynaraHarnessPolicyTextPart,
} from "./GrokAdapter.ts";

describe("Grok runtime model settings", () => {
  it("keeps only reasoning efforts supported by the selected model family", () => {
    expect(
      resolveGrokRuntimeModelSettings({
        model: "grok-build",
        options: { reasoningEffort: "xhigh" },
      }),
    ).toEqual({ model: "grok-build" });
    expect(
      resolveGrokRuntimeModelSettings({
        model: "grok-4.6",
        options: { reasoningEffort: "xhigh" },
      }),
    ).toEqual({ model: "grok-4.6", reasoningEffort: "xhigh" });
    expect(
      resolveGrokRuntimeModelSettings({
        model: "grok-build",
        options: { reasoningEffort: "high" },
      }),
    ).toEqual({ model: "grok-build", reasoningEffort: "high" });
  });
});

describe("Grok Synara harness policy", () => {
  it("delivers private scoped host context once", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    expect(takeGrokSynaraHarnessPolicyTextPart(state, true)?.text).toContain(
      SYNARA_HARNESS_POLICY_MARKER,
    );
    expect(takeGrokSynaraHarnessPolicyTextPart(state, true)).toBeNull();
  });
});

describe("Grok native plan approval", () => {
  it("adds Plan instructions without sending a pager-only slash command as model text", () => {
    expect(
      buildGrokTurnPromptText({
        text: "Design the change",
        interactionMode: "plan",
      }),
    ).toMatch(/^Synara requested Grok's native plan mode\./u);
  });

  it("sets Grok's native prompt mode idempotently on every turn", () => {
    expect(buildGrokPromptMeta("plan")).toEqual({ mode: "plan" });
    expect(buildGrokPromptMeta("default")).toEqual({ mode: "agent" });
    expect(buildGrokPromptMeta("debug")).toEqual({ mode: "agent" });
  });

  it("backs native Plan mode with a fail-closed pre-tool hook", () => {
    expect(
      resolveGrokPlanHookResponse("plan", {
        hookCallbackId: "synara-plan-guard",
        hookEventName: "pre_tool_use",
        toolName: "read_file",
      }),
    ).toEqual({});
    expect(
      resolveGrokPlanHookResponse("plan", {
        hookCallbackId: "synara-plan-guard",
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_cmd",
      }),
    ).toMatchObject({ decision: "deny" });
    expect(
      resolveGrokPlanHookResponse("plan", {
        hookCallbackId: "synara-plan-guard",
        hookEventName: "pre_tool_use",
        toolName: "future_mutating_tool",
      }),
    ).toMatchObject({ decision: "deny" });
    expect(
      resolveGrokPlanHookResponse("default", {
        hookCallbackId: "synara-plan-guard",
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_cmd",
      }),
    ).toEqual({});
    expect(
      resolveGrokPlanHookResponse("plan", {
        hookCallbackId: "another-client-hook",
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_cmd",
      }),
    ).toEqual({});
  });

  it("leaves Default prompts untouched after the native gate is switched explicitly", () => {
    expect(
      buildGrokTurnPromptText({
        text: "Implement the approved plan",
        interactionMode: "default",
      }),
    ).toBe("Implement the approved plan");
  });

  it("uses Grok agent mode for Debug prompts", () => {
    expect(
      buildGrokTurnPromptText({
        text: "Investigate the failed tool call",
        interactionMode: "debug",
      }),
    ).toBe("Investigate the failed tool call");
  });

  it("accepts current and legacy ACP method names", () => {
    expect(GROK_EXIT_PLAN_MODE_METHODS).toEqual(["_x.ai/exit_plan_mode", "x.ai/exit_plan_mode"]);
  });

  it("extracts the proposed plan from Grok's reverse request", () => {
    const request = Schema.decodeUnknownSync(GrokExitPlanModeRequest)({
      sessionId: "session-1",
      toolCallId: "tool-1",
      planContent: "\n# Ship it\n\n- Verify the fix\n",
    });

    expect(extractGrokExitPlanMarkdown(request)).toBe("# Ship it\n\n- Verify the fix");
  });

  it("does not invent a plan when Grok submits an empty plan file", () => {
    const request = Schema.decodeUnknownSync(GrokExitPlanModeRequest)({
      sessionId: "session-1",
      toolCallId: "tool-1",
      planContent: null,
    });

    expect(extractGrokExitPlanMarkdown(request)).toBeUndefined();
  });

  it("keeps native plan mode gated after Synara captures the plan", () => {
    expect(makeGrokExitPlanModeCapturedResponse()).toEqual({
      outcome: "cancelled",
      feedback:
        "Synara captured this plan for user review. Do not revise or implement it now. End this turn and wait for the user's next message.",
    });
  });

  it("approves leaving native plan mode only for a later implementation turn", () => {
    expect(makeGrokExitPlanModeApprovedResponse()).toEqual({ outcome: "approved" });
  });

  it("uses a terminal Plan response as a proposal when Grok omits the extension", () => {
    expect(
      extractGrokTerminalPlanMarkdown({
        interactionMode: "plan",
        capturedPlanFingerprint: undefined,
        assistantText: "\n# Plan\n\n- Implement safely\n",
      }),
    ).toBe("# Plan\n\n- Implement safely");
    expect(
      extractGrokTerminalPlanMarkdown({
        interactionMode: "plan",
        capturedPlanFingerprint: "# Native plan",
        assistantText: "# Duplicate",
      }),
    ).toBeUndefined();
  });
});

describe("Grok native user questions", () => {
  const request = Schema.decodeUnknownSync(GrokAskUserQuestionRequest)({
    sessionId: "session-1",
    toolCallId: "tool-1",
    mode: "plan",
    questions: [
      {
        question: "Which checks?",
        label: "Verification",
        multiSelect: true,
        options: [
          { label: "Unit", description: "Focused tests" },
          { label: "Integration", description: "End-to-end tests" },
        ],
      },
    ],
  });

  it("accepts current and legacy question method names", () => {
    expect(GROK_ASK_USER_QUESTION_METHODS).toEqual([
      "_x.ai/ask_user_question",
      "x.ai/ask_user_question",
    ]);
  });

  it("maps Synara answers to Grok's question-text keyed response", () => {
    expect(extractGrokUserInputQuestions(request)[0]).toMatchObject({
      id: "grok-question-0",
      header: "Verification",
      question: "Which checks?",
      multiSelect: true,
    });
    expect(
      makeGrokQuestionResponse(request, {
        "grok-question-0": ["Unit", "Integration"],
      }),
    ).toEqual({
      outcome: "accepted",
      answers: { "Which checks?": ["Unit", "Integration"] },
      annotations: {},
    });
    expect(makeGrokQuestionResponse(request, {})).toEqual({ outcome: "cancelled" });
  });
});

describe("GrokAdapter runtime event scoping", () => {
  it("makes reused ACP assistant segment ids unique per DP turn", () => {
    const providerItemId = "assistant:grok-session:segment:5";

    expect(scopeGrokRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-a"), providerItemId)).toBe(
      "grok:turn-a:assistant:grok-session:segment:5",
    );
    expect(scopeGrokRuntimeItemIdForTurn(TurnId.makeUnsafe("turn-b"), providerItemId)).toBe(
      "grok:turn-b:assistant:grok-session:segment:5",
    );
  });

  it("preserves the provider tool id while scoping the runtime item id", () => {
    const scoped = scopeGrokToolCallStateForTurn(TurnId.makeUnsafe("turn-a"), {
      toolCallId: "call-1",
      kind: "execute",
      status: "completed",
      title: "Ran command",
      data: {
        toolCallId: "call-1",
      },
    });

    expect(scoped.toolCallId).toBe("grok:turn-a:call-1");
    expect(scoped.data).toMatchObject({
      toolCallId: "call-1",
      providerToolCallId: "call-1",
    });
  });

  it("detects Grok compaction tool calls for context compaction UI rows", () => {
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-1",
        kind: "other",
        status: "inProgress",
        title: "Compacting conversation context",
        data: {},
      }),
    ).toBe(true);
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-2",
        kind: "execute",
        status: "completed",
        title: "Run tests",
        data: {},
      }),
    ).toBe(false);
  });

  it("only treats visible assistant text as renderable Grok content", () => {
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "assistant_text",
        text: "done",
      }),
    ).toBe(true);
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "assistant_text",
        text: "   ",
      }),
    ).toBe(false);
    expect(
      isRenderableGrokAssistantDelta({
        streamKind: "reasoning_text",
        text: "thinking",
      }),
    ).toBe(false);
  });

  it("parses xAI language model API responses for picker discovery", () => {
    expect(
      parseXaiLanguageModelDescriptors({
        models: [
          {
            id: "grok-build-0.1",
            object: "model",
            aliases: ["grok-code-fast", "grok-code-fast-1", "grok-build-0.1", "ignored-alias"],
          },
          { id: "grok-code-fast-1-0825", object: "model" },
          { id: "grok-4.3", object: "model" },
          { id: "   " },
          null,
        ],
      }),
    ).toEqual([
      { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      { slug: "grok-code-fast", name: "Grok Code Fast" },
      { slug: "grok-code-fast-1", name: "Grok Code Fast 1" },
      { slug: "grok-code-fast-1-0825", name: "Grok Code Fast 1 0825" },
    ]);
  });

  it("merges Grok CLI and xAI API model lists without duplicates", () => {
    const models = mergeGrokModelDescriptors([
      [
        { slug: "grok-build", name: "Grok 4.3" },
        { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      ],
      [
        { slug: "grok-build-0.1", name: "Grok Build 0.1" },
        { slug: "grok-4.5", name: "Grok 4.5" },
      ],
    ]);

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "grok-build", name: "Grok 4.3" },
      { slug: "grok-build-0.1", name: "Grok Build 0.1" },
      { slug: "grok-4.5", name: "Grok 4.5" },
    ]);
    expect(models[0]?.defaultReasoningEffort).toBe("low");
    expect(models[0]?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(models[2]?.defaultReasoningEffort).toBe("high");
    expect(models[2]?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps the live Grok CLI catalog instead of retired xAI API slugs", () => {
    const models = mergeGrokModelDescriptors(
      selectGrokDiscoveredModelGroups({
        cliModels: [{ slug: "grok-4.6", name: "Grok 4.6" }],
        apiModels: [
          { slug: "grok-build-0.1", name: "Grok Build 0.1" },
          { slug: "grok-4.5", name: "Grok 4.5" },
        ],
      }),
    );

    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "grok-4.6", name: "Grok 4.6" },
    ]);
  });

  it("stamps Grok 4.6 with Extra High instead of the grok-build None ladder", () => {
    const [model] = mergeGrokModelDescriptors([[{ slug: "grok-4.6", name: "Grok 4.6" }]]);
    expect(model?.defaultReasoningEffort).toBe("high");
    expect(model?.supportedReasoningEfforts).toEqual([
      {
        value: "low",
        label: "Low",
        description: "Quick, fast implementations",
      },
      {
        value: "medium",
        label: "Medium",
        description: "Balanced effort with standard implementation and testing",
      },
      {
        value: "high",
        label: "High",
        description: "Higher implementation quality with extensive reasoning",
      },
      {
        value: "xhigh",
        label: "Extra High",
        description: "Highest effort and reasoning level",
      },
    ]);
  });
});
