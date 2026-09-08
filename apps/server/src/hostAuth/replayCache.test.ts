import { describe, expect, it } from "vitest";

import { JwtReplayCache } from "./replayCache";

const NOW = 1_800_000_000;
const EXPIRES_AT = NOW + 60;
/**
 * Pinned to the literal rather than JWT_CLOCK_TOLERANCE_SECONDS: retention
 * must track the window the VERIFIER grants, so a test that reads the same
 * constant the cache reads would stay green if either side moved alone.
 */
const CLOCK_TOLERANCE_SECONDS = 60;

describe("JwtReplayCache", () => {
  it("refuses an immediate replay of the same jti", () => {
    const cache = new JwtReplayCache();
    cache.consume("jti-1", EXPIRES_AT, NOW);
    expect(() => cache.consume("jti-1", EXPIRES_AT, NOW)).toThrow(/already been used/);
  });

  it("does not confuse two distinct jtis", () => {
    const cache = new JwtReplayCache();
    cache.consume("jti-1", EXPIRES_AT, NOW);
    expect(() => cache.consume("jti-2", EXPIRES_AT, NOW)).not.toThrow();
  });

  it("refuses a replay one second past exp, while the token is still acceptable", () => {
    // Verification allows clockTolerance past exp. An entry retained only to
    // exp is swept here — and the token replays in that window.
    const cache = new JwtReplayCache();
    cache.consume("jti-1", EXPIRES_AT, NOW);
    expect(() => cache.consume("jti-1", EXPIRES_AT, EXPIRES_AT + 1)).toThrow(/already been used/);
  });

  it("refuses a replay at the last instant the verifier would still accept the token", () => {
    const cache = new JwtReplayCache();
    cache.consume("jti-1", EXPIRES_AT, NOW);
    expect(() => cache.consume("jti-1", EXPIRES_AT, EXPIRES_AT + CLOCK_TOLERANCE_SECONDS)).toThrow(
      /already been used/,
    );
  });

  it("sweeps the entry once the token can no longer be accepted", () => {
    // Pins the WINDOW rather than "never sweeps": one second past
    // exp + tolerance the JWT is dead, so retaining its jti is pure leak.
    const cache = new JwtReplayCache();
    cache.consume("jti-1", EXPIRES_AT, NOW);
    expect(() => cache.consume("jti-1", EXPIRES_AT, EXPIRES_AT + 60 + 1)).not.toThrow();
  });
});
