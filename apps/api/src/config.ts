export type ApiConfig = {
  databaseUrl: string;
  baseUrl: string;
  port: number;
  workosApiKey: string;
  workosClientId: string;
  /** WorkOS API origin, no trailing slash. Overridable so tests can point at a local server. */
  workosApiUrl: string;
  /** Full JWKS URL. Derived from the client id unless WORKOS_JWKS_URL overrides it. */
  workosJwksUrl: string;
  /**
   * Expected `iss` claim on access tokens. WorkOS mints the API origin *with* a
   * trailing slash, and swaps in a custom auth domain when one is configured —
   * hence the override rather than a constant.
   */
  workosIssuer: string;
};

export class ApiConfigError extends Error {}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "ACCOUNT_BASE_URL",
] as const;

const DEFAULT_WORKOS_API_URL = "https://api.workos.com";

export function loadApiConfig(env: Env): ApiConfig {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ApiConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 8788;
  const workosClientId = env.WORKOS_CLIENT_ID as string;
  const workosApiUrl = (env.WORKOS_API_URL ?? DEFAULT_WORKOS_API_URL).replace(/\/+$/, "");
  const workosJwksUrl = env.WORKOS_JWKS_URL ?? `${workosApiUrl}/sso/jwks/${workosClientId}`;
  const workosIssuer = env.WORKOS_ISSUER ?? `${workosApiUrl}/`;

  return {
    databaseUrl: env.DATABASE_URL as string,
    baseUrl: env.ACCOUNT_BASE_URL as string,
    port,
    workosApiKey: env.WORKOS_API_KEY as string,
    workosClientId,
    workosApiUrl,
    workosJwksUrl,
    workosIssuer,
  };
}
