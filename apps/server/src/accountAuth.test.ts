import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { type AccountHost, EnvironmentId } from "@synara/contracts";
import { Readable } from "node:stream";

import type { AccountClient } from "@synara/shared/account";
import { AccountApiError, OrganizationRequiredError } from "@synara/shared/account";

import {
  accountCredentialsPath,
  readAccountCredentials,
  readAccountFile,
  refreshHostRegistration,
  resolveAccountUrl,
  resolveEnvironmentId,
  runAuthLogin,
  runAuthLogout,
  runStatus,
  selectOrganization,
  SessionExpiredError,
  withFreshAccessToken,
  WORKSPACE_CHANGED_MESSAGE,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
} from "./accountAuth.ts";

const temporaryDirectories: string[] = [];

function makeBaseDir(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "synara-account-auth-test-"));
  temporaryDirectories.push(value);
  return value;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeStdout() {
  const chunks: string[] = [];
  return {
    write: (text: string) => {
      chunks.push(text);
    },
    text: () => chunks.join(""),
  };
}

const host: AccountHost = {
  id: "host_1",
  environmentId: EnvironmentId.makeUnsafe("env-uuid"),
  name: "workstation",
  platform: "darwin",
  kind: "local",
  endpoints: [{ url: "http://192.168.1.10:3773", transport: "lan" }],
  appVersion: "0.6.4",
  registeredByUserId: "user_1",
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-03T12:00:00.000Z",
};

const ORGANIZATION = { id: "org_1", name: "Personal — ada@example.com" };

/** What `/me` returns for a caller acting inside {@link ORGANIZATION}. */
function meResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: ORGANIZATION,
    ...overrides,
  };
}

function organizationRequired(
  organizations: ReadonlyArray<{ id: string; name: string }> = [ORGANIZATION],
): OrganizationRequiredError {
  return new OrganizationRequiredError({ message: "Pick a workspace", organizations });
}

/** A readable stdin that yields the given lines, for the workspace picker. */
function stdinOf(...lines: string[]): NodeJS.ReadableStream {
  return Readable.from([`${lines.join("\n")}\n`]) as unknown as NodeJS.ReadableStream;
}

function unimplemented(name: string) {
  return () => Promise.reject(new Error(`${name} should not be called`));
}

const CLIENT_ID = "client_01ABC";
const WORKOS_API_URL = "https://api.workos.example";

/** A credentials file with a live session, as `synara auth` leaves it. */
function credentials(overrides: Record<string, unknown> = {}) {
  return {
    accountUrl: "https://accounts.example.com",
    workosClientId: CLIENT_ID,
    workosApiUrl: WORKOS_API_URL,
    organizationId: ORGANIZATION.id,
    accessToken: "access-1",
    refreshToken: "refresh-1",
    ...overrides,
  };
}

