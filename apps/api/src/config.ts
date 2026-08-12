import { resolveTrustedProxyHops } from "./clientIp";

/**
 * Where uploaded profile avatars live: any S3-compatible object store
 * (Cloudflare R2, MinIO, AWS S3, …), addressed path-style through a single
 * endpoint. All five variables are optional as a set — when any is missing
 * the avatar upload routes answer 503 and everything else runs unaffected,
 * so a deployment without object storage is a smaller deployment, not a
 * broken one.
 */
export type AvatarStorageConfig = {
  /** S3 endpoint origin, e.g. https://<account>.r2.cloudflarestorage.com — no trailing slash. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public origin the bucket is served from (CDN/custom domain), no trailing slash. */
  publicBaseUrl: string;
};

export type ApiConfigBase = {
  databaseUrl: string;
  baseUrl: string;
  port: number;
  /**
   * S3-compatible avatar storage, or undefined when the deployment has none
   * configured (uploads answer 503; everything else works).
   */
  avatarStorage?: AvatarStorageConfig;
  /**
   * How many proxies in front of this service append to `x-forwarded-for`,
   * from TRUSTED_PROXY_HOPS. The rate limiter keys on the address the
   * outermost trusted proxy saw; 0 means "no proxy — trust only the socket".
   * Defaults to 1, the deployed Railway shape (one TLS-terminating hop).
   */
  trustedProxyHops: number;
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
  /**
   * Per-attempt deadline on cheap/idempotent WorkOS calls, milliseconds.
   * Test hook only — there is no env var for it; production uses the module
   * default (15s).
   */
  workosRequestTimeoutMs?: number;
  /**
   * Per-attempt deadline on grant-consuming WorkOS calls (authenticates,
   * token exchanges, refresh), milliseconds. Test hook only — production
   * uses the module default (45s): a grant spends a single-use credential,
   * so it gets far longer than a cheap lookup before we abandon it.
   */
  workosGrantTimeoutMs?: number;
};

/**
 * Configuration for the offline dev identity provider: an in-process identity
 * endpoint with codes printed to stdout, for hacking on Synara accounts with
 * no hosted-provider tenancy. Selected with IDENTITY_PROVIDER=dev and refused
 * outright in anything that looks like a deployment — see
 * {@link assertDevIdentityAllowed}.
 */
export type DevApiConfig = ApiConfigBase & {
  identityProvider: "dev";
};

export type ApiConfig = WorkosApiConfig | DevApiConfig;

export class ApiConfigError extends Error {}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = [
  "DATABASE_URL",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "ACCOUNT_BASE_URL",
] as const;

/** The dev provider stores rows and serves clients, so these it still needs. */
const REQUIRED_DEV_VARS = ["DATABASE_URL", "ACCOUNT_BASE_URL"] as const;

const DEFAULT_WORKOS_API_URL = "https://api.workos.com";

/**
 * The hard safety gate on the dev identity provider. It accepts any email,
 * prints one-time codes to stdout, and must therefore be impossible to enable
 * accidentally in a deployed environment — so it refuses to start (the thrown
 * ApiConfigError exits the process from `main`) when the environment says
 * production, or when a WorkOS API key is present: a machine holding a real
 * identity-provider secret is configured to serve real users, and "dev" there
 * is a misconfiguration, not a choice.
 *
 * Called from {@link loadApiConfig} AND from the dev provider's own factory,
 * so hand-built configs cannot bypass it.
 */
export function assertDevIdentityAllowed(env: Env): void {
  if (env.NODE_ENV === "production") {
    throw new ApiConfigError(
      "IDENTITY_PROVIDER=dev refuses to start with NODE_ENV=production. " +
        "The dev identity provider accepts any email and prints sign-in codes " +
        "to stdout; it is for local development only. Unset IDENTITY_PROVIDER " +
        "to use the real identity provider.",
    );
  }
  if (env.WORKOS_API_KEY) {
    throw new ApiConfigError(
      "IDENTITY_PROVIDER=dev refuses to start while WORKOS_API_KEY is set. " +
        "A real identity-provider secret means this environment serves real " +
        "users; unset IDENTITY_PROVIDER to use it, or unset WORKOS_API_KEY " +
        "for offline development.",
    );
  }
}

function requireVars(env: Env, names: readonly string[]): void {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ApiConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

/** The five S3_* variables, valid only as a complete set. */
const AVATAR_STORAGE_VARS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PUBLIC_BASE_URL",
] as const;

/**
 * The avatar-storage config, or undefined when none of the S3_* variables are
 * set. A PARTIAL set is refused loudly rather than treated as absent: an
 * operator who set four of five variables was configuring storage, and a
 * silent 503 in production would hide the typo indefinitely.
 */
export function loadAvatarStorageConfig(env: Env): AvatarStorageConfig | undefined {
  const present = AVATAR_STORAGE_VARS.filter((name) => env[name]);
  if (present.length === 0) return undefined;
  if (present.length < AVATAR_STORAGE_VARS.length) {
    const missing = AVATAR_STORAGE_VARS.filter((name) => !env[name]);
    throw new ApiConfigError(
      `Avatar storage is partially configured — missing: ${missing.join(", ")}. ` +
        "Set all of S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, " +
        "and S3_PUBLIC_BASE_URL, or unset them all to run without avatar uploads.",
    );
  }
  return {
    endpoint: (env.S3_ENDPOINT as string).replace(/\/+$/, ""),
    bucket: env.S3_BUCKET as string,
    accessKeyId: env.S3_ACCESS_KEY_ID as string,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    publicBaseUrl: (env.S3_PUBLIC_BASE_URL as string).replace(/\/+$/, ""),
  };
}

export function loadApiConfig(env: Env): ApiConfig {
  const identityProvider = env.IDENTITY_PROVIDER ?? "workos";
  if (identityProvider !== "workos" && identityProvider !== "dev") {
    throw new ApiConfigError(
      `Unknown IDENTITY_PROVIDER "${identityProvider}" — expected "workos" or "dev"`,
    );
  }

  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 8788;
  const trustedProxyHops = resolveTrustedProxyHops(env.TRUSTED_PROXY_HOPS);
  const avatarStorage = loadAvatarStorageConfig(env);

  if (identityProvider === "dev") {
    assertDevIdentityAllowed(env);
    requireVars(env, REQUIRED_DEV_VARS);
    return {
      identityProvider,
      databaseUrl: env.DATABASE_URL as string,
      baseUrl: env.ACCOUNT_BASE_URL as string,
      port,
      trustedProxyHops,
      ...(avatarStorage ? { avatarStorage } : {}),
    };
  }

  requireVars(env, REQUIRED_VARS);
  const workosClientId = env.WORKOS_CLIENT_ID as string;
  const workosApiUrl = (env.WORKOS_API_URL ?? DEFAULT_WORKOS_API_URL).replace(/\/+$/, "");
  return {
    identityProvider,
    databaseUrl: env.DATABASE_URL as string,
    baseUrl: env.ACCOUNT_BASE_URL as string,
    port,
    trustedProxyHops,
    ...(avatarStorage ? { avatarStorage } : {}),
    workosApiKey: env.WORKOS_API_KEY as string,
    workosClientId,
    workosApiUrl,
    ...(env.WORKOS_JWKS_URL ? { workosJwksUrl: env.WORKOS_JWKS_URL } : {}),
    ...(env.WORKOS_ISSUER ? { workosIssuer: env.WORKOS_ISSUER } : {}),
  };
}
