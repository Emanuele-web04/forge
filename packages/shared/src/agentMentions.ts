import {
  resolveAgentAlias,
  type ClaudeSubagentAliasDefinition,
  type ProviderKind,
  type ResolvedAgentAlias,
} from "@synara/contracts";

export interface ParsedAgentMentionInvocation {
  readonly alias: string;
  readonly task: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly definition: ResolvedAgentAlias;
}

function isAliasChar(char: string | undefined): boolean {
  return typeof char === "string" && /[a-zA-Z0-9._-]/.test(char);
}

function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

function readBalancedTask(
  text: string,
  openParenIndex: number,
): { task: string; end: number } | null {
  let depth = 1;
  let cursor = openParenIndex + 1;

  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          task: text.slice(openParenIndex + 1, cursor),
          end: cursor + 1,
        };
      }
    }
    cursor += 1;
  }

  return null;
}

export function parseAgentMentionInvocations(
  text: string,
  provider: ProviderKind,
): ReadonlyArray<ParsedAgentMentionInvocation> {
  const invocations: ParsedAgentMentionInvocation[] = [];

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") {
      continue;
    }
    if (!isMentionBoundary(text[index - 1])) {
      continue;
    }

    let aliasEnd = index + 1;
    while (isAliasChar(text[aliasEnd])) {
      aliasEnd += 1;
    }

    const alias = text.slice(index + 1, aliasEnd);
    if (alias.length === 0 || text[aliasEnd] !== "(") {
      continue;
    }

    const resolved = resolveAgentAlias(alias, provider);
    if (!resolved) {
      continue;
    }

    const taskMatch = readBalancedTask(text, aliasEnd);
    if (!taskMatch) {
      continue;
    }
    const task = taskMatch.task.trim();
    if (task.length === 0) {
      index = taskMatch.end - 1;
      continue;
    }

    invocations.push({
      alias,
      task,
      raw: text.slice(index, taskMatch.end),
      start: index,
      end: taskMatch.end,
      definition: {
        alias,
        ...resolved,
      },
    });

    index = taskMatch.end - 1;
  }

  return invocations;
}

export function buildClaudeSubagentPrompt(text: string): {
  readonly prompt: string;
  readonly invocations: ReadonlyArray<
    ParsedAgentMentionInvocation & {
      readonly definition: ResolvedAgentAlias & ClaudeSubagentAliasDefinition;
    }
  >;
} {
  const invocations = parseAgentMentionInvocations(text, "claudeAgent").filter(
    (
      invocation,
    ): invocation is ParsedAgentMentionInvocation & {
      readonly definition: ResolvedAgentAlias & ClaudeSubagentAliasDefinition;
    } => invocation.definition.kind === "claude-subagent",
  );

  if (invocations.length === 0) {
    return {
      prompt: text,
      invocations,
    };
  }

  const directiveLines = invocations
    .map(
      (invocation, index) =>
        `${index + 1}. Use the "${invocation.definition.agentName}" agent for this task:\n${invocation.task}`,
    )
    .join("\n\n");

  return {
    prompt: [
      "The user included inline subagent directives in the form @alias(task).",
      "Execute each directive explicitly via the Agent tool using the named subagent below.",
      "After the delegated work completes, continue with the overall request and synthesize the results.",
      "Do not echo the literal @alias(task) syntax back to the user unless it is directly relevant.",
      "",
      "Inline directives:",
      directiveLines,
      "",
      "Original user prompt:",
      text,
    ].join("\n"),
    invocations,
  };
}