function makeClient(overrides: Partial<AccountClient>): AccountClient {
  return {
    instance: unimplemented("instance"),
    sendOtp: unimplemented("sendOtp"),
    authenticateOtp: unimplemented("authenticateOtp"),
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

function unauthorized(): AccountApiError {
  return new AccountApiError({ code: "unauthorized", status: 401, message: "Unauthorized" });
}

/**
 * What `synara auth`'s device flow returns once the user approves.
 *
 * The device grant hands back an org-less token — WorkOS never scopes one —
 * so `me` refuses it and the flow refreshes into a workspace. That rotation is
 * why the persisted pair is `access-1`/`refresh-1` while the poll returned
 * `access-0`/`refresh-0`: modelling it any other way would let a client that
 * forgot to scope the token pass every test here and fail against a real
 * account.
 */
function deviceFlowClient(overrides: Partial<AccountClient> = {}): AccountClient {
  return makeClient({
    instance: () =>
      Promise.resolve({
        version: "0.6.4",
        authMode: "workos" as const,
        clientId: CLIENT_ID,
        workosApiUrl: WORKOS_API_URL,
      }),
    requestDeviceCode: () =>
      Promise.resolve({
        deviceCode: "device-code",
        userCode: "WDJB-MJHT",
        verificationUri: "https://accounts.example.com/device",
        verificationUriComplete: "https://accounts.example.com/device?user_code=WDJB-MJHT",
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
      token === "access-0" ? Promise.reject(organizationRequired()) : Promise.resolve(meResponse()),
    refreshAccessToken: () =>
      Promise.resolve({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
      }),
    ...overrides,
  });
}

describe("account credential store", () => {
  it("round-trips credentials and keeps the file private", async () => {
    const baseDir = makeBaseDir();
    expect(await readAccountCredentials(baseDir)).toBeUndefined();

    const stored = credentials({ hostToken: "host-token", hostId: "host_1" });
    await writeAccountCredentials(baseDir, stored);

    expect(await readAccountCredentials(baseDir)).toEqual(stored);

    if (process.platform !== "win32") {
      const stat = await fsp.stat(accountCredentialsPath(baseDir));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("ignores a corrupt credentials file instead of throwing", async () => {
    const baseDir = makeBaseDir();
    await fsp.writeFile(accountCredentialsPath(baseDir), "{not json", "utf8");
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
  });

  it("treats a pre-WorkOS credentials file as not signed in", async () => {
    const baseDir = makeBaseDir();
    await fsp.writeFile(
      accountCredentialsPath(baseDir),
      JSON.stringify({
        accountUrl: "https://accounts.example.com",
        deviceToken: "legacy-device-token",
        hostToken: "host-token",
        hostId: "host_1",
      }),
      "utf8",
    );

    expect(await readAccountFile(baseDir)).toBeUndefined();
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
  });

  /**
   * A v2 file predates organizations. Its refresh token is still live, but
   * every token minted from it would be org-less and refused by the account,
   * so it is treated as signed out — the same as a v1 file, and for the same
   * reason: re-authenticating is the only thing that fixes it.
   */
  it("treats a v2 credentials file with no organizationId as not signed in", async () => {
    const baseDir = makeBaseDir();
    await fsp.writeFile(
      accountCredentialsPath(baseDir),
      JSON.stringify({
        accountUrl: "https://accounts.example.com",
        workosClientId: CLIENT_ID,
        workosApiUrl: WORKOS_API_URL,
        accessToken: "access-1",
        refreshToken: "refresh-1",
        hostToken: "host-token",
        hostId: "host_1",
      }),
      "utf8",
    );

    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    // The host half is still readable, so `synara auth` can re-link rather
    // than stranding the machine's registration.
    expect(await readAccountFile(baseDir)).toMatchObject({
      hostToken: "host-token",
      hostId: "host_1",
    });
  });

  it("reads a file whose session was cleared but keeps its host fields", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });

    expect(await readAccountFile(baseDir)).toMatchObject({
      hostToken: "host-token",
      hostId: "host_1",
    });
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
  });
});

describe("withFreshAccessToken", () => {
  it("passes the stored access token straight through when it is accepted", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    const seen: string[] = [];
    const result = await withFreshAccessToken(
      { baseDir, client: makeClient({}) },
      (accessToken) => {
        seen.push(accessToken);
        return Promise.resolve("ok");
      },
    );

    expect(result).toBe("ok");
    expect(seen).toEqual(["access-1"]);
  });

  it("persists the rotated pair before retrying, so a crash mid-retry cannot lose it", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials({ hostToken: "host-token" }));

    // Read back inside the retry, not after it: a helper that wrote the new
    // pair only once `fn` resolved would still pass an after-the-fact
    // assertion while leaving a window where the spent token is all that is
    // on disk.
    let onDiskDuringRetry: unknown;
    const attempts: string[] = [];
    const result = await withFreshAccessToken(
      {
        baseDir,
        client: makeClient({
          refreshAccessToken: (options) => {
            // The organization must ride along on every renewal: without it
            // the provider mints an org-less token and the very next call 403s.
            expect(options).toEqual({
              refreshToken: "refresh-1",
              organizationId: ORGANIZATION.id,
            });
            return Promise.resolve({
              accessToken: "access-2",
              refreshToken: "refresh-2",
              user: { id: "user_1", email: "ada@example.com" },
            });
          },
        }),
      },
      async (accessToken) => {
        attempts.push(accessToken);
        if (attempts.length === 1) throw unauthorized();
        onDiskDuringRetry = await readAccountCredentials(baseDir);
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toEqual(["access-1", "access-2"]);
    expect(onDiskDuringRetry).toEqual(
      credentials({ accessToken: "access-2", refreshToken: "refresh-2", hostToken: "host-token" }),
    );
  });

  it("retries only once, surfacing a second rejection to the caller", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    let attempts = 0;
    await expect(
      withFreshAccessToken(
        {
          baseDir,
          client: makeClient({
            refreshAccessToken: () =>
              Promise.resolve({
                accessToken: "access-2",
                refreshToken: "refresh-2",
                user: { id: "user_1", email: "ada@example.com" },
              }),
          }),
        },
        () => {
          attempts += 1;
          return Promise.reject(unauthorized());
        },
      ),
    ).rejects.toBeInstanceOf(AccountApiError);
    expect(attempts).toBe(2);
  });

  it("does not refresh on a non-auth failure", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    await expect(
      withFreshAccessToken({ baseDir, client: makeClient({}) }, () =>
        Promise.reject(new Error("ECONNREFUSED")),
      ),
    ).rejects.toThrow("ECONNREFUSED");
    expect(await readAccountCredentials(baseDir)).toEqual(credentials());
  });

  it("keeps the stored refresh token when the identity provider is merely unreachable", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    // A network blip says nothing about whether the refresh token is still
    // good. Discarding it here would force a full re-auth over an outage.
    await expect(
      withFreshAccessToken(
        {
          baseDir,
          client: makeClient({
            refreshAccessToken: () => Promise.reject(new Error("ECONNREFUSED")),
          }),
        },
        () => Promise.reject(unauthorized()),
      ),
    ).rejects.toThrow("ECONNREFUSED");

    expect(await readAccountCredentials(baseDir)).toEqual(credentials());
  });

  it("keeps the stored refresh token when the identity provider returns a 5xx", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    const caught = await withFreshAccessToken(
      {
        baseDir,
        client: makeClient({
          refreshAccessToken: () =>
            Promise.reject(
              new AccountApiError({
                code: "internal_error",
                status: 503,
                message: "Identity provider is unavailable",
              }),
            ),
        }),
      },
      () => Promise.reject(unauthorized()),
    ).catch((error: unknown) => error);

    // The upstream failure must reach the caller unchanged: reporting it as an
    // expired session would send the user to re-authenticate over an outage.
    expect(caught).toBeInstanceOf(AccountApiError);
    expect(caught).not.toBeInstanceOf(SessionExpiredError);
    expect(caught).toMatchObject({ status: 503 });
    expect(await readAccountCredentials(baseDir)).toEqual(credentials());
  });

  // 408 and 429 are 4xx by status but transient by meaning: WorkOS is telling
  // us to come back, not that the grant is dead. Burning the session on either
  // turns a momentary rate limit into a forced re-authentication.
  it.each([
    [408, "Request timeout"],
    [429, "Too many requests"],
  ])(
    "keeps the stored refresh token when the identity provider answers %i",
    async (status, message) => {
      const baseDir = makeBaseDir();
      await writeAccountCredentials(baseDir, credentials());

      const caught = await withFreshAccessToken(
        {
          baseDir,
          client: makeClient({
            refreshAccessToken: () =>
              Promise.reject(new AccountApiError({ code: "internal_error", status, message })),
          }),
        },
        () => Promise.reject(unauthorized()),
      ).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(AccountApiError);
      expect(caught).not.toBeInstanceOf(SessionExpiredError);
      expect(caught).toMatchObject({ status });
      expect(await readAccountCredentials(baseDir)).toEqual(credentials());
    },
  );

  it("signs the session out but keeps the host fields when the refresh token is spent", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );

    await expect(
      withFreshAccessToken(
        {
          baseDir,
          client: makeClient({
            refreshAccessToken: () =>
              Promise.reject(
                new AccountApiError({
                  code: "internal_error",
                  status: 400,
                  message: "Refresh token is invalid",
                }),
              ),
          }),
        },
        () => Promise.reject(unauthorized()),
      ),
    ).rejects.toBeInstanceOf(SessionExpiredError);

    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    expect(await readAccountFile(baseDir)).toEqual({
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });
  });
});

