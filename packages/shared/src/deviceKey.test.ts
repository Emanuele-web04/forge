import {
  DEVICE_REGISTER_JWT_TYP,
  DEVICE_REGISTER_MAX_AGE_SECONDS,
  DPOP_JWT_TYP,
  DeviceRegisterClaims,
  DpopProofClaims,
  DpopProofWithCredentialClaims,
  MINT_REQUEST_JWT_TYP,
  MINT_REQUEST_MAX_AGE_SECONDS,
  MintRequestClaims,
  SYNARA_DEVICE_ISSUER,
} from "@synara/contracts";
import { Schema } from "effect";
import {
  base64url,
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  credentialHash,
  deviceThumbprint,
  dpopHttpUri,
  exportPublicJwk,
  generateDeviceKey,
  hostAudience,
  signDeviceRegistration,
  signDpopProof,
  signMintRequest,
} from "./deviceKey";

const API_ISSUER = "https://api.synara.example";
const USER_ID = "user_01J8ZQ";
const ENVIRONMENT_ID = "env-1";

let key: CryptoKeyPair;
let publicJwk: Awaited<ReturnType<typeof exportPublicJwk>>;

beforeAll(async () => {
  key = await generateDeviceKey();
  publicJwk = await exportPublicJwk(key);
});

/** Verifies the signature against the device's own public key. */
async function verifyWithDeviceKey(token: string) {
  return jwtVerify(token, await importJWK(publicJwk as JWK, "ES256"), { algorithms: ["ES256"] });
}

describe("generateDeviceKey", () => {
  it("mints a non-extractable ES256 signing key", async () => {
    expect(key.privateKey.extractable).toBe(false);
    expect(key.privateKey.usages).toContain("sign");
    expect(key.privateKey.algorithm).toMatchObject({ name: "ECDSA" });
    await expect(globalThis.crypto.subtle.exportKey("jwk", key.privateKey)).rejects.toThrow();
  });

  it("exports only the RFC 7638 required members of the public key", async () => {
    expect(Object.keys(publicJwk).toSorted()).toEqual(["crv", "kty", "x", "y"]);
    expect(publicJwk.kty).toBe("EC");
    expect(publicJwk.crv).toBe("P-256");
  });
});

describe("deviceThumbprint", () => {
  it("matches jose's calculateJwkThumbprint — the same derivation the API uses", async () => {
    await expect(deviceThumbprint(publicJwk)).resolves.toBe(
      await calculateJwkThumbprint(publicJwk as JWK, "sha256"),
    );
  });

  it("ignores member order, so a re-serialized JWK keeps its identity", async () => {
    const reordered = { y: publicJwk.y, x: publicJwk.x, crv: publicJwk.crv, kty: publicJwk.kty };
    await expect(deviceThumbprint(reordered)).resolves.toBe(await deviceThumbprint(publicJwk));
  });

  it("thumbprints an Ed25519 device key too (Slice A accepts both)", async () => {
    const jwk = {
      kty: "OKP",
      crv: "Ed25519",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    } as const;
    await expect(deviceThumbprint(jwk)).resolves.toBe(
      await calculateJwkThumbprint(jwk as JWK, "sha256"),
    );
  });
});

describe("signDeviceRegistration", () => {
  it("decodes against the committed DeviceRegisterClaims schema", async () => {
    const proof = await signDeviceRegistration({
      key,
      publicJwk,
      userId: USER_ID,
      displayName: "Dylan's MacBook",
      platform: "darwin",
      audience: API_ISSUER,
    });

    const claims = Schema.decodeUnknownSync(DeviceRegisterClaims)(decodeJwt(proof));
    expect(claims.iss).toBe(SYNARA_DEVICE_ISSUER);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.aud).toBe(API_ISSUER);
    expect(claims.publicKeyJwk).toEqual(publicJwk);
    expect(claims.displayName).toBe("Dylan's MacBook");
    expect(claims.platform).toBe("darwin");
  });

  it("pins the typ and algorithm the API's verifier exact-matches", async () => {
    const proof = await signDeviceRegistration({
      key,
      publicJwk,
      userId: USER_ID,
      displayName: "Mac",
      platform: "darwin",
      audience: API_ISSUER,
    });
    expect(decodeProtectedHeader(proof)).toMatchObject({
      typ: DEVICE_REGISTER_JWT_TYP,
      alg: "ES256",
    });
    await expect(verifyWithDeviceKey(proof)).resolves.toBeDefined();
  });

  it("stays inside DEVICE_REGISTER_MAX_AGE_SECONDS, clamping an over-long request", async () => {
    const now = 1_760_000_000;
    const proof = await signDeviceRegistration({
      key,
      publicJwk,
      userId: USER_ID,
      displayName: "Mac",
      platform: "darwin",
      audience: API_ISSUER,
      nowSeconds: now,
      lifetimeSeconds: DEVICE_REGISTER_MAX_AGE_SECONDS * 10,
    });
    const claims = Schema.decodeUnknownSync(DeviceRegisterClaims)(decodeJwt(proof));
    expect(claims.iat).toBe(now);
    expect(claims.exp - claims.iat).toBe(DEVICE_REGISTER_MAX_AGE_SECONDS);
  });

  it("gives every proof a distinct jti", async () => {
    const mint = () =>
      signDeviceRegistration({
        key,
        publicJwk,
        userId: USER_ID,
        displayName: "Mac",
        platform: "darwin",
        audience: API_ISSUER,
      });
    const [first, second] = await Promise.all([mint(), mint()]);
    expect(decodeJwt(first).jti).not.toBe(decodeJwt(second).jti);
  });
});

