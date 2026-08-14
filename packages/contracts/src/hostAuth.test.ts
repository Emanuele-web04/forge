import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEVICE_REGISTER_JWT_TYP,
  DEVICE_REGISTER_MAX_AGE_SECONDS,
  DEVICE_USER_CODE_ALPHABET,
  DevicePublicKeyJwk,
  DPOP_JWT_TYP,
  DpopProofWithCredentialClaims,
  Es256PublicKeyJwk,
  GRANT_JWT_TYP,
  GRANT_MAX_AGE_SECONDS,
  HOST_CONNECT_SCOPE,
  HOST_LINK_JWT_TYP,
  HOST_LINK_MAX_AGE_SECONDS,
  HOST_PROOF_JWT_TYP,
  HOST_PROOF_MAX_AGE_SECONDS,
  HostLinkClaims,
  HostPublicKeyJwk,
  JWT_CLOCK_TOLERANCE_SECONDS,
  LinkCompleteResponse,
  LinkDeviceApproveRequest,
  LinkStartRequest,
  MINT_REQUEST_JWT_TYP,
  MINT_REQUEST_MAX_AGE_SECONDS,
  RegisterDeviceRequest,
  RELAY_CONTROL_SCOPE,
  RELAY_TICKET_JWT_TYP,
  RELAY_TICKET_MAX_AGE_SECONDS,
  RevocationEventsResponse,
  SESSION_CREDENTIAL_JWT_TYP,
  SESSION_CREDENTIAL_MAX_AGE_SECONDS,
  SYNARA_DEVICE_ISSUER,
  SYNARA_RELAY_AUDIENCE,
  SYNARA_SESSION_AUDIENCE,
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

  it("pins every token lifetime literal so widening the constant cannot slip past", () => {
    // These bound each token's blast radius; assert the literal, not the constant a mutation could widen alongside its own consumer.
    expect(GRANT_MAX_AGE_SECONDS).toBe(60);
    expect(RELAY_TICKET_MAX_AGE_SECONDS).toBe(300);
    expect(MINT_REQUEST_MAX_AGE_SECONDS).toBe(120);
    expect(SESSION_CREDENTIAL_MAX_AGE_SECONDS).toBe(3600);
    expect(JWT_CLOCK_TOLERANCE_SECONDS).toBe(60);
    expect(HOST_PROOF_MAX_AGE_SECONDS).toBe(60);
    expect(DEVICE_REGISTER_MAX_AGE_SECONDS).toBe(60);
    expect(HOST_LINK_MAX_AGE_SECONDS).toBe(300);
  });

  it("pins scope, audience, issuer, and typ literals shared wire-to-wire with the relay and account API", () => {
    // A silent rename here desynchronizes this host from every peer that hardcodes the same literal.
    expect(HOST_CONNECT_SCOPE).toBe("host:connect");
    expect(RELAY_CONTROL_SCOPE).toBe("relay:control");
    expect(SYNARA_RELAY_AUDIENCE).toBe("synara-relay");
    expect(SYNARA_SESSION_AUDIENCE).toBe("synara-session");
    expect(SYNARA_DEVICE_ISSUER).toBe("synara-device");
    expect(HOST_LINK_JWT_TYP).toBe("synara-host-link+jwt");
    expect(HOST_PROOF_JWT_TYP).toBe("synara-host-proof+jwt");
    expect(DEVICE_REGISTER_JWT_TYP).toBe("synara-device-register+jwt");
    expect(GRANT_JWT_TYP).toBe("synara-grant+jwt");
    expect(RELAY_TICKET_JWT_TYP).toBe("synara-relay-ticket+jwt");
    expect(MINT_REQUEST_JWT_TYP).toBe("synara-mint-request+jwt");
    expect(SESSION_CREDENTIAL_JWT_TYP).toBe("synara-session-credential+jwt");
    expect(DPOP_JWT_TYP).toBe("dpop+jwt");
    expect(DEVICE_USER_CODE_ALPHABET).toBe("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  });

  it("rejects device user codes with any length or character the generator cannot produce", () => {
    const decode = Schema.decodeUnknownSync(LinkDeviceApproveRequest);
    for (const userCode of [
      "ABCDEFG", // 7 chars
      "ABCDEFGHJ", // 9 chars
      "abcdefgh", // lowercase
      "ABCDEFGI", // excluded I
      "ABCDEFGO", // excluded O
      "ABCDEF20", // excluded 0
      "ABCDEF21", // excluded 1
    ]) {
      expect(() => decode({ userCode })).toThrow();
    }
    const valid = DEVICE_USER_CODE_ALPHABET.slice(0, 8);
    expect(decode({ userCode: valid }).userCode).toBe(valid);
  });

  it("rejects non-base64url JWK coordinates and DPoP ath, and still decodes valid ones", () => {
    // Base64Url guards JWK x/y (which flow into importJWK), the link nonce, deviceCode, and DPoP ath.
    const decodeHost = Schema.decodeUnknownSync(HostPublicKeyJwk);
    expect(() => decodeHost({ kty: "OKP", crv: "Ed25519", x: "" })).toThrow();
    expect(() => decodeHost({ kty: "OKP", crv: "Ed25519", x: "has spaces!" })).toThrow();
    expect(() => decodeHost({ kty: "OKP", crv: "Ed25519", x: "plus+slash/" })).toThrow();
    expect(decodeHost({ kty: "OKP", crv: "Ed25519", x: "abc123_-" }).x).toBe("abc123_-");

    const decodeEs256 = Schema.decodeUnknownSync(Es256PublicKeyJwk);
    expect(() => decodeEs256({ kty: "EC", crv: "P-256", x: "x", y: "" })).toThrow();
    expect(() => decodeEs256({ kty: "EC", crv: "P-256", x: "x", y: "has spaces!" })).toThrow();
    expect(() => decodeEs256({ kty: "EC", crv: "P-256", x: "x", y: "plus+slash/" })).toThrow();

    const decodeDpop = Schema.decodeUnknownSync(DpopProofWithCredentialClaims);
    const baseDpop = {
      htu: "https://example.com",
      htm: "POST",
      jti: "550e8400-e29b-41d4-a716-446655440000",
      iat: 1,
    };
    expect(() => decodeDpop({ ...baseDpop, ath: "not base64url!" })).toThrow();
    expect(decodeDpop({ ...baseDpop, ath: "abc123_-" }).ath).toBe("abc123_-");
  });

  it("strips a private d component from a device JWK instead of passing it through", () => {
    // Not a mutation target, but a silently-relied-on behaviour: importJWK must never see a private key.
    expect(
      Schema.decodeUnknownSync(DevicePublicKeyJwk)({
        kty: "OKP",
        crv: "Ed25519",
        x: "x",
        d: "secret",
      }),
    ).toEqual({ kty: "OKP", crv: "Ed25519", x: "x" });
  });
});
