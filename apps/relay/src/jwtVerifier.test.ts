import {
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  RELAY_CONTROL_SCOPE,
  RELAY_TICKET_JWT_TYP,
  SYNARA_RELAY_AUDIENCE,
} from "@synara/contracts";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiJwtVerifier } from "./jwtVerifier";
import { FakeApi } from "./test/fakeApi";

const hostId = "00000000-0000-4000-8000-000000000001";

describe("API JWT verifier", () => {
  let api: FakeApi;
  let verifier: ApiJwtVerifier;

  beforeEach(async () => {
    api = await FakeApi.create();
    verifier = new ApiJwtVerifier({
      apiBaseUrl: "https://fake-api.test",
      issuer: api.issuer,
      fetch: api.fetch,
      logger: { error: vi.fn() },
    });
    await verifier.initialize();
  });

  afterEach(async () => {
    verifier.stop();
    await api.close();
  });

  async function ticket(overrides: Partial<Parameters<FakeApi["sign"]>[0]> = {}): Promise<string> {
    return api.sign({
      typ: RELAY_TICKET_JWT_TYP,
      audience: SYNARA_RELAY_AUDIENCE,
      subject: hostId,
      claims: {
        environmentId: "shared-environment",
        keyGeneration: 1,
        scope: [RELAY_CONTROL_SCOPE],
      },
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    });
  }

  async function grant(overrides: Partial<Parameters<FakeApi["sign"]>[0]> = {}): Promise<string> {
    return api.sign({
      typ: GRANT_JWT_TYP,
      audience: SYNARA_RELAY_AUDIENCE,
      subject: "user_1",
      claims: {
        hostId,
        environmentId: "shared-environment",
        cnf: { jkt: "device-thumbprint" },
        scope: [HOST_CONNECT_SCOPE],
      },
      ...overrides,
    });
  }

  it("verifies valid ticket and grant claim schemas", async () => {
    await expect(verifier.verifyRelayTicket(await ticket())).resolves.toMatchObject({
      sub: hostId,
      environmentId: "shared-environment",
      scope: [RELAY_CONTROL_SCOPE],
    });
    await expect(verifier.verifyGrant(await grant())).resolves.toMatchObject({
      hostId,
      sub: "user_1",
      cnf: { jkt: "device-thumbprint" },
      scope: [HOST_CONNECT_SCOPE],
    });
  });

  it.each([
    ["typ", { typ: GRANT_JWT_TYP }],
    ["audience", { audience: "another-audience" }],
    ["issuer", { issuer: "https://other-issuer.example/api/v1" }],
    [
      "scope",
      {
        claims: {
          environmentId: "shared-environment",
          keyGeneration: 1,
          scope: [HOST_CONNECT_SCOPE],
        },
      },
    ],
  ])("rejects a ticket with the wrong %s", async (_label, overrides) => {
    await expect(verifier.verifyRelayTicket(await ticket(overrides))).rejects.toThrow();
  });

  it("pins EdDSA before attempting signature verification", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      environmentId: "shared-environment",
      keyGeneration: 1,
      scope: [RELAY_CONTROL_SCOPE],
    })
      .setProtectedHeader({ alg: "HS256", typ: RELAY_TICKET_JWT_TYP, kid: "symmetric" })
      .setIssuer(api.issuer)
      .setSubject(hostId)
      .setAudience(SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(new TextEncoder().encode("a sufficiently long test secret"));
    await expect(verifier.verifyRelayTicket(token)).rejects.toThrow(
      "JWT signing algorithm is not allowed",
    );
    expect(api.jwksRequests).toBe(1);
  });

  it("enforces absolute expiry, forward-stamp limits, and bounded lifetimes", async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(
      verifier.verifyRelayTicket(await ticket({ issuedAt: now - 10, expiresAt: now - 1 })),
    ).rejects.toThrow("JWT has expired");
    await expect(
      verifier.verifyRelayTicket(await ticket({ issuedAt: now + 61, expiresAt: now + 62 })),
    ).rejects.toThrow("JWT iat is too far in the future");
    await expect(
      verifier.verifyRelayTicket(await ticket({ issuedAt: now, expiresAt: now + 301 })),
    ).rejects.toThrow("JWT lifetime exceeds its allowed bound");
    await expect(
      verifier.verifyRelayTicket(await ticket({ issuedAt: now - 1, expiresAt: now })),
    ).resolves.toMatchObject({ exp: now });
  });

  it("refreshes once for a newly published kid and rate-limits unknown-kid fetches", async () => {
    const rotated = await api.rotate();
    await expect(verifier.verifyRelayTicket(await ticket({ key: rotated }))).resolves.toMatchObject(
      {
        sub: hostId,
      },
    );
    expect(api.jwksRequests).toBe(2);

    const unknown = await api.unpublishedKey();
    await expect(verifier.verifyRelayTicket(await ticket({ key: unknown }))).rejects.toThrow();
    await expect(verifier.verifyRelayTicket(await ticket({ key: unknown }))).rejects.toThrow();
    expect(api.jwksRequests).toBe(2);
  });

  it("retains the last-known-good set when a periodic refresh fails", async () => {
    verifier.stop();
    verifier = new ApiJwtVerifier({
      apiBaseUrl: "https://fake-api.test",
      issuer: api.issuer,
      fetch: api.fetch,
      refreshIntervalMs: 10,
      logger: { error: vi.fn() },
    });
    await verifier.initialize();
    const valid = await ticket();
    api.jwksFailuresRemaining = 1;
    await vi.waitFor(() => expect(api.jwksRequests).toBeGreaterThanOrEqual(3));
    await expect(verifier.verifyRelayTicket(valid)).resolves.toMatchObject({ sub: hostId });
  });

  it("fails initialization closed when no JWKS has ever loaded", async () => {
    verifier.stop();
    api.jwksFailuresRemaining = 1;
    verifier = new ApiJwtVerifier({
      apiBaseUrl: "https://fake-api.test",
      issuer: api.issuer,
      fetch: api.fetch,
    });
    await expect(verifier.initialize()).rejects.toThrow("JWKS request failed");
  });
});
