import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AccountMe } from "@synara/contracts";
import {
  AccountApiError,
  OrganizationRequiredError,
  type AccountClient,
} from "@synara/shared/account";

import { accountCredentialsPath, readAccountFile, writeAccountCredentials } from "./accountAuth.ts";
import { createAccountSession } from "./accountSession.ts";

const temporaryDirectories: string[] = [];

function makeBaseDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "synara-account-session-test-"));
  temporaryDirectories.push(value);
  return value;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const ACCOUNT_URL = "https://accounts.example.com";
const CLIENT_ID = "client_01ABC";
const WORKOS_API_URL = "https://api.workos.example";
const ORGANIZATION = { id: "org_1", name: "Personal — ada@example.com" };

function unimplemented(name: string) {
  return () => Promise.reject(new Error(`${name} should not be called`));
}

function makeClient(overrides: Partial<AccountClient>): AccountClient {
  return {
    instance: () =>
      Promise.resolve({
        version: "0.6.4",
        authMode: "workos" as const,
        clientId: CLIENT_ID,
        workosApiUrl: WORKOS_API_URL,
      }),
    sendOtp: unimplemented("sendOtp"),
    authenticateOtp: unimplemented("authenticateOtp"),
    me: unimplemented("me"),
    updateProfile: unimplemented("updateProfile"),
    uploadAvatar: unimplemented("uploadAvatar"),
    deleteAvatar: unimplemented("deleteAvatar"),
    updateOrganization: unimplemented("updateOrganization"),
    listHosts: unimplemented("listHosts"),
    registerHost: unimplemented("registerHost"),
    updateHost: unimplemented("updateHost"),
    deleteHost: unimplemented("deleteHost"),
    requestAuthorizeUrl: unimplemented("requestAuthorizeUrl"),
    exchangeAuthorizeCode: unimplemented("exchangeAuthorizeCode"),
    refreshAccessToken: unimplemented("refreshAccessToken"),
    ...overrides,
  } as AccountClient;
}

function meResponse(overrides: Partial<AccountMe> = {}): AccountMe {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: ORGANIZATION,
    profile: null,
    ...overrides,
  } as AccountMe;
}

/** A stored file with a live session, as a completed sign-in leaves it. */
function credentials(overrides: Record<string, unknown> = {}) {
  return {
    accountUrl: ACCOUNT_URL,
    workosClientId: CLIENT_ID,
    workosApiUrl: WORKOS_API_URL,
    organizationId: ORGANIZATION.id,
    accessToken: "access-1",
    refreshToken: "refresh-1",
    ...overrides,
  };
}

function sessionFor(baseDir: string, client: AccountClient) {
  return createAccountSession({ baseDir, accountUrl: ACCOUNT_URL, client });
}

describe("status", () => {
  it("reports signed out with no credential file, without touching the network", async () => {
    const session = sessionFor(makeBaseDir(), makeClient({}));
    expect(await session.status()).toEqual({ state: "signed-out" });
  });

  it("reports the signed-in user", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const session = sessionFor(baseDir, makeClient({ me: () => Promise.resolve(meResponse()) }));

    expect(await session.status()).toEqual({ state: "signed-in", me: meResponse() });
  });

  // The access token outlives `synara auth` by about five minutes, so the
  // common case for a returning user is an expired one.
  it("refreshes an expired access token and persists the rotated pair", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const session = sessionFor(
      baseDir,
      makeClient({
        me: (token) =>
          token === "access-1"
            ? Promise.reject(
                new AccountApiError({ code: "unauthorized", status: 401, message: "Expired" }),
              )
            : Promise.resolve(meResponse()),
        refreshAccessToken: () =>
          Promise.resolve({
            accessToken: "access-2",
            refreshToken: "refresh-2",
            user: { id: "user_1", email: "ada@example.com" },
          }),
      }),
    );

    expect(await session.status()).toEqual({ state: "signed-in", me: meResponse() });
    expect(await readAccountFile(baseDir)).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
  });

  // An expired session is a state the UI already renders, not an error worth
  // raising a failed RPC over.
  it("reports signed out when the refresh token can no longer be redeemed", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials({ hostToken: "host-token" }));
    const session = sessionFor(
      baseDir,
      makeClient({
        me: () =>
          Promise.reject(
            new AccountApiError({ code: "unauthorized", status: 401, message: "Expired" }),
          ),
        refreshAccessToken: () =>
          Promise.reject(
            new AccountApiError({ code: "unauthorized", status: 400, message: "Spent" }),
          ),
      }),
    );

    expect(await session.status()).toEqual({ state: "signed-out" });
    // The host registration is not part of the session and must survive it.
    expect(await readAccountFile(baseDir)).toMatchObject({ hostToken: "host-token" });
  });

  // An unreachable account is not a signed-out one: reporting it that way
  // would make a network blip look like being logged out.
  it("fails rather than reporting signed out when the account is unreachable", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const session = sessionFor(
      baseDir,
      makeClient({ me: () => Promise.reject(new Error("ECONNREFUSED")) }),
    );

    await expect(session.status()).rejects.toThrow("ECONNREFUSED");
  });
});

