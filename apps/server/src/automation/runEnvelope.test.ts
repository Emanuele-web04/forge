import {
  DEFAULT_PROVIDER_PROFILE_ID,
  AutomationId,
  AutomationRunId,
  ProjectId,
  type AutomationDefinition,
  type AutomationRun,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  AUTOMATION_MEMORY_INJECTION_MAX_BYTES,
  AUTOMATION_MEMORY_TRUNCATION_MARKER,
  automationMemoryForEnvelope,
  buildAutomationRunEnvelope,
} from "./runEnvelope.ts";

function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return {
    id: AutomationId.makeUnsafe("automation-envelope"),
    name: "Review build",
    prompt: "Inspect the latest build.",
    mode: "heartbeat",
    iterationCount: 2,
    maxIterations: 10,
    ...overrides,
  } as AutomationDefinition;
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: AutomationRunId.makeUnsafe("run-envelope"),
    automationId: AutomationId.makeUnsafe("automation-envelope"),
    projectId: ProjectId.makeUnsafe("project-envelope"),
    trigger: { type: "scheduled" },
    scheduledFor: "2026-07-23T09:00:00.000Z",
    permissionSnapshot: {
      provider: "codex",
      modelSelection: { provider: "codex", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      worktreeMode: "local",
      allowedCapabilities: ["send-turn"],
      createdAt: "2026-07-23T09:00:00.000Z",
    },
    ...overrides,
  } as AutomationRun;
}

describe("buildAutomationRunEnvelope", () => {
  it("builds the canonical heartbeat envelope in one place", () => {
    const envelope = buildAutomationRunEnvelope({
      definition: definition(),
      run: run(),
      memoryContent: "Last build was green.",
      lastRunAt: "2026-07-22T09:00:12.000Z",
    });

    expect(envelope).toContain("Automation: Review build");
    expect(envelope).toContain("Automation ID: automation-envelope");
    expect(envelope).toContain(
      "Run: scheduled, scheduled for 2026-07-23T09:00:00.000Z " +
        "(last run: 2026-07-22T09:00:12.000Z, iteration 3/10)",
    );
    expect(envelope).toContain("Last build was green.");
    expect(envelope).toContain(
      "These automation-only completion duties do not carry into later manual follow-up turns.",
    );
    expect(envelope).toContain("call synara_report_automation_result");
    expect(envelope).toContain('decision "silent"');
    expect(envelope).toContain("synara_cancel_automation");
    expect(envelope.endsWith("---\n\nInspect the latest build.")).toBe(true);
  });

  it("offers self-cancellation to standalone runs too", () => {
    // Standalone runs are the ones that most need it: their per-run thread owns nothing,
    // so run-scoped authorization is their only way to retire the automation.
    const envelope = buildAutomationRunEnvelope({
      definition: definition({ mode: "standalone" }),
      run: run(),
      memoryContent: "",
      lastRunAt: null,
    });

    expect(envelope).toContain("synara_cancel_automation");
    expect(envelope).toContain('decision "notify"');
  });

  it("tells each mode who else writes in the thread it runs in", () => {
    const dedicated = buildAutomationRunEnvelope({
      definition: definition({ mode: "dedicated" }),
      run: run(),
      memoryContent: "",
      lastRunAt: null,
    });
    const heartbeat = buildAutomationRunEnvelope({
      definition: definition(),
      run: run(),
      memoryContent: "",
      lastRunAt: null,
    });
    const standalone = buildAutomationRunEnvelope({
      definition: definition({ mode: "standalone" }),
      run: run(),
      memoryContent: "",
      lastRunAt: null,
    });

    expect(dedicated).toContain(
      "this thread belongs to this automation and is reused by every run",
    );
    // A dedicated run reports like a heartbeat: its work stays visible in the thread.
    expect(dedicated).toContain('decision "silent"');
    expect(heartbeat).toContain("it may also carry the user's own turns");
    expect(standalone).not.toContain("Thread scope:");
  });

  it("uses an explicit empty-memory placeholder and unbounded iteration label", () => {
    const envelope = buildAutomationRunEnvelope({
      definition: definition({ mode: "standalone", maxIterations: null }),
      run: run({ trigger: { type: "manual" } }),
      memoryContent: "",
      lastRunAt: null,
    });

    expect(envelope).toContain("Run: manual");
    expect(envelope).toContain("(last run: never, iteration 3/∞)");
    expect(envelope).toContain("\n(empty)\n");
  });

  it("uses the run's claimed iteration after a deferred retry reloads the definition", () => {
    const envelope = buildAutomationRunEnvelope({
      definition: definition({ iterationCount: 7 }),
      run: run({
        permissionSnapshot: {
          ...run().permissionSnapshot,
          iterationNumber: 3,
        },
      }),
      memoryContent: "",
      lastRunAt: null,
    });

    expect(envelope).toContain("iteration 3/10");
  });
});

describe("automationMemoryForEnvelope", () => {
  it("keeps at most 8 KiB, drops the oldest bytes, and preserves valid UTF-8", () => {
    const newest = "NEWEST: café 🚀";
    const memory = `${"old ".repeat(3_000)}${newest}`;
    const injected = automationMemoryForEnvelope(memory);

    expect(injected.startsWith(AUTOMATION_MEMORY_TRUNCATION_MARKER)).toBe(true);
    expect(injected.endsWith(newest)).toBe(true);
    expect(Buffer.byteLength(injected, "utf8")).toBeLessThanOrEqual(
      AUTOMATION_MEMORY_INJECTION_MAX_BYTES,
    );
    expect(injected).not.toContain("\uFFFD");
  });
});