describe("selectOrganization", () => {
  // One workspace is not a decision. Prompting anyway would put a question in
  // front of every single-workspace user on every sign-in.
  it("returns the only workspace without prompting", async () => {
    const stdout = makeStdout();
    const selected = await selectOrganization([ORGANIZATION], {
      stdout: stdout.write,
      // Reaching stdin at all would hang: this stream never yields a line.
      stdin: Readable.from([]) as unknown as NodeJS.ReadableStream,
    });

    expect(selected).toEqual(ORGANIZATION);
    expect(stdout.text()).toBe("");
  });

  it("prompts for a numbered choice when there is more than one", async () => {
    const stdout = makeStdout();
    const organizations = [ORGANIZATION, { id: "org_2", name: "Acme" }];

    const selected = await selectOrganization(organizations, {
      stdout: stdout.write,
      stdin: stdinOf("2"),
    });

    expect(selected).toEqual({ id: "org_2", name: "Acme" });
    expect(stdout.text()).toContain("1. Personal — ada@example.com");
    expect(stdout.text()).toContain("2. Acme");
  });

  it("re-asks on an out-of-range or non-numeric answer", async () => {
    const stdout = makeStdout();
    const organizations = [ORGANIZATION, { id: "org_2", name: "Acme" }];

    const selected = await selectOrganization(organizations, {
      stdout: stdout.write,
      stdin: stdinOf("9", "banana", "1"),
    });

    expect(selected).toEqual(ORGANIZATION);
    expect(stdout.text()).toContain('"9" is not one of the options');
    expect(stdout.text()).toContain('"banana" is not one of the options');
  });

  // A closed stdin cannot answer. Looping on end-of-input would hang the CLI
  // with no prompt visible and no way to interrupt it.
  it("fails rather than looping when stdin ends without an answer", async () => {
    await expect(
      selectOrganization([ORGANIZATION, { id: "org_2", name: "Acme" }], {
        stdout: makeStdout().write,
        stdin: Readable.from([]) as unknown as NodeJS.ReadableStream,
      }),
    ).rejects.toThrow("No workspace was selected");
  });

  it("explains rather than crashing when the account offers no workspace at all", async () => {
    await expect(selectOrganization([], { stdout: makeStdout().write })).rejects.toThrow(
      "no workspace",
    );
  });
});