describe("OTP sign-in", () => {
  const OTP_INPUT = { email: "ada@example.com", code: "654321" } as const;

  /**
   * A client whose Magic Auth grant succeeds, returning the org-less pair a
   * real grant yields. Everything after that is the shared path SSO also
   * takes.
   */
  function otpClient(overrides: Partial<AccountClient> = {}): AccountClient {
    return makeClient({
      sendOtp: (request) =>
        Promise.resolve({ email: request.email, expiresAt: "2026-08-10T12:10:00.000Z" }),
      authenticateOtp: () =>
        Promise.resolve({
          accessToken: "access-0",
          refreshToken: "refresh-0",
          user: { id: "user_1", email: OTP_INPUT.email, name: "Ada Lovelace" },
        }),
      me: (token) =>
        token === "access-0"
          ? Promise.reject(
              new OrganizationRequiredError({
                message: "Pick a workspace",
                organizations: [ORGANIZATION],
              }),
            )
          : Promise.resolve(meResponse()),
      refreshAccessToken: () =>
        Promise.resolve({
          accessToken: "access-1",
          refreshToken: "refresh-1",
          user: { id: "user_1", email: OTP_INPUT.email },
        }),
      ...overrides,
    });
  }

  it("passes a send through to the account service", async () => {
    const sends: string[] = [];
    const session = sessionFor(
      makeBaseDir(),
      makeClient({
        sendOtp: (request) => {
          sends.push(request.email);
          return Promise.resolve({ email: request.email, expiresAt: "2026-08-10T12:10:00.000Z" });
        },
      }),
    );

    expect(await session.sendOtp({ email: OTP_INPUT.email })).toEqual({
      email: OTP_INPUT.email,
      expiresAt: "2026-08-10T12:10:00.000Z",
    });
    expect(sends).toEqual([OTP_INPUT.email]);
  });

  it("signs in and persists the scoped session, like the SSO path", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, otpClient());

    expect(await session.authenticateOtp(OTP_INPUT)).toEqual({
      state: "signed-in",
      me: meResponse(),
    });
    expect(await readAccountFile(baseDir)).toMatchObject({
      organizationId: ORGANIZATION.id,
      // The user id rides along with the session: the usage reporter keys
      // its watermark identity on it (multi-member orgs).
      userId: "user_1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  // e.g. the file an expired session left behind: same account, same
  // workspace, so the registration still describes this machine's link.
  it("keeps an existing host registration when the sign-in lands on the same account and workspace", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: ACCOUNT_URL,
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      organizationId: ORGANIZATION.id,
      hostToken: "host-token",
      hostId: "host_1",
    });
    const session = sessionFor(baseDir, otpClient());

    await session.authenticateOtp(OTP_INPUT);
    expect(await readAccountFile(baseDir)).toMatchObject({
      hostToken: "host-token",
      hostId: "host_1",
    });
  });

  // A host registration belongs to the identity that made it. Signing in as
  // someone else (a different workspace) must not carry the previous
  // identity's host credentials into the new session's file.
  it("drops the host registration when the sign-in scopes to a different workspace", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: ACCOUNT_URL,
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      organizationId: "org_other_user",
      hostToken: "host-token",
      hostId: "host_1",
    });
    const session = sessionFor(baseDir, otpClient());

    await session.authenticateOtp(OTP_INPUT);
    const stored = await readAccountFile(baseDir);
    expect(stored?.hostToken).toBeUndefined();
    expect(stored?.hostId).toBeUndefined();
    expect(stored).toMatchObject({ organizationId: ORGANIZATION.id });
  });

  it("drops the host registration when the sign-in targets a different account service", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://other-account.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      organizationId: ORGANIZATION.id,
      hostToken: "host-token",
      hostId: "host_1",
    });
    const session = sessionFor(baseDir, otpClient());

    await session.authenticateOtp(OTP_INPUT);
    const stored = await readAccountFile(baseDir);
    expect(stored?.hostToken).toBeUndefined();
    expect(stored?.hostId).toBeUndefined();
    expect(stored).toMatchObject({ accountUrl: ACCOUNT_URL });
  });

  // The credential file is the one place the code could plausibly end up,
  // since it is the only thing this module writes to disk.
  it("never writes the code to the credential file", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, otpClient());

    await session.authenticateOtp(OTP_INPUT);

    const raw = fs.readFileSync(accountCredentialsPath(baseDir), "utf8");
    expect(raw).not.toContain(OTP_INPUT.code);
  });

  it("surfaces a refused code as a failure, leaving no session behind", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(
      baseDir,
      otpClient({
        authenticateOtp: () =>
          Promise.reject(
            new AccountApiError({
              code: "invalid_verification_code",
              status: 401,
              message: "That code didn't work — check it and try again",
            }),
          ),
      }),
    );

    await expect(session.authenticateOtp(OTP_INPUT)).rejects.toThrow(/didn't work/);
    expect(await session.status()).toEqual({ state: "signed-out" });
  });

  // The single-use code must not be spent into a race that can throw the
  // result away: /instance is fetched BEFORE the grant, so its failure costs
  // a retryable error while the code is still redeemable.
  it("does not consume the code when the instance lookup fails", async () => {
    let redeemed = false;
    const session = sessionFor(
      makeBaseDir(),
      otpClient({
        instance: () => Promise.reject(new Error("instance unavailable")),
        authenticateOtp: () => {
          redeemed = true;
          return Promise.reject(new Error("must not be reached"));
        },
      }),
    );

    await expect(session.authenticateOtp(OTP_INPUT)).rejects.toThrow(/instance unavailable/);
    expect(redeemed).toBe(false);
  });

  // Once the grant succeeded and the scoped pair is on disk, an ancillary
  // failure (the status /me here) must not lose the sign-in: the session is
  // already persisted and status() recovers it.
  it("keeps the persisted session when the post-persist status read fails", async () => {
    const baseDir = makeBaseDir();
    let persistedMeCalls = 0;
    const session = sessionFor(
      baseDir,
      otpClient({
        me: (token) => {
          if (token === "access-0") {
            return Promise.reject(
              new OrganizationRequiredError({
                message: "Pick a workspace",
                organizations: [ORGANIZATION],
              }),
            );
          }
          persistedMeCalls += 1;
          return persistedMeCalls === 1
            ? Promise.reject(new Error("status read blipped"))
            : Promise.resolve(meResponse());
        },
      }),
    );

    await expect(session.authenticateOtp(OTP_INPUT)).rejects.toThrow(/status read blipped/);
    expect(await readAccountFile(baseDir)).toMatchObject({
      organizationId: ORGANIZATION.id,
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
    expect(await session.status()).toEqual({ state: "signed-in", me: meResponse() });
  });
});

