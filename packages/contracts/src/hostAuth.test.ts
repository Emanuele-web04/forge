import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DevicePublicKeyJwk,
  HOST_LINK_JWT_TYP,
  HostLinkClaims,
  LinkCompleteResponse,
  LinkStartRequest,
  RegisterDeviceRequest,
  RevocationEventsResponse,
} from "./hostAuth";

describe("host auth contracts", () => {
  it("exports the exact host-link typ and decodes its claims", () => {
    expect(HOST_LINK_JWT_TYP).toBe("synara-host-link+jwt");
    const claims = Schema.decodeUnknownSync(HostLinkClaims)({
      iss: "synara-host:env-1",
      sub: "env-1",
      aud: "https://accounts.example.com",
      iat: 1,
      exp: 2,
      jti: "550e8400-e29b-41d4-a716-446655440000",
      challengeId: "550e8400-e29b-41d4-a716-446655440001",
      nonce: "nonce",
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "x" },
      name: "Mac",
      platform: "darwin",
    });
    expect(claims.challengeId).toContain("550e");
  });

  it("accepts both device-key algorithms and rejects unrelated curves", () => {
    const decode = Schema.decodeUnknownSync(DevicePublicKeyJwk);
    expect(decode({ kty: "OKP", crv: "Ed25519", x: "x" }).crv).toBe("Ed25519");
    expect(decode({ kty: "EC", crv: "P-256", x: "x", y: "y" }).crv).toBe("P-256");
    expect(() => decode({ kty: "EC", crv: "P-384", x: "x", y: "y" })).toThrow();
  });

  it("bounds request credentials and supports unbound link starts", () => {
    expect(Schema.decodeUnknownSync(LinkStartRequest)({})).toEqual({});
    expect(() =>
      Schema.decodeUnknownSync(RegisterDeviceRequest)({ proof: "x".repeat(16_385) }),
    ).toThrow();
  });

  it("decodes revocation feed watermarks and events", () => {
    expect(
      Schema.decodeUnknownSync(RevocationEventsResponse)({
        events: [
          {
            id: 4,
            hostId: "550e8400-e29b-41d4-a716-446655440000",
            kind: "device_revoked",
            subject: "jkt",
            createdAt: "2026-08-13T00:00:00.000Z",
          },
        ],
        watermark: 3,
      }).watermark,
    ).toBe(3);
  });

  it("requires complete ownership and key state on a link response", () => {
    const host = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      environmentId: "env-1",
      name: "Mac",
      platform: "darwin",
      kind: "local",
      endpoints: [],
      registeredByUserId: "user_1",
      createdAt: "2026-08-13T00:00:00.000Z",
      lastSeenAt: "2026-08-13T00:00:00.000Z",
    };
    expect(() => Schema.decodeUnknownSync(LinkCompleteResponse)({ host })).toThrow();
    expect(
      Schema.decodeUnknownSync(LinkCompleteResponse)({
        host: {
          ...host,
          ownerUserId: "user_1",
          discoverable: true,
          linked: true,
          keyGeneration: 1,
        },
      }).host.keyGeneration,
    ).toBe(1);
  });
});