describe("withFreshAccessToken and workspace access", () => {
  /**
   * Membership revoked mid-session. Renewing would mint another token for the
   * same dead organization, so the refresh is skipped entirely — a retry here
   * would be a guaranteed second failure and a spent refresh token.
   */
  it("clears the session without refreshing when the workspace is no longer the caller's", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );

    let attempts = 0;
    await expect(
      withFreshAccessToken(
        {
          baseDir,
          client: makeClient({
            refreshAccessToken: () => Promise.reject(new Error("must not refresh")),
          }),
        },
        () => {
          attempts += 1;
          return Promise.reject(organizationRequired([]));
        },
      ),
    ).rejects.toBeInstanceOf(WorkspaceAccessChangedError);

    expect(attempts).toBe(1);
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    // The host registration survives, and so does everything but the session
    // — including the now-meaningless organization choice.
    expect(await readAccountFile(baseDir)).toEqual({
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });
  });

  it("keeps the organization across a token rotation", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    const attempts: string[] = [];
    await withFreshAccessToken(
      {
        baseDir,
        client: makeClient({
          refreshAccessToken: () =>
            Promise.resolve({
              accessToken: "access-2",
              refreshToken: "refresh-2",
              user: { id: "user_1", email: "ada@example.com" },
            }),
        }),
      },
      (accessToken) => {
        attempts.push(accessToken);
        return attempts.length === 1 ? Promise.reject(unauthorized()) : Promise.resolve("ok");
      },
    );

    // Losing it here would leave the next command unable to refresh into the
    // workspace this machine's hosts actually belong to.
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ accessToken: "access-2", refreshToken: "refresh-2" }),
    );
  });
});

describe("resolveEnvironmentId", () => {
  it("reuses the id the server persisted", async () => {
    const baseDir = makeBaseDir();
    const stateDir = path.join(baseDir, "userdata");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "environment-id"), "persisted-env-id\n", "utf8");

    expect(await resolveEnvironmentId(baseDir)).toBe("persisted-env-id");
  });

  it("generates and persists an id the server will later read back", async () => {
    const baseDir = makeBaseDir();
    const generated = await resolveEnvironmentId(baseDir);
    expect(generated).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fs.readFileSync(path.join(baseDir, "userdata", "environment-id"), "utf8")).toBe(
      `${generated}\n`,
    );
    expect(await resolveEnvironmentId(baseDir)).toBe(generated);
  });
});

describe("resolveAccountUrl", () => {
  it("prefers the flag, falls back to the environment, and trims", () => {
    expect(
      resolveAccountUrl({
        flag: "https://flag.example ",
        env: { SYNARA_ACCOUNT_URL: "https://env" },
      }),
    ).toBe("https://flag.example");
    expect(resolveAccountUrl({ env: { SYNARA_ACCOUNT_URL: " https://env " } })).toBe("https://env");
    expect(resolveAccountUrl({ env: {} })).toBeUndefined();
    expect(resolveAccountUrl({ flag: "  ", env: { SYNARA_ACCOUNT_URL: "" } })).toBeUndefined();
  });
});

