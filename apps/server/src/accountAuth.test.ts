import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { type AccountHost, EnvironmentId } from "@synara/contracts";
import type { AccountClient } from "@synara/shared/account";
import { AccountApiError } from "@synara/shared/account";

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
  SessionExpiredError,
  withFreshAccessToken,
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
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-08-03T12:00:00.000Z",
};

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
    accessToken: "access-1",
    refreshToken: "refresh-1",
    ...overrides,
  };
}

function makeClient(overrides: Partial<AccountClient>): AccountClient {
  return {
    instance: unimplemented("instance"),
    me: unimplemented("me"),
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

/** What `synara auth`'s device flow returns once the user approves. */
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
            expect(options).toEqual({
              refreshToken: "refresh-1",
              clientId: CLIENT_ID,
              workosApiUrl: WORKOS_API_URL,
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

    // The client id and WorkOS origin must come from /instance: the poll goes
    // straight to WorkOS, so a hardcoded pair would break every self-hoster.
    expect(polls).toEqual([
      { interval: 5, expiresIn: 900, clientId: CLIENT_ID, workosApiUrl: WORKOS_API_URL },
    ]);

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

  it("refuses to re-login when credentials already exist", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, credentials());
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({}),
    });

    expect(stdout.text()).toContain("synara auth logout");
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
        me: () => Promise.resolve({ id: "user_1", name: "Ada Lovelace", email: "ada@example.com" }),
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
          return Promise.resolve({ id: "user_1", name: "Ada Lovelace", email: "ada@example.com" });
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