describe("PKCE SSO sign-in", () => {
  /**
   * A client whose authorize/exchange legs succeed, recording what they were
   * given. The recorded authorize input is how a test plays the browser: it
   * fetches the loopback redirect URI with a code and the flow's own state.
   */
  function ssoClient(overrides: Partial<AccountClient> = {}) {
    const authorizeInputs: Array<{
      provider: string;
      redirectUri: string;
      codeChallenge: string;
      state: string;
    }> = [];
    const exchangeInputs: Array<{ code: string; codeVerifier: string }> = [];
    const client = makeClient({
      requestAuthorizeUrl: (input) => {
        authorizeInputs.push(input);
        return Promise.resolve({
          authorizeUrl: `https://auth.example.com/authorize?provider=${input.provider}&state=${input.state}`,
        });
      },
      exchangeAuthorizeCode: (input) => {
        exchangeInputs.push(input);
        return Promise.resolve({
          accessToken: "access-0",
          refreshToken: "refresh-0",
          user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
        });
      },
      me: (token) =>
        token === "access-0"
          ? Promise.reject(
              new OrganizationRequiredError({
                message: "Pick a workspace",
                organizations: [ORGANIZATION],
              }),
            )
          : Promise.resolve(meResponse()),
      refreshAccessToken: () =>
        Promise.resolve({
          accessToken: "access-1",
          refreshToken: "refresh-1",
          user: { id: "user_1", email: "ada@example.com" },
        }),
      ...overrides,
    });
    return { client, authorizeInputs, exchangeInputs };
  }

  /** Plays the browser: delivers `code` to the attempt's loopback listener. */
  function deliverCallback(redirectUri: string, params: Record<string, string>) {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return fetch(url);
  }

  it("begins with a loopback redirect, S256 challenge, and the chosen provider", async () => {
    const { client, authorizeInputs } = ssoClient();
    const session = sessionFor(makeBaseDir(), client);

    const begun = await session.beginSso({ provider: "github" });
    expect(begun.ssoId.length).toBeGreaterThan(0);
    expect(begun.authorizeUrl).toContain("provider=github");

    const input = authorizeInputs[0];
    if (!input) throw new Error("no authorize request was made");
    expect(input.provider).toBe("github");
    const redirect = new URL(input.redirectUri);
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.protocol).toBe("http:");
    // base64url S256 output is 43 characters, no padding.
    expect(input.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(input.state.length).toBeGreaterThan(0);

    await session.cancelSso({ ssoId: begun.ssoId });
  });

  it("completes end to end: callback, proxied exchange, scoped persistence", async () => {
    const baseDir = makeBaseDir();
    const { client, authorizeInputs, exchangeInputs } = ssoClient();
    const session = sessionFor(baseDir, client);

    const begun = await session.beginSso({ provider: "google" });
    const input = authorizeInputs[0];
    if (!input) throw new Error("no authorize request was made");

    const completion = session.completeSso({ ssoId: begun.ssoId });
    const delivered = await deliverCallback(input.redirectUri, {
      code: "authz_code_1",
      state: input.state,
    });
    expect(delivered.status).toBe(200);

    expect(await completion).toEqual({ state: "signed-in", me: meResponse() });
    // The exchange went through the account client — never the provider
    // directly — and carried the verifier matching the challenge.
    expect(exchangeInputs).toHaveLength(1);
    expect(exchangeInputs[0]?.code).toBe("authz_code_1");
    const { createHash } = await import("node:crypto");
    expect(
      createHash("sha256")
        .update(exchangeInputs[0]?.codeVerifier ?? "")
        .digest("base64url"),
    ).toBe(input.codeChallenge);
    // Scoped pair persisted, as on every other path.
    expect(await readAccountFile(baseDir)).toMatchObject({
      organizationId: ORGANIZATION.id,
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("rejects a callback whose state does not match, exchanging nothing", async () => {
    const { client, authorizeInputs, exchangeInputs } = ssoClient();
    const session = sessionFor(makeBaseDir(), client);

    const begun = await session.beginSso({ provider: "google" });
    const input = authorizeInputs[0];
    if (!input) throw new Error("no authorize request was made");

    // The assertion attaches its handler before the callback can reject the
    // completion, so the rejection is never momentarily unhandled.
    const completion = expect(session.completeSso({ ssoId: begun.ssoId })).rejects.toThrow(
      /did not match/,
    );
    await deliverCallback(input.redirectUri, { code: "authz_stolen", state: "forged" });

    await completion;
    expect(exchangeInputs).toHaveLength(0);
  });

  it("cancelSso closes the listener so a late callback lands on nothing", async () => {
    const { client, authorizeInputs } = ssoClient();
    const session = sessionFor(makeBaseDir(), client);

    const begun = await session.beginSso({ provider: "google" });
    const input = authorizeInputs[0];
    if (!input) throw new Error("no authorize request was made");

    await session.cancelSso({ ssoId: begun.ssoId });
    await expect(
      deliverCallback(input.redirectUri, { code: "late", state: input.state }),
    ).rejects.toThrow();
    await expect(session.completeSso({ ssoId: begun.ssoId })).rejects.toThrow(/expired/);
  });

  it("allows opening the authorize URL it issued, and only that", async () => {
    const { client } = ssoClient();
    const session = sessionFor(makeBaseDir(), client);
    const begun = await session.beginSso({ provider: "google" });

    expect(await session.isVerificationUrlAllowed(begun.authorizeUrl)).toBe(true);
    expect(await session.isVerificationUrlAllowed("https://evil.example.com/authorize")).toBe(
      false,
    );
    await session.cancelSso({ ssoId: begun.ssoId });
    expect(await session.isVerificationUrlAllowed(begun.authorizeUrl)).toBe(false);
  });
});

describe("transient sign-in recovery", () => {
  const OTP_INPUT = { email: "ada@example.com", code: "654321" } as const;

  it("reports signed-in, not an error, when a timed-out grant actually persisted", async () => {
    const baseDir = makeBaseDir();
    // The grant leg times out client-side — but the session was persisted
    // anyway (as when the provider finishes after our abort and a concurrent
    // completion stored it).
    const client = makeClient({
      authenticateOtp: async () => {
        await writeAccountCredentials(baseDir, credentials());
        throw new AccountApiError({
          code: "internal_error",
          status: 408,
          message: "Request to /api/v1/auth/otp/authenticate timed out",
        });
      },
      me: () => Promise.resolve(meResponse()),
    });
    const session = sessionFor(baseDir, client);

    expect(await session.authenticateOtp(OTP_INPUT)).toEqual({
      state: "signed-in",
      me: meResponse(),
    });
  });

  it("surfaces a retryable provider-slow error when nothing was persisted", async () => {
    const session = sessionFor(
      makeBaseDir(),
      makeClient({
        authenticateOtp: () =>
          Promise.reject(
            new AccountApiError({ code: "internal_error", status: 504, message: "Timed out" }),
          ),
      }),
    );

    const caught = await session.authenticateOtp(OTP_INPUT).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AccountApiError);
    // Retryable status preserved; message says slow + code may still be
    // valid, never the flat "unavailable".
    expect((caught as AccountApiError).status).toBe(504);
    expect((caught as AccountApiError).message).toMatch(/slowly/);
    expect((caught as AccountApiError).message).toMatch(/still/);
    expect((caught as AccountApiError).message).not.toMatch(/unavailable/i);
  });

  it("passes a genuine terminal refusal through untouched", async () => {
    const session = sessionFor(
      makeBaseDir(),
      makeClient({
        authenticateOtp: () =>
          Promise.reject(
            new AccountApiError({
              code: "invalid_verification_code",
              status: 401,
              message: "That code didn't work — check it and try again",
            }),
          ),
      }),
    );

    const caught = await session.authenticateOtp(OTP_INPUT).catch((error: unknown) => error);
    expect(caught).toMatchObject({
      code: "invalid_verification_code",
      status: 401,
      message: "That code didn't work — check it and try again",
    });
  });
});

describe("updateProfile", () => {
  it("writes the profile without touching the workspace when no name is given", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const profile = { handle: "ada", displayName: "Ada", avatarColor: "#22c55e" } as const;
    const session = sessionFor(
      baseDir,
      makeClient({
        updateProfile: (_token, request) =>
          Promise.resolve(meResponse({ profile: request as AccountMe["profile"] })),
      }),
    );

    expect(await session.updateProfile(profile)).toMatchObject({ profile });
  });

  // The profile is written FIRST: it is where the user-recoverable
  // `handle_taken` conflict surfaces, and a rename that ran before it would
  // turn that conflict into a permanent partial rename.
  it("writes the profile before renaming the workspace when the name differs", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const calls: string[] = [];
    const profile = { handle: "ada", displayName: "Ada", avatarColor: "#22c55e" } as const;
    const session = sessionFor(
      baseDir,
      makeClient({
        updateOrganization: (_token, request) => {
          calls.push(`rename:${request.name}`);
          return Promise.resolve(meResponse({ organization: { id: ORGANIZATION.id, ...request } }));
        },
        updateProfile: (_token, request) => {
          calls.push("profile");
          return Promise.resolve(meResponse({ profile: request as AccountMe["profile"] }));
        },
      }),
    );

    const result = await session.updateProfile({ ...profile, workspaceName: "Analytical Engines" });
    expect(calls).toEqual(["profile", "rename:Analytical Engines"]);
    expect(result.organization.name).toBe("Analytical Engines");
  });

  // M8: a handle conflict during onboarding must change NOTHING — no partial
  // rename left behind for the user to discover after picking another handle.
  it("leaves the workspace name untouched when the handle is taken", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    let renamed = false;
    const session = sessionFor(
      baseDir,
      makeClient({
        updateOrganization: () => {
          renamed = true;
          return Promise.resolve(meResponse());
        },
        updateProfile: () =>
          Promise.reject(
            new AccountApiError({
              code: "handle_taken",
              status: 409,
              message: "That handle is already taken",
            }),
          ),
      }),
    );

    await expect(
      session.updateProfile({
        handle: "ada",
        displayName: "Ada",
        avatarColor: "#22c55e",
        workspaceName: "Analytical Engines",
      }),
    ).rejects.toMatchObject({ code: "handle_taken" });
    expect(renamed).toBe(false);
  });

  // Renaming to the name it already has is a no-op, not a WorkOS round trip:
  // onboarding sends the workspace name on every save.
  it("skips the rename when the workspace name is unchanged", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const session = sessionFor(
      baseDir,
      makeClient({
        me: () => Promise.resolve(meResponse()),
        updateProfile: () => Promise.resolve(meResponse()),
      }),
    );

    await expect(
      session.updateProfile({
        handle: "ada",
        displayName: "Ada",
        avatarColor: "#22c55e",
        workspaceName: ORGANIZATION.name,
      }),
    ).resolves.toBeDefined();
  });
});