describe("runAuthLogin", () => {
  it("completes the device flow, saves both tokens, and registers the persisted environment", async () => {
    const baseDir = makeBaseDir();
    const stateDir = path.join(baseDir, "userdata");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "environment-id"), "persisted-env-id\n", "utf8");
    const stdout = makeStdout();

    const registered: Array<{ token: string; request: unknown }> = [];
    const polls: unknown[] = [];
    const client = deviceFlowClient({
      pollDeviceToken: (_deviceCode, pollOptions) => {
        polls.push(pollOptions);
        return Promise.resolve({
          accessToken: "access-1",
          refreshToken: "refresh-1",
          user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
        });
      },
      registerHost: (token, request) => {
        registered.push({ token, request });
        return Promise.resolve({ host, hostToken: "host-token" });
      },
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      client,
      stdout: stdout.write,
      platform: "darwin",
      hostname: "workstation",
      appVersion: "0.6.4",
    });

    expect(stdout.text()).toContain("https://accounts.example.com/device?user_code=WDJB-MJHT");
    expect(stdout.text()).toContain("WDJB-MJHT");

    // The poll is proxied through the account service, so the only options
    // that travel are the pacing hints the authorization response carried.
    expect(polls).toEqual([{ interval: 5, expiresIn: 900 }]);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.token).toBe("access-1");
    expect(registered[0]?.request).toMatchObject({
      environmentId: "persisted-env-id",
      name: "workstation",
      platform: "darwin",
      kind: "local",
      appVersion: "0.6.4",
    });

    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
  });

  /**
   * The whole loop the org model adds: the device grant's token is refused,
   * the sole workspace is auto-selected, the token is refreshed into it, and
   * registration then simply works. Asserted as one sequence because the
   * ordering is the contract — refreshing before selecting, or registering
   * with the unscoped token, both fail only at the account.
   */
  it("scopes the device token to a workspace and persists the rotated pair", async () => {
    const baseDir = makeBaseDir();
    const stdout = makeStdout();

    const refreshCalls: unknown[] = [];
    const registerTokens: string[] = [];
    const client = deviceFlowClient({
      refreshAccessToken: (options) => {
        refreshCalls.push(options);
        return Promise.resolve({
          accessToken: "access-1",
          refreshToken: "refresh-1",
          user: { id: "user_1", email: "ada@example.com" },
        });
      },
      registerHost: (token) => {
        registerTokens.push(token);
        return Promise.resolve({ host, hostToken: "host-token" });
      },
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      client,
      stdout: stdout.write,
      platform: "darwin",
      hostname: "workstation",
    });

    expect(refreshCalls).toEqual([{ refreshToken: "refresh-0", organizationId: ORGANIZATION.id }]);
    // Registration uses the scoped token, never the one /me refused.
    expect(registerTokens).toEqual(["access-1"]);
    expect(stdout.text()).toContain(`Workspace: ${ORGANIZATION.name}`);
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
  });

  it("asks which workspace to use when the account offers several", async () => {
    const baseDir = makeBaseDir();
    const stdout = makeStdout();
    const acme = { id: "org_2", name: "Acme" };

    const refreshCalls: Array<{ organizationId?: string }> = [];
    const client = deviceFlowClient({
      me: (token) =>
        token === "access-0"
          ? Promise.reject(organizationRequired([ORGANIZATION, acme]))
          : Promise.resolve(meResponse({ organization: acme })),
      refreshAccessToken: (options) => {
        refreshCalls.push(options);
        return Promise.resolve({
          accessToken: "access-1",
          refreshToken: "refresh-1",
          user: { id: "user_1", email: "ada@example.com" },
        });
      },
      registerHost: () => Promise.resolve({ host, hostToken: "host-token" }),
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      client,
      stdout: stdout.write,
      platform: "darwin",
      hostname: "workstation",
      stdin: stdinOf("2"),
    });

    expect(stdout.text()).toContain("Which workspace");
    expect(refreshCalls[0]?.organizationId).toBe(acme.id);
    expect((await readAccountCredentials(baseDir))?.organizationId).toBe(acme.id);
  });

  // A self-hoster whose WorkOS already scopes the device grant never sees the
  // 403, and must not be dragged through a refresh they do not need.
  it("skips the workspace dance when the device token already names one", async () => {
    const baseDir = makeBaseDir();

    const client = deviceFlowClient({
      me: () => Promise.resolve(meResponse()),
      refreshAccessToken: () => Promise.reject(new Error("must not refresh")),
      registerHost: () => Promise.resolve({ host, hostToken: "host-token" }),
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      client,
      stdout: makeStdout().write,
      platform: "darwin",
      hostname: "workstation",
    });

    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({
        accessToken: "access-0",
        refreshToken: "refresh-0",
        hostToken: "host-token",
        hostId: "host_1",
      }),
    );
  });

  it("maps win32 to the windows platform literal", async () => {
    const baseDir = makeBaseDir();
    const stdout = makeStdout();
    const requests: Array<{ platform: string }> = [];

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      platform: "win32",
      hostname: "pc",
      client: deviceFlowClient({
        registerHost: (_token, request) => {
          requests.push({ platform: request.platform });
          return Promise.resolve({
            host: { ...host, platform: "windows" },
            hostToken: "host-token",
          });
        },
      }),
    });

    expect(requests[0]?.platform).toBe("windows");
  });

  it("keeps the session and explains when the platform is unsupported", async () => {
    const baseDir = makeBaseDir();
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      platform: "freebsd",
      hostname: "bsd",
      client: deviceFlowClient(),
    });

    expect(stdout.text()).toContain("freebsd");
    const stored = await readAccountCredentials(baseDir);
    expect(stored?.accessToken).toBe("access-1");
    expect(stored?.refreshToken).toBe("refresh-1");
    expect(stored?.hostId).toBeUndefined();
  });

  it("re-links an existing host registration after a session expiry", async () => {
    const baseDir = makeBaseDir();
    // What `withFreshAccessToken` leaves behind when the refresh token dies:
    // no session, but a host this machine is still registered as.
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "old-host-token",
      hostId: "host_1",
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: makeStdout().write,
      platform: "freebsd",
      hostname: "bsd",
      client: deviceFlowClient(),
    });

    // Registration is skipped on this platform, so the pre-existing host
    // fields are the only ones there are — losing them would strand the host.
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ hostToken: "old-host-token", hostId: "host_1" }),
    );
  });

  it("refuses to re-login when a fully registered session already exists", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("synara auth logout");
  });

  // The state a failed registration leaves: a good session, no host. Sending
  // the user back through the device flow would be busywork, and refusing
  // outright leaves them with no way to finish at all.
  it("completes host registration for a session that never got one, without a device flow", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    const registered: Array<{ token: string }> = [];
    const client = makeClient({
      registerHost: (token) => {
        registered.push({ token });
        return Promise.resolve({ host, hostToken: "host-token" });
      },
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      platform: "darwin",
      hostname: "workstation",
      client,
    });

    // `requestDeviceCode` and `pollDeviceToken` are unimplemented on this
    // client, so reaching either would have rejected the call.
    expect(registered).toEqual([{ token: "access-1" }]);
    expect(stdout.text()).toContain("completing host registration");
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
  });

  it("renews an expired access token while completing an interrupted registration", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    const tokens: string[] = [];
    const client = makeClient({
      refreshAccessToken: () =>
        Promise.resolve({
          accessToken: "access-2",
          refreshToken: "refresh-2",
          user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
        }),
      registerHost: (token) => {
        tokens.push(token);
        if (token === "access-1") return Promise.reject(unauthorized());
        return Promise.resolve({ host, hostToken: "host-token" });
      },
    });

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: makeStdout().write,
      platform: "darwin",
      hostname: "workstation",
      client,
    });

    expect(tokens).toEqual(["access-1", "access-2"]);
    // The rotated pair must survive: writing the host fields back over a
    // captured pre-refresh copy would spend the session for nothing.
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        hostToken: "host-token",
        hostId: "host_1",
      }),
    );
  });
});

