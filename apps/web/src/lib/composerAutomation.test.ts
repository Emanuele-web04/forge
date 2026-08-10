// FILE: composerAutomation.test.ts
// Purpose: Locks down composer-to-automation orchestration outside ChatView.
// Layer: Web lib test
// Depends on: composerAutomation resolver and automation form helpers.

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  automationClarificationPrompt,
  buildComposerAutomationDraft,
  resolveComposerAutomationRequest,
} from "./composerAutomation";

const PROJECT_ID = "project-composer-automation" as ProjectId;
const THREAD_ID = "thread-composer-automation" as ThreadId;
const MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  profileId: DEFAULT_PROVIDER_PROFILE_ID,
  model: "gpt-5",
};
const NOW_ISO = "2026-06-22T08:00:00.000Z";

describe("composerAutomation", () => {
  it("keeps unmarked automation questions as normal chat", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("should not generate");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "how do automations work every day?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toEqual({ type: "normal-chat" });
    expect(generateIntent).not.toHaveBeenCalled();

    const scriptDecision = await resolveComposerAutomationRequest({
      message: "can you write a script that runs every 5 minutes?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(scriptDecision).toEqual({ type: "normal-chat" });
    expect(generateIntent).not.toHaveBeenCalled();
  });

  it("accepts polite unmarked automation requests", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("offline generation falls back to deterministic intent");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "could you remind me every day to stretch?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "remind me stretch",
          executionScope: "thread",
          schedule: { type: "daily", timeOfDay: "09:00" },
        },
      },
    });
  });

  it("uses generation for explicit unmarked creation requests when local parsing is incomplete", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.91,
      language: "en",
      name: "Check queue",
      taskPrompt: "Check the queue and report anything actionable.",
      schedule: { type: "daily" as const, timeOfDay: "09:00" },
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: false,
      reason: null,
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "could you create an automation tomorrow morning to check the queue?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(generateIntent).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      message: "create an automation tomorrow morning to check the queue",
      defaultMode: "heartbeat",
      nowIso: NOW_ISO,
    });
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        source: "generated",
        mode: "heartbeat",
        intent: {
          prompt: "Check the queue and report anything actionable.",
          schedule: { type: "daily", timeOfDay: "09:00" },
        },
      },
    });
  });

  it("accepts polite say requests as bounded thread automations", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("bounded fast loops should not need generation");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "could you say hi every 15 seconds for 3 times",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "thread",
          schedule: { type: "interval", everySeconds: 15 },
        },
      },
    });
    expect(generateIntent).not.toHaveBeenCalled();
  });

  it("keeps generated standalone mode when regex scope parsing misses it", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.93,
      language: "en",
      name: "Check CI",
      taskPrompt: "Check CI.",
      schedule: { type: "interval" as const, everySeconds: 300 },
      mode: "standalone" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: false,
      reason: null,
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation independently check CI every 5 minutes",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "standalone",
        requiresReview: true,
        intent: {
          prompt: "Check CI.",
          executionScope: "standalone",
        },
      },
    });
  });

  it("falls back to deterministic automation parsing when AI enrichment is slow", async () => {
    const generateIntent = vi.fn(() => new Promise<never>(() => undefined));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation ogni domenica alle 9 controlla CI",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
      generateIntentTimeoutMs: 1,
    });

    expect(generateIntent).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        source: "deterministic",
        mode: "heartbeat",
        intent: {
          prompt: "controlla CI",
          executionScope: "thread",
          schedule: { type: "weekly", dayOfWeek: 0, timeOfDay: "09:00" },
        },
      },
    });
  });

  it("opens review when AI prompt enrichment needs confirmation", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.94,
      language: "en",
      name: "Check deployment",
      taskPrompt: "Check the deployment status and report any ambiguous result.",
      schedule: { type: "interval" as const, everySeconds: 21_600 },
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: true,
      reason: "The target is vague.",
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "check it every 6h",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        generatedNeedsConfirmation: true,
        reason: "The target is vague.",
        intent: {
          prompt: "Check the deployment status and report any ambiguous result.",
        },
      },
    });
    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(true);
    expect(draft.warnings.map((warning) => warning.id)).toContain("generated-low-confidence");
  });

  it("builds an auto-submittable thread heartbeat draft for bounded fast loops", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.96,
      language: "en",
      name: "Say hi",
      taskPrompt: "Every 15 seconds, say hi in this thread for 3 times.",
      schedule: { type: "interval" as const, everySeconds: 15 },
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: [],
      needsConfirmation: true,
      reason: "Fast interval",
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation say hi every 15 seconds for 3 times",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "automation",
      automationMessage: "say hi every 15 seconds for 3 times",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "thread",
          schedule: { type: "interval", everySeconds: 15 },
        },
      },
    });
    expect(generateIntent).not.toHaveBeenCalled();

    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(false);
    expect(draft.form).toMatchObject({
      mode: "heartbeat",
      targetThreadId: THREAD_ID,
      runtimeMode: "approval-required",
      maxIterations: "3",
      prompt: "say hi",
    });
    expect(draft.warnings.map((warning) => warning.id)).toEqual(["fast-recurring-interval"]);
    expect(Array.from(draft.acknowledgedWarningIds)).toEqual(["fast-recurring-interval"]);
  });

  it("auto-submits fast loops when the run cap is written as a total", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("bounded fast loops should not need generation");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "/automation say hi every 15 seconds 3 times total",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "heartbeat",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "thread",
          schedule: { type: "interval", everySeconds: 15 },
        },
      },
    });
    expect(generateIntent).not.toHaveBeenCalled();

    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(false);
    expect(draft.form).toMatchObject({
      mode: "heartbeat",
      targetThreadId: THREAD_ID,
      maxIterations: "3",
      prompt: "say hi",
    });
    expect(Array.from(draft.acknowledgedWarningIds)).toEqual(["fast-recurring-interval"]);
  });

  it("keeps explicit standalone drafts behind review with risks unacknowledged", async () => {
    const generateIntent = vi.fn(async () => {
      throw new Error("offline generation falls back to deterministic intent");
    });

    const decision = await resolveComposerAutomationRequest({
      message: "/automation run standalone say hi every 15 seconds for 3 times",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "automation",
      resolution: {
        mode: "standalone",
        intent: {
          prompt: "say hi",
          maxIterations: 3,
          executionScope: "standalone",
        },
      },
    });

    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: null,
      hasEphemeralContext: false,
    });

    expect(draft.needsDraftReview).toBe(true);
    expect(draft.form).toMatchObject({
      mode: "standalone",
      targetThreadId: "",
      worktreeMode: "auto",
      maxIterations: "3",
    });
    expect(draft.warnings.map((warning) => warning.id)).toEqual([
      "fast-recurring-interval",
      "local-checkout",
      "worktree-cleanup",
    ]);
    expect(Array.from(draft.acknowledgedWarningIds)).toEqual([]);
  });

  it("keeps a stop clause and its own thread on a dedicated draft", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.95,
      language: "en",
      name: "Watch the release branch",
      taskPrompt: "Watch the release branch and report regressions.",
      schedule: { type: "interval" as const, everySeconds: 3_600 },
      mode: "dedicated" as const,
      completionPolicy: {
        type: "ai-evaluated" as const,
        stopWhen: "the release is out",
        confidenceThreshold: 0.8,
      },
      missingFields: [],
      needsConfirmation: false,
      reason: null,
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "/automation watch the release branch every hour until the release is out",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    const draft = buildComposerAutomationDraft({
      resolution: decision.resolution,
      projectId: PROJECT_ID,
      projectModelSelection: MODEL_SELECTION,
      selectedModelSelection: MODEL_SELECTION,
      targetThreadId: THREAD_ID,
      hasEphemeralContext: false,
    });

    expect(draft.form).toMatchObject({
      mode: "dedicated",
      // The automation opens its own thread, so the caller's thread is never borrowed.
      targetThreadId: "",
      // Stop clauses are mode-independent; they used to be dropped outside heartbeat.
      stopWhen: "the release is out",
    });
  });

  it("asks for clarification when an automation request is missing its task and schedule", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.9,
      language: "en",
      name: null,
      taskPrompt: null,
      schedule: null,
      mode: null,
      completionPolicy: { type: "none" as const },
      missingFields: ["taskPrompt" as const, "schedule" as const],
      needsConfirmation: false,
      reason: "Tell me what to automate.",
    }));

    const decision = await resolveComposerAutomationRequest({
      message: "could you create an automation for me?",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });

    expect(generateIntent).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      type: "needs-clarification",
      // The accumulated request is the cleaned invocation (politeness, "?", and "for me"
      // filler stripped), so folding the next reply never re-parses scaffolding as the task.
      automationMessage: "create an automation",
      missingFields: ["taskPrompt", "schedule"],
      reason: "Tell me what to automate.",
    });
  });

  it("resolves to an automation once the follow-up supplies the schedule", async () => {
    // First turn: a task with no cadence cannot be created yet.
    const incompleteGeneration = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.9,
      language: "en",
      name: null,
      taskPrompt: null,
      schedule: null,
      mode: null,
      completionPolicy: { type: "none" as const },
      missingFields: ["schedule" as const],
      needsConfirmation: false,
      reason: null,
    }));
    const first = await resolveComposerAutomationRequest({
      message: "create an automation to check the build",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: incompleteGeneration,
    });
    expect(first.type).toBe("needs-clarification");

    // Second turn: the composer folds the reply back into the original request. The
    // deterministic parser now finds the schedule, so the automation resolves even
    // though optional enrichment generation fails.
    const failingEnrichment = vi.fn(async () => {
      throw new Error("enrichment is optional once the schedule parses deterministically");
    });
    const combined = await resolveComposerAutomationRequest({
      message: "create an automation to check the build\nevery 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: failingEnrichment,
    });
    expect(combined).toMatchObject({
      type: "automation",
      resolution: {
        source: "deterministic",
        intent: {
          schedule: { type: "interval", everySeconds: 21_600 },
        },
      },
    });
  });

  it("does not leak creation scaffolding into the task prompt across turns", async () => {
    const offline = vi.fn(async () => {
      throw new Error("deterministic parse should cover the combined request");
    });
    // Mirrors ChatView folding the cleaned, filler-stripped automationMessage
    // ("create an automation") with the user's follow-up answer.
    const decision = await resolveComposerAutomationRequest({
      message: "create an automation\ncheck the build every 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(decision.type).toBe("automation");
    if (decision.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(decision.resolution.intent.prompt).toBe("check the build");
    expect(decision.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 21_600,
    });
  });

  it("strips possessive creation filler before the task across turns", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.9,
      language: "en",
      name: "Check build",
      taskPrompt: "Check the build.",
      schedule: null,
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: ["schedule" as const],
      needsConfirmation: false,
      reason: null,
    }));
    const first = await resolveComposerAutomationRequest({
      message: "create an automation for me to check the build",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(first).toMatchObject({
      type: "needs-clarification",
      automationMessage: "create an automation to check the build",
    });

    const offline = vi.fn(async () => {
      throw new Error("deterministic parse should cover the combined request");
    });
    const combined = await resolveComposerAutomationRequest({
      message: "create an automation to check the build\nevery 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(combined.type).toBe("automation");
    if (combined.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(combined.resolution.intent.prompt).toBe("check the build");
    expect(combined.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 21_600,
    });

    const withoutConnector = await resolveComposerAutomationRequest({
      message: "create an automation for me check the build\nevery 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(withoutConnector.type).toBe("automation");
    if (withoutConnector.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(withoutConnector.resolution.intent.prompt).toBe("check the build");

    const scheduledTask = await resolveComposerAutomationRequest({
      message: "schedule a task for me to check the build",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(scheduledTask).toMatchObject({
      type: "needs-clarification",
      automationMessage: "schedule a task to check the build",
    });

    const scheduledTaskCombined = await resolveComposerAutomationRequest({
      message: "schedule a task to check the build\nevery 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(scheduledTaskCombined.type).toBe("automation");
    if (scheduledTaskCombined.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(scheduledTaskCombined.resolution.intent.prompt).toBe("check the build");

    const usSubject = await resolveComposerAutomationRequest({
      message: "create an automation for US outages every hour",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(usSubject.type).toBe("automation");
    if (usSubject.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(usSubject.resolution.intent.prompt).toBe("US outages");
    expect(usSubject.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 3600,
    });

    const metricsSubject = await resolveComposerAutomationRequest({
      message: "create an automation for metrics every hour",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(metricsSubject.type).toBe("automation");
    if (metricsSubject.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(metricsSubject.resolution.intent.prompt).toBe("metrics");
    expect(metricsSubject.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 3600,
    });

    const leadingBareCadence = await resolveComposerAutomationRequest({
      message: "every hour check metrics",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(leadingBareCadence.type).toBe("automation");
    if (leadingBareCadence.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(leadingBareCadence.resolution.intent.prompt).toBe("check metrics");
    expect(leadingBareCadence.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 3600,
    });

    const trailingEachCadence = await resolveComposerAutomationRequest({
      message: "check CI each hour",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(trailingEachCadence.type).toBe("automation");
    if (trailingEachCadence.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(trailingEachCadence.resolution.intent.prompt).toBe("check CI");
    expect(trailingEachCadence.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 3600,
    });

    const leadingEachCadence = await resolveComposerAutomationRequest({
      message: "each hour check CI",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(leadingEachCadence.type).toBe("automation");
    if (leadingEachCadence.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(leadingEachCadence.resolution.intent.prompt).toBe("check CI");
    expect(leadingEachCadence.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 3600,
    });

    const wakeUpEachCadence = await resolveComposerAutomationRequest({
      message: "create an automation where you wake up each 6h and check the site",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(wakeUpEachCadence.type).toBe("automation");
    if (wakeUpEachCadence.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(wakeUpEachCadence.resolution.intent.prompt).toBe("check the site");
    expect(wakeUpEachCadence.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 21_600,
    });

    const runItEachCadence = await resolveComposerAutomationRequest({
      message: "create an automation where you run it each 6h and check the queue",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(runItEachCadence.type).toBe("automation");
    if (runItEachCadence.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(runItEachCadence.resolution.intent.prompt).toBe("check the queue");
    expect(runItEachCadence.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 21_600,
    });

    const punctuatedFiller = await resolveComposerAutomationRequest({
      message: "create an automation for me!",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(punctuatedFiller).toMatchObject({
      type: "needs-clarification",
      automationMessage: "create an automation",
    });

    const punctuatedCombined = await resolveComposerAutomationRequest({
      message: "create an automation\ncheck the build every 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(punctuatedCombined.type).toBe("automation");
    if (punctuatedCombined.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(punctuatedCombined.resolution.intent.prompt).toBe("check the build");
  });

  it("strips Italian possessive creation filler before the task across turns", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.9,
      language: "it",
      name: "Controlla build",
      taskPrompt: "Controlla la build.",
      schedule: null,
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: ["schedule" as const],
      needsConfirmation: false,
      reason: null,
    }));
    const first = await resolveComposerAutomationRequest({
      message: "crea un'automazione per me che controlla la build",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(first).toMatchObject({
      type: "needs-clarification",
      automationMessage: "crea un'automazione che controlla la build",
    });

    const offline = vi.fn(async () => {
      throw new Error("deterministic parse should cover the combined request");
    });
    const combined = await resolveComposerAutomationRequest({
      message: "crea un'automazione che controlla la build\nogni 6 ore",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(combined.type).toBe("automation");
    if (combined.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(combined.resolution.intent.prompt).toBe("controlla la build");
    expect(combined.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 21_600,
    });

    const mercatoSubject = await resolveComposerAutomationRequest({
      message: "crea un'automazione per mercato ogni ora",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(mercatoSubject.type).toBe("automation");
    if (mercatoSubject.type !== "automation") {
      throw new Error("Expected automation decision");
    }
    expect(mercatoSubject.resolution.intent.prompt).toBe("mercato");
    expect(mercatoSubject.resolution.intent.schedule).toMatchObject({
      type: "interval",
      everySeconds: 3600,
    });
  });

  it("keeps 'please' as task content when generation is unavailable", async () => {
    // Generation fails, so the deterministic invocation is carried forward. "please" must
    // survive (it is real task content here), unlike "for me" possessive filler.
    const offline = vi.fn(async () => {
      throw new Error("generation unavailable");
    });
    const decision = await resolveComposerAutomationRequest({
      message: "create an automation to remind me to say please",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(decision.type).toBe("needs-clarification");
    if (decision.type !== "needs-clarification") {
      throw new Error("Expected needs-clarification decision");
    }
    expect(decision.automationMessage).toContain("say please");
  });

  describe("automationClarificationPrompt", () => {
    it("asks for both the task and cadence when the task is missing", () => {
      expect(automationClarificationPrompt(["taskPrompt", "schedule"])).toContain(
        "what should this automation do",
      );
    });

    it("asks only for the cadence when just the schedule is missing", () => {
      const prompt = automationClarificationPrompt(["schedule"]);
      expect(prompt).toContain("How often");
      expect(prompt).not.toContain("what should this automation do");
    });

    it("asks only for the task when the cadence is already known", () => {
      const prompt = automationClarificationPrompt(["taskPrompt"]);
      expect(prompt).toContain("What should this automation do");
      expect(prompt).not.toContain("How often");
    });

    it("asks for task and cadence when nothing was reported, so setup can recover", () => {
      // Empty missingFields (generation timed out/failed) must not loop on cadence for a
      // bare request that has no task yet.
      expect(automationClarificationPrompt([])).toContain("what should this automation do");
    });
  });

  it("asks how often instead of accepting a defaulted manual schedule", async () => {
    // The generator extracts the task but reports the schedule as missing; it must not be
    // silently accepted as a manual automation — the conversational "how often?" follow-up
    // should fire for the common "create an automation to check the build" case.
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.92,
      language: "en",
      name: "Check the build",
      taskPrompt: "Check the build.",
      schedule: null,
      mode: "heartbeat" as const,
      completionPolicy: { type: "none" as const },
      missingFields: ["schedule" as const],
      needsConfirmation: false,
      reason: null,
    }));
    const decision = await resolveComposerAutomationRequest({
      message: "create an automation to check the build",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    expect(decision).toMatchObject({
      type: "needs-clarification",
      missingFields: ["schedule"],
    });
  });

  it("keeps an explicit /automation setup parseable across follow-ups", async () => {
    const generateIntent = vi.fn(async () => ({
      isAutomation: true,
      confidence: 0.9,
      language: "en",
      name: null,
      taskPrompt: null,
      schedule: { type: "interval" as const, everySeconds: 21_600 },
      mode: null,
      completionPolicy: { type: "none" as const },
      missingFields: ["taskPrompt" as const],
      needsConfirmation: false,
      reason: null,
    }));
    const first = await resolveComposerAutomationRequest({
      message: "/automation every 6 hours",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent,
    });
    // The marker is stripped, so the carry-forward re-seeds a creation scaffold instead
    // of leaving a cadence-only fragment that the next turn could not re-detect.
    expect(first).toMatchObject({
      type: "needs-clarification",
      automationMessage: "create an automation every 6 hours",
    });

    const offline = vi.fn(async () => {
      throw new Error("deterministic parse should cover the combined request");
    });
    const combined = await resolveComposerAutomationRequest({
      message: "create an automation every 6 hours\ncheck the build",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(combined).toMatchObject({
      type: "automation",
      resolution: {
        intent: {
          prompt: "check the build",
          schedule: { type: "interval", everySeconds: 21_600 },
        },
      },
    });

    const dailyWithTaskOrdinal = await resolveComposerAutomationRequest({
      message: "/automation every day check every second item in the queue",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(dailyWithTaskOrdinal).toMatchObject({
      type: "automation",
      resolution: {
        intent: {
          prompt: "check every second item in the queue",
          schedule: { type: "daily", timeOfDay: "09:00" },
        },
      },
    });

    const leadingOrdinalWithDailyCadence = await resolveComposerAutomationRequest({
      message: "/automation every second item in the queue daily",
      cwd: "/tmp/project",
      nowIso: NOW_ISO,
      generateIntent: offline,
    });
    expect(leadingOrdinalWithDailyCadence).toMatchObject({
      type: "automation",
      resolution: {
        intent: {
          prompt: "every second item in the queue",
          schedule: { type: "daily", timeOfDay: "09:00" },
        },
      },
    });
  });
});
