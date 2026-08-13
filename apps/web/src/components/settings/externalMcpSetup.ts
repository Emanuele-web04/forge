import type {
  ExternalMcpCapability,
  ExternalMcpClientKind,
  ExternalMcpProjectScope,
  ExternalMcpStdioConfiguration,
} from "@synara/contracts";

export interface ExternalMcpClientConfiguration {
  readonly format: "command" | "json";
  readonly value: string;
  readonly copyLabel: string;
  readonly instruction: string;
}

export type ExternalMcpSetupAction = "resume-pairing" | "revoke" | "done" | null;

export function externalMcpSetupAction(input: {
  readonly revoked: boolean;
  readonly integrationExpired: boolean;
  readonly paired: boolean;
  readonly pairingExpired: boolean;
}): ExternalMcpSetupAction {
  if (input.revoked || input.integrationExpired) return "revoke";
  if (!input.paired && input.pairingExpired) return "resume-pairing";
  return input.paired ? "done" : null;
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(parts: ReadonlyArray<string>, platform: string): string {
  if (/win/i.test(platform)) {
    return `& ${parts.map((part) => `'${part.replaceAll("'", "''")}'`).join(" ")}`;
  }
  return parts.map(quoteShellArgument).join(" ");
}

function jsonConfiguration(stdio: ExternalMcpStdioConfiguration): string {
  return JSON.stringify(
    {
      mcpServers: {
        synara: {
          command: stdio.command,
          args: stdio.args,
          ...(stdio.env ? { env: stdio.env } : {}),
        },
      },
    },
    null,
    2,
  );
}

export function buildExternalMcpClientConfiguration(
  client: ExternalMcpClientKind,
  stdio: ExternalMcpStdioConfiguration,
  platform = "",
): ExternalMcpClientConfiguration {
  if (client === "codex") {
    const environment = Object.entries(stdio.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    return {
      format: "command",
      value: shellCommand(
        ["codex", "mcp", "add", "synara", ...environment, "--", stdio.command, ...stdio.args],
        platform,
      ),
      copyLabel: "Copy Codex command",
      instruction: /win/i.test(platform)
        ? "Run this command in PowerShell. Codex will save Synara as a local MCP server; then open a new Codex task."
        : "Run this command in Terminal. Codex will save Synara as a local MCP server; then open a new Codex task.",
    };
  }

  if (client === "claudeCode") {
    const environment = Object.entries(stdio.env ?? {}).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]);
    return {
      format: "command",
      value: shellCommand(
        [
          "claude",
          "mcp",
          "add",
          "--scope",
          "user",
          "synara",
          ...environment,
          "--",
          stdio.command,
          ...stdio.args,
        ],
        platform,
      ),
      copyLabel: "Copy Claude command",
      instruction: /win/i.test(platform)
        ? "Run this command in PowerShell. Claude Code will make Synara available in all your projects."
        : "Run this command in Terminal. Claude Code will make Synara available in all your projects.",
    };
  }

  return {
    format: "json",
    value: jsonConfiguration(stdio),
    copyLabel: "Copy configuration",
    instruction:
      client === "claudeDesktop"
        ? "In Claude Desktop, open Settings → Developer → Edit Config. Add the Synara entry without removing existing servers, save, and restart Claude Desktop."
        : "Paste this into your app's local stdio MCP configuration.",
  };
}

export function buildExternalMcpExamplePrompt(projectTitle: string | null): string {
  return [
    projectTitle === null
      ? "Use Synara to create a new task: call synara_overview first, pick the most relevant project, and tell me which one you chose."
      : `Use Synara to create a new task in the project named ${JSON.stringify(projectTitle)}.`,
    "First inspect Synara's capabilities and choose an exact available provider and model; do not guess model names.",
    "Use an isolated managed worktree and approval-required execution.",
    "Goal: [DESCRIBE THE WORK].",
    "Wait for the task to finish, then read the result and summarize it for me.",
  ].join(" ");
}

// The one block a user pastes into any coding agent (Codex, Claude Code, or
// another MCP-capable app). The agent pairs the machine, registers Synara in
// its own MCP configuration, and verifies the connection — no per-client
// artifacts to juggle. `setupCommand` is null once pairing already happened.
export function buildExternalMcpSetupPrompt(input: {
  readonly setupCommand: string | null;
  readonly stdio: ExternalMcpStdioConfiguration;
  readonly platform?: string;
}): string {
  const platform = input.platform ?? "";
  const codex = buildExternalMcpClientConfiguration("codex", input.stdio, platform);
  const claude = buildExternalMcpClientConfiguration("claudeCode", input.stdio, platform);
  const sections: string[] = [
    "Connect this coding agent to Synara via MCP. Complete every step yourself, in order, and report what happened.",
  ];
  if (input.setupCommand !== null) {
    sections.push(
      [
        "Step 1 — Pair this computer. Run this exact command in a shell. It exchanges a one-time code (valid for about 10 minutes) for a private credential stored on this computer; no secret ever goes into your MCP configuration:",
        "",
        input.setupCommand,
      ].join("\n"),
    );
  } else {
    sections.push("Step 1 — Pairing is already completed on this computer. Skip it.");
  }
  sections.push(
    [
      'Step 2 — Register Synara as a stdio MCP server named "synara" in your own configuration, using whichever mechanism your app supports:',
      "",
      `If you are Codex, run: ${codex.value}`,
      `If you are Claude Code, run: ${claude.value}`,
      "For any other MCP app, merge this into its MCP configuration:",
      jsonConfiguration(input.stdio),
    ].join("\n"),
    'Step 3 — Verify. Reload your MCP servers if needed, then call the "synara_overview" tool and summarize the projects, providers, and permissions it returns.',
  );
  return sections.join("\n\n");
}

export function describeExternalMcpProjects(input: {
  readonly projectScope?: ExternalMcpProjectScope | undefined;
  readonly allowedProjects: ReadonlyArray<{ readonly title: string }>;
}): string {
  if (input.projectScope === "all") return "All projects, including future ones";
  const titles = input.allowedProjects.map((project) => project.title);
  return titles.length > 0 ? titles.join(", ") : "No projects";
}

export function describeExternalMcpPermissions(
  capabilities: ReadonlyArray<ExternalMcpCapability>,
): string {
  const descriptions = ["Create and follow its own tasks"];
  if (capabilities.includes("tasks:read-project")) {
    descriptions.push("Read other tasks in selected projects");
  }
  if (capabilities.includes("runtime:local")) {
    descriptions.push("Use the shared local checkout");
  }
  if (capabilities.includes("runtime:full-access")) {
    descriptions.push("Run without approval prompts");
  }
  return descriptions.join(" · ");
}