describe("avatar", () => {
  it("decodes the base64 payload and forwards raw bytes with the content type", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    let received: { bytes: Uint8Array; contentType: string } | null = null;
    const session = sessionFor(
      baseDir,
      makeClient({
        uploadAvatar: (_token, bytes, contentType) => {
          received = { bytes, contentType };
          return Promise.resolve(meResponse());
        },
      }),
    );

    // "hello" as the stand-in image body; the session must not reinterpret it.
    await session.uploadAvatar({ bytes: "aGVsbG8=", contentType: "image/webp" });

    expect(received).not.toBeNull();
    expect(new TextDecoder().decode(received!.bytes)).toBe("hello");
    expect(received!.contentType).toBe("image/webp");
  });

  it("deletes the avatar through the stored session", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const me = meResponse();
    const session = sessionFor(baseDir, makeClient({ deleteAvatar: () => Promise.resolve(me) }));

    expect(await session.deleteAvatar()).toEqual(me);
  });
});

describe("signOut", () => {
  it("drops the session and keeps the host registration", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
    const session = sessionFor(baseDir, makeClient({}));

    await session.signOut();

    const stored = await readAccountFile(baseDir);
    expect(stored).toMatchObject({ hostToken: "host-token", hostId: "host_1" });
    expect(stored?.accessToken).toBeUndefined();
    expect(stored?.refreshToken).toBeUndefined();
    expect(stored?.organizationId).toBeUndefined();
    expect(await session.status()).toEqual({ state: "signed-out" });
  });

  it("is a no-op when there is nothing stored", async () => {
    const session = sessionFor(makeBaseDir(), makeClient({}));
    await expect(session.signOut()).resolves.toBeUndefined();
  });
});