describe("runAuthLogout", () => {
  it("removes the host, then removes the credentials file", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
    const stdout = makeStdout();
    const deleted: Array<[string, string]> = [];

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        deleteHost: (token, hostId) => {
          deleted.push([token, hostId]);
          return Promise.resolve();
        },
      }),
    });

    expect(deleted).toEqual([["host-token", "host_1"]]);
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
    expect(stdout.text()).toContain("expires on its own");
  });

  it("signs out a file whose session already expired", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostToken: "host-token",
      hostId: "host_1",
    });
    const stdout = makeStdout();
    const deleted: Array<[string, string]> = [];

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        deleteHost: (token, hostId) => {
          deleted.push([token, hostId]);
          return Promise.resolve();
        },
      }),
    });

    // The host token is independent of the user session, so an expired
    // session must not leave a phantom host on the account.
    expect(deleted).toEqual([["host-token", "host_1"]]);
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
  });

  it("still removes local credentials when the network calls fail", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
    const stdout = makeStdout();

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        deleteHost: () => Promise.reject(new Error("network down")),
      }),
    });

    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    expect(stdout.text()).toContain("network down");
    expect(stdout.text()).toContain("Signed out");
  });

  it("signs out against the stored account URL with no ambient one configured", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(
      baseDir,
      credentials({ accountUrl: "https://stored.example.com" }),
    );
    const stdout = makeStdout();

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("Signed out of https://stored.example.com");
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
  });

  it("deletes a pre-WorkOS credentials file instead of silently no-opping", async () => {
    const baseDir = makeBaseDir();
    await fsp.writeFile(
      accountCredentialsPath(baseDir),
      JSON.stringify({
        accountUrl: "https://accounts.example.com",
        deviceToken: "legacy-device-token",
        hostToken: "host-token",
        hostId: "host_1",
      }),
      "utf8",
    );
    const stdout = makeStdout();

    await runAuthLogout({ baseDir, stdout: stdout.write, client: makeClient({}) });

    // The legacy host token cannot authenticate against the new API, so the
    // host record is the user's to clean up — but the file must still go.
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
    expect(stdout.text()).toContain("stale credentials");
    expect(stdout.text()).toContain("manual removal");
  });

  it("reports when there is nothing to sign out of", async () => {
    const stdout = makeStdout();
    await runAuthLogout({
      baseDir: makeBaseDir(),
      stdout: stdout.write,
      client: makeClient({}),
    });
    expect(stdout.text()).toContain("Not signed in");
  });
});

