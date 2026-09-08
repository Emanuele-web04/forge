import { describe, expect, it } from "vitest";

import {
  createPkcePair,
  createSsoState,
  startSsoCallbackListener,
  type SsoCallbackListener,
} from "./accountSsoCallback.ts";

const STATE = "state_test_123";

async function startListener(timeoutMs = 5_000): Promise<SsoCallbackListener> {
  return startSsoCallbackListener({ state: STATE, timeoutMs });
}

function callback(listener: SsoCallbackListener, params: Record<string, string>) {
  const url = new URL(listener.redirectUri);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return fetch(url);
}

describe("createPkcePair", () => {
  it("derives the challenge as S256(verifier), base64url", async () => {
    const { createHash } = await import("node:crypto");
    const pair = createPkcePair();
    expect(pair.codeChallenge).toBe(
      createHash("sha256").update(pair.codeVerifier).digest("base64url"),
    );
    // RFC 7636 bounds the verifier at 43–128 characters.
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
  });

  it("mints a distinct pair and state every time", () => {
    expect(createPkcePair().codeVerifier).not.toBe(createPkcePair().codeVerifier);
    expect(createSsoState()).not.toBe(createSsoState());
  });
});

describe("startSsoCallbackListener", () => {
  it("binds loopback only, on an ephemeral port", async () => {
    const listener = await startListener();
    try {
      const url = new URL(listener.redirectUri);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.pathname).toBe("/callback");
      expect(Number(url.port)).toBeGreaterThan(0);
    } finally {
      listener.close();
    }
  });

  it("resolves with the code on a state-matching callback and closes", async () => {
    const listener = await startListener();
    const response = await callback(listener, { code: "authz_123", state: STATE });
    expect(response.status).toBe(200);
    // The page never echoes the code.
    expect(await response.text()).not.toContain("authz_123");
    await expect(listener.waitForCode()).resolves.toBe("authz_123");
    // Single-use: the listener is down after the outcome.
    await expect(callback(listener, { code: "again", state: STATE })).rejects.toThrow();
  });

  it("rejects a state mismatch without surfacing the delivered code", async () => {
    const listener = await startListener();
    const response = await callback(listener, { code: "authz_stolen", state: "wrong_state" });
    expect(response.status).toBe(400);
    const caught = await listener.waitForCode().catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/did not match/);
    expect((caught as Error).message).not.toContain("authz_stolen");
  });

  it("rejects a provider-reported error callback", async () => {
    const listener = await startListener();
    const response = await callback(listener, { error: "access_denied", state: STATE });
    expect(response.status).toBe(200);
    const caught = await listener.waitForCode().catch((error: unknown) => error);
    expect((caught as Error).message).toMatch(/cancelled or denied/);
  });

  it("rejects and shuts down at the timeout", async () => {
    const listener = await startListener(50);
    const caught = await listener.waitForCode().catch((error: unknown) => error);
    expect((caught as Error).message).toMatch(/timed out/);
    await expect(callback(listener, { code: "late", state: STATE })).rejects.toThrow();
  });

  it("rejects and shuts down on close()", async () => {
    const listener = await startListener();
    listener.close();
    const caught = await listener.waitForCode().catch((error: unknown) => error);
    expect((caught as Error).message).toMatch(/cancelled/);
    await expect(callback(listener, { code: "late", state: STATE })).rejects.toThrow();
  });
});
