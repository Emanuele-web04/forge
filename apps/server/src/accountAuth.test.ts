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
  resolveAccountUrl,
  resolveEnvironmentId,
  runAuthLogin,
  runAuthLogout,
  runStatus,
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

function makeClient(overrides: Partial<AccountClient>): AccountClient {
  return {
    instance: unimplemented("instance"),
    me: unimplemented("me"),
    listHosts: unimplemented("listHosts"),
    registerHost: unimplemented("registerHost"),
    updateHost: unimplemented("updateHost"),
    deleteHost: unimplemented("deleteHost"),
    listSessions: unimplemented("listSessions"),
    deleteSession: unimplemented("deleteSession"),
    requestDeviceCode: unimplemented("requestDeviceCode"),
    pollDeviceToken: unimplemented("pollDeviceToken"),
    ...overrides,
  } as AccountClient;
}

describe("account credential store", () => {
  it("round-trips credentials and keeps the file private", async () => {
    const baseDir = makeBaseDir();
    expect(await readAccountCredentials(baseDir)).toBeUndefined();

    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
      hostToken: "host-token",
      hostId: "host_1",
    });

    expect(await readAccountCredentials(baseDir)).toEqual({
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
      hostToken: "host-token",
      hostId: "host_1",
    });

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
    const client = makeClient({
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
          accessToken: "device-token",
          tokenType: "Bearer",
          expiresIn: 3600,
          scope: "",
        }),
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

    expect(registered).toHaveLength(1);
    expect(registered[0]?.token).toBe("device-token");
    expect(registered[0]?.request).toMatchObject({
      environmentId: "persisted-env-id",
      name: "workstation",
      platform: "darwin",
      kind: "local",
      appVersion: "0.6.4",
    });

    expect(await readAccountCredentials(baseDir)).toEqual({
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
      hostToken: "host-token",
      hostId: "host_1",
    });
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
      client: makeClient({
        requestDeviceCode: () =>
          Promise.resolve({
            deviceCode: "device-code",
            userCode: "AAAA-BBBB",
            verificationUri: "https://accounts.example.com/device",
            verificationUriComplete: "https://accounts.example.com/device?user_code=AAAA-BBBB",
            expiresIn: 900,
            interval: 5,
          }),
        pollDeviceToken: () =>
          Promise.resolve({
            accessToken: "device-token",
            tokenType: "Bearer",
            expiresIn: 3600,
            scope: "",
          }),
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

  it("keeps the device token and explains when the platform is unsupported", async () => {
    const baseDir = makeBaseDir();
    const stdout = makeStdout();

    await runAuthLogin({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      platform: "freebsd",
      hostname: "bsd",
      client: makeClient({
        requestDeviceCode: () =>
          Promise.resolve({
            deviceCode: "device-code",
            userCode: "AAAA-BBBB",
            verificationUri: "https://accounts.example.com/device",
            verificationUriComplete: "https://accounts.example.com/device?user_code=AAAA-BBBB",
            expiresIn: 900,
            interval: 5,
          }),
        pollDeviceToken: () =>
          Promise.resolve({
            accessToken: "device-token",
            tokenType: "Bearer",
            expiresIn: 3600,
            scope: "",
          }),
      }),
    });

    expect(stdout.text()).toContain("freebsd");
    const credentials = await readAccountCredentials(baseDir);
    expect(credentials?.deviceToken).toBe("device-token");
    expect(credentials?.hostId).toBeUndefined();
  });

  it("refuses to re-login when credentials already exist", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
    });
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
  it("revokes the host and session, then removes the credentials file", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
      hostToken: "host-token",
      hostId: "host_1",
    });
    const stdout = makeStdout();
    const deleted: Array<[string, string]> = [];

    await runAuthLogout({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        deleteHost: (token, hostId) => {
          deleted.push([token, hostId]);
          return Promise.resolve();
        },
        listSessions: () =>
          Promise.resolve({
            sessions: [
              { id: "session_1", createdAt: "2026-08-01T00:00:00.000Z", current: true },
              { id: "session_2", createdAt: "2026-08-01T00:00:00.000Z", current: false },
            ],
          }),
        deleteSession: (token, sessionId) => {
          deleted.push([token, sessionId]);
          return Promise.resolve();
        },
      }),
    });

    expect(deleted).toEqual([
      ["host-token", "host_1"],
      ["device-token", "session_1"],
    ]);
    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    expect(fs.existsSync(accountCredentialsPath(baseDir))).toBe(false);
  });

  it("still removes local credentials when the network calls fail", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
      hostToken: "host-token",
      hostId: "host_1",
    });
    const stdout = makeStdout();

    await runAuthLogout({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        deleteHost: () => Promise.reject(new Error("network down")),
        listSessions: () => Promise.reject(new Error("network down")),
      }),
    });

    expect(await readAccountCredentials(baseDir)).toBeUndefined();
    expect(stdout.text()).toContain("network down");
    expect(stdout.text()).toContain("Signed out");
  });

  it("reports when there is nothing to sign out of", async () => {
    const stdout = makeStdout();
    await runAuthLogout({
      accountUrl: "https://accounts.example.com",
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
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
      hostToken: "host-token",
      hostId: "host_1",
    });
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

  it("explains that a revoked token needs a fresh sign-in", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
    });
    const stdout = makeStdout();

    await runStatus({
      accountUrl: "https://accounts.example.com",
      baseDir,
      stdout: stdout.write,
      client: makeClient({
        me: () =>
          Promise.reject(
            new AccountApiError({ code: "unauthorized", status: 401, message: "Unauthorized" }),
          ),
      }),
    });

    expect(stdout.text()).toContain("synara auth");
  });

  it("does not advise re-authenticating when the account is merely unreachable", async () => {
    const baseDir = makeBaseDir();
    await writeAccountCredentials(baseDir, {
      accountUrl: "https://accounts.example.com",
      deviceToken: "device-token",
    });
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
