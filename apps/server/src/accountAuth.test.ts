import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { type AccountHost, EnvironmentId } from "@synara/contracts";

import type { AccountClient } from "@synara/shared/account";
import { AccountApiError, OrganizationRequiredError } from "@synara/shared/account";
import { generateAndPersistHostIdentity } from "./hostIdentity";

vi.mock("./tailscaleEndpoint", () => ({
  resolveTailscaleEndpoint: vi.fn(async () => undefined),
}));

import {
  accountApiIssuer,
  accountCredentialsPath,
  readAccountCredentials,
  readAccountFile,
  refreshHostRegistration,
  resolveAccountUrl,
  resolveAuthLoginAccountUrl,
  resolveEnvironmentId,
  runAuthLogin,
  runAuthLogout,
  runStatus,
  selectOrganization,
  SessionExpiredError,
  withFreshAccessToken,
  withLockedAccountFile,
  WORKSPACE_CHANGED_MESSAGE,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
} from "./accountAuth.ts";

describe("accountApiIssuer", () => {
  it("derives the Slice A JWT issuer from the account client origin", () => {
    expect(accountApiIssuer("https://accounts.example.test///")).toBe(
      "https://accounts.example.test/api/v1",
    );
  });
});

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
  ownerUserId: "user_1",
  discoverable: true,
  linked: true,
  keyGeneration: 1,
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

function unimplemented(name: string) {
  return () => Promise.reject(new Error(`${name} should not be called`));
}

const CLIENT_ID = "client_01ABC";
const WORKOS_API_URL = "https://api.workos.example";

/** A credentials file with a live session, as `synara auth` leaves it. */
function credentials(overrides: Record<string, unknown> = {}) {
  const { linkedHost: linkedHostValue, ...currentOverrides } = overrides;
  return {
    accountUrl: "https://accounts.example.com",
    workosClientId: CLIENT_ID,
    workosApiUrl: WORKOS_API_URL,
    organizationId: ORGANIZATION.id,
    userId: "user_1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    ...currentOverrides,
    ...(linkedHostValue === true
      ? {
          hostId: typeof currentOverrides.hostId === "string" ? currentOverrides.hostId : "host_1",
          hostOwnerUserId: "user_1",
          hostKeyGeneration: 1,
        }
      : {}),
  };
}

type AccountClientOverrides = Partial<AccountClient> & {
  readonly linkHost?: (token: string, request: any) => Promise<{ host: AccountHost }>;
  readonly unlinkHostFlow?: (proof: string, hostId: string) => Promise<void>;
  readonly reportEndpoints?: (
    proof: string,
    hostId: string,
    request: { readonly endpoints: readonly unknown[] },
  ) => Promise<AccountHost>;
};

