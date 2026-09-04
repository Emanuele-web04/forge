import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  accountAgentHome,
  accountAppDataDir,
  accountDir,
  accountJsonPath,
  accountsDir,
  activePointerDir,
  activePointerPath,
  appLeasesDir,
  launcherDiagnosticsDir,
  pendingDir,
  pendingPath,
  resolveAccountRoot,
  runtimeDir,
  versionFilePath,
} from "./accountPaths";

const home = "/home/user";

describe("resolveAccountRoot", () => {
  it("honors SYNARA_ACCOUNT_HOME on any platform", () => {
    expect(
      resolveAccountRoot({ platform: "darwin", env: { SYNARA_ACCOUNT_HOME: "/tmp/acct" }, home }),
    ).toBe("/tmp/acct");
  });

  it("uses the macOS application support default", () => {
    expect(resolveAccountRoot({ platform: "darwin", env: {}, home })).toBe(
      join(home, "Library", "Application Support", "Synara", "Accounts"),
    );
  });

  it("uses LOCALAPPDATA on Windows with a fallback", () => {
    expect(
      resolveAccountRoot({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        home,
      }),
    ).toBe(join("C:\\Users\\u\\AppData\\Local", "Synara", "Accounts"));
    expect(resolveAccountRoot({ platform: "win32", env: {}, home })).toBe(
      join(home, "AppData", "Local", "Synara", "Accounts"),
    );
  });

  it("uses XDG_DATA_HOME on Linux with a fallback", () => {
    expect(resolveAccountRoot({ platform: "linux", env: { XDG_DATA_HOME: "/data" }, home })).toBe(
      join("/data", "synara", "accounts"),
    );
    expect(resolveAccountRoot({ platform: "linux", env: {}, home })).toBe(
      join(home, ".local", "share", "synara", "accounts"),
    );
  });
});

describe("layout helpers", () => {
  const root = "/root/accounts";

  it("builds the documented filesystem layout", () => {
    expect(versionFilePath(root)).toBe(join(root, "version"));
    expect(activePointerDir(root)).toBe(join(root, "active"));
    expect(activePointerPath(root, "codex")).toBe(join(root, "active", "codex"));
    expect(accountsDir(root, "claudeAgent")).toBe(join(root, "accounts", "claudeAgent"));
    expect(accountDir(root, "codex", 2)).toBe(join(root, "accounts", "codex", "2"));
    expect(accountJsonPath(root, "codex", 2)).toBe(
      join(root, "accounts", "codex", "2", "account.json"),
    );
    expect(accountAgentHome(root, "codex", 2)).toBe(
      join(root, "accounts", "codex", "2", "agent", "home"),
    );
    expect(accountAppDataDir(root, "codex", 2)).toBe(
      join(root, "accounts", "codex", "2", "app", "data"),
    );
    expect(pendingDir(root, "grok")).toBe(join(root, "pending", "grok"));
    expect(pendingPath(root, "grok", "op-1")).toBe(join(root, "pending", "grok", "op-1"));
    expect(runtimeDir(root)).toBe(join(root, "runtime"));
    expect(appLeasesDir(root)).toBe(join(root, "runtime", "app-leases"));
    expect(launcherDiagnosticsDir(root)).toBe(join(root, "runtime", "launcher-diagnostics"));
  });

  it("rejects invalid ordinals through accountDir", () => {
    expect(() => accountDir(root, "codex", -1)).toThrow(RangeError);
  });
});
