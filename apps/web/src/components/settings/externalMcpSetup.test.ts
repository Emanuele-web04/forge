import { describe, expect, it } from "vitest";

import {
  buildExternalMcpClientConfiguration,
  buildExternalMcpExamplePrompt,
  buildExternalMcpSetupPrompt,
  describeExternalMcpPermissions,
  describeExternalMcpProjects,
  externalMcpSetupAction,
} from "./externalMcpSetup";

const stdio = {
  command: "/Applications/Synara.app/Contents/MacOS/Synara",
  args: [
    "server.js",
    "mcp",
    "serve",
    "--integration",
    "mcp_int_example",
    "--home-dir",
    "/tmp/Synara home",
  ],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};

describe("external MCP guided setup", () => {
  it("builds copyable Codex and Claude Code commands without embedding a credential", () => {
    const codex = buildExternalMcpClientConfiguration("codex", stdio);
    const claude = buildExternalMcpClientConfiguration("claudeCode", stdio);

    expect(codex.value).toBe(
      "codex mcp add synara --env ELECTRON_RUN_AS_NODE=1 -- /Applications/Synara.app/Contents/MacOS/Synara server.js mcp serve --integration mcp_int_example --home-dir '/tmp/Synara home'",
    );
    expect(claude.value).toBe(
      "claude mcp add --scope user synara -e ELECTRON_RUN_AS_NODE=1 -- /Applications/Synara.app/Contents/MacOS/Synara server.js mcp serve --integration mcp_int_example --home-dir '/tmp/Synara home'",
    );
    expect(`${codex.value}${claude.value}`).not.toContain("syn_mcp_v1_");
  });

  it("builds standard JSON configuration for desktop and other clients", () => {
    const desktop = buildExternalMcpClientConfiguration("claudeDesktop", stdio);
    const parsed = JSON.parse(desktop.value) as {
      mcpServers: { synara: { command: string; args: ReadonlyArray<string> } };
    };

    expect(desktop.format).toBe("json");
    expect(parsed.mcpServers.synara).toEqual(stdio);
  });

  it("builds terminal commands for PowerShell on Windows", () => {
    const codex = buildExternalMcpClientConfiguration("codex", stdio, "Win32");
    expect(codex.value).toBe(
      "& 'codex' 'mcp' 'add' 'synara' '--env' 'ELECTRON_RUN_AS_NODE=1' '--' '/Applications/Synara.app/Contents/MacOS/Synara' 'server.js' 'mcp' 'serve' '--integration' 'mcp_int_example' '--home-dir' '/tmp/Synara home'",
    );
    expect(codex.instruction).toContain("PowerShell");
  });

  it("builds a project-specific prompt without exposing implementation identifiers", () => {
    const prompt = buildExternalMcpExamplePrompt("Synara app");

    expect(prompt).toContain('project named "Synara app"');
    expect(prompt).toContain("managed worktree");
    expect(prompt).toContain("approval-required");
    expect(prompt).not.toContain("projectId");
    expect(prompt).not.toContain("request ID");
    expect(prompt).not.toContain("mcp_int_");
  });

  it("builds one agent-facing setup prompt covering pairing, registration, and verification", () => {
    const prompt = buildExternalMcpSetupPrompt({
      setupCommand: "synara mcp pair --code syn_pair_v1_example --home-dir /tmp/home",
      stdio,
    });

    expect(prompt).toContain("syn_pair_v1_example");
    expect(prompt).toContain("codex mcp add synara");
    expect(prompt).toContain("claude mcp add --scope user synara");
    expect(prompt).toContain('"mcpServers"');
    expect(prompt).toContain("synara_overview");
    expect(prompt).not.toContain("syn_mcp_v1_");
  });

  it("omits the pairing step once the computer is already paired", () => {
    const prompt = buildExternalMcpSetupPrompt({ setupCommand: null, stdio });

    expect(prompt).toContain("already completed");
    expect(prompt).not.toContain("syn_pair_v1_");
    expect(prompt).toContain("synara_overview");
  });

  it("builds a discovery-first example prompt for all-projects connections", () => {
    const prompt = buildExternalMcpExamplePrompt(null);

    expect(prompt).toContain("synara_overview");
    expect(prompt).toContain("managed worktree");
  });

  it("describes project access for both scopes", () => {
    expect(
      describeExternalMcpProjects({ projectScope: "all", allowedProjects: [{ title: "One" }] }),
    ).toBe("All projects, including future ones");
    expect(
      describeExternalMcpProjects({
        projectScope: "selected",
        allowedProjects: [{ title: "One" }, { title: "Two" }],
      }),
    ).toBe("One, Two");
  });

  it("describes scopes without exposing capability identifiers", () => {
    const description = describeExternalMcpPermissions([
      "projects:read",
      "tasks:create",
      "tasks:wait",
      "tasks:read",
      "runtime:local",
    ]);

    expect(description).toBe("Create and follow its own tasks · Use the shared local checkout");
    expect(description).not.toContain("runtime:local");
  });

  it("offers a non-destructive resume path when only the pairing code expired", () => {
    expect(
      externalMcpSetupAction({
        revoked: false,
        integrationExpired: false,
        paired: false,
        pairingExpired: true,
      }),
    ).toBe("resume-pairing");
    expect(
      externalMcpSetupAction({
        revoked: false,
        integrationExpired: true,
        paired: false,
        pairingExpired: true,
      }),
    ).toBe("revoke");
  });
});