function makeClient(overrides: AccountClientOverrides): AccountClient {
  let pendingLink: Promise<{ host: AccountHost }> | undefined;
  const linkHost = overrides.linkHost;
  const unlinkHostFlow = overrides.unlinkHostFlow;
  const reportEndpoints = overrides.reportEndpoints;
  return {
    instance: unimplemented("instance"),
    sendOtp: unimplemented("sendOtp"),
    authenticateOtp: unimplemented("authenticateOtp"),
    me: unimplemented("me"),
    updateProfile: unimplemented("updateProfile"),
    updateOrganization: unimplemented("updateOrganization"),
    listHosts: unimplemented("listHosts"),
    startHostLink: linkHost
      ? async (token, request) => {
          pendingLink = Promise.resolve(await linkHost(token, request));
          return Promise.resolve({
            challengeId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
            nonce: "bm9uY2U",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          });
        }
      : unimplemented("startHostLink"),
    completeHostLink: linkHost
      ? async () => ({ host: (await pendingLink!).host as any })
      : unimplemented("completeHostLink"),
    startDeviceHostLink: unimplemented("startDeviceHostLink"),
    approveDeviceHostLink: unimplemented("approveDeviceHostLink"),
    exchangeDeviceHostLink: unimplemented("exchangeDeviceHostLink"),
    getApiJwks: unimplemented("getApiJwks"),
    replaceHostEndpoints: unimplemented("replaceHostEndpoints"),
    requestRelayTicket: unimplemented("requestRelayTicket"),
    getHostAuthorization: unimplemented("getHostAuthorization"),
    unlinkHost: unimplemented("unlinkHost"),
    updateHost: unimplemented("updateHost"),
    deleteHost: unimplemented("deleteHost"),
    requestAuthorizeUrl: unimplemented("requestAuthorizeUrl"),
    exchangeAuthorizeCode: unimplemented("exchangeAuthorizeCode"),
    refreshAccessToken: unimplemented("refreshAccessToken"),
    ...overrides,
    ...(linkHost
      ? {
          startHostLink: async (token: string, request: any) => {
            pendingLink = Promise.resolve(await linkHost(token, request));
            return Promise.resolve({
              challengeId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
              nonce: "bm9uY2U",
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            });
          },
          completeHostLink: async () => ({ host: (await pendingLink!).host as any }),
        }
      : {}),
    ...(unlinkHostFlow
      ? {
          unlinkHost: (proof: string, hostId: string) =>
            unlinkHostFlow(proof, hostId).then(() => host),
        }
      : {}),
    ...(reportEndpoints
      ? {
          replaceHostEndpoints: (proof: string, hostId: string, endpoints: readonly unknown[]) =>
            reportEndpoints(proof, hostId, { endpoints } as any),
        }
      : {}),
  } as AccountClient;
}

async function persistTestHostIdentity(baseDir: string): Promise<void> {
  const secretsDir = path.join(baseDir, "userdata", "secrets");
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  await generateAndPersistHostIdentity(path.join(secretsDir, "host-identity.json"));
}

function unauthorized(): AccountApiError {
  return new AccountApiError({ code: "unauthorized", status: 401, message: "Unauthorized" });
}

