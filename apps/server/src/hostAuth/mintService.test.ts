import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DPOP_JWT_TYP,
  GRANT_JWT_TYP,
  HOST_CONNECT_SCOPE,
  MINT_REQUEST_JWT_TYP,
  SYNARA_DEVICE_ISSUER,
  SYNARA_RELAY_AUDIENCE,
  type ApiJwks,
} from "@synara/contracts";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type GenerateKeyPairResult,
  type JWK,
} from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateAndPersistHostIdentity, type HostIdentity } from "../hostIdentity";
import { verifySessionCredential } from "./credential";
import { HostMintService } from "./mintService";
import { JwtReplayCache } from "./replayCache";

const NOW = 1_800_000_000;
const API_ISSUER = "https://accounts.example.test";
const ENVIRONMENT_ID = "env-test";
const HOST_ID = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";
const USER_ID = "user_1";

type KeyPair = GenerateKeyPairResult & { publicJwk: JWK };

async function keyPair(algorithm: "EdDSA" | "ES256" = "EdDSA"): Promise<KeyPair> {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  return { ...pair, publicJwk: await exportJWK(pair.publicKey) };
}

describe("HostMintService", () => {
  let hostIdentity: HostIdentity;
  let api: KeyPair;
  let wrongApi: KeyPair;
  let device: KeyPair;
  let deviceJkt: string;
  let jwks: ApiJwks;

  beforeEach(async () => {
    hostIdentity = await generateAndPersistHostIdentity(
      path.join(await mkdtemp(path.join(tmpdir(), "synara-mint-")), "host.json"),
    );
    api = await keyPair();
    wrongApi = await keyPair();
    device = await keyPair();
    deviceJkt = await calculateJwkThumbprint(device.publicJwk, "sha256");
    jwks = {
      keys: [
        {
          kty: "OKP",
          crv: "Ed25519",
          x: api.publicJwk.x as string,
          kid: "api-1",
          alg: "EdDSA",
          use: "sig",
        },
      ],
    };
  });

  async function grant(
    options: {
      signingKey?: CryptoKey;
      audience?: string;
      expiresAt?: number;
      issuedAt?: number;
      jti?: string;
      jkt?: string;
      hostId?: string;
      environmentId?: string;
      subject?: string;
      kid?: string;
    } = {},
  ): Promise<string> {
    return new SignJWT({
      hostId: options.hostId ?? HOST_ID,
      environmentId: options.environmentId ?? ENVIRONMENT_ID,
      cnf: { jkt: options.jkt ?? deviceJkt },
      scope: [HOST_CONNECT_SCOPE],
    })
      .setProtectedHeader({ alg: "EdDSA", typ: GRANT_JWT_TYP, kid: options.kid ?? "api-1" })
      .setIssuer(API_ISSUER)
      .setSubject(options.subject ?? USER_ID)
      .setAudience(options.audience ?? SYNARA_RELAY_AUDIENCE)
      .setIssuedAt(options.issuedAt ?? NOW)
      .setExpirationTime(options.expiresAt ?? NOW + 60)
      .setJti(options.jti ?? randomUUID())
      .sign(options.signingKey ?? api.privateKey);
  }

  async function mintRequest(
    grantJwt: string,
    options: {
      signingKey?: CryptoKey;
      subject?: string;
      typ?: string;
      issuedAt?: number;
      expiresAt?: number;
    } = {},
  ): Promise<string> {
    return new SignJWT({ publicKeyJwk: device.publicJwk, grant: grantJwt })
      .setProtectedHeader({
        alg: device.publicJwk.kty === "EC" ? "ES256" : "EdDSA",
        typ: options.typ ?? MINT_REQUEST_JWT_TYP,
      })
      .setIssuer(SYNARA_DEVICE_ISSUER)
      .setSubject(options.subject ?? USER_ID)
      .setAudience(`synara-host:${ENVIRONMENT_ID}`)
      .setIssuedAt(options.issuedAt ?? NOW)
      .setExpirationTime(options.expiresAt ?? NOW + 120)
      .setJti(randomUUID())
      .sign(options.signingKey ?? device.privateKey);
  }

  function service(overrides: Partial<ConstructorParameters<typeof HostMintService>[0]> = {}) {
    return new HostMintService({
      identity: hostIdentity,
      apiIssuer: API_ISSUER,
      environmentId: ENVIRONMENT_ID,
      hostId: HOST_ID,
      keyGeneration: 4,
      // The default fixture is the ORG-MEMBER path: the connecting user is
      // not the link-time owner, so the live authorization call still runs.
      ownerUserId: "owner_1",
      getApiJwks: async () => jwks,
      getAuthorization: async () => ({
        discoverable: true,
        ownerUserId: "owner_1",
        orgId: "org_1",
        revokedDeviceJkts: [],
        ownerInOrg: true,
      }),
      nowSeconds: () => NOW,
      ...overrides,
    });
  }

  it("mints a one-hour host-signed credential bound to the device key", async () => {
    const result = await service().mint(await mintRequest(await grant()));
    expect(result).toMatchObject({ userId: USER_ID, deviceJkt, expiresAtSeconds: NOW + 3600 });
  });

  it.each<[string, () => Promise<string>, RegExp]>([
    [
      "bad signature",
      async () => mintRequest(await grant({ signingKey: wrongApi.privateKey })),
      /signature verification failed/,
    ],
    ["expired", async () => mintRequest(await grant({ expiresAt: NOW - 1 })), /grant/],
    ["wrong audience", async () => mintRequest(await grant({ audience: "wrong" })), /aud/],
    [
      "jkt mismatch",
      async () => mintRequest(await grant({ jkt: "not-the-device" })),
      /not bound to this host, user, and device key/,
    ],
    // A grant minted for a DIFFERENT host must not be redeemable here: the id
    // is a real UUID so it survives schema decode and only the host binding
    // can reject it.
    [
      "another host's grant",
      async () => mintRequest(await grant({ hostId: randomUUID() })),
      /not bound to this host/,
    ],
    // environmentId is a tenancy boundary — it also forms the host issuer —
    // so a staging-scoped grant must not be honoured by a production host.
    [
      "another environment's grant",
      async () => mintRequest(await grant({ environmentId: "env-other" })),
      /not bound to this host/,
    ],
  ])("rejects %s", async (_label, makeRequest, expected) => {
    await expect(service().mint(await makeRequest())).rejects.toThrow(expected);
  });

  it("refuses a mint request that wraps another user's grant", async () => {
    // The device key is the attacker's throughout, so the cnf.jkt check
    // passes; only tying grant.sub to the mint request's sub stops the
    // attacker from having a credential minted under the victim's identity.
    await expect(
      service().mint(
        await mintRequest(await grant({ subject: "victim" }), { subject: "attacker" }),
      ),
    ).rejects.toThrow(/not bound to this host, user, and device key/);
  });

  it.each([
    ["discoverability was turned off", { discoverable: false, ownerInOrg: true }],
    ["the owner left the org", { discoverable: true, ownerInOrg: false }],
  ])("refuses an org member after %s", async (_label, policy) => {
    // Either failure alone must refuse — sessionRegistry.reverify uses the
    // OR form, so an AND here would kill live sessions while still handing
    // out fresh credentials.
    await expect(
      service({
        getAuthorization: async () => ({
          ...policy,
          ownerUserId: "owner_1",
          orgId: "org_1",
          revokedDeviceJkts: [],
        }),
      }).mint(await mintRequest(await grant())),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("refuses a mint request whose protected header claims another typ", async () => {
    // The mint request is the UNAUTHENTICATED front door and publicKeyJwk is
    // read from the unverified payload, so pinning typ/alg is the whole
    // defence against cross-protocol header confusion.
    await expect(
      service().mint(await mintRequest(await grant(), { typ: GRANT_JWT_TYP })),
    ).rejects.toThrow(/protected header is invalid/);
  });

  it("refuses a mint request a device self-issued for an hour", async () => {
    // Hard-coded span, not MINT_REQUEST_MAX_AGE_SECONDS: a stolen device key
    // must not gain an unbounded minting window by the cap being widened.
    await expect(
      service().mint(await mintRequest(await grant(), { expiresAt: NOW + 3_600 })),
    ).rejects.toThrow(/mint request lifetime exceeds/);
  });

  it("refuses an hour-long grant", async () => {
    // Likewise hard-coded against GRANT_MAX_AGE_SECONDS.
    await expect(
      service().mint(await mintRequest(await grant({ expiresAt: NOW + 3_600 }))),
    ).rejects.toThrow(/grant lifetime exceeds/);
  });

  it("does not refetch the API JWKS when a grant fails for a reason other than an unknown kid", async () => {
    // A blanket retry would make any forged grant an unauthenticated trigger
    // for outbound fetches — a DoS amplifier aimed at the account API.
    const refreshApiJwksForUnknownKid = vi.fn(async () => jwks);
    await expect(
      service({ refreshApiJwksForUnknownKid }).mint(
        await mintRequest(await grant({ signingKey: wrongApi.privateKey })),
      ),
    ).rejects.toThrow();
    expect(refreshApiJwksForUnknownKid).not.toHaveBeenCalled();
  });

  it("refetches the API JWKS exactly once when the grant names a rotated kid", async () => {
    const rotated: ApiJwks = {
      keys: [{ ...jwks.keys[0]!, kid: "api-2" }],
    };
    const refreshApiJwksForUnknownKid = vi.fn(async () => rotated);
    const minted = await service({ refreshApiJwksForUnknownKid }).mint(
      await mintRequest(await grant({ kid: "api-2" })),
    );
    expect(minted.userId).toBe(USER_ID);
    expect(refreshApiJwksForUnknownKid).toHaveBeenCalledTimes(1);
  });

  it("rejects a grant whose validity window starts an hour in the future", async () => {
    await expect(
      service().mint(
        await mintRequest(await grant({ issuedAt: NOW + 3_600, expiresAt: NOW + 3_660 })),
      ),
    ).rejects.toThrow(/iat is too far in the future/i);
  });

  it("rejects an absolutely expired grant even when jose observes a slow system clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((NOW - 1_200) * 1_000);
    try {
      await expect(
        service().mint(
          await mintRequest(await grant({ issuedAt: NOW - 660, expiresAt: NOW - 600 })),
        ),
      ).rejects.toThrow(/grant has expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects grant jti replay", async () => {
    const grantJwt = await grant({ jti: "2e670ffc-3092-4c4a-a220-e682bea95b20" });
    const mint = service();
    await mint.mint(await mintRequest(grantJwt));
    await expect(mint.mint(await mintRequest(grantJwt))).rejects.toThrow(/already been used/);
  });

  it("accepts ES256 device keys and verifies credential plus DPoP", async () => {
    device = await keyPair("ES256");
    deviceJkt = await calculateJwkThumbprint(device.publicJwk, "sha256");
    const result = await service().mint(await mintRequest(await grant()));
    const htu = "synara://remote/session";
    const dpop = await new SignJWT({
      htu,
      htm: "CONNECT",
      ath: createHash("sha256").update(result.credential).digest("base64url"),
    })
      .setProtectedHeader({ alg: "ES256", typ: DPOP_JWT_TYP, jwk: device.publicJwk })
      .setIssuedAt(NOW)
      .setJti(randomUUID())
      .sign(device.privateKey);
    await expect(
      verifySessionCredential({
        credential: result.credential,
        dpop,
        identity: hostIdentity,
        environmentId: ENVIRONMENT_ID,
        keyGeneration: 4,
        expectedHtu: htu,
        expectedHtm: "CONNECT",
        replayCache: new JwtReplayCache(),
        nowSeconds: NOW,
      }),
    ).resolves.toEqual({ userId: USER_ID, deviceJkt, expiresAtSeconds: NOW + 3600 });
  });

  it("mints for the link-time owner without consulting the account API", async () => {
    // ADR 0011: the owner's own access must survive an API outage, and a
    // compromised API must not be able to nominate itself as owner. Both
    // follow from deciding the owner path off the link-time record.
    let authorizationCalls = 0;
    const minted = await service({
      ownerUserId: USER_ID,
      getAuthorization: async () => {
        authorizationCalls += 1;
        throw new Error("account API is unreachable");
      },
    }).mint(await mintRequest(await grant()));
    expect(minted.userId).toBe(USER_ID);
    expect(authorizationCalls).toBe(0);
  });

  it("refuses an org member whose device was revoked while its grant was in flight", async () => {
    await expect(
      service({
        getAuthorization: async () => ({
          discoverable: true,
          ownerUserId: "owner_1",
          orgId: "org_1",
          revokedDeviceJkts: [deviceJkt],
          ownerInOrg: true,
        }),
      }).mint(await mintRequest(await grant())),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("still refuses a non-owner when the account API is unreachable", async () => {
    // The org-member path is cloud-governed policy, so it must fail CLOSED
    // rather than inherit the owner's offline tolerance.
    await expect(
      service({
        ownerUserId: "someone_else",
        getAuthorization: async () => {
          throw new Error("account API is unreachable");
        },
      }).mint(await mintRequest(await grant())),
    ).rejects.toThrow();
  });
});
