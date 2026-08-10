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
const VERIFICATION_URL = "https://auth.example.com/device?user_code=WDJB-MJHT";

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
    signInWithPassword: unimplemented("signInWithPassword"),
    signUpWithPassword: unimplemented("signUpWithPassword"),
    verifyEmail: unimplemented("verifyEmail"),
    resendVerificationEmail: unimplemented("resendVerificationEmail"),
    me: unimplemented("me"),
    updateProfile: unimplemented("updateProfile"),
    updateOrganization: unimplemented("updateOrganization"),
    listHosts: unimplemented("listHosts"),
    registerHost: unimplemented("registerHost"),
    updateHost: unimplemented("updateHost"),
    deleteHost: unimplemented("deleteHost"),
    requestDeviceCode: unimplemented("requestDeviceCode"),
    pollDeviceToken: unimplemented("pollDeviceToken"),
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

/**
 * The device flow as WorkOS runs it: the grant hands back an org-less token,
 * `/me` refuses it with the memberships to pick from, and the refresh mints
 * the scoped pair that is actually usable. Modelled faithfully because a
 * session that forgot to scope its token would otherwise pass every test here
 * and fail against a real account.
 */
function deviceFlowClient(overrides: Partial<AccountClient> = {}): AccountClient {
  return makeClient({
    requestDeviceCode: () =>
      Promise.resolve({
        deviceCode: "device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://auth.example.com/device",
        verificationUriComplete: VERIFICATION_URL,
        expiresIn: 900,
        interval: 5,
      }),
    pollDeviceToken: () =>
      Promise.resolve({
        accessToken: "access-0",
        refreshToken: "refresh-0",
        user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
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
        user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
      }),
    ...overrides,
  });
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

describe("sign-in", () => {
  it("polls to completion, scopes the token to a workspace, and persists it", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, deviceFlowClient());

    const begun = await session.beginSignIn();
    expect(begun).toMatchObject({
      deviceCode: "device-code",
      userCode: "WDJB-MJHT",
      verificationUriComplete: VERIFICATION_URL,
    });

    expect(await session.completeSignIn({ deviceCode: begun.deviceCode })).toEqual({
      state: "signed-in",
      me: meResponse(),
    });

    // The scoped pair, not the org-less one the device grant returned: the
    // refresh spent `refresh-0`, so persisting it would lock the user out.
    expect(await readAccountFile(baseDir)).toMatchObject({
      accountUrl: ACCOUNT_URL,
      organizationId: ORGANIZATION.id,
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("keeps the existing host registration across a new sign-in", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: ACCOUNT_URL,
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });
    const session = sessionFor(baseDir, deviceFlowClient());

    const begun = await session.beginSignIn();
    await session.completeSignIn({ deviceCode: begun.deviceCode });

    expect(await readAccountFile(baseDir)).toMatchObject({
      hostToken: "host-token",
      hostId: "host_1",
      accessToken: "access-1",
    });
  });

  // Polling a code supplied from outside would let a caller drive someone
  // else's sign-in and have the result stored as this machine's session.
  it("refuses a device code this server did not issue", async () => {
    const session = sessionFor(makeBaseDir(), deviceFlowClient());
    await expect(session.completeSignIn({ deviceCode: "not-ours" })).rejects.toThrow(/expired/i);
  });

  it("refuses to complete the same device code twice", async () => {
    const session = sessionFor(makeBaseDir(), deviceFlowClient());
    const begun = await session.beginSignIn();
    await session.completeSignIn({ deviceCode: begun.deviceCode });

    await expect(session.completeSignIn({ deviceCode: begun.deviceCode })).rejects.toThrow(
      /expired/i,
    );
  });

  // V1 has no workspace picker, so a member of several teams gets the first.
  it("takes the first workspace when the account offers several", async () => {
    const baseDir = makeBaseDir();
    const second = { id: "org_2", name: "Acme" };
    const session = sessionFor(
      baseDir,
      deviceFlowClient({
        me: (token) =>
          token === "access-0"
            ? Promise.reject(
                new OrganizationRequiredError({
                  message: "Pick a workspace",
                  organizations: [ORGANIZATION, second],
                }),
              )
            : Promise.resolve(meResponse()),
      }),
    );

    const begun = await session.beginSignIn();
    await session.completeSignIn({ deviceCode: begun.deviceCode });

    expect(await readAccountFile(baseDir)).toMatchObject({ organizationId: ORGANIZATION.id });
  });
});