describe("account credential store", () => {
  it("round-trips credentials and keeps the file private", async () => {
    const baseDir = makeBaseDir();
    expect(await readAccountCredentials(baseDir)).toBeUndefined();

    const stored = credentials({ linkedHost: true, hostId: "host_1" });
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
        hostId: "host_1",
        hostOwnerUserId: "user_1",
        hostKeyGeneration: 1,
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
        hostId: "host_1",
      }),
      "utf8",
    );

    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    // An incomplete public-key link is ignored.
    expect(await readAccountFile(baseDir)).not.toHaveProperty("hostId");
  });

  it("reads a file whose session was cleared but keeps its host fields", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    });

    expect(await readAccountFile(baseDir)).toMatchObject({
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
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
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true }));

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
      credentials({ accessToken: "access-2", refreshToken: "refresh-2", linkedHost: true }),
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
          refreshRetryDelayMs: 0,
        },
        () => Promise.reject(unauthorized()),
      ),
    ).rejects.toThrow("ECONNREFUSED");

    expect(await readAccountCredentials(baseDir)).toEqual(credentials());
  });

  // A transient refresh failure is worth one bounded retry with the SAME
  // token — the provider only rotates on success — so a single blip renews
  // the session instead of failing the command.
  it("retries a transient refresh failure once and renews on success", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    let refreshCalls = 0;
    const result = await withFreshAccessToken(
      {
        baseDir,
        client: makeClient({
          refreshAccessToken: () => {
            refreshCalls += 1;
            if (refreshCalls === 1) {
              return Promise.reject(
                new AccountApiError({
                  code: "internal_error",
                  status: 502,
                  message: "Identity provider is unavailable",
                }),
              );
            }
            return Promise.resolve({
              accessToken: "access-2",
              refreshToken: "refresh-2",
              user: { id: "user_1", email: "ada@example.com" },
            });
          },
        }),
        refreshRetryDelayMs: 0,
      },
      (accessToken) =>
        accessToken === "access-1" ? Promise.reject(unauthorized()) : Promise.resolve(accessToken),
    );

    expect(result).toBe("access-2");
    expect(refreshCalls).toBe(2);
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ accessToken: "access-2", refreshToken: "refresh-2" }),
    );
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
        refreshRetryDelayMs: 0,
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
          refreshRetryDelayMs: 0,
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
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));

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
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    });
  });

  // The double-spend race: WorkOS refresh tokens are single-use, so two
  // concurrent expired-token operations that both consumed the stored token
  // must not both redeem it — and the loser must not clear the winner's
  // rotated pair off disk. Renewal is serialized and compare-and-swapped, so
  // the loser re-reads and rides the winner's stored pair instead.
  it("lets concurrent expired-token operations share one rotation instead of double-spending", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true }));

    // Single-use semantics, as WorkOS enforces them: only the stored token
    // redeems, exactly once.
    let liveRefreshToken = "refresh-1";
    let refreshCalls = 0;
    const client = makeClient({
      refreshAccessToken: (options) => {
        refreshCalls += 1;
        if (options.refreshToken !== liveRefreshToken) {
          return Promise.reject(
            new AccountApiError({
              code: "unauthorized",
              status: 400,
              message: "Refresh token is invalid or spent",
            }),
          );
        }
        liveRefreshToken = "refresh-2";
        return Promise.resolve({
          accessToken: "access-2",
          refreshToken: "refresh-2",
          user: { id: "user_1", email: "ada@example.com" },
        });
      },
    });

    // Both operations reject their first (stale) token, forcing both into
    // renewal with the same consumed refresh token.
    const operation = () =>
      withFreshAccessToken({ baseDir, client }, (accessToken) =>
        accessToken === "access-1" ? Promise.reject(unauthorized()) : Promise.resolve(accessToken),
      );

    const [first, second] = await Promise.all([operation(), operation()]);

    expect(first).toBe("access-2");
    expect(second).toBe("access-2");
    // Exactly one redemption: the loser saw the rotated pair on re-read and
    // never presented the spent token.
    expect(refreshCalls).toBe(1);
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ accessToken: "access-2", refreshToken: "refresh-2", linkedHost: true }),
    );
  });

  // A caller that decided "this session is dead" from a stale snapshot must
  // not clear the fresh session another caller stored since: the clear is
  // compare-and-swapped on the refresh token it consumed.
  it("does not let a stale workspace-changed clear overwrite a newly rotated session", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true }));

    let releaseFn: ((error: unknown) => void) | undefined;
    const gate = new Promise<never>((_, reject) => {
      releaseFn = reject;
    });

    // Operation A: stalls inside `fn` holding the stale snapshot, then fails
    // with the workspace-changed refusal.
    const stale = withFreshAccessToken({ baseDir, client: makeClient({}) }, () => gate).catch(
      (error: unknown) => error,
    );

    // Meanwhile the session rotates and a host link is stored.
    await writeAccountCredentials(
      baseDir,
      credentials({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        linkedHost: true,
        hostId: "host_2",
      }),
    );

    releaseFn?.(organizationRequired());
    const caught = await stale;
    expect(caught).toBeInstanceOf(WorkspaceAccessChangedError);

    // The stale clear was skipped: the rotated session and its host fields
    // survive untouched.
    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        linkedHost: true,
        hostId: "host_2",
      }),
    );
  });
});

