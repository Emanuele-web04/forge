import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { deviceAuthorization, jwt } from "better-auth/plugins";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ApiConfig, OAuthPair } from "./config";
import type * as schema from "./db/schema";

const SOCIAL_PROVIDER_KEYS = ["github", "google", "apple", "microsoft"] as const;

const RESEND_API_URL = "https://api.resend.com/emails";

let warnedNoEmailDelivery = false;

function warnEmailDeliveryDisabled(kind: "verification" | "reset password"): void {
  if (warnedNoEmailDelivery) return;
  warnedNoEmailDelivery = true;
  console.warn(
    `[auth] No email delivery configured (RESEND_API_KEY unset); ${kind} emails will only be logged, not sent.`,
  );
}

async function sendViaResend(
  email: { resendApiKey: string; from: string | undefined },
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${email.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: email.from ?? "onboarding@resend.dev",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend request failed (${res.status}): ${body}`);
  }
}

function buildSocialProviders(
  config: ApiConfig,
): Partial<Record<(typeof SOCIAL_PROVIDER_KEYS)[number], OAuthPair>> {
  const providers: Partial<Record<(typeof SOCIAL_PROVIDER_KEYS)[number], OAuthPair>> = {};
  for (const key of SOCIAL_PROVIDER_KEYS) {
    const pair = config.providers[key];
    if (pair) providers[key] = pair;
  }
  return providers;
}

// Under `composite: true` (apps/api/tsconfig.json), `tsc` requires every
// exported declaration's type to be nameable for `.d.ts` emission.
// `betterAuth(...)`'s inferred return type — with the `jwt()` and
// `deviceAuthorization()` plugins applied — transitively references an
// internal, unexported zod subpath, which fails that check (TS2742) no
// matter whether the call is annotated inline or assigned through a typed
// `const options` first (both were tried; both hit the same error, because
// the offending reference lives inside the plugins' own declared types, not
// in how `createAuth`'s return type is spelled out).
//
// The Task 2 stub avoided this by casting through `unknown` to the fully
// generic `ReturnType<typeof betterAuth>` (i.e. `Auth<BetterAuthOptions>`),
// which erased the `jwt`/`deviceAuthorization` plugin-specific endpoints
// (`auth.api.getJwks`, `auth.api.deviceCode`, etc.) for every consumer. To
// avoid propagating that erasure, this module keeps the same cast at the
// `betterAuth(...)` call site but re-exports an explicit `Auth` type below
// that lists the plugin endpoints consumers actually need, so Tasks 5/6 can
// use `auth.api.getJwks`/`deviceCode`/`deviceApprove`/`deviceToken` with
// real types instead of losing them to the erasure.
type DeviceCodeResult = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type DeviceTokenResult = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

type JwksResult = {
  keys: Array<Record<string, unknown>>;
};

export type Auth = ReturnType<typeof betterAuth> & {
  api: ReturnType<typeof betterAuth>["api"] & {
    getJwks: () => Promise<JwksResult>;
    deviceCode: (input: {
      body: { client_id: string; user_id?: string; scope?: string };
    }) => Promise<DeviceCodeResult>;
    deviceVerify: (input: {
      query: { user_code: string };
      headers: Headers;
    }) => Promise<{ user_code: string; status: string }>;
    deviceApprove: (input: {
      body: { userCode: string };
      headers: Headers;
    }) => Promise<{ success: boolean }>;
    deviceDeny: (input: {
      body: { userCode: string };
      headers: Headers;
    }) => Promise<{ success: boolean }>;
    deviceToken: (input: {
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code";
        device_code: string;
        client_id: string;
      };
    }) => Promise<DeviceTokenResult>;
  };
};

export function createAuth(config: ApiConfig, db: NodePgDatabase<typeof schema>): Auth {
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: ["synara://", "synara-dev://"],
    rateLimit: { enabled: true },
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        if (!config.email?.resendApiKey) {
          warnEmailDeliveryDisabled("reset password");
          return;
        }
        await sendViaResend(
          { resendApiKey: config.email.resendApiKey, from: config.email.from },
          user.email,
          "Reset your Synara account password",
          `<p>Reset your password: <a href="${url}">${url}</a></p>`,
        );
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        if (!config.email?.resendApiKey) {
          warnEmailDeliveryDisabled("verification");
          return;
        }
        await sendViaResend(
          { resendApiKey: config.email.resendApiKey, from: config.email.from },
          user.email,
          "Verify your Synara account email",
          `<p>Verify your email: <a href="${url}">${url}</a></p>`,
        );
      },
    },
    socialProviders: buildSocialProviders(config),
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: SOCIAL_PROVIDER_KEYS.filter((key) => config.providers[key]),
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (config.allowedSignupEmails && config.allowedSignupEmails.length > 0) {
              if (!config.allowedSignupEmails.includes(user.email)) {
                throw new APIError("FORBIDDEN", { message: "signup_restricted" });
              }
            }
          },
        },
      },
    },
    plugins: [jwt(), deviceAuthorization()],
  }) as unknown as Auth;
}
