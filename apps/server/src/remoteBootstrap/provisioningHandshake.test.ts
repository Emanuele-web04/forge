import { describe, expect, it } from "vitest";

import {
  mintRemoteCredential,
  type ProvisioningClaim,
  redactCredential,
  verifyProvisioningHandshake,
} from "./provisioningHandshake";

const credential = { token: "a".repeat(43) };

const expected = {
  environmentId: "6f9d0c6e-7a1f-4d2b-9a3c-0e5d1b2c3d4e",
  serverVersion: "0.6.3",
  credential,
};

function claim(overrides: Partial<ProvisioningClaim> = {}): ProvisioningClaim {
  return {
    environmentId: expected.environmentId,
    serverVersion: expected.serverVersion,
    acceptedToken: credential.token,
    authenticated: true,
    ...overrides,
  };
}

describe("mintRemoteCredential", () => {
  it("mints 256 bits of entropy as base64url", () => {
    const minted = mintRemoteCredential();
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(minted.token, "base64url").byteLength).toBe(32);
  });

  it("asks the generator for 32 bytes", () => {
    const sizes: number[] = [];
    mintRemoteCredential((size) => {
      sizes.push(size);
      return Buffer.alloc(size, 7);
    });
    expect(sizes).toEqual([32]);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 64 }, () => mintRemoteCredential().token));
    expect(tokens.size).toBe(64);
  });
});

describe("redactCredential", () => {
  // Mutation guard: replacing this with a token prefix would leak entropy into
  // every log line that reports a bootstrap.
  it("never reveals any part of the token", () => {
    const minted = mintRemoteCredential();
    const redacted = redactCredential(minted);
    expect(redacted).toBe("<redacted>");
    expect(redacted).not.toContain(minted.token.slice(0, 4));
  });

  it("redacts a raw string and an absent value the same way", () => {
    expect(redactCredential("super-secret")).toBe("<redacted>");
    expect(redactCredential(undefined)).toBe("<redacted>");
  });
});

describe("verifyProvisioningHandshake", () => {
  it("accepts a fully matching claim", () => {
    expect(verifyProvisioningHandshake({ claim: claim(), expected })).toEqual({ ok: true });
  });

  // Mutation guard (F5): this check must not be conditional on the field being
  // present. `authenticated` is self-reported by the same untrusted side, so a
  // remote that simply omits acceptedToken would otherwise opt itself out of
  // the only comparison that proves it holds the credential we minted.
  it("refuses a claim that omits the token echo, even when it claims authenticated", () => {
    const verdict = verifyProvisioningHandshake({
      claim: claim({ acceptedToken: undefined }),
      expected,
    });
    expect(verdict).toEqual({
      ok: false,
      reason: "Remote server did not echo the credential it accepted.",
    });
  });

  // Each of these is a separate predicate. Removing any one of them must fail.
  it("refuses an unauthenticated server", () => {
    const verdict = verifyProvisioningHandshake({
      claim: claim({ authenticated: false }),
      expected,
    });
    expect(verdict).toEqual({
      ok: false,
      reason: "Remote server did not accept the provisioned credential.",
    });
  });

  // Mutation guard (M35): pinned to the exact reason, so a mutation that
  // reaches the wrong branch cannot pass by failing for a different cause.
  it.each([undefined, ""])(
    "refuses environmentId %j rather than assuming it matches",
    (environmentId) => {
      const verdict = verifyProvisioningHandshake({ claim: claim({ environmentId }), expected });
      expect(verdict).toEqual({
        ok: false,
        reason: "Remote server reported no environmentId.",
      });
    },
  );

  // An empty expected id would make the comparison vacuous; the bootstrapper
  // validates it as a UUID up front, and this pins the second half of that.
  it("refuses an empty claimed environmentId even against an empty expectation", () => {
    const verdict = verifyProvisioningHandshake({
      claim: claim({ environmentId: "" }),
      expected: { ...expected, environmentId: "" },
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses a different environmentId, so we never attach to a foreign server", () => {
    const verdict = verifyProvisioningHandshake({
      claim: claim({ environmentId: "00000000-0000-4000-8000-000000000000" }),
      expected,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/did not provision/);
  });

  // Mutation guard (M36): likewise pinned to its own reason.
  it.each([undefined, ""])("refuses serverVersion %j", (serverVersion) => {
    expect(verifyProvisioningHandshake({ claim: claim({ serverVersion }), expected })).toEqual({
      ok: false,
      reason: "Remote server reported no version.",
    });
  });

  it("refuses a version that is not the release we activated", () => {
    const verdict = verifyProvisioningHandshake({
      claim: claim({ serverVersion: "0.6.2" }),
      expected,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/not the one running/);
  });

  it("refuses a credential echo we did not mint", () => {
    const verdict = verifyProvisioningHandshake({
      claim: claim({ acceptedToken: "b".repeat(43) }),
      expected,
    });
    expect(verdict).toEqual({
      ok: false,
      reason: "Remote server echoed a credential we did not provision.",
    });
  });

  it("refuses a length-different credential echo without throwing", () => {
    expect(() =>
      verifyProvisioningHandshake({ claim: claim({ acceptedToken: "short" }), expected }),
    ).not.toThrow();
    expect(
      verifyProvisioningHandshake({ claim: claim({ acceptedToken: "short" }), expected }).ok,
    ).toBe(false);
  });

  // Mutation guard: a failure reason that interpolates the token would leak it
  // into logs and the UI at exactly the moment an operator is reading closely.
  it("never puts credential material in a failure reason", () => {
    for (const overrides of [
      { authenticated: false },
      { acceptedToken: "b".repeat(43) },
      { environmentId: "other" },
      { serverVersion: "9.9.9" },
    ] satisfies ReadonlyArray<Partial<ProvisioningClaim>>) {
      const verdict = verifyProvisioningHandshake({ claim: claim(overrides), expected });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).not.toContain(credential.token);
        expect(verdict.reason).not.toContain("b".repeat(43));
      }
    }
  });
});