describe("selectOrganization", () => {
  it("returns the only workspace", async () => {
    await expect(selectOrganization([ORGANIZATION])).resolves.toEqual(ORGANIZATION);
  });

  // V1 is personal-org-only, matching the in-app flow: several workspaces
  // fail closed with the same classified error, so the CLI and desktop paths
  // are indistinguishable — no interactive picker until workspace selection
  // ships for both.
  it("fails closed when the account offers several workspaces", async () => {
    const caught = await selectOrganization([ORGANIZATION, { id: "org_2", name: "Acme" }]).catch(
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(AccountApiError);
    expect(caught).toMatchObject({
      code: "multiple_organizations_unsupported",
      status: 403,
      message: "Multiple workspaces aren't supported yet",
    });
  });

  it("explains rather than crashing when the account offers no workspace at all", async () => {
    await expect(selectOrganization([])).rejects.toThrow("no workspace");
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
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));

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
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
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

  // First-time creation is exclusive: `synara auth` and a starting server can
  // both see the file missing, and last-writer-wins would leave one of them
  // registering a host under an id nobody persisted (a phantom host).
  it("resolves concurrent first-time callers to one persisted id", async () => {
    const baseDir = makeBaseDir();
    const ids = await Promise.all(Array.from({ length: 8 }, () => resolveEnvironmentId(baseDir)));

    const persisted = fs
      .readFileSync(path.join(baseDir, "userdata", "environment-id"), "utf8")
      .trim();
    expect(persisted).toMatch(/^[0-9a-f-]{36}$/u);
    // Every caller — winners and losers alike — got the persisted id.
    expect(new Set(ids)).toEqual(new Set([persisted]));
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

describe("resolveAuthLoginAccountUrl", () => {
  // The signed-in session already recorded which service minted its tokens;
  // `synara auth` must use it even with no env/flag configured at all.
  it("uses the persisted session's accountUrl when no explicit URL is given", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    await expect(resolveAuthLoginAccountUrl({ baseDir, explicitUrl: undefined })).resolves.toBe(
      "https://accounts.example.com",
    );
  });

  it("accepts an explicit URL that matches the persisted session", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    await expect(
      resolveAuthLoginAccountUrl({ baseDir, explicitUrl: "https://accounts.example.com" }),
    ).resolves.toBe("https://accounts.example.com");
  });

  // Sending the stored token to a DIFFERENT service is exactly what this
  // resolution exists to prevent: refuse loudly, do not pick either side.
  it("refuses a conflicting explicit URL instead of sending the stored token elsewhere", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());

    await expect(
      resolveAuthLoginAccountUrl({ baseDir, explicitUrl: "https://other.example.com" }),
    ).rejects.toThrow(/signed in to https:\/\/accounts\.example\.com.*synara auth logout/su);
  });

  it("passes the explicit URL through unchanged when no session exists", async () => {
    const baseDir = makeBaseDir();

    await expect(
      resolveAuthLoginAccountUrl({ baseDir, explicitUrl: "https://accounts.example.com" }),
    ).resolves.toBe("https://accounts.example.com");
    await expect(
      resolveAuthLoginAccountUrl({ baseDir, explicitUrl: undefined }),
    ).resolves.toBeUndefined();
  });

  // A session-less file (host fields only, or expired session) is not a
  // session: the explicit-URL requirement stays in force.
  it("ignores a stored file that carries no usable session", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    });

    await expect(
      resolveAuthLoginAccountUrl({ baseDir, explicitUrl: undefined }),
    ).resolves.toBeUndefined();
  });
});

