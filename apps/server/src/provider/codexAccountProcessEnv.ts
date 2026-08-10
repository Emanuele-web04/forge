import path from "node:path";

import { resolveBaseCodexHomePath } from "../codexHomePaths";
import { buildProviderChildEnvironment } from "../providerChildEnvironment";
import type { CodexProviderLaunchContext } from "./codexProviderLaunchContext";

const MANAGED_ACCOUNT_OPERATIONAL_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  // Proxy and CA variables are an explicit connectivity policy. No other
  // ambient application or provider configuration crosses this boundary.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_CA_CERTIFICATE",
] as const;

function managedAccountEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const isolatedEnv: NodeJS.ProcessEnv = {};
  const caseInsensitiveEnvironment =
    platform === "win32"
      ? new Map(
          Object.entries(env).map(([key, value]) => [key.toLowerCase(), value] as const),
        )
      : undefined;
  for (const key of MANAGED_ACCOUNT_OPERATIONAL_ENV_KEYS) {
    const value = env[key] ?? caseInsensitiveEnvironment?.get(key.toLowerCase());
    if (value !== undefined) isolatedEnv[key] = value;
  }
  return isolatedEnv;
}

export function resolveCodexAccountHomePath(
  launchContext: CodexProviderLaunchContext,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (launchContext.home.strategy === "managed-direct") {
    return launchContext.home.codexHomePath;
  }
  return path.resolve(
    cwd,
    resolveBaseCodexHomePath(env, launchContext.home.sourceHomePath ?? undefined),
  );
}

export function buildCodexAccountProcessEnv(input: {
  readonly launchContext: CodexProviderLaunchContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const baseEnv = { ...(input.env ?? process.env) };
  const { launchContext } = input;

  if (launchContext.home.strategy === "legacy-overlay") {
    const sourceHomePath = resolveCodexAccountHomePath(
      launchContext,
      baseEnv,
      input.cwd ?? process.cwd(),
    );
    return buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: { ...baseEnv, CODEX_HOME: sourceHomePath },
    });
  }

  const privateProfileRoot = path.dirname(launchContext.home.codexHomePath);
  return {
    ...managedAccountEnvironment(baseEnv, input.platform ?? process.platform),
    HOME: privateProfileRoot,
    USERPROFILE: privateProfileRoot,
    CODEX_HOME: launchContext.home.codexHomePath,
    CODEX_SQLITE_HOME: launchContext.home.codexSqliteHomePath,
  };
}