describe("runStatus", () => {
  it("reports when no account URL is configured", async () => {
    const stdout = makeStdout();
    await runStatus({ baseDir: makeBaseDir(), stdout: stdout.write });
    expect(stdout.text()).toContain("SYNARA_ACCOUNT_URL");
    expect(stdout.text()).toContain("not configured");
  });

  it("reports when the account URL is set but no credentials exist", async () => {
    const stdout = makeStdout();
    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir: makeBaseDir(),
      stdout: stdout.write,
      client: makeClient({}),
    });
    expect(stdout.text()).toContain("Not signed in");
    expect(stdout.text()).toContain("synara auth");
  });

  it("prints the identity, this host, and every registered host", async () => {
    const baseDir = makeBaseDir();
    const stateDir = path.join(baseDir, "userdata");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "environment-id"), "env-uuid\n", "utf8");
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );
    const stdout = makeStdout();

    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        me: () => Promise.resolve(meResponse()),
        listHosts: () =>
          Promise.resolve({
            hosts: [
              host,
              {
                ...host,
                id: "host_2",
                environmentId: EnvironmentId.makeUnsafe("other-env"),
                name: "laptop",
                platform: "linux",
                endpoints: [],
              },
            ],
          }),
      }),
    });

    const text = stdout.text();
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("ada@example.com");
    expect(text).toContain(`Workspace: ${ORGANIZATION.name}`);
    expect(text).toContain("This host");
    expect(text).toContain("workstation");
    expect(text).toContain("http://192.168.1.10:3773");
    expect(text).toContain("laptop");
    expect(text).toContain("linux");
  });

  it("refreshes a rejected access token and reports the identity without bothering the user", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    const tokensSeen: string[] = [];
    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        me: (token) => {
          tokensSeen.push(token);
          if (token === "access-1") return Promise.reject(unauthorized());
          return Promise.resolve(meResponse());
        },
        listHosts: (token) => {
          tokensSeen.push(token);
          return Promise.resolve({ hosts: [] });
        },
        refreshAccessToken: () =>
          Promise.resolve({
            accessToken: "access-2",
            refreshToken: "refresh-2",
            user: { id: "user_1", email: "ada@example.com" },
          }),
      }),
    });

    expect(stdout.text()).toContain("Ada Lovelace");
    // The listHosts call that follows must use the rotated token, not the one
    // the account just rejected.
    expect(tokensSeen).toEqual(["access-1", "access-2", "access-2"]);
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ accessToken: "access-2", refreshToken: "refresh-2" }),
    );
  });

  it("explains that an unrenewable session needs a fresh sign-in", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        me: () => Promise.reject(unauthorized()),
        refreshAccessToken: () =>
          Promise.reject(
            new AccountApiError({
              code: "internal_error",
              status: 400,
              message: "Refresh token is invalid",
            }),
          ),
      }),
    });

    expect(stdout.text()).toContain("Session expired");
    expect(stdout.text()).toContain("synara auth");
  });

  // Distinct advice from an expired session: the refresh token may be fine,
  // and telling the user their session expired would not explain why signing
  // in again is nonetheless the fix.
  it("reports a changed workspace distinctly from an expired session", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({ me: () => Promise.reject(organizationRequired([])) }),
    });

    expect(stdout.text()).toContain(WORKSPACE_CHANGED_MESSAGE);
    expect(stdout.text()).not.toContain("Session expired");
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
  });

  it("does not advise re-authenticating when the account is merely unreachable", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({ me: () => Promise.reject(new Error("ECONNREFUSED")) }),
    });

    expect(stdout.text()).toContain("could not reach the account");
    expect(stdout.text()).toContain("ECONNREFUSED");
    expect(stdout.text()).not.toContain("sign in again");
  });
});

