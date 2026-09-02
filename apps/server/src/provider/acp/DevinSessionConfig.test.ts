import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDevinSessionConfig, type DevinSessionConfig } from "./DevinSessionConfig.ts";

const configs: DevinSessionConfig[] = [];
afterEach(async () => {
  await Promise.all(configs.splice(0).map((config) => config.cleanup()));
});

async function makeInput(overrides: Record<string, unknown> = {}) {
  const root = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), "devin-config-test-")),
  );
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  await mkdir(path.join(xdg, "devin", "skills", "native"), { recursive: true });
  await mkdir(path.join(xdg, "cognition", "skills", "cognition-native"), { recursive: true });
  return {
    connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "REAL-BEARER" },
    stdioProxy: { command: process.execPath, args: ["/proxy.mjs"] },
    bootstrapToken: "spent-one-shot-bootstrap",
    env: { HOME: home, XDG_CONFIG_HOME: xdg, XDG_DATA_HOME: "/real/data" },
    tmpDir: root,
    ...overrides,
  };
}

describe("createDevinSessionConfig", () => {
  it("merges user MCP entries without mutating the source and keeps credentials paths visible", async () => {
    const input = await makeInput();
    const source = path.join(input.env.XDG_CONFIG_HOME, "devin", "mcp_config.json");
    const original = JSON.stringify(
      { mcpServers: { github: { url: "https://example.test/mcp" } }, note: "keep" },
      null,
      2,
    );
    await writeFile(source, original);

    const config = await createDevinSessionConfig(input);
    configs.push(config);
    const generated = JSON.parse(await readFile(config.configPath, "utf8"));

    expect(generated.note).toBe("keep");
    expect(generated.mcpServers.github).toEqual({ url: "https://example.test/mcp" });
    expect(generated.mcpServers.synara).toMatchObject({
      command: process.execPath,
      args: ["/proxy.mjs"],
      env: {
        SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:3773/mcp",
        SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "spent-one-shot-bootstrap",
      },
      transport: "stdio",
    });
    expect(await readFile(source, "utf8")).toBe(original);
    expect(config.childEnvironment.HOME).toBe(input.env.HOME);
    expect(config.childEnvironment.XDG_DATA_HOME).toBe("/real/data");
    expect(config.childEnvironment.XDG_CONFIG_HOME).toBe(config.root);
    await expect(
      access(path.join(config.root, "devin", "skills", "native")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(config.root, "cognition", "skills", "cognition-native")),
    ).resolves.toBeUndefined();
  });

  it("contains no session bearer and uses owner-only POSIX permissions", async () => {
    const config = await createDevinSessionConfig(await makeInput());
    configs.push(config);
    const generated = await readFile(config.configPath, "utf8");
    expect(generated).not.toContain("REAL-BEARER");
    expect((await stat(config.root)).mode & 0o777).toBe(0o700);
    expect((await stat(config.configPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a reserved synara collision without changing user config", async () => {
    const input = await makeInput();
    const source = path.join(input.env.XDG_CONFIG_HOME, "devin", "mcp_config.json");
    const original = JSON.stringify({ mcpServers: { synara: { command: "user-owned" } } });
    await writeFile(source, original);
    await expect(createDevinSessionConfig(input)).rejects.toThrow("reserved 'synara'");
    expect(await readFile(source, "utf8")).toBe(original);
  });

  it("isolates concurrent process roots and cleans each idempotently", async () => {
    const input = await makeInput();
    const [first, second] = await Promise.all([
      createDevinSessionConfig(input),
      createDevinSessionConfig({ ...input, bootstrapToken: "second-bootstrap" }),
    ]);
    expect(first.root).not.toBe(second.root);
    expect(first.configPath).not.toBe(second.configPath);
    await first.cleanup();
    await first.cleanup();
    await expect(access(first.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(second.configPath, "utf8")).toContain("second-bootstrap");
    configs.push(second);
  });

  it("isolates the Windows MCP config through APPDATA", async () => {
    const baseInput = await makeInput();
    const appData = path.join(baseInput.tmpDir, "appdata");
    const sourceConfig = path.join(appData, "devin", "mcp_config.json");
    await mkdir(path.dirname(sourceConfig), { recursive: true });
    await writeFile(
      sourceConfig,
      JSON.stringify({ mcpServers: { github: { url: "https://example.test/mcp" } } }),
    );

    const config = await createDevinSessionConfig({
      ...baseInput,
      platform: "win32",
      env: { ...baseInput.env, APPDATA: appData },
    });
    configs.push(config);

    expect(config.childEnvironment.APPDATA).toBe(config.root);
    expect(JSON.parse(await readFile(config.configPath, "utf8")).mcpServers).toMatchObject({
      github: { url: "https://example.test/mcp" },
      synara: { transport: "stdio" },
    });
    expect(await readFile(sourceConfig, "utf8")).not.toContain("synara");
  });
});
