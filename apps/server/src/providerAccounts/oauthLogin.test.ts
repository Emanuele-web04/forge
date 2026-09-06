// Hermetic tests for the real codex OAuth login runner: a fake `codex`
// shell script on a private PATH stands in for the provider binary. No
// network, no real credentials.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { codexOauthLoginRunner, OAUTH_LOGIN_TIMEOUT_MS } from "./oauthLogin";

const FAKE_KEY = "sk-test-never-echo-1234";

const makeIdToken = (email: string): string => {
  const payload = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
};

describe("codexOauthLoginRunner", () => {
  let dir: string;
  let profileHome: string;
  let originalPath: string | undefined;

  const installFakeCodex = (script: string) => {
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    const codexPath = join(binDir, "codex");
    writeFileSync(codexPath, `#!/bin/sh\n${script}\n`);
    chmodSync(codexPath, 0o755);
    // Prepend so the fake codex wins while shell built-ins stay resolvable.
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  };

  const writeAuthJson = (idToken?: string) => {
    writeFileSync(
      join(profileHome, "auth.json"),
      JSON.stringify(idToken !== undefined ? { tokens: { id_token: idToken } } : {}),
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "synara-oauth-"));
    profileHome = join(dir, "profile");
    mkdirSync(profileHome, { recursive: true });
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces the first verification URL printed on stdout and succeeds", async () => {
    installFakeCodex(
      [
        `echo "Open https://auth.openai.com/device?code=abc to continue"`,
        `echo "second https://auth.openai.com/ignored"`,
        `printf '{"tokens":{"id_token":"${makeIdToken("kartik@example.com")}"}}' > "$CODEX_HOME/auth.json"`,
      ].join("\n"),
    );
    const verifications: Array<string | undefined> = [];
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: (info) => verifications.push(info.verificationUrl),
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: true, identityHint: "k\u2022\u2022\u2022\u2022@example.com" });
    expect(verifications).toEqual(["https://auth.openai.com/device?code=abc"]);
  });

  it("ignores URLs on unexpected hosts and surfaces the first on a known auth host", async () => {
    installFakeCodex(
      [
        `echo "Visit https://evil.com/login first"`,
        `echo "Then open https://auth.openai.com/device?code=real"`,
        `printf '{}' > "$CODEX_HOME/auth.json"`,
      ].join("\n"),
    );
    const verifications: Array<string | undefined> = [];
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: (info) => verifications.push(info.verificationUrl),
    });
    const outcome = await handle.done;
    expect(outcome.ok).toBe(true);
    expect(verifications).toEqual(["https://auth.openai.com/device?code=real"]);
  });

  it("never surfaces a verification URL when only unexpected hosts are printed", async () => {
    installFakeCodex(
      [
        `echo "Visit https://evil.com/login and https://auth.openai.com.evil.net/phish"`,
        `printf '{}' > "$CODEX_HOME/auth.json"`,
      ].join("\n"),
    );
    const verifications: Array<unknown> = [];
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: (info) => verifications.push(info),
    });
    const outcome = await handle.done;
    expect(outcome.ok).toBe(true);
    expect(verifications).toEqual([]);
  });

  it("extracts a verification URL printed on stderr", async () => {
    installFakeCodex(
      [
        `echo "Visit https://auth.openai.com/from-stderr" 1>&2`,
        `printf '{}' > "$CODEX_HOME/auth.json"`,
      ].join("\n"),
    );
    const verifications: Array<string | undefined> = [];
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: (info) => verifications.push(info.verificationUrl),
    });
    const outcome = await handle.done;
    expect(outcome.ok).toBe(true);
    expect(verifications).toEqual(["https://auth.openai.com/from-stderr"]);
  });

  it("succeeds without an identity hint when the login emits no URL and no id token", async () => {
    installFakeCodex(`printf '{}' > "$CODEX_HOME/auth.json"`);
    const verifications: Array<unknown> = [];
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: (info) => verifications.push(info),
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: true });
    expect(verifications).toEqual([]);
  });

  it("omits the identity hint when auth.json holds an unparsable id token", async () => {
    installFakeCodex("exit 0");
    writeAuthJson("not-a-jwt");
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: true });
  });

  it("omits the identity hint when the decoded claims carry no email", async () => {
    installFakeCodex("exit 0");
    const payload = Buffer.from(JSON.stringify({ sub: "user-1" }), "utf8").toString("base64url");
    writeAuthJson(`header.${payload}.sig`);
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: true });
  });

  it("fails when the login exits zero without writing credentials", async () => {
    installFakeCodex("exit 0");
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({
      ok: false,
      error: "Codex login finished but no credentials were written to the managed profile.",
    });
  });

  it("fails with the exit code when the login exits nonzero", async () => {
    installFakeCodex("exit 3");
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: false, error: "'codex login' exited with code 3." });
  });

  it("fails with a helpful error when the codex binary is missing", async () => {
    process.env.PATH = join(dir, "empty-path");
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    const outcome = await handle.done;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/Could not start 'codex login'/);
  });

  it("cancel kills the login child and reports cancellation", async () => {
    installFakeCodex("sleep 60");
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    // Give the child a moment to spawn before killing it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    handle.cancel();
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: false, error: "Codex login was cancelled." });
  });

  it("times out after the login deadline and kills the child", async () => {
    installFakeCodex("sleep 60");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const handle = codexOauthLoginRunner({
      provider: "codex",
      profileHome,
      onVerification: () => undefined,
    });
    vi.advanceTimersByTime(OAUTH_LOGIN_TIMEOUT_MS);
    const outcome = await handle.done;
    expect(outcome).toEqual({ ok: false, error: "Codex login timed out after 10 minutes." });
  });

  it("pins CODEX_HOME to the profile home and strips conflicting variables", async () => {
    installFakeCodex(
      [
        `printf 'CODEX_HOME=%s\\nOPENAI_API_KEY=%s\\nCODEX_API_KEY=%s\\nOPENAI_BASE_URL=%s\\n' \\`,
        `  "$CODEX_HOME" "\${OPENAI_API_KEY-unset}" "\${CODEX_API_KEY-unset}" "\${OPENAI_BASE_URL-unset}" > "$CODEX_HOME/env.txt"`,
        `printf '{}' > "$CODEX_HOME/auth.json"`,
      ].join("\n"),
    );
    process.env.CODEX_HOME = "/native/home";
    process.env.OPENAI_API_KEY = FAKE_KEY;
    process.env.CODEX_API_KEY = FAKE_KEY;
    process.env.OPENAI_BASE_URL = "https://native.example.com";
    try {
      const handle = codexOauthLoginRunner({
        provider: "codex",
        profileHome,
        onVerification: () => undefined,
      });
      const outcome = await handle.done;
      expect(outcome.ok).toBe(true);
      const observed = readFileSync(join(profileHome, "env.txt"), "utf8");
      expect(observed).toContain(`CODEX_HOME=${profileHome}`);
      expect(observed).toContain("OPENAI_API_KEY=unset");
      expect(observed).toContain("CODEX_API_KEY=unset");
      expect(observed).toContain("OPENAI_BASE_URL=unset");
      expect(observed).not.toContain(FAKE_KEY);
    } finally {
      delete process.env.CODEX_HOME;
      delete process.env.OPENAI_API_KEY;
      delete process.env.CODEX_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });
});
