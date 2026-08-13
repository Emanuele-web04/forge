import { resolveTrustedProxyHops } from "./clientIp";
import { randomBytes } from "node:crypto";

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
  /**
   * SigV4 signing region, from S3_REGION. Defaults to "auto" — the spelling
   * R2 requires and MinIO accepts — but real AWS rejects it, so an AWS
   * deployment sets its bucket's region (e.g. us-east-1) here.
   */
  region: string;
};

export type ApiConfigBase = {
  databaseUrl: string;
  baseUrl: string;
  /** Exact JWT issuer and public origin for API-facing host auth. */
  apiPublicUrl: string;
  /** Base64url 32-byte Ed25519 seed used for API-signed grants and tickets. */
  apiSigningKey: string;
  /** Previous seed served through JWKS during rotation, verification-only. */
  apiSigningKeyPrevious?: string;
  /** Shared credential for relay-only internal routes. */
  relayServiceToken?: string;
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
   * Defaults to 0, the direct/Docker self-host shape — any nonzero default
   * would let a direct caller forge the header and rotate rate-limit
   * buckets. Proxied deployments (Railway: one TLS-terminating hop) must
   * set TRUSTED_PROXY_HOPS=1 explicitly.
   */
  trustedProxyHops: number;
  /**
   * Shared secret the profiles SSR deployment sends as
   * `x-synara-proxy-secret`, from PROFILE_PROXY_SECRET. When set and matched,
   * the public-profile rate limit keys on the forwarded viewer IP instead of
   * the SSR deployment's egress IP. Undefined disables the channel — the
   * viewer header is ignored entirely.
   */
  profileProxySecret?: string;
};

/**
 * Configuration for the hosted identity provider (WorkOS). The only place
 * outside `src/identity/workos.ts` where WorkOS is named: config plumbing has
 * to spell the env vars, the implementation consumes them, and nothing else
 * in the service knows which provider is behind the seam.
 */
export type WorkosApiConfig = ApiConfigBase & {
  identityProvider: "workos";
  relayServiceToken: string;
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
  "API_PUBLIC_URL",
  "API_SIGNING_KEY",
  "RELAY_SERVICE_TOKEN",
] as const;

/** The dev provider stores rows and serves clients, so these it still needs. */
const REQUIRED_DEV_VARS = ["DATABASE_URL", "ACCOUNT_BASE_URL", "API_PUBLIC_URL"] as const;

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

function signingSeed(
  env: Env,
  name: "API_SIGNING_KEY" | "API_SIGNING_KEY_PREVIOUS",
): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, "base64url").length !== 32) {
    throw new ApiConfigError(`${name} must be a base64url-encoded 32-byte Ed25519 seed`);
  }
  return value;
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
    // Optional, outside the all-or-nothing set: absent means R2's "auto".
    region: env.S3_REGION?.trim() || "auto",
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
  const profileProxySecret = env.PROFILE_PROXY_SECRET?.trim() || undefined;
  const avatarStorage = loadAvatarStorageConfig(env);

  if (identityProvider === "dev") {
    assertDevIdentityAllowed(env);
    requireVars(env, REQUIRED_DEV_VARS);
    const configuredSigningKey = signingSeed(env, "API_SIGNING_KEY");
    const apiSigningKeyPrevious = signingSeed(env, "API_SIGNING_KEY_PREVIOUS");
    const apiSigningKey = configuredSigningKey ?? randomBytes(32).toString("base64url");
    if (!configuredSigningKey) {
      console.warn("[api] API_SIGNING_KEY is unset in dev mode; using an ephemeral signing key");
    }
    return {
      identityProvider,
      databaseUrl: env.DATABASE_URL as string,
      baseUrl: env.ACCOUNT_BASE_URL as string,
      apiPublicUrl: (env.API_PUBLIC_URL as string).replace(/\/+$/, ""),
      apiSigningKey,
      ...(apiSigningKeyPrevious ? { apiSigningKeyPrevious } : {}),
      ...(env.RELAY_SERVICE_TOKEN?.trim()
        ? { relayServiceToken: env.RELAY_SERVICE_TOKEN.trim() }
        : {}),
      port,
      trustedProxyHops,
      ...(profileProxySecret ? { profileProxySecret } : {}),
      ...(avatarStorage ? { avatarStorage } : {}),
    };
  }

  requireVars(env, REQUIRED_VARS);
  const workosClientId = env.WORKOS_CLIENT_ID as string;
  const apiSigningKey = signingSeed(env, "API_SIGNING_KEY");
  if (!apiSigningKey) {
    throw new ApiConfigError("API_SIGNING_KEY must be a base64url-encoded 32-byte Ed25519 seed");
  }
  const apiSigningKeyPrevious = signingSeed(env, "API_SIGNING_KEY_PREVIOUS");
  const relayServiceToken = env.RELAY_SERVICE_TOKEN?.trim();
  if (!relayServiceToken) {
    throw new ApiConfigError("RELAY_SERVICE_TOKEN must not be empty");
  }
  const workosApiUrl = (env.WORKOS_API_URL ?? DEFAULT_WORKOS_API_URL).replace(/\/+$/, "");
  return {
    identityProvider,
    databaseUrl: env.DATABASE_URL as string,
    baseUrl: env.ACCOUNT_BASE_URL as string,
    apiPublicUrl: (env.API_PUBLIC_URL as string).replace(/\/+$/, ""),
    apiSigningKey,
    ...(apiSigningKeyPrevious ? { apiSigningKeyPrevious } : {}),
    relayServiceToken,
    port,
    trustedProxyHops,
    ...(profileProxySecret ? { profileProxySecret } : {}),
    ...(avatarStorage ? { avatarStorage } : {}),
    workosApiKey: env.WORKOS_API_KEY as string,
    workosClientId,
    workosApiUrl,
    ...(env.WORKOS_JWKS_URL ? { workosJwksUrl: env.WORKOS_JWKS_URL } : {}),
    ...(env.WORKOS_ISSUER ? { workosIssuer: env.WORKOS_ISSUER } : {}),
  };
}
