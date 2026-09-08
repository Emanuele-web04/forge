import { describe, expect, it } from "vitest";
import {
  buildCodexCollaborationMode,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../../codexAppServerManager.ts";
import { computerToolInstructions } from "../../agentGateway/computerGuidance.ts";
import { buildEmbeddedClaudeSystemPromptAppend } from "./ClaudeAdapter.ts";
import { takeCursorSynaraHarnessPolicyTextPart } from "./CursorAdapter.ts";
import { takeDroidSynaraHarnessPolicyTextPart } from "./DroidAdapter.ts";
import { takeGrokSynaraHarnessPolicyTextPart } from "./GrokAdapter.ts";
import { buildAntigravityTurnPrompt } from "./AntigravityAdapter.ts";

import { buildPiTurnPrompt } from "./PiAdapter.ts";
import { takeDevinSynaraHarnessPolicyTextPart } from "./DevinAdapter.ts";

const computerContext = computerToolInstructions();
const marker = "## Synara computer use";

describe("conditional Computer host context", () => {
  it.each(["default", "plan"] as const)(
    "keeps Codex %s off payload unchanged and adds one enabled block",
    (interactionMode) => {
      const off = buildCodexCollaborationMode({ interactionMode, enableComputerControl: false });
      expect(off?.settings.developer_instructions).toBe(
        interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      );
      expect(off?.settings.developer_instructions).not.toContain(marker);
      const on = buildCodexCollaborationMode({ interactionMode, enableComputerControl: true });
      expect(on?.settings.developer_instructions).toContain(computerContext);
      expect(on?.settings.developer_instructions.split(marker)).toHaveLength(2);
    },
  );
  it("does not drop enabled Codex guidance when the caller omits collaboration mode", () => {
    expect(buildCodexCollaborationMode({})).toBeUndefined();
    expect(
      buildCodexCollaborationMode({ enableComputerControl: true })?.settings.developer_instructions,
    ).toContain(computerContext);
  });
  it("adds Claude Computer context only when both activation and gateway are present", () => {
    expect(buildEmbeddedClaudeSystemPromptAppend(true, false)).toBe(
      buildEmbeddedClaudeSystemPromptAppend(true),
    );
    expect(buildEmbeddedClaudeSystemPromptAppend(true, false)).not.toContain(marker);
    expect(buildEmbeddedClaudeSystemPromptAppend(false, true)).not.toContain(marker);
    expect(buildEmbeddedClaudeSystemPromptAppend(true, true).split(marker)).toHaveLength(2);
    expect(buildEmbeddedClaudeSystemPromptAppend(true, true)).toContain(computerContext);
  });
  it.each([
    ["Cursor", takeCursorSynaraHarnessPolicyTextPart],
    ["Droid", takeDroidSynaraHarnessPolicyTextPart],
    ["Grok", takeGrokSynaraHarnessPolicyTextPart],
    ["Devin", takeDevinSynaraHarnessPolicyTextPart],
  ] as const)("delivers %s Computer context once only for enabled sessions", (_name, take) => {
    expect(take({ enableComputerControl: false }, true)?.text).not.toContain(marker);
    expect(take({ enableComputerControl: true }, false)?.text).not.toContain(marker);
    const state = { enableComputerControl: true };
    const first = take(state, true)?.text;
    expect(first).toContain(computerContext);
    expect(first?.split(marker)).toHaveLength(2);
    expect(take(state, true)).toBeNull();
  });
  it("delivers Pi Computer context once through prompts despite skipping MCP initialize", () => {
    expect(
      buildPiTurnPrompt(
        { enableComputerControl: false },
        { text: "code", gatewayControlAvailable: true },
      ),
    ).not.toContain(marker);
    expect(
      buildPiTurnPrompt(
        { enableComputerControl: true },
        { text: "code", gatewayControlAvailable: false },
      ),
    ).not.toContain(marker);
    const state = { enableComputerControl: true };
    const first = buildPiTurnPrompt(state, { text: "inspect", gatewayControlAvailable: true });
    expect(first).toContain(computerContext);
    expect(first.split(marker)).toHaveLength(2);
    expect(buildPiTurnPrompt(state, { text: "continue", gatewayControlAvailable: true })).toBe(
      "continue",
    );
  });
  it("delivers Antigravity Computer context once across credential rotations", () => {
    expect(
      buildAntigravityTurnPrompt(
        { enableComputerControl: false },
        { prompt: "code", hasGatewaySessionLease: true },
      ),
    ).not.toContain(marker);
    const state = { enableComputerControl: true };
    const first = buildAntigravityTurnPrompt(state, {
      prompt: "inspect",
      hasGatewaySessionLease: true,
    });
    expect(first).toContain(computerContext);
    expect(first.split(marker)).toHaveLength(2);
    expect(
      buildAntigravityTurnPrompt(state, { prompt: "continue", hasGatewaySessionLease: true }),
    ).toBe("continue");
  });
});
