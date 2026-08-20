// FILE: providerUsage/providers/localCredential.test.ts
// Purpose: Local-login providers without a personal quota API still surface a
// connected Settings card, and stay needs-auth when no credential file exists.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { droidUsageFetcher, kiloUsageFetcher, piUsageFetcher } from "./localCredential";

const NOW_MS = 1_780_000_000_000;
const tempDirs: string[] = [];

function makeHome(): string {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-local-usage-"));
  tempDirs.push(homeDir);
  return homeDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local credential usage fetchers", () => {
  it("reports needs-auth when no local login is present", async () => {
    const homeDir = makeHome();
    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    expect((await droidUsageFetcher.fetch(ctx)).status).toBe("needs-auth");
    expect((await kiloUsageFetcher.fetch(ctx)).status).toBe("needs-auth");
    expect((await piUsageFetcher.fetch(ctx)).status).toBe("needs-auth");
  });

  it("surfaces signed-in Droid, Kilo, and Pi without inventing quota bars", async () => {
    const homeDir = makeHome();
    mkdirSync(nodePath.join(homeDir, ".factory"), { recursive: true });
    writeFileSync(nodePath.join(homeDir, ".factory", "auth.json"), JSON.stringify({ token: "d" }));
    mkdirSync(nodePath.join(homeDir, ".local", "share", "kilo"), { recursive: true });
    writeFileSync(
      nodePath.join(homeDir, ".local", "share", "kilo", "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth" } }),
    );
    mkdirSync(nodePath.join(homeDir, ".pi", "agent"), { recursive: true });
    writeFileSync(
      nodePath.join(homeDir, ".pi", "agent", "auth.json"),
      JSON.stringify({ provider: "openai" }),
    );

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    const droid = await droidUsageFetcher.fetch(ctx);
    const kilo = await kiloUsageFetcher.fetch(ctx);
    const pi = await piUsageFetcher.fetch(ctx);

    expect(droid.status).toBe("ok");
    expect(kilo.status).toBe("ok");
    expect(pi.status).toBe("ok");
    expect(droid.limits).toEqual([]);
    expect(kilo.usageLines[0]?.label).toBe("Limits");
  });

  it("finds Kilo on the Windows XDG path, not only %APPDATA%", async () => {
    const homeDir = makeHome();
    mkdirSync(nodePath.join(homeDir, ".local", "share", "kilo"), { recursive: true });
    writeFileSync(
      nodePath.join(homeDir, ".local", "share", "kilo", "auth.json"),
      JSON.stringify({ anthropic: { type: "oauth" } }),
    );
    const snapshot = await kiloUsageFetcher.fetch({
      homeDir,
      env: { APPDATA: nodePath.join(homeDir, "AppData", "Roaming") },
      platform: "win32",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
  });
});