describe("refreshHostRegistration", () => {
  /**
   * A client that records every method reached instead of rejecting. The
   * default `makeClient` mock rejects, which `refreshHostRegistration`'s own
   * catch swallows — so a "must not call" assertion built on rejection would
   * still pass with the guard deleted. Only an explicit record proves it.
   */
  function makeRecordingClient(): { client: AccountClient; reached: string[] } {
    const reached: string[] = [];
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        reached.push(name);
        void args;
        return Promise.resolve(host);
      };
    const client = {
      instance: record("instance"),
      me: record("me"),
      listHosts: record("listHosts"),
      registerHost: record("registerHost"),
      updateHost: record("updateHost"),
      deleteHost: record("deleteHost"),
      requestDeviceCode: record("requestDeviceCode"),
      pollDeviceToken: record("pollDeviceToken"),
    } as unknown as AccountClient;
    return { client, reached };
  }

  function writeRuntimeState(baseDir: string, origin: string, host: string): void {
    const stateDir = path.join(baseDir, "userdata");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(stateDir, "server-runtime.json"),
      `${JSON.stringify({
        version: 1,
        pid: 1,
        host,
        port: 3773,
        origin,
        startedAt: "2026-08-03T12:00:00.000Z",
        externalMcpRuntimeSecret: "secret",
      })}\n`,
      "utf8",
    );
  }

  it("sends the freshly derived endpoints for the registered host exactly once", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );

    const calls: Array<{ hostToken: string; hostId: string; request: unknown }> = [];
    await refreshHostRegistration({
      baseDir,
      appVersion: "0.6.4",
      client: makeClient({
        updateHost: (hostToken, hostId, request) => {
          calls.push({ hostToken, hostId, request });
          return Promise.resolve(host);
        },
      }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.hostToken).toBe("host-token");
    expect(calls[0]?.hostId).toBe("host_1");
    expect(calls[0]?.request).toEqual({
      endpoints: [{ url: "http://192.168.1.42:3773", transport: "lan" }],
      appVersion: "0.6.4",
    });
  });

  it("resolves without throwing when the account rejects the refresh", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );

    let attempted = false;
    await expect(
      refreshHostRegistration({
        baseDir,
        client: makeClient({
          updateHost: () => {
            attempted = true;
            return Promise.reject(
              new AccountApiError({
                code: "token_revoked",
                status: 403,
                message: "Host token invalid",
              }),
            );
          },
        }),
      }),
    ).resolves.toBeUndefined();

    // Without this the test would also pass if the refresh never ran at all,
    // which is the opposite of what it is meant to prove.
    expect(attempted).toBe(true);
  });

  it("does not call the account when no credentials are stored", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");

    const { client, reached } = makeRecordingClient();
    await refreshHostRegistration({ baseDir, client });

    expect(reached).toEqual([]);
  });

  it("does not call the account when credentials exist without a host token", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(baseDir, credentials());

    const { client, reached } = makeRecordingClient();
    await refreshHostRegistration({ baseDir, client });

    expect(reached).toEqual([]);
  });

  it("does not call the account when credentials carry a host token but no host id", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(baseDir, credentials({ hostToken: "host-token" }));

    const { client, reached } = makeRecordingClient();
    await refreshHostRegistration({ baseDir, client });

    expect(reached).toEqual([]);
  });

  it("clears stale endpoints when the server is only reachable on loopback", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://127.0.0.1:3773", "127.0.0.1");
    await writeAccountCredentials(
      baseDir,
      credentials({ hostToken: "host-token", hostId: "host_1" }),
    );

    const requests: unknown[] = [];
    await refreshHostRegistration({
      baseDir,
      appVersion: "0.6.4",
      client: makeClient({
        updateHost: (_hostToken, _hostId, request) => {
          requests.push(request);
          return Promise.resolve(host);
        },
      }),
    });

    expect(requests).toEqual([{ endpoints: [], appVersion: "0.6.4" }]);
  });
});
