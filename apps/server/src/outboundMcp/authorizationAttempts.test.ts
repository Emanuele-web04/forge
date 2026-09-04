import { describe, expect, it, vi } from "vitest";

import { makeAuthorizationAttemptRegistry } from "./authorizationAttempts.ts";

describe("AuthorizationAttemptRegistry", () => {
  it("rejects an authorization attempt TTL longer than ten minutes", () => {
    expect(() => makeAuthorizationAttemptRegistry({ ttlMs: 600_001 })).toThrow(
      "Authorization attempt TTL must not exceed 600000ms.",
    );
  });

  it("consumes matching state exactly once with its saved PKCE verifier", () => {
    const attempts = makeAuthorizationAttemptRegistry({ ttlMs: 10 * 60 * 1000 });
    const created = attempts.create("paraty", new URL("http://127.0.0.1:58090/oauth/callback"));
    attempts.saveVerifier(created.id, "pkce-verifier");

    expect(created.id).toMatch(/^[a-f0-9]{64}$/);
    expect(created.state).toMatch(/^[a-f0-9]{64}$/);
    expect(attempts.consume(created.id, created.state)).toMatchObject({
      connectionId: "paraty",
      codeVerifier: "pkce-verifier",
    });
    expect(attempts.consume(created.id, created.state)).toBeNull();
  });

  it("deletes an attempt after a state mismatch so the correct state cannot be replayed", () => {
    const attempts = makeAuthorizationAttemptRegistry({ ttlMs: 10 * 60 * 1000 });
    const created = attempts.create("paraty", new URL("http://127.0.0.1:58090/oauth/callback"));

    expect(attempts.consume(created.id, "wrong-state")).toBeNull();
    expect(attempts.consume(created.id, created.state)).toBeNull();
  });

  it("expires attempts and consumes the expired entry", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
      const attempts = makeAuthorizationAttemptRegistry({ ttlMs: 1_000 });
      const created = attempts.create("paraty", new URL("http://127.0.0.1:58090/oauth/callback"));
      vi.advanceTimersByTime(1_000);

      expect(attempts.consume(created.id, created.state)).toBeNull();
      expect(attempts.consume(created.id, created.state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes an expired attempt without consuming a live one", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-01T08:00:00.000Z"));
      const attempts = makeAuthorizationAttemptRegistry({ ttlMs: 1_000 });
      const created = attempts.create("paraty", new URL("http://127.0.0.1:58090/oauth/callback"));

      expect(attempts.expire(created.id)).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(attempts.expire(created.id)).toBe(true);
      expect(attempts.expire(created.id)).toBe(false);
      expect(attempts.consume(created.id, created.state)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not restore unfinished authorization attempts in a new registry", () => {
    const firstProcess = makeAuthorizationAttemptRegistry({ ttlMs: 10 * 60 * 1000 });
    const created = firstProcess.create("paraty", new URL("http://127.0.0.1:58090/oauth/callback"));
    firstProcess.saveVerifier(created.id, "pkce-verifier");

    const restartedProcess = makeAuthorizationAttemptRegistry({ ttlMs: 10 * 60 * 1000 });
    expect(restartedProcess.consume(created.id, created.state)).toBeNull();
  });

  it("cancels an attempt without affecting another attempt", () => {
    const attempts = makeAuthorizationAttemptRegistry({ ttlMs: 10 * 60 * 1000 });
    const cancelled = attempts.create("paraty", new URL("http://127.0.0.1:58090/oauth/callback"));
    const retained = attempts.create("other", new URL("http://127.0.0.1:58090/oauth/callback"));

    attempts.cancel(cancelled.id);

    expect(attempts.consume(cancelled.id, cancelled.state)).toBeNull();
    expect(attempts.consume(retained.id, retained.state)).toMatchObject({
      connectionId: "other",
    });
  });
});