describe("password sign-in", () => {
  const CREDENTIALS = { email: "ada@example.com", password: "correct-horse" } as const;

  /**
   * A client whose password grant succeeds, returning the org-less pair a real
   * grant yields. Everything after that is the shared path SSO also takes.
   */
  function passwordClient(overrides: Partial<AccountClient> = {}): AccountClient {
    return makeClient({
      signInWithPassword: () =>
        Promise.resolve({
          accessToken: "access-0",
          refreshToken: "refresh-0",
          user: { id: "user_1", email: CREDENTIALS.email, name: "Ada Lovelace" },
        }),
      signUpWithPassword: () =>
        Promise.resolve({
          accessToken: "access-0",
          refreshToken: "refresh-0",
          user: { id: "user_1", email: CREDENTIALS.email, name: "Ada Lovelace" },
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
          user: { id: "user_1", email: CREDENTIALS.email },
        }),
      ...overrides,
    });
  }

  it("signs in and persists the scoped session, like the SSO path", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, passwordClient());

    expect(await session.signInWithPassword(CREDENTIALS)).toEqual({
      state: "signed-in",
      me: meResponse(),
    });
    expect(await readAccountFile(baseDir)).toMatchObject({
      organizationId: ORGANIZATION.id,
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("signs up and persists the scoped session", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, passwordClient());

    expect(await session.signUpWithPassword(CREDENTIALS)).toEqual({
      state: "signed-in",
      me: meResponse(),
    });
    expect(await readAccountFile(baseDir)).toMatchObject({ accessToken: "access-1" });
  });

  it("keeps an existing host registration across a password sign-in", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: ACCOUNT_URL,
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });
    const session = sessionFor(baseDir, passwordClient());

    await session.signInWithPassword(CREDENTIALS);
    expect(await readAccountFile(baseDir)).toMatchObject({
      hostToken: "host-token",
      hostId: "host_1",
    });
  });

  // The credential file is the one place a password could plausibly end up,
  // since it is the only thing this module writes to disk.
  it("never writes the password to the credential file", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, passwordClient());

    await session.signInWithPassword(CREDENTIALS);

    const raw = fs.readFileSync(accountCredentialsPath(baseDir), "utf8");
    expect(raw).not.toContain(CREDENTIALS.password);
  });

  it("surfaces a rejected sign-in as a failure, leaving no session behind", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(
      baseDir,
      passwordClient({
        signInWithPassword: () =>
          Promise.reject(
            new AccountApiError({
              code: "invalid_credentials",
              status: 401,
              message: "That email and password do not match an account",
            }),
          ),
      }),
    );

    await expect(session.signInWithPassword(CREDENTIALS)).rejects.toThrow(/do not match/);
    expect(await session.status()).toEqual({ state: "signed-out" });
  });
});

describe("email verification", () => {
  const VERIFY_INPUT = { code: "123456", pendingAuthenticationToken: "pat_123" } as const;

  /** A client whose verification grant succeeds with the usual org-less pair. */
  function verificationClient(overrides: Partial<AccountClient> = {}): AccountClient {
    return makeClient({
      verifyEmail: () =>
        Promise.resolve({
          accessToken: "access-0",
          refreshToken: "refresh-0",
          user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
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
          user: { id: "user_1", email: "ada@example.com" },
        }),
      ...overrides,
    });
  }

  // The verification grant is the third way to a token pair, and it must land
  // in exactly the same place as the other two: a scoped, persisted session.
  it("verifies and persists the scoped session, like the password path", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, verificationClient());

    expect(await session.verifyEmail(VERIFY_INPUT)).toEqual({
      state: "signed-in",
      me: meResponse(),
    });
    expect(await readAccountFile(baseDir)).toMatchObject({
      organizationId: ORGANIZATION.id,
      accessToken: "access-1",
      refreshToken: "refresh-1",
    });
  });

  it("keeps an existing host registration across a verification sign-in", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: ACCOUNT_URL,
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });
    const session = sessionFor(baseDir, verificationClient());

    await session.verifyEmail(VERIFY_INPUT);
    expect(await readAccountFile(baseDir)).toMatchObject({
      hostToken: "host-token",
      hostId: "host_1",
      accessToken: "access-1",
    });
  });

  // The credential file is the only thing this module writes to disk, so it
  // is the one place the code or pending token could end up.
  it("never writes the code or pending token to the credential file", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(baseDir, verificationClient());

    await session.verifyEmail(VERIFY_INPUT);

    const raw = fs.readFileSync(accountCredentialsPath(baseDir), "utf8");
    expect(raw).not.toContain(VERIFY_INPUT.pendingAuthenticationToken);
    expect(raw).not.toContain(VERIFY_INPUT.code);
  });

  it("surfaces a refused code as a failure, leaving no session behind", async () => {
    const baseDir = makeBaseDir();
    const session = sessionFor(
      baseDir,
      verificationClient({
        verifyEmail: () =>
          Promise.reject(
            new AccountApiError({
              code: "invalid_verification_code",
              status: 401,
              message: "That code didn't work — check it and try again",
            }),
          ),
      }),
    );

    await expect(session.verifyEmail(VERIFY_INPUT)).rejects.toThrow(/didn't work/);
    expect(await session.status()).toEqual({ state: "signed-out" });
  });

  it("passes a resend through to the account service", async () => {
    const resends: string[] = [];
    const session = sessionFor(
      makeBaseDir(),
      makeClient({
        resendVerificationEmail: (request) => {
          resends.push(request.emailVerificationId);
          return Promise.resolve();
        },
      }),
    );

    await session.resendVerificationEmail({ emailVerificationId: "email_verification_123" });
    expect(resends).toEqual(["email_verification_123"]);
  });
});

describe("verification URL", () => {
  it("allows only a URL this server issued", async () => {
    const session = sessionFor(makeBaseDir(), deviceFlowClient());

    expect(await session.isVerificationUrlAllowed(VERIFICATION_URL)).toBe(false);

    await session.beginSignIn();
    expect(await session.isVerificationUrlAllowed(VERIFICATION_URL)).toBe(true);
    expect(await session.isVerificationUrlAllowed("https://evil.example.com/")).toBe(false);
    expect(await session.isVerificationUrlAllowed("file:///etc/passwd")).toBe(false);
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

  it("renames the workspace before writing the profile when the name differs", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const calls: string[] = [];
    const profile = { handle: "ada", displayName: "Ada", avatarColor: "#22c55e" } as const;
    const session = sessionFor(
      baseDir,
      makeClient({
        me: () => Promise.resolve(meResponse()),
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

    await session.updateProfile({ ...profile, workspaceName: "Analytical Engines" });
    expect(calls).toEqual(["rename:Analytical Engines", "profile"]);
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
