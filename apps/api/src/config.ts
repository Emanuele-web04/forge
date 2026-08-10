export type ApiConfigBase = {
  databaseUrl: string;
  baseUrl: string;
  port: number;
};

/**
 * Configuration for the hosted identity provider (WorkOS). The only place
 * outside `src/identity/workos.ts` where WorkOS is named: config plumbing has
 * to spell the env vars, the implementation consumes them, and nothing else
 * in the service knows which provider is behind the seam.
 */
export type WorkosApiConfig = ApiConfigBase & {
  identityProvider: "workos";
  workosApiKey: string;
  workosClientId: string;
  /** WorkOS API origin, no trailing slash. Overridable so tests can point at a local server. */
  workosApiUrl: string;
  /**
   * Full JWKS URL, from WORKOS_JWKS_URL. Undefined means "discover it": the
   * OIDC metadata document is the single source of truth, and hand-deriving a
   * second one here is how the two drift apart.
   */
  workosJwksUrl?: string;
  /**
   * Expected `iss` claim on access tokens, from WORKOS_ISSUER. Undefined means
   * "discover it". There is no safe static default — WorkOS mints `iss` as
   * `{apiUrl}/user_management/{environment client id}`, and that environment
   * client id is not WORKOS_CLIENT_ID whenever the app is a non-default
   * AuthKit application. Set this only for a custom auth domain or a stand-in.
   */
  workosIssuer?: string;
};

export type ApiConfig = WorkosApiConfig;

export class ApiConfigError extends Error {}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "ACCOUNT_BASE_URL",
] as const;

const DEFAULT_WORKOS_API_URL = "https://api.workos.com";

function requireVars(env: Env, names: readonly string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ApiConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export function loadApiConfig(env: Env): ApiConfig {
  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 8788;

  requireVars(env, REQUIRED_VARS);
  const workosClientId = env.WORKOS_CLIENT_ID as string;
  const workosApiUrl = (env.WORKOS_API_URL ?? DEFAULT_WORKOS_API_URL).replace(/\/+$/, "");
  return {
    identityProvider: "workos",
    databaseUrl: env.DATABASE_URL as string,
    baseUrl: env.ACCOUNT_BASE_URL as string,
    port,
    workosApiKey: env.WORKOS_API_KEY as string,
    workosClientId,
    workosApiUrl,
    ...(env.WORKOS_JWKS_URL ? { workosJwksUrl: env.WORKOS_JWKS_URL } : {}),
    ...(env.WORKOS_ISSUER ? { workosIssuer: env.WORKOS_ISSUER } : {}),
  };
}
