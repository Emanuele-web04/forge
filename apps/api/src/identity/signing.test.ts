import { randomUUID } from "node:crypto";
import { decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { GRANT_JWT_TYP, HOST_PROOF_JWT_TYP } from "@synara/contracts";
import { createApiSigningService, verifyBoundedJwt, verifyJwtWithEmbeddedJwk } from "./signing";

const seed = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

describe("API signing", () => {
  it("derives a stable RFC 7638 kid from the same seed across boots", async () => {
    const first = await createApiSigningService({ issuer: "https://api.example", seed: seed(1) });
    const second = await createApiSigningService({ issuer: "https://api.example", seed: seed(1) });
    expect(first.currentKid).toBe(second.currentKid);
    expect(first.jwks.keys[0]?.kid).toBe(first.currentKid);
  });

  it("publishes the current and previous public keys but signs with current", async () => {
    const service = await createApiSigningService({
      issuer: "https://api.example",
      seed: seed(2),
      previousSeed: seed(3),
    });
    expect(service.jwks.keys).toHaveLength(2);
    expect(new Set(service.jwks.keys.map((key) => key.kid)).size).toBe(2);

    const jwt = await service.sign({
      typ: "synara-grant+jwt",
      audience: "synara-relay",
      subject: "user_1",
      expiresInSeconds: 60,
      claims: { hostId: randomUUID() },
    });
    expect(decodeProtectedHeader(jwt).kid).toBe(service.currentKid);
  });

  it("verifies a token minted by the previous key during rotation", async () => {
    const previous = await createApiSigningService({
      issuer: "https://api.example",
      seed: seed(3),
    });
    const rotated = await createApiSigningService({
      issuer: "https://api.example",
      seed: seed(2),
      previousSeed: seed(3),
    });
    const token = await previous.sign({
      typ: "synara-grant+jwt",
      audience: "synara-relay",
      subject: "user_1",
      expiresInSeconds: 60,
    });
    await expect(
      rotated.verify(token, {
        typ: "synara-grant+jwt",
        audience: "synara-relay",
        maxAgeSeconds: 60,
      }),
    ).resolves.toMatchObject({ sub: "user_1" });
  });

  it("verifies ES256 device proof against its embedded public JWK", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const publicKeyJwk = await exportJWK(publicKey);
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ publicKeyJwk })
      .setProtectedHeader({ alg: "ES256", typ: "synara-device-register+jwt" })
      .setIssuer("synara-device")
      .setSubject("user_1")
      .setAudience("https://api.example")
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    const verified = await verifyJwtWithEmbeddedJwk(token, {
      typ: "synara-device-register+jwt",
      audience: "https://api.example",
      maxAgeSeconds: 60,
      publicKeyJwk: publicKeyJwk as {
        kty: "EC";
        crv: "P-256";
        x: string;
        y: string;
      },
      algorithms: ["ES256", "EdDSA"],
    });
    expect(verified.payload.sub).toBe("user_1");
  });

  it("rejects an overlong lifetime even when the signature and exp are valid", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ keyGeneration: 1 })
      .setProtectedHeader({ alg: "EdDSA", typ: HOST_PROOF_JWT_TYP })
      .setIssuer("synara-host:env-1")
      .setSubject(randomUUID())
      .setAudience("https://api.example")
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 61)
      .sign(privateKey);

    await expect(
      verifyBoundedJwt(token, publicKey, {
        typ: HOST_PROOF_JWT_TYP,
        audience: "https://api.example",
        algorithms: ["EdDSA"],
        maxAgeSeconds: 60,
      }),
    ).rejects.toThrow(/lifetime/i);
  });

  it("rejects a host proof stamped with the wrong typ", async () => {
    // typ is the only thing distinguishing a grant from a host proof from a
    // device registration once they all share one signing key — see the
    // ApiSigningService doc comment.
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ keyGeneration: 1 })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP })
      .setIssuer("synara-host:env-1")
      .setSubject(randomUUID())
      .setAudience("https://api.example")
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);

    await expect(
      verifyBoundedJwt(token, publicKey, {
        typ: HOST_PROOF_JWT_TYP,
        audience: "https://api.example",
        algorithms: ["EdDSA"],
        maxAgeSeconds: 60,
      }),
    ).rejects.toThrow(`JWT typ must be ${HOST_PROOF_JWT_TYP}`);
    // Both sides of the wire read this constant; pin the literal too.
    expect(HOST_PROOF_JWT_TYP).toBe("synara-host-proof+jwt");
  });

  it("rejects a host proof forged without iat or exp claims", async () => {
    // No lifetime claims at all makes the proof immortal: the subsequent
    // expiresAt/issuedAt arithmetic on undefined is NaN, so every bound and
    // expiry comparison silently fails open.
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    const publicKeyJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x as string } as const;
    const token = await new SignJWT({ keyGeneration: 1 })
      .setProtectedHeader({ alg: "EdDSA", typ: HOST_PROOF_JWT_TYP })
      .setIssuer("synara-host:env-1")
      .setSubject("host-1")
      .setAudience("https://api.example")
      .sign(keys.privateKey);

    await expect(
      verifyJwtWithEmbeddedJwk(token, {
        typ: HOST_PROOF_JWT_TYP,
        audience: "https://api.example",
        issuer: "synara-host:env-1",
        algorithms: ["EdDSA"],
        maxAgeSeconds: 60,
        publicKeyJwk,
      }),
    ).rejects.toThrow(/integer iat and exp/);
  });

  it("rejects a host proof with fractional iat/exp claims", async () => {
    // Number.isInteger rejects fractional seconds too, not just missing claims.
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    const publicKeyJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x as string } as const;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ keyGeneration: 1 })
      .setProtectedHeader({ alg: "EdDSA", typ: HOST_PROOF_JWT_TYP })
      .setIssuer("synara-host:env-1")
      .setSubject("host-1")
      .setAudience("https://api.example")
      .setIssuedAt(now + 0.5)
      .setExpirationTime(now + 10_000.5)
      .sign(keys.privateKey);

    await expect(
      verifyJwtWithEmbeddedJwk(token, {
        typ: HOST_PROOF_JWT_TYP,
        audience: "https://api.example",
        issuer: "synara-host:env-1",
        algorithms: ["EdDSA"],
        maxAgeSeconds: 60,
        publicKeyJwk,
      }),
    ).rejects.toThrow(/integer iat and exp/);
  });

  it("refuses a token minted by a different deployment sharing the seed", async () => {
    // Two deployments can share a signing seed (staging clone, key reuse).
    // verify() pins its own issuer and does not accept a caller override, so
    // a token minted by B is never valid at A.
    const a = await createApiSigningService({ issuer: "https://a.example", seed: seed(3) });
    const b = await createApiSigningService({ issuer: "https://b.example", seed: seed(3) });
    const token = await b.sign({
      typ: "synara-grant+jwt",
      audience: "synara-relay",
      subject: "user_1",
      expiresInSeconds: 60,
    });
    await expect(
      a.verify(token, {
        typ: "synara-grant+jwt",
        audience: "synara-relay",
        maxAgeSeconds: 60,
      }),
    ).rejects.toThrow();
    // Issuer is deliberately not a caller option (see the ApiSigningService
    // doc comment): even a call site that passes B's issuer explicitly must
    // not make verify() trust it over A's own pinned issuer.
    await expect(
      a.verify(token, {
        typ: "synara-grant+jwt",
        audience: "synara-relay",
        maxAgeSeconds: 60,
        issuer: "https://b.example",
      } as Parameters<typeof a.verify>[1]),
    ).rejects.toThrow(/"iss"/);
  });

  it("stops honoring a proof the moment it expires, despite clock tolerance", async () => {
    // jose accepts until exp + clockTolerance (60s here). On a 60s host proof
    // that doubles the replay window, and combined with forward-stamped iat
    // it reaches ~3x. Expiry must be absolute for these short-lived proofs.
    const keys = await generateKeyPair("EdDSA", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    const publicKeyJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x as string } as const;
    const now = Math.floor(Date.now() / 1000);
    const sign = (iat: number, exp: number) =>
      new SignJWT({ keyGeneration: 1 })
        .setProtectedHeader({ alg: "EdDSA", typ: HOST_PROOF_JWT_TYP })
        .setIssuer("synara-host:env-1")
        .setSubject("host-1")
        .setAudience("https://api.example")
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(keys.privateKey);
    const options = {
      typ: HOST_PROOF_JWT_TYP,
      audience: "https://api.example",
      issuer: "synara-host:env-1",
      algorithms: ["EdDSA"],
      maxAgeSeconds: 60,
      publicKeyJwk,
    } as const;

    await expect(
      verifyJwtWithEmbeddedJwk(await sign(now, now + 60), options),
    ).resolves.toBeDefined();
    // Expired 30s ago: inside jose's tolerance, outside ours.
    await expect(
      verifyJwtWithEmbeddedJwk(await sign(now - 90, now - 30), options),
    ).rejects.toThrow();
    // Forward-stamped 1s past the 60s clock tolerance: an attacker who
    // obtains one proof must not be able to hold it for a future window.
    await expect(
      verifyJwtWithEmbeddedJwk(await sign(now + 61, now + 121), options),
    ).rejects.toThrow(/iat is too far in the future/);
    // Exactly at the tolerance boundary: still accepted.
    await expect(
      verifyJwtWithEmbeddedJwk(await sign(now + 60, now + 120), options),
    ).resolves.toBeDefined();
  });
});
