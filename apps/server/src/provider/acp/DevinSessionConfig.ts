import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AgentGatewayMcpConnection,
  AgentGatewayStdioProxySpawn,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV,
  SYNARA_AGENT_GATEWAY_URL_ENV,
  SYNARA_MCP_SERVER_NAME,
} from "../../agentGateway/mcpInjection.ts";

interface DevinMcpConfig {
  readonly mcpServers?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface DevinSessionConfig {
  readonly root: string;
  readonly configPath: string;
  readonly childEnvironment: NodeJS.ProcessEnv;
  readonly installed: boolean;
  readonly cleanup: () => Promise<void>;
}

export interface DevinSessionConfigInput {
  readonly connection: AgentGatewayMcpConnection;
  readonly stdioProxy: AgentGatewayStdioProxySpawn;
  readonly bootstrapToken: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly tmpDir?: string;
}

function userMcpConfigPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData ? path.join(appData, "devin", "mcp_config.json") : undefined;
  }
  const home = env.HOME?.trim();
  const configHome = env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : undefined);
  if (!configHome) return undefined;
  return path.join(configHome, "devin", "mcp_config.json");
}

async function readUserConfig(configPath: string | undefined): Promise<DevinMcpConfig> {
  if (!configPath) return {};
  const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Devin user MCP config must contain a JSON object.");
  }
  return parsed as DevinMcpConfig;
}

export async function createDevinSessionConfig(
  input: DevinSessionConfigInput,
): Promise<DevinSessionConfig> {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const userConfig = await readUserConfig(userMcpConfigPath(env, platform));
  const userServers = userConfig.mcpServers;
  if (
    userServers !== undefined &&
    (userServers === null || typeof userServers !== "object" || Array.isArray(userServers))
  ) {
    throw new Error("Devin user MCP config mcpServers must contain an object.");
  }
  if (userServers && Object.prototype.hasOwnProperty.call(userServers, SYNARA_MCP_SERVER_NAME)) {
    throw new Error("Devin user MCP config already defines the reserved 'synara' server name.");
  }

  const root = await mkdtemp(path.join(input.tmpDir ?? os.tmpdir(), "synara-devin-"));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(root, { recursive: true, force: true });
  };
  try {
    await chmod(root, 0o700);
    const home = env.HOME?.trim();
    const sourceConfigHome =
      platform === "win32"
        ? env.APPDATA?.trim()
        : env.XDG_CONFIG_HOME?.trim() || (home ? path.join(home, ".config") : undefined);
    for (const namespace of ["devin", "cognition"] as const) {
      if (!sourceConfigHome) break;
      const sourceSkills = path.join(sourceConfigHome, namespace, "skills");
      const targetNamespace = path.join(root, namespace);
      const targetSkills = path.join(targetNamespace, "skills");
      await access(sourceSkills).then(
        async () => {
          await mkdir(targetNamespace, { recursive: true, mode: 0o700 });
          await symlink(sourceSkills, targetSkills, platform === "win32" ? "junction" : "dir");
        },
        () => undefined,
      );
    }
    const configDir = path.join(root, "devin");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await chmod(configDir, 0o700);
    const configPath = path.join(configDir, "mcp_config.json");
    const config: DevinMcpConfig = {
      ...userConfig,
      mcpServers: {
        ...(userServers as Record<string, unknown> | undefined),
        [SYNARA_MCP_SERVER_NAME]: {
          command: input.stdioProxy.command,
          args: [...input.stdioProxy.args],
          env: {
            [SYNARA_AGENT_GATEWAY_URL_ENV]: input.connection.url,
            [SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN_ENV]: input.bootstrapToken,
            ELECTRON_RUN_AS_NODE: "1",
          },
          transport: "stdio",
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(configPath, 0o600);
    return {
      root,
      configPath,
      childEnvironment: {
        ...env,
        ...(platform === "win32" ? { APPDATA: root } : { XDG_CONFIG_HOME: root }),
      },
      installed: true,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