describe("runAuthLogin", () => {
  // Sign-in is app-only now: with no stored session there is nothing to link
  // a host with, and the CLI must say where sign-in actually lives.
  it("points a signed-out user at the Synara app instead of signing in", async () => {
    const baseDir = makeBaseDir();
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("Not signed in");
    expect(stdout.text()).toContain("sign in from the Synara app");
    expect(await readAccountFile(baseDir)).toBeUndefined();
  });

  // A file with host fields but no session is still signed out: the app must
  // sign in first, and the stored registration is left exactly as found.
  it("treats a session-less file with host fields as not signed in", async () => {
    const baseDir = makeBaseDir();
    const stored = {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    };
    await writeAccountCredentials(baseDir, stored);
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("Not signed in");
    expect(await readAccountFile(baseDir)).toEqual(stored);
  });

  it("refuses to re-link when a fully registered session already exists", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("Already signed in");
    expect(stdout.text()).toContain("this host is linked");
    expect(stdout.text()).toContain("synara auth logout");
  });

  it("registers this host from the app's session, using the persisted environment id", async () => {
    const baseDir = makeBaseDir();
    const stateDir = path.join(baseDir, "userdata");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "environment-id"), "persisted-env-id\n", "utf8");
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    const registered: Array<{ token: string; request: unknown }> = [];
    const client = makeClient({
      linkHost: (token, request) => {
        registered.push({ token, request });
        return Promise.resolve({ host, linkedHost: true });
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

    expect(stdout.text()).toContain("completing host link");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.token).toBe("access-1");
    expect(registered[0]?.request).toMatchObject({
      environmentId: "persisted-env-id",
      name: "workstation",
      platform: "darwin",
      kind: "local",
    });

    expect(await readAccountCredentials(baseDir)).toEqual(
      credentials({ linkedHost: true, hostId: "host_1" }),
    );
  });

  it("maps win32 to the windows platform literal", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();
    const requests: Array<{ platform: string }> = [];

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      platform: "win32",
      hostname: "pc",
      client: makeClient({
        linkHost: (_token, request) => {
          requests.push({ platform: request.platform });
          return Promise.resolve({
            host: { ...host, platform: "windows" },
            linkedHost: true,
          });
        },
      }),
    });

    expect(requests[0]?.platform).toBe("windows");
  });

  it("keeps the session and explains when the platform is unsupported", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      platform: "freebsd",
      hostname: "bsd",
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("freebsd");
    const stored = await readAccountCredentials(baseDir);
    expect(stored?.accessToken).toBe("access-1");
    expect(stored?.refreshToken).toBe("refresh-1");
    expect(stored?.hostId).toBeUndefined();
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
      linkHost: (token) => {
        tokens.push(token);
        if (token === "access-1") return Promise.reject(unauthorized());
        return Promise.resolve({ host, linkedHost: true });
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
        linkedHost: true,
        hostId: "host_1",
      }),
    );
  });
});