describe("signDpopProof", () => {
  const CREDENTIAL = "eyJhbGciOiJFZERTQSJ9.session-credential.signature";

  it("decodes against DpopProofClaims with the correct ath for the credential", async () => {
    const proof = await signDpopProof({
      key,
      publicJwk,
      method: "post",
      url: "https://host.example/v1/mint?retry=1#frag",
      accessToken: CREDENTIAL,
    });

    const claims = Schema.decodeUnknownSync(DpopProofClaims)(decodeJwt(proof));
    expect(claims.htm).toBe("POST");
    expect(claims.htu).toBe("https://host.example/v1/mint");
    expect(claims.ath).toBe(
      base64url.encode(
        new Uint8Array(
          await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(CREDENTIAL)),
        ),
      ),
    );
    expect(claims.iat).toBeGreaterThan(0);
  });

  it("carries typ dpop+jwt and the public jwk header that binds it to cnf.jkt", async () => {
    const proof = await signDpopProof({
      key,
      publicJwk,
      method: "GET",
      url: "wss://relay.example/client/session",
      accessToken: CREDENTIAL,
    });
    const header = decodeProtectedHeader(proof);
    expect(header.typ).toBe(DPOP_JWT_TYP);
    expect(header.alg).toBe("ES256");
    expect(header.jwk).toEqual(publicJwk);
    await expect(deviceThumbprint(publicJwk)).resolves.toBe(
      await calculateJwkThumbprint(header.jwk as JWK, "sha256"),
    );
    await expect(verifyWithDeviceKey(proof)).resolves.toBeDefined();
  });

  it("omits ath when no credential exists yet (the mint handshake)", async () => {
    // The mint handshake is the one request that OBTAINS a credential, so
    // there is nothing to hash. The base schema tolerates that; the
    // credential-bearing schema does not, which is what forces verifiers of
    // authenticated requests to demand the binding.
    const proof = await signDpopProof({
      key,
      publicJwk,
      method: "POST",
      url: "https://host.example/v1/mint",
    });
    const payload = decodeJwt(proof);
    expect(payload.ath).toBeUndefined();
    expect(Schema.decodeUnknownSync(DpopProofClaims)(payload).ath).toBeUndefined();
    expect(() => Schema.decodeUnknownSync(DpopProofWithCredentialClaims)(payload)).toThrow();
  });

  it("binds ath on a credential-bearing proof so the strict schema accepts it", async () => {
    const proof = await signDpopProof({
      key,
      publicJwk,
      method: "GET",
      url: "wss://relay.example/client/session",
      accessToken: CREDENTIAL,
    });
    const decoded = Schema.decodeUnknownSync(DpopProofWithCredentialClaims)(decodeJwt(proof));
    expect(decoded.ath).toBe(await credentialHash(CREDENTIAL));
  });

  it("strips query and fragment from htu but keeps the wss scheme and port", () => {
    expect(dpopHttpUri("wss://relay.example:8443/client/session?grant=abc#x")).toBe(
      "wss://relay.example:8443/client/session",
    );
  });

  it("hashes the credential, not a truncation of it", async () => {
    expect(await credentialHash(CREDENTIAL)).not.toBe(await credentialHash(`${CREDENTIAL}x`));
  });
});

describe("signMintRequest", () => {
  const GRANT = "eyJhbGciOiJFZERTQSJ9.grant-payload.grant-signature";

  it("decodes against MintRequestClaims with the grant echoed whole", async () => {
    const request = await signMintRequest({
      key,
      publicJwk,
      userId: USER_ID,
      grant: GRANT,
      environmentId: ENVIRONMENT_ID,
    });

    const claims = Schema.decodeUnknownSync(MintRequestClaims)(decodeJwt(request));
    expect(claims.iss).toBe(SYNARA_DEVICE_ISSUER);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.aud).toBe(hostAudience(ENVIRONMENT_ID));
    expect(claims.aud).toBe("synara-host:env-1");
    expect(claims.grant).toBe(GRANT);
    expect(claims.publicKeyJwk).toEqual(publicJwk);
  });

  it("pins typ and stays inside MINT_REQUEST_MAX_AGE_SECONDS", async () => {
    const now = 1_760_000_000;
    const request = await signMintRequest({
      key,
      publicJwk,
      userId: USER_ID,
      grant: GRANT,
      environmentId: ENVIRONMENT_ID,
      nowSeconds: now,
      lifetimeSeconds: MINT_REQUEST_MAX_AGE_SECONDS + 600,
    });
    expect(decodeProtectedHeader(request)).toMatchObject({
      typ: MINT_REQUEST_JWT_TYP,
      alg: "ES256",
    });
    const claims = Schema.decodeUnknownSync(MintRequestClaims)(decodeJwt(request));
    expect(claims.exp - claims.iat).toBe(MINT_REQUEST_MAX_AGE_SECONDS);
    // The fixed `nowSeconds` above is in the past, so pin the verifier's clock
    // to the same instant rather than asserting against wall time.
    await expect(
      jwtVerify(request, await importJWK(publicJwk as JWK, "ES256"), {
        algorithms: ["ES256"],
        currentDate: new Date(now * 1000),
      }),
    ).resolves.toBeDefined();
  });

  it("binds the request to the host it is addressed to", async () => {
    const request = await signMintRequest({
      key,
      publicJwk,
      userId: USER_ID,
      grant: GRANT,
      environmentId: "env-other",
    });
    await expect(
      jwtVerify(request, await importJWK(publicJwk as JWK, "ES256"), {
        audience: hostAudience(ENVIRONMENT_ID),
        algorithms: ["ES256"],
      }),
    ).rejects.toThrow();
  });
});
