import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDeepSeekAcpSpawnInput,
  buildDeepSeekHarnessConfig,
  deepSeekPermissionMode,
} from "./DeepSeekAcpSupport.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deepSeekPermissionMode", () => {
  it("uses workspace-write unless Synara is in Full Access", () => {
    expect(deepSeekPermissionMode("approval-required")).toBe("workspace-write");
    expect(deepSeekPermissionMode("full-access")).toBe("danger-full-access");
  });
});

describe("buildDeepSeekHarnessConfig", () => {
  it("builds the official ACP bridge composition with the selected model", () => {
    const config = buildDeepSeekHarnessConfig("deepseek-v4-flash", "approval-required");

    expect(config).toContain("name: '@deepseek-ai/dsh-llm-deepseek'");
    expect(config).toContain("name: '@deepseek-ai/dsh-sandbox-local'");
    expect(config).toContain("name: '@deepseek-ai/dsh-user-approval'");
    expect(config).toContain("name: '@deepseek-ai/dsh-acp-demo'");
    expect(config).toContain('model: "deepseek-v4-flash"');
    expect(config).toContain("mode: workspace-write");
    expect(config).toContain("policy: ask");
  });

  it("switches sandbox and approval policy for Full Access", () => {
    const config = buildDeepSeekHarnessConfig(undefined, "full-access");

    expect(config).toContain('model: "deepseek-v4-pro"');
    expect(config).toContain("mode: danger-full-access");
    expect(config).toContain("policy: never");
  });

  it("keeps a custom Harness model in the generated model catalog", () => {
    const config = buildDeepSeekHarnessConfig("deepseek-custom", "approval-required");

    expect(config).toContain('- id: "deepseek-v4-flash"');
    expect(config).toContain('- id: "deepseek-v4-pro"');
    expect(config).toContain('- id: "deepseek-custom"');
  });
});

describe("buildDeepSeekAcpSpawnInput", () => {
  it("launches dsh-acp-demo with the generated Cordis config", () => {
    expect(
      buildDeepSeekAcpSpawnInput({
        settings: undefined,
        configPath: "/tmp/deepseek/cordis.yml",
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      }),
    ).toMatchObject({
      command: "dsh-acp-demo",
      args: ["--config", "/tmp/deepseek/cordis.yml"],
      cwd: "/tmp/project",
      env: { DSH_PERMISSION_MODE: "workspace-write" },
    });
  });

  it("keeps generated Harness persistence out of the project workspace", () => {
    expect(
      buildDeepSeekAcpSpawnInput({
        settings: undefined,
        configPath: "/tmp/deepseek/cordis.yml",
        generatedSessionsRoot: "/tmp/deepseek/sessions",
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      }).env,
    ).toMatchObject({
      SYNARA_DEEPSEEK_SESSIONS_ROOT: "/tmp/deepseek/sessions",
    });
  });

  it("honors a custom Harness binary and Full Access mode", () => {
    expect(
      buildDeepSeekAcpSpawnInput({
        settings: { binaryPath: "/opt/deepseek/dsh-acp-demo" },
        configPath: "/tmp/deepseek/custom.yml",
        cwd: "/workspace",
        runtimeMode: "full-access",
      }),
    ).toMatchObject({
      command: "/opt/deepseek/dsh-acp-demo",
      args: ["--config", "/tmp/deepseek/custom.yml"],
      cwd: "/workspace",
      env: { DSH_PERMISSION_MODE: "danger-full-access" },
    });
  });

  it("preserves the sessions root override without forwarding unrelated Synara state", () => {
    vi.stubEnv("SYNARA_DEEPSEEK_SESSIONS_ROOT", "/tmp/deepseek-sessions");
    vi.stubEnv("SYNARA_CONTROL_PLANE_SECRET", "do-not-forward");

    const spawn = buildDeepSeekAcpSpawnInput({
      settings: undefined,
      configPath: "/tmp/deepseek/cordis.yml",
      generatedSessionsRoot: "/tmp/generated-deepseek-sessions",
      cwd: "/tmp/project",
      runtimeMode: "approval-required",
    });

    expect(spawn.env?.SYNARA_DEEPSEEK_SESSIONS_ROOT).toBe("/tmp/deepseek-sessions");
    expect(spawn.env?.SYNARA_CONTROL_PLANE_SECRET).toBeUndefined();
  });
});