describe("runAuthLogout", () => {
  it("removes the host, then removes the credentials file", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));
    const stdout = makeStdout();
    const deleted: Array<[string, string]> = [];

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        unlinkHostFlow: (token, hostId) => {
          deleted.push([token, hostId]);
          return Promise.resolve();
        },
      }),
    });

    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.[1]).toBe("host_1");
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
    expect(stdout.text()).toContain("expires on its own");
  });

  it("signs out a file whose session already expired", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      workosClientId: CLIENT_ID,
      workosApiUrl: WORKOS_API_URL,
      hostId: "host_1",
      hostOwnerUserId: "user_1",
      hostKeyGeneration: 1,
    });
    const stdout = makeStdout();
    const deleted: Array<[string, string]> = [];

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        unlinkHostFlow: (token, hostId) => {
          deleted.push([token, hostId]);
          return Promise.resolve();
        },
      }),
    });

    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.[1]).toBe("host_1");
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
  });

  it("still removes local credentials when the network calls fail", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));
    const stdout = makeStdout();

    await runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        unlinkHostFlow: () => Promise.reject(new Error("network down")),
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
        linkedHost: true,
        hostId: "host_1",
      }),
      "utf8",
    );
    const stdout = makeStdout();

    await runAuthLogout({ baseDir, stdout: stdout.write, client: makeClient({}) });

    // The legacy host link cannot authenticate against the new API, so the
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

  it("waits for a concurrent credential-lock holder and tears down what it stored", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));

    // A slow refresh/host-registration holding the lock mid-flight. If logout
    // deleted the file without the lock, this holder's write would land after
    // the deletion and silently recreate the credentials logout just reported
    // deleted.
    let releaseHolder!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      holderAcquired = resolve;
    });
    const holder = withLockedAccountFile(baseDir, async () => {
      holderAcquired();
      await released;
      await writeAccountCredentials(
        baseDir,
        credentials({
          accessToken: "access-2",
          refreshToken: "refresh-2",
          linkedHost: true,
          hostId: "host_2",
        }),
      );
    });
    await acquired;

    const deleted: Array<[string, string]> = [];
    const stdout = makeStdout();
    const logout = runAuthLogout({
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        unlinkHostFlow: (token, hostId) => {
          deleted.push([token, hostId]);
          return Promise.resolve();
        },
      }),
    });

    // While the holder owns the lock, logout must be queued behind it — no
    // host teardown, no file deletion mid-flight.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(deleted).toEqual([]);
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(true);

    releaseHolder();
    await Promise.all([holder, logout]);

    // Logout re-read inside the lock, so the host it tore down is the one the
    // holder committed — not the stale pre-rotation snapshot.
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.[1]).toBe("host_2");
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
    expect(stdout.text()).toContain("Signed out");
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
    expect(stdout.text()).toContain("sign in from the Synara app");
  });

  it("prints the identity, this host, and every registered host", async () => {
    const baseDir = makeBaseDir();
    const stateDir = path.join(baseDir, "userdata");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, "environment-id"), "env-uuid\n", "utf8");
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));
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
    expect(stdout.text()).toContain("sign in again from the Synara app");
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
      linkHost: record("linkHost"),
      reportEndpoints: record("reportEndpoints"),
      unlinkHostFlow: record("unlinkHostFlow"),
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
    await persistTestHostIdentity(baseDir);
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));

    const calls: Array<{ linkedHost: string; hostId: string; request: unknown }> = [];
    await refreshHostRegistration({
      baseDir,
      appVersion: "0.6.4",
      client: makeClient({
        reportEndpoints: (linkedHost, hostId, request) => {
          calls.push({ linkedHost, hostId, request });
          return Promise.resolve(host);
        },
      }),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.hostId).toBe("host_1");
    expect(calls[0]?.request).toEqual({
      endpoints: [{ url: "http://192.168.1.42:3773", transport: "lan" }],
    });
  });

  it("resolves without throwing when the account rejects the refresh", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));

    let attempted = false;
    await expect(
      refreshHostRegistration({
        baseDir,
        client: makeClient({
          reportEndpoints: () => {
            attempted = true;
            return Promise.reject(
              new AccountApiError({
                code: "token_revoked",
                status: 403,
                message: "Host proof invalid",
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

  it("does not call the account when credentials exist without a host link", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(baseDir, credentials());

    const { client, reached } = makeRecordingClient();
    await refreshHostRegistration({ baseDir, client });

    expect(reached).toEqual([]);
  });

  it("does not call the account when credentials carry a host link but no host id", async () => {
    const baseDir = makeBaseDir();
    writeRuntimeState(baseDir, "http://192.168.1.42:3773", "192.168.1.42");
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true }));

    const { client, reached } = makeRecordingClient();
    await refreshHostRegistration({ baseDir, client });

    expect(reached).toEqual([]);
  });

  it("clears stale endpoints when the server is only reachable on loopback", async () => {
    const baseDir = makeBaseDir();
    await persistTestHostIdentity(baseDir);
    writeRuntimeState(baseDir, "http://127.0.0.1:3773", "127.0.0.1");
    await writeAccountCredentials(baseDir, credentials({ linkedHost: true, hostId: "host_1" }));

    const requests: unknown[] = [];
    await refreshHostRegistration({
      baseDir,
      appVersion: "0.6.4",
      client: makeClient({
        reportEndpoints: (_linkedHost, _hostId, request) => {
          requests.push(request);
          return Promise.resolve(host);
        },
      }),
    });

    expect(requests).toEqual([{ endpoints: [] }]);
  });
});
