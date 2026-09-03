import { describe, expect, it } from "vitest";

import { buildClaudeSubagentPrompt, parseAgentMentionInvocations } from "./agentMentions";

describe("parseAgentMentionInvocations", () => {
  it("parses Codex inline subagent syntax", () => {
    expect(parseAgentMentionInvocations("Check @spark(find the regression)", "codex")).toEqual([
      {
        alias: "spark",
        task: "find the regression",
        raw: "@spark(find the regression)",
        start: 6,
        end: 33,
        definition: {
          alias: "spark",
          provider: "codex",
          kind: "model",
          model: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Codex Spark",
          color: "cyan",
        },
      },
    ]);
  });

  it("parses balanced nested parentheses for Claude subagents", () => {
    const parsed = parseAgentMentionInvocations(
      "Please @review(check fn(a, b) and the SQL migration)",
      "claudeAgent",
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.task).toBe("check fn(a, b) and the SQL migration");
    expect(parsed[0]?.definition.kind).toBe("claude-subagent");
  });

  it("ignores empty and whitespace-only agent tasks", () => {
    expect(parseAgentMentionInvocations("Please @review()", "claudeAgent")).toEqual([]);
    expect(parseAgentMentionInvocations("Please @review(   )", "claudeAgent")).toEqual([]);
  });
});

describe("buildClaudeSubagentPrompt", () => {
  it("leaves plain prompts untouched when no Claude mentions exist", () => {
    expect(buildClaudeSubagentPrompt("Just answer directly")).toEqual({
      prompt: "Just answer directly",
      invocations: [],
    });
  });

  it("leaves empty Claude directives untouched instead of creating an empty Agent task", () => {
    const prompt = "Please @review()";
    expect(buildClaudeSubagentPrompt(prompt)).toEqual({ prompt, invocations: [] });
  });

  it("rewrites Claude mentions into explicit Agent-tool instructions", () => {
    const rewritten = buildClaudeSubagentPrompt(
      "Compare these changes and @review(check for regressions) then @explore(find related files)",
    );

    expect(rewritten.invocations.map((invocation) => invocation.definition.agentName)).toEqual([
      "review",
      "explore",
    ]);
    expect(rewritten.prompt).toContain('Use the "review" agent for this task:');
    expect(rewritten.prompt).toContain("check for regressions");
    expect(rewritten.prompt).toContain('Use the "explore" agent for this task:');
    expect(rewritten.prompt).toContain("Original user prompt:");
  });
});
