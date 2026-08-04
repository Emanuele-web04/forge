export type OAuthPair = {
  clientId: string;
  clientSecret: string;
};

export type ApiConfig = {
  databaseUrl: string;
  baseUrl: string;
  authSecret: string;
  port: number;
  providers: {
    github?: OAuthPair;
    google?: OAuthPair;
    apple?: OAuthPair;
    microsoft?: OAuthPair;
  };
  email?: {
    resendApiKey?: string;
    from?: string;
  };
  allowedSignupEmails?: string[];
};

export class ApiConfigError extends Error {}

type Env = Record<string, string | undefined>;

const REQUIRED_VARS = ["DATABASE_URL", "BETTER_AUTH_SECRET", "ACCOUNT_BASE_URL"] as const;

const SOCIAL_PROVIDERS = ["github", "google", "apple", "microsoft"] as const;
type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

const PROVIDER_ENV_PREFIX: Record<SocialProvider, string> = {
  github: "GITHUB",
  google: "GOOGLE",
  apple: "APPLE",
  microsoft: "MICROSOFT",
};

function readOAuthPair(env: Env, provider: SocialProvider): OAuthPair | undefined {
  const prefix = PROVIDER_ENV_PREFIX[provider];
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    return undefined;
  }
  return { clientId, clientSecret };
}

export function loadApiConfig(env: Env): ApiConfig {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ApiConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const providers: ApiConfig["providers"] = {};
  for (const provider of SOCIAL_PROVIDERS) {
    const pair = readOAuthPair(env, provider);
    if (pair) {
      providers[provider] = pair;
    }
  }

  const email: ApiConfig["email"] = {};
  if (env.RESEND_API_KEY) email.resendApiKey = env.RESEND_API_KEY;
  if (env.EMAIL_FROM) email.from = env.EMAIL_FROM;

  const allowedSignupEmails = env.ACCOUNT_ALLOWED_SIGNUP_EMAILS
    ? env.ACCOUNT_ALLOWED_SIGNUP_EMAILS.split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;

  const port = env.PORT ? Number.parseInt(env.PORT, 10) : 8788;

  return {
    databaseUrl: env.DATABASE_URL as string,
    baseUrl: env.ACCOUNT_BASE_URL as string,
    authSecret: env.BETTER_AUTH_SECRET as string,
    port,
    providers,
    ...(Object.keys(email).length > 0 ? { email } : {}),
    ...(allowedSignupEmails ? { allowedSignupEmails } : {}),
  };
}

/**
 * Signup allowlist check — the single place email comparison happens. Email
 * local parts are case-sensitive per RFC 5321 but no real mailbox relies on
 * that, and an operator writing `Ada@X.com` means the same person who signs up
 * as `ada@x.com`, so both sides are lowercased here rather than at parse time
 * (config keeps the operator's spelling for anything that surfaces it).
 */
export function isSignupAllowed(config: ApiConfig, email: string): boolean {
  const allowlist = config.allowedSignupEmails;
  if (!allowlist || allowlist.length === 0) return true;
  const normalized = email.trim().toLowerCase();
  return allowlist.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

export function enabledAuthMethods(config: ApiConfig): {
  emailPassword: true;
  social: SocialProvider[];
  emailDelivery: boolean;
  signupRestricted: boolean;
} {
  const social = SOCIAL_PROVIDERS.filter((provider) => Boolean(config.providers[provider]));
  const emailDelivery = Boolean(config.email?.resendApiKey);
  const signupRestricted = Boolean(
    config.allowedSignupEmails && config.allowedSignupEmails.length > 0,
  );

  return {
    emailPassword: true,
    social,
    emailDelivery,
    signupRestricted,
  };
}
