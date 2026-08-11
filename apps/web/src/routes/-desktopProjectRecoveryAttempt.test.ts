import { describe, expect, it } from "vitest";

import { createDesktopProjectRecoveryAttemptGate } from "./-desktopProjectRecoveryAttempt";

describe("desktop project recovery attempt ownership", () => {
  it("lets a dependency rerun replace an in-flight attempt without stale cleanup taking it", () => {
    const gate = createDesktopProjectRecoveryAttemptGate();
    const firstAttempt = gate.begin();
    expect(firstAttempt).not.toBeNull();

    // An effect dependency changes while the first request is still pending.
    firstAttempt?.release();
    const replacementAttempt = gate.begin();
    expect(replacementAttempt).not.toBeNull();

    // The stale response and stale rejection path cannot complete or release
    // the replacement attempt.
    expect(firstAttempt?.complete()).toBe(false);
    firstAttempt?.release();
    expect(replacementAttempt?.isCurrent()).toBe(true);

    expect(replacementAttempt?.complete()).toBe(true);
    expect(gate.begin()).toBeNull();
    replacementAttempt?.release();
    expect(gate.begin()).toBeNull();
  });
});
