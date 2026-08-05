// FILE: testing/fakeWorkos.ts
// Purpose: An in-process stand-in for the WorkOS API — serves a JWKS backed by
// a freshly generated key pair, mints access tokens signed by it, and answers
// the user-lookup and device-authorization endpoints. Lets the auth path be
// exercised end to end with no network and no shared fixtures.
// Layer: API test support
// Depends on: jose, hono, @hono/node-server.

import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { ApiConfig } from "../config";

const KID = "fake-workos-key";

export type FakeWorkosRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
};

export type FakeWorkosUser = {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
};

export type FakeWorkos = {
  origin: string;
  clientId: string;
  apiKey: string;
  /** Config pointed at this server; spread overrides on top as needed. */
  config(overrides?: Partial<ApiConfig>): ApiConfig;
  /** Registers a user that `getUser` will return, and returns its id. */
  addUser(user: Partial<FakeWorkosUser> & { id?: string }): FakeWorkosUser;
  /**
   * Mints an access token with the given claims; `expiresIn` accepts jose spans.
   * `issuer` defaults to the value this server's config expects — pass a
   * different one to exercise the issuer check.
   */
  signAccessToken(claims: {
    sub: string;
    sid?: string;
    expiresIn?: string;
    issuer?: string;
  }): Promise<string>;
  /** Every request the server has seen, oldest first. */
  requests: FakeWorkosRequest[];
  close(): Promise<void>;
};

export const FAKE_DEVICE_AUTHORIZATION = {
  device_code: "dc_fake_123",
  user_code: "ABCD-EFGH",
  verification_uri: "https://auth.example.com/device",
  verification_uri_complete: "https://auth.example.com/device?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
} as const;

export async function startFakeWorkos(
  options: { apiKey?: string; clientId?: string } = {},
): Promise<FakeWorkos> {
  const apiKey = options.apiKey ?? "sk_test_fake";
  const clientId = options.clientId ?? "client_01FAKE";

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };

  const users = new Map<string, FakeWorkosUser>();
  const requests: FakeWorkosRequest[] = [];

  const app = new Hono();
  app.use("*", async (c, next) => {
    requests.push({
      method: c.req.method,
      path: c.req.path,
      authorization: c.req.header("authorization"),
      body: c.req.method === "GET" ? "" : await c.req.raw.clone().text(),
    });
    await next();
  });

  app.get(`/sso/jwks/${clientId}`, (c) => c.json({ keys: [publicJwk] }));

  app.post("/user_management/authorize/device", (c) => c.json(FAKE_DEVICE_AUTHORIZATION));

  app.get("/user_management/users/:id", (c) => {
    const user = users.get(c.req.param("id"));
    if (!user) return c.json({ message: "User not found" }, 404);
    return c.json(user);
  });

  const server = serve({ fetch: app.fetch, port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake WorkOS server failed to bind a port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    clientId,
    apiKey,
    requests,

    config(overrides = {}) {
      return {
        databaseUrl: "postgres://unused",
        baseUrl: "http://localhost:8788",
        port: 8788,
        workosApiKey: apiKey,
        workosClientId: clientId,
        workosApiUrl: origin,
        workosJwksUrl: `${origin}/sso/jwks/${clientId}`,
        // Mirrors WorkOS: the API origin with a trailing slash.
        workosIssuer: `${origin}/`,
        ...overrides,
      };
    },

    addUser(user) {
      // Random, not sequential: host rows are keyed by WorkOS user id and the
      // test database outlives a run, so a counter would make the second run
      // against the same database inherit the first run's hosts.
      const id = user.id ?? `user_fake_${randomUUID()}`;
      // Explicitly-undefined keys are dropped before the spread: `{id: undefined}`
      // would otherwise overwrite the id resolved just above.
      const provided = Object.fromEntries(
        Object.entries(user).filter(([, value]) => value !== undefined),
      );
      const record: FakeWorkosUser = {
        id,
        email: `${id}@example.com`,
        ...provided,
      };
      users.set(record.id, record);
      return record;
    },

    signAccessToken({ sub, sid, expiresIn = "5m", issuer = `${origin}/` }) {
      const claims: Record<string, unknown> = { sub };
      if (sid !== undefined) claims.sid = sid;
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(privateKey);
    },

    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
