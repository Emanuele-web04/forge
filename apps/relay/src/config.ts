export type RelayConfig = {
  port: number;
  apiBaseUrl: string;
  apiIssuer: string;
  relayServiceToken: string;
  maxPairs: number;
  highWaterBytes: number;
};

export class RelayConfigError extends Error {}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = ["API_BASE_URL", "API_ISSUER", "RELAY_SERVICE_TOKEN"] as const;

function requireVars(env: Env): void {
  const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new RelayConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function httpUrl(env: Env, name: "API_BASE_URL" | "API_ISSUER"): string {
  const raw = env[name]?.trim() as string;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RelayConfigError(`${name} must be an absolute HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new RelayConfigError(
      `${name} must be an absolute HTTP(S) URL without credentials, query, or hash`,
    );
  }
  return raw.replace(/\/+$/, "");
}

function positiveInteger(
  env: Env,
  name: "RELAY_PORT" | "RELAY_MAX_PAIRS" | "RELAY_HIGH_WATER_BYTES",
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new RelayConfigError(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new RelayConfigError(`${name} is outside the supported range`);
  }
  return value;
}

export function loadRelayConfig(env: Env): RelayConfig {
  requireVars(env);
  return {
    port: positiveInteger(env, "RELAY_PORT", 8789, 65_535),
    apiBaseUrl: httpUrl(env, "API_BASE_URL"),
    apiIssuer: httpUrl(env, "API_ISSUER"),
    relayServiceToken: env.RELAY_SERVICE_TOKEN?.trim() as string,
    maxPairs: positiveInteger(env, "RELAY_MAX_PAIRS", 1_024),
    highWaterBytes: positiveInteger(env, "RELAY_HIGH_WATER_BYTES", 1024 * 1024),
  };
}
