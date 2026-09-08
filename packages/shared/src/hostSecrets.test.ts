import { describe, expect, it } from "vitest";

import {
  decodeBase64Url,
  encodeBase64Url,
  generatePairingKeyPair,
  generateSyncKey,
  HOST_SECRET_INITIAL_VERSION,
  HOST_SECRET_IV_BYTES,
  HostSecretsError,
  openHostSecret,
  PAIRING_VERIFICATION_CODE_LENGTH,
  pairingVerificationCode,
  rotateHostSecrets,
  sealHostSecret,
  unwrapSyncKey,
  wrapSyncKey,
  type HostSecretEntry,
  type HostSecretEnvelope,
} from "./hostSecrets";

const OWNER = "11111111-1111-4111-8111-111111111111";
const HOST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The shape Slice E actually syncs: SSH destination, launcher, key policy. */
const SSH_HOST_SECRET = {
  ssh: {
    destination: "deploy@build-01.internal:2222",
    identityFile: "~/.ssh/id_ed25519_synara",
    proxyJump: "bastion.internal",
  },
  launcher: {
    command: "/opt/synara/bin/synara-server",
    args: ["--port", "0"],
    env: { SYNARA_HOME: "/var/lib/synara" },
  },
  keyVerification: {
    policy: "pinned" as const,
    pinnedHostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterial0000000000"],
  },
};

/** Flips one bit in a base64url field so the AEAD tag must reject it. */
function tamper(value: string, index: number): string {
  const bytes = decodeBase64Url(value);
  const target = bytes[index];
  if (target === undefined) throw new Error(`tamper index ${index} out of range`);
  bytes[index] = target ^ 0b0000_0001;
  return encodeBase64Url(bytes);
}

/**
 * The AAD layout, spelled out here rather than imported. A test that rebuilt
 * the additional data by calling the module's own encoder could not notice the
 * domain string or the field order changing — and both are wire format that
 * ciphertext already in the account service's columns depends on.
 */
const SEAL_AAD_DOMAIN = "synara.hostSecret.aad.v1";

function hostSecretAad(
  hostId: string,
  ownerUserId: string,
  version: number,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([SEAL_AAD_DOMAIN, hostId, ownerUserId, version]),
  ) as Uint8Array<ArrayBuffer>;
}

/** Imports raw bytes as a Sync Key, so a checked-in key can be replayed. */
async function importSyncKey(rawBase64Url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    decodeBase64Url(rawBase64Url),
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Re-spells a 32-byte coordinate without changing it. 43 base64url characters
 * carry 258 bits for 256 bits of data, so the final character's low two bits
 * are ignored on decode: flipping them yields a genuinely different string for
 * byte-identical key material. This is the case normalization exists for.
 */
function respellCoordinate(coordinate: string): string {
  const last = coordinate.at(-1);
  if (last === undefined) throw new Error("empty coordinate");
  const index = BASE64URL_ALPHABET.indexOf(last);
  if (index < 0) throw new Error("coordinate is not base64url");
  const flipped = BASE64URL_ALPHABET[index ^ 0b11];
  if (flipped === undefined) throw new Error("unreachable");
  return coordinate.slice(0, -1) + flipped;
}

/** p = 2^256 - 2^224 + 2^192 + 2^96 - 1, the P-256 field prime. */
const P256_FIELD_PRIME = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;

/**
 * y -> p - y: the negation of a curve point, which shares the original's x.
 * An attacker who can substitute -P for P is the reason the verification code
 * has to commit to both coordinates.
 */
function negateCoordinate(coordinate: string): string {
  const source = decodeBase64Url(coordinate);
  let value = 0n;
  for (const byte of source) {
    value = (value << 8n) | BigInt(byte);
  }
  let rest = P256_FIELD_PRIME - value;
  const bytes = new Uint8Array(32);
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return encodeBase64Url(bytes);
}

async function sealForHostA(syncKey: CryptoKey, secret: unknown = SSH_HOST_SECRET) {
  return sealHostSecret({
    syncKey,
    hostId: HOST_A,
    ownerUserId: OWNER,
    version: HOST_SECRET_INITIAL_VERSION,
    secret,
  });
}

/** Every rejection must be our own uniform error, never a raw DOMException. */
async function expectOpenRejection(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(HostSecretsError);
  await expect(promise).rejects.toMatchObject({ reason: "open-failed" });
}

describe("base64url codec", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      const encoded = encodeBase64Url(bytes);
      expect(encoded).not.toContain("=");
      expect(Array.from(decodeBase64Url(encoded))).toEqual(Array.from(bytes));
    }
  });

  it("refuses inputs that are not base64url rather than guessing at the bytes", () => {
    // Two devices that disagree about the bytes behind one string would produce
    // ciphertext neither can open, so the decoder must never improvise.
    expect(() => decodeBase64Url("abc+")).toThrow(HostSecretsError);
    expect(() => decodeBase64Url("ab/d")).toThrow(HostSecretsError);
    expect(() => decodeBase64Url("abcd=")).toThrow(HostSecretsError);
    expect(() => decodeBase64Url("abcde")).toThrow(HostSecretsError);
  });
});

describe("sealHostSecret / openHostSecret", () => {
  it("round-trips a realistic host secret", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    expect(envelope.version).toBe(HOST_SECRET_INITIAL_VERSION);
    expect(decodeBase64Url(envelope.iv)).toHaveLength(HOST_SECRET_IV_BYTES);

    const opened = await openHostSecret({
      syncKey,
      hostId: HOST_A,
      ownerUserId: OWNER,
      version: HOST_SECRET_INITIAL_VERSION,
      envelope,
    });
    expect(opened).toEqual(SSH_HOST_SECRET);
  });

  it("produces an envelope that survives JSON storage unchanged", async () => {
    // The account service stores this as opaque columns and hands it back; a
    // field that did not survive the trip would break sync silently.
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);
    const stored: HostSecretEnvelope = JSON.parse(JSON.stringify(envelope));

    await expect(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope: stored,
      }),
    ).resolves.toEqual(SSH_HOST_SECRET);
  });

  it("never reuses an IV across repeated seals of identical plaintext", async () => {
    // AES-GCM loses confidentiality outright on IV reuse, and host config is
    // rewritten with byte-identical contents often.
    const syncKey = await generateSyncKey();
    const seals = await Promise.all(Array.from({ length: 512 }, () => sealForHostA(syncKey)));

    // Checked before uniqueness because it is the deterministic half. Distinct
    // IVs are only evidence of entropy somewhere; a nonce with two random bytes
    // and ten fixed ones still usually draws 512 distinct values while carrying
    // 16 bits instead of 96. Requiring every position to move cannot be passed
    // by any partially-fixed nonce, at any sample size.
    const ivs = seals.map((seal) => decodeBase64Url(seal.iv));
    for (const iv of ivs) {
      expect(iv).toHaveLength(12);
    }
    for (let position = 0; position < 12; position += 1) {
      const distinct = new Set(ivs.map((iv) => iv[position]));
      // 512 uniform draws collapsing to one value has probability 256^-511.
      expect(distinct.size, `IV byte ${position} never varied`).toBeGreaterThan(1);
    }

    expect(new Set(seals.map((seal) => seal.iv)).size).toBe(seals.length);
    expect(new Set(seals.map((seal) => seal.ciphertext)).size).toBe(seals.length);
  });

  it("rejects identifiers and versions it cannot bind", async () => {
    const syncKey = await generateSyncKey();
    await expect(
      sealHostSecret({ syncKey, hostId: "", ownerUserId: OWNER, version: 1, secret: {} }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      sealHostSecret({ syncKey, hostId: HOST_A, ownerUserId: "", version: 1, secret: {} }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      sealHostSecret({ syncKey, hostId: HOST_A, ownerUserId: OWNER, version: -1, secret: {} }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      sealHostSecret({ syncKey, hostId: HOST_A, ownerUserId: OWNER, version: 1.5, secret: {} }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
  });
});

describe("AAD binding", () => {
  it("refuses a ciphertext lifted onto another host's row", async () => {
    // The security property: the account service cannot inspect rows, so
    // nothing but the AAD stops attacker-chosen SSH config from being replayed
    // into a different host.
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_B,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope,
      }),
    );
  });

  it("refuses a ciphertext replayed under a different owner", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: "22222222-2222-4222-8222-222222222222",
        version: HOST_SECRET_INITIAL_VERSION,
        envelope,
      }),
    );
  });

  it("refuses a ciphertext replayed at a different version", async () => {
    // Without this, a rolled-back row would silently revive superseded config.
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION + 1,
        envelope: { ...envelope, version: HOST_SECRET_INITIAL_VERSION + 1 },
      }),
    );
  });

  it("refuses an envelope whose version field was edited under a correct AAD", async () => {
    // Storage-level tampering with the version column alone must not open.
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope: { ...envelope, version: HOST_SECRET_INITIAL_VERSION + 7 },
      }),
    );
  });

  it("builds the AAD from the caller's version, never the envelope's claim", async () => {
    // The half the AEAD cannot cover. `envelope.version` here agrees with the
    // ciphertext, so an implementation that fed the envelope's claim into the
    // AAD would decrypt this happily — the disagreement with the caller's
    // expected version is the only thing wrong, and only the guard sees it.
    const syncKey = await generateSyncKey();
    const envelope = await sealHostSecret({
      syncKey,
      hostId: HOST_A,
      ownerUserId: OWNER,
      version: 3,
      secret: SSH_HOST_SECRET,
    });

    // Control: at the version the caller actually did compare-and-swap on, it opens.
    await expect(
      openHostSecret({ syncKey, hostId: HOST_A, ownerUserId: OWNER, version: 3, envelope }),
    ).resolves.toEqual(SSH_HOST_SECRET);

    await expectOpenRejection(
      openHostSecret({ syncKey, hostId: HOST_A, ownerUserId: OWNER, version: 9, envelope }),
    );
  });

  it("refuses a mismatch the AAD alone would also catch, so the guard cannot be dropped", async () => {
    // Mirror of the above: here the ciphertext matches the caller's version and
    // the envelope's column is the lie. Dropping the guard while still binding
    // the caller's version would open this.
    const syncKey = await generateSyncKey();
    const envelope = await sealHostSecret({
      syncKey,
      hostId: HOST_A,
      ownerUserId: OWNER,
      version: 9,
      secret: SSH_HOST_SECRET,
    });

    await expect(
      openHostSecret({ syncKey, hostId: HOST_A, ownerUserId: OWNER, version: 9, envelope }),
    ).resolves.toEqual(SSH_HOST_SECRET);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: 9,
        envelope: { ...envelope, version: 3 },
      }),
    );
  });

  it("does not let a crafted hostId forge another pair's binding", async () => {
    // A delimiter-joined AAD would let ("a", "b|c") collide with ("a|b", "c").
    const syncKey = await generateSyncKey();
    const envelope = await sealHostSecret({
      syncKey,
      hostId: "host",
      ownerUserId: `owner","extra`,
      version: 1,
      secret: SSH_HOST_SECRET,
    });

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: `host","owner`,
        ownerUserId: "extra",
        version: 1,
        envelope,
      }),
    );
  });

  it("refuses the right envelope under the wrong sync key", async () => {
    const envelope = await sealForHostA(await generateSyncKey());
    await expectOpenRejection(
      openHostSecret({
        syncKey: await generateSyncKey(),
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope,
      }),
    );
  });
});

describe("tampering", () => {
  it("fails authentication when a ciphertext byte is flipped", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    for (const index of [0, 5, decodeBase64Url(envelope.ciphertext).length - 1]) {
      await expectOpenRejection(
        openHostSecret({
          syncKey,
          hostId: HOST_A,
          ownerUserId: OWNER,
          version: HOST_SECRET_INITIAL_VERSION,
          envelope: { ...envelope, ciphertext: tamper(envelope.ciphertext, index) },
        }),
      );
    }
  });

  it("fails authentication when an IV byte is flipped", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope: { ...envelope, iv: tamper(envelope.iv, 0) },
      }),
    );
  });

  it("rejects an IV of the wrong length rather than letting the platform decide", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope: { ...envelope, iv: encodeBase64Url(new Uint8Array(16)) },
      }),
    );
  });

  it("rejects a 16-byte IV even when the ciphertext genuinely authenticates under it", async () => {
    // WebCrypto happily accepts a 16-byte AES-GCM nonce, so the previous test's
    // rejection comes from the tag, not the length check. This envelope is
    // correctly sealed under a 16-byte IV with the exact AAD `openHostSecret`
    // will rebuild: nothing but the explicit length guard can refuse it. A
    // nonce width that varies by writer is how two devices end up reusing one.
    const syncKey = await generateSyncKey();
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: hostSecretAad(HOST_A, OWNER, HOST_SECRET_INITIAL_VERSION),
        tagLength: 128,
      },
      syncKey,
      new TextEncoder().encode(JSON.stringify(SSH_HOST_SECRET)),
    );

    // Proof the vector is well-formed: WebCrypto itself opens it.
    await expect(
      crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: hostSecretAad(HOST_A, OWNER, HOST_SECRET_INITIAL_VERSION),
          tagLength: 128,
        },
        syncKey,
        ciphertext,
      ),
    ).resolves.toBeDefined();

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope: {
          ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
          iv: encodeBase64Url(iv),
          version: HOST_SECRET_INITIAL_VERSION,
        },
      }),
    );
  });

  it("rejects a truncated ciphertext", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);
    const bytes = decodeBase64Url(envelope.ciphertext);

    await expectOpenRejection(
      openHostSecret({
        syncKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope: { ...envelope, ciphertext: encodeBase64Url(bytes.slice(0, bytes.length - 1)) },
      }),
    );
  });
});

describe("wire format", () => {
  // Everything in this block is a number or string the account service's stored
  // bytes already depend on. Asserting them against the module's own constants
  // would compare the product to itself, so every expectation here is a
  // literal: changing one of these is a migration, not a refactor.

  it("pins the envelope's byte widths as literals", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    expect(HOST_SECRET_IV_BYTES).toBe(12);
    expect(decodeBase64Url(envelope.iv)).toHaveLength(12);
    expect(PAIRING_VERIFICATION_CODE_LENGTH).toBe(6);
    // Plaintext plus exactly a 128-bit tag. A shorter tag would still round-trip
    // in-process while quietly weakening the AEAD and orphaning stored rows.
    expect(decodeBase64Url(envelope.ciphertext)).toHaveLength(
      JSON.stringify(SSH_HOST_SECRET).length + 16,
    );
  });

  it("opens a host secret sealed by an earlier build of this module", async () => {
    // Frozen vector. The AAD domain string and its field layout, the IV width,
    // and the tag length are all baked into these bytes; if any of them drifts,
    // every host secret in the account service's bytea columns becomes
    // permanently unopenable, with no error until a user opens one.
    const syncKey = await importSyncKey("YfnnsYRL4gx8Sf55vkFon06TfxZiec2Vec_1EU4RiEE");

    await expect(
      openHostSecret({
        syncKey,
        hostId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ownerUserId: "11111111-1111-4111-8111-111111111111",
        version: 1,
        envelope: {
          ciphertext:
            "5_ro5fyz9UKqUrafkM-FBAJs9IPYTf7ktquYqa8283SB2LPXXrwBkykhKyFgmVsT6qi31xb0119frr98jnmOjfNLfR-PYXZlHSGkX4QDzxGvY7QHbtxAuENxKHxV4x7M5bUCOW1Z-MBqHzc2M6JmyQ3VyS1oBi1OUFYxliVK7ahFlctM5Wjbt2Xf7xcQ_0sHjTg7XzpyVsGI-dGHRZ98y8p77j80KPyF3pk3L0LDHnWjzO-REJEz4m7W7L8-O-pbnkZE1G1a3fHTWEZW6tysgLvGgb--n1lwzRfcdy6wiMqgiHY7MYP2gMohLG9f-jX7ESMhKp7uywVLhibui5V9e1mn-D5YZPL_S0qhjIQikOX0L7YCxAJD93Db8AtUQli4RNRvi1f7fEW61JuJHPZlKLyGRNjmxTfMlqZv501oZpSkYvVQNCkg-27xUmXV9PTeygjshR-eplRytImEuvYEC651hc7extIS2SqFh2hx7X5Q31JBoKLD5R1blLcjdv5eKtE",
          iv: "6kNCE-NYRVXRppaS",
          version: 1,
        },
      }),
    ).resolves.toEqual(SSH_HOST_SECRET);
  });

  it("derives the same verification code an earlier build showed the user", async () => {
    // Frozen vector over the pairing-code domain separator and the transcript
    // layout. A drift here does not fail loudly — it shows two honest devices
    // different codes, and the user is told to treat that as an attack.
    await expect(
      pairingVerificationCode({
        senderPublicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "VOOEi6C7xQvXl-eEMEEhE1TqzFdwAmQBG4vomSF5pBo",
          y: "h2h26MkWj79W3dWdXsIXX6-dmArujOvvv5ncTmgoUkg",
        },
        recipientPublicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "XkV4AX4m570E3XFDIoygc7Oj6cllA9cRufIrjGSyLLM",
          y: "jAn4bvfPkYck14Lob8yHi9CNlk4iyHDOHlvOUXCWsTs",
        },
      }),
    ).resolves.toBe("BDZP79");
  });

  it("unwraps a sync key wrapped by an earlier build of this module", async () => {
    // Frozen vector over the pairing KDF domain separator, its salt, and the
    // transcript layout. Pairing blobs are short-lived, but a device mid-pairing
    // across an upgrade would fail with nothing to point at.
    const recipientPrivateKey = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        d: "xVOLb_4-mAz0-x8nNO4qXsmJAZ22_TVasIx6IcrqghI",
        x: "mcG5atO191PJ9PeoMxCmOHNequFwKpjEBngsItQPKCo",
        y: "X8jYM2TDxAKhvPtZZgpDXxAsgSdOBpUREBMQFTI0yns",
      },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );

    const received = await unwrapSyncKey({
      wrapped: {
        ephemeralPublicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "yr3auFIGzKwrULQwOJhPv0Ibdl980sFW18ptxv0y0xU",
          y: "ltHmwiwcO9JQ2hjGApllM3-w2VSi81vVofUo-7UqUxQ",
        },
        recipientPublicJwk: {
          kty: "EC",
          crv: "P-256",
          x: "mcG5atO191PJ9PeoMxCmOHNequFwKpjEBngsItQPKCo",
          y: "X8jYM2TDxAKhvPtZZgpDXxAsgSdOBpUREBMQFTI0yns",
        },
        wrapped: "3oYNOh1ODlBrHGvp8vpSbwjBriL84HEnxp4anNSMtEqiv_2gxJI4Bw",
      },
      recipientPrivateKey,
    });

    // It really is the Sync Key from the envelope vector above.
    expect(encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", received)))).toBe(
      "YfnnsYRL4gx8Sf55vkFon06TfxZiec2Vec_1EU4RiEE",
    );
  });
});

describe("pairing key wrap", () => {
  it("hands the sync key to a new device and keeps it usable end to end", async () => {
    const syncKey = await generateSyncKey();
    const envelope = await sealForHostA(syncKey);

    const newDevice = await generatePairingKeyPair();
    const wrapped = await wrapSyncKey({ syncKey, recipientPublicJwk: newDevice.publicJwk });
    const received = await unwrapSyncKey({
      wrapped,
      recipientPrivateKey: newDevice.privateKey,
    });

    // The real acceptance test: the second device reads config it never saw.
    await expect(
      openHostSecret({
        syncKey: received,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope,
      }),
    ).resolves.toEqual(SSH_HOST_SECRET);
  });

  it("produces a key the receiving device can wrap onward to a third device", async () => {
    // Pairing chains: device 2 must be able to enroll device 3.
    const syncKey = await generateSyncKey();
    const second = await generatePairingKeyPair();
    const third = await generatePairingKeyPair();

    const toSecond = await unwrapSyncKey({
      wrapped: await wrapSyncKey({ syncKey, recipientPublicJwk: second.publicJwk }),
      recipientPrivateKey: second.privateKey,
    });
    const toThird = await unwrapSyncKey({
      wrapped: await wrapSyncKey({ syncKey: toSecond, recipientPublicJwk: third.publicJwk }),
      recipientPrivateKey: third.privateKey,
    });

    const envelope = await sealForHostA(syncKey);
    await expect(
      openHostSecret({
        syncKey: toThird,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope,
      }),
    ).resolves.toEqual(SSH_HOST_SECRET);
  });

  it("refuses to unwrap with the wrong private key", async () => {
    const syncKey = await generateSyncKey();
    const intended = await generatePairingKeyPair();
    const eavesdropper = await generatePairingKeyPair();

    const wrapped = await wrapSyncKey({ syncKey, recipientPublicJwk: intended.publicJwk });

    await expect(
      unwrapSyncKey({ wrapped, recipientPrivateKey: eavesdropper.privateKey }),
    ).rejects.toMatchObject({ reason: "unwrap-failed" });
  });

  it("refuses a wrap re-pointed at a different recipient", async () => {
    // The KDF transcript binds both public keys, so a relayed blob cannot be
    // re-labelled for another device even by the service carrying it.
    const syncKey = await generateSyncKey();
    const intended = await generatePairingKeyPair();
    const other = await generatePairingKeyPair();

    const wrapped = await wrapSyncKey({ syncKey, recipientPublicJwk: intended.publicJwk });

    await expect(
      unwrapSyncKey({
        wrapped: { ...wrapped, recipientPublicJwk: other.publicJwk },
        recipientPrivateKey: intended.privateKey,
      }),
    ).rejects.toMatchObject({ reason: "unwrap-failed" });
  });

  it("refuses a wrap whose ephemeral key was swapped", async () => {
    const syncKey = await generateSyncKey();
    const recipient = await generatePairingKeyPair();
    const attacker = await generatePairingKeyPair();

    const wrapped = await wrapSyncKey({ syncKey, recipientPublicJwk: recipient.publicJwk });

    await expect(
      unwrapSyncKey({
        wrapped: { ...wrapped, ephemeralPublicJwk: attacker.publicJwk },
        recipientPrivateKey: recipient.privateKey,
      }),
    ).rejects.toMatchObject({ reason: "unwrap-failed" });
  });

  it("refuses a wrap whose bytes were tampered with", async () => {
    const syncKey = await generateSyncKey();
    const recipient = await generatePairingKeyPair();
    const wrapped = await wrapSyncKey({ syncKey, recipientPublicJwk: recipient.publicJwk });

    await expect(
      unwrapSyncKey({
        wrapped: { ...wrapped, wrapped: tamper(wrapped.wrapped, 3) },
        recipientPrivateKey: recipient.privateKey,
      }),
    ).rejects.toMatchObject({ reason: "unwrap-failed" });
  });

  it("uses a fresh ephemeral key per wrap", async () => {
    const syncKey = await generateSyncKey();
    const recipient = await generatePairingKeyPair();

    const first = await wrapSyncKey({ syncKey, recipientPublicJwk: recipient.publicJwk });
    const second = await wrapSyncKey({ syncKey, recipientPublicJwk: recipient.publicJwk });

    expect(first.ephemeralPublicJwk.x).not.toBe(second.ephemeralPublicJwk.x);
    expect(first.wrapped).not.toBe(second.wrapped);
  });

  it("rejects a public JWK that is not an EC P-256 point", async () => {
    const syncKey = await generateSyncKey();
    const recipient = await generatePairingKeyPair();

    await expect(
      wrapSyncKey({
        syncKey,
        recipientPublicJwk: { ...recipient.publicJwk, crv: "P-384" } as never,
      }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
    await expect(
      wrapSyncKey({
        syncKey,
        recipientPublicJwk: { ...recipient.publicJwk, x: encodeBase64Url(new Uint8Array(31)) },
      }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
  });
});

describe("pairingVerificationCode", () => {
  it("gives both peers the same code regardless of who calls itself the sender", async () => {
    // Documented contract: order does not matter. A check that reported a
    // mismatch on role confusion is a check users learn to click through.
    const alice = await generatePairingKeyPair();
    const bob = await generatePairingKeyPair();

    const fromAlice = await pairingVerificationCode({
      senderPublicJwk: alice.publicJwk,
      recipientPublicJwk: bob.publicJwk,
    });
    const fromBob = await pairingVerificationCode({
      senderPublicJwk: bob.publicJwk,
      recipientPublicJwk: alice.publicJwk,
    });

    expect(fromAlice).toBe(fromBob);
  });

  it("is deterministic and shaped for a human to read aloud", async () => {
    const alice = await generatePairingKeyPair();
    const bob = await generatePairingKeyPair();
    const args = { senderPublicJwk: alice.publicJwk, recipientPublicJwk: bob.publicJwk };

    const code = await pairingVerificationCode(args);
    expect(code).toHaveLength(PAIRING_VERIFICATION_CODE_LENGTH);
    // No 0/1/I/O: a code read over the phone must not be ambiguous.
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    await expect(pairingVerificationCode(args)).resolves.toBe(code);
  });

  it("changes when either peer is substituted — this is what makes a MITM visible", async () => {
    const alice = await generatePairingKeyPair();
    const bob = await generatePairingKeyPair();
    const attacker = await generatePairingKeyPair();

    const honest = await pairingVerificationCode({
      senderPublicJwk: alice.publicJwk,
      recipientPublicJwk: bob.publicJwk,
    });
    // What Alice would see if the attacker's key reached her instead of Bob's.
    const aliceSideOfMitm = await pairingVerificationCode({
      senderPublicJwk: alice.publicJwk,
      recipientPublicJwk: attacker.publicJwk,
    });
    // What Bob would see on his side of the same attack.
    const bobSideOfMitm = await pairingVerificationCode({
      senderPublicJwk: attacker.publicJwk,
      recipientPublicJwk: bob.publicJwk,
    });

    expect(aliceSideOfMitm).not.toBe(honest);
    expect(bobSideOfMitm).not.toBe(honest);
    // The two halves of the attack disagree with each other, which is exactly
    // what the user is asked to notice.
    expect(aliceSideOfMitm).not.toBe(bobSideOfMitm);
  });

  it("spreads codes across the alphabet rather than collapsing onto a few", async () => {
    // A derivation that discarded entropy would still pass the tests above.
    const pairs = await Promise.all(
      Array.from({ length: 24 }, async () => {
        const [sender, recipient] = await Promise.all([
          generatePairingKeyPair(),
          generatePairingKeyPair(),
        ]);
        return pairingVerificationCode({
          senderPublicJwk: sender.publicJwk,
          recipientPublicJwk: recipient.publicJwk,
        });
      }),
    );

    expect(new Set(pairs).size).toBe(pairs.length);
    expect(new Set(pairs.map((code) => code[0])).size).toBeGreaterThan(1);
    expect(new Set(pairs.map((code) => code.at(-1))).size).toBeGreaterThan(1);
  });

  it("changes when only the y coordinate is substituted", async () => {
    // The attack a code committing to x alone would miss entirely: on P-256, P
    // and -P share an x, so an attacker who negates the honest key produces the
    // same six characters on both devices and the user confirms a MITM. The
    // negated key is a real point on the curve, so this is not a malformed
    // input the validator would catch.
    const alice = await generatePairingKeyPair();
    const bob = await generatePairingKeyPair();
    const negatedBob = { ...bob.publicJwk, y: negateCoordinate(bob.publicJwk.y) };

    expect(negatedBob.y).not.toBe(bob.publicJwk.y);
    expect(negatedBob.x).toBe(bob.publicJwk.x);

    const honest = await pairingVerificationCode({
      senderPublicJwk: alice.publicJwk,
      recipientPublicJwk: bob.publicJwk,
    });
    await expect(
      pairingVerificationCode({
        senderPublicJwk: alice.publicJwk,
        recipientPublicJwk: negatedBob,
      }),
    ).resolves.not.toBe(honest);
  });

  it("changes when only the x coordinate is substituted", async () => {
    // The mirror: a code built from y alone would collide here.
    const alice = await generatePairingKeyPair();
    const bob = await generatePairingKeyPair();
    const other = await generatePairingKeyPair();
    const splicedBob = { ...bob.publicJwk, x: other.publicJwk.x };

    expect(splicedBob.x).not.toBe(bob.publicJwk.x);
    expect(splicedBob.y).toBe(bob.publicJwk.y);

    const honest = await pairingVerificationCode({
      senderPublicJwk: alice.publicJwk,
      recipientPublicJwk: bob.publicJwk,
    });
    await expect(
      pairingVerificationCode({
        senderPublicJwk: alice.publicJwk,
        recipientPublicJwk: splicedBob,
      }),
    ).resolves.not.toBe(honest);
  });

  it("ignores base64url spelling differences in an otherwise identical key", async () => {
    // Same point, differently spelled, must not read as a different peer.
    // A 32-byte coordinate leaves two unused bits in its final base64url
    // character, so the same bytes have four legal spellings — a peer that
    // emitted a different one would otherwise look like an attacker.
    const alice = await generatePairingKeyPair();
    const bob = await generatePairingKeyPair();
    const respelledX = respellCoordinate(bob.publicJwk.x);
    const respelledBob = { ...bob.publicJwk, x: respelledX };

    // Without this the test proves nothing: the strings must genuinely differ
    // while decoding to identical bytes.
    expect(respelledX).not.toBe(bob.publicJwk.x);
    expect(Array.from(decodeBase64Url(respelledX))).toEqual(
      Array.from(decodeBase64Url(bob.publicJwk.x)),
    );

    await expect(
      pairingVerificationCode({
        senderPublicJwk: alice.publicJwk,
        recipientPublicJwk: respelledBob,
      }),
    ).resolves.toBe(
      await pairingVerificationCode({
        senderPublicJwk: alice.publicJwk,
        recipientPublicJwk: bob.publicJwk,
      }),
    );
  });
});

describe("rotateHostSecrets", () => {
  const HOST_IDS = [HOST_A, HOST_B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"];

  async function seedEntries(syncKey: CryptoKey): Promise<readonly HostSecretEntry[]> {
    return Promise.all(
      HOST_IDS.map(async (hostId, index): Promise<HostSecretEntry> => {
        const version = HOST_SECRET_INITIAL_VERSION + index;
        return {
          hostId,
          ownerUserId: OWNER,
          envelope: await sealHostSecret({
            syncKey,
            hostId,
            ownerUserId: OWNER,
            version,
            secret: { ...SSH_HOST_SECRET, label: `host-${index}` },
          }),
        };
      }),
    );
  }

  it("re-encrypts every entry, bumps each version, and locks the old key out", async () => {
    const oldSyncKey = await generateSyncKey();
    const newSyncKey = await generateSyncKey();
    const entries = await seedEntries(oldSyncKey);

    const rotated = await rotateHostSecrets({ oldSyncKey, newSyncKey, entries });

    expect(rotated).toHaveLength(entries.length);
    expect(rotated.map((entry) => entry.hostId)).toEqual(HOST_IDS);

    for (const [index, entry] of rotated.entries()) {
      const before = entries[index];
      if (before === undefined) throw new Error("missing seeded entry");

      expect(entry.envelope.version).toBe(before.envelope.version + 1);
      expect(entry.envelope.ciphertext).not.toBe(before.envelope.ciphertext);
      expect(entry.envelope.iv).not.toBe(before.envelope.iv);

      // The new key opens everything...
      await expect(
        openHostSecret({
          syncKey: newSyncKey,
          hostId: entry.hostId,
          ownerUserId: entry.ownerUserId,
          version: entry.envelope.version,
          envelope: entry.envelope,
        }),
      ).resolves.toEqual({ ...SSH_HOST_SECRET, label: `host-${index}` });

      // ...and the removed device's key opens none of it. This is the whole
      // point of rotation on device removal (ADR 0015).
      await expectOpenRejection(
        openHostSecret({
          syncKey: oldSyncKey,
          hostId: entry.hostId,
          ownerUserId: entry.ownerUserId,
          version: entry.envelope.version,
          envelope: entry.envelope,
        }),
      );
    }
  });

  it("accepts an empty set", async () => {
    const oldSyncKey = await generateSyncKey();
    const newSyncKey = await generateSyncKey();
    await expect(rotateHostSecrets({ oldSyncKey, newSyncKey, entries: [] })).resolves.toEqual([]);
  });

  it("throws rather than returning a partially rotated set", async () => {
    // Silently skipping the bad entry would leave some hosts readable by the
    // removed device, with nothing recording which.
    const oldSyncKey = await generateSyncKey();
    const newSyncKey = await generateSyncKey();
    const entries = await seedEntries(oldSyncKey);
    const middle = entries[1];
    if (middle === undefined) throw new Error("missing seeded entry");
    const poisoned: readonly HostSecretEntry[] = entries.with(1, {
      ...middle,
      envelope: { ...middle.envelope, ciphertext: tamper(middle.envelope.ciphertext, 0) },
    });

    await expect(
      rotateHostSecrets({ oldSyncKey, newSyncKey, entries: poisoned }),
    ).rejects.toBeInstanceOf(HostSecretsError);
  });

  it("refuses a set with duplicate hosts", async () => {
    const oldSyncKey = await generateSyncKey();
    const newSyncKey = await generateSyncKey();
    const entries = await seedEntries(oldSyncKey);
    const first = entries[0];
    if (first === undefined) throw new Error("missing seeded entry");

    await expect(
      rotateHostSecrets({ oldSyncKey, newSyncKey, entries: [...entries, first] }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
  });

  it("refuses a rotation that does not actually change the key", async () => {
    // A no-op that reports success is the one failure that defeats the feature.
    const syncKey = await generateSyncKey();
    const entries = await seedEntries(syncKey);

    await expect(
      rotateHostSecrets({ oldSyncKey: syncKey, newSyncKey: syncKey, entries }),
    ).rejects.toMatchObject({ reason: "invalid-input" });
  });

  it("refuses when an entry is bound to a different owner than its ciphertext", async () => {
    const oldSyncKey = await generateSyncKey();
    const newSyncKey = await generateSyncKey();
    const entries = await seedEntries(oldSyncKey);
    const first = entries[0];
    if (first === undefined) throw new Error("missing seeded entry");

    await expect(
      rotateHostSecrets({
        oldSyncKey,
        newSyncKey,
        entries: [{ ...first, ownerUserId: "33333333-3333-4333-8333-333333333333" }],
      }),
    ).rejects.toMatchObject({ reason: "open-failed" });
  });
});

describe("device removal, end to end", () => {
  it("pairs two devices, shares a secret, rotates, and shuts the removed device out", async () => {
    // The integration path from the spec, in one place: what a user actually
    // does when a laptop is stolen.
    const firstDevice = await generateSyncKey();
    const envelope = await sealForHostA(firstDevice);

    const removedDevice = await generatePairingKeyPair();
    const survivingDevice = await generatePairingKeyPair();
    const removedKey = await unwrapSyncKey({
      wrapped: await wrapSyncKey({
        syncKey: firstDevice,
        recipientPublicJwk: removedDevice.publicJwk,
      }),
      recipientPrivateKey: removedDevice.privateKey,
    });
    const survivingKey = await unwrapSyncKey({
      wrapped: await wrapSyncKey({
        syncKey: firstDevice,
        recipientPublicJwk: survivingDevice.publicJwk,
      }),
      recipientPrivateKey: survivingDevice.privateKey,
    });

    // Before removal, both devices read the same host config.
    await expect(
      openHostSecret({
        syncKey: removedKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: HOST_SECRET_INITIAL_VERSION,
        envelope,
      }),
    ).resolves.toEqual(SSH_HOST_SECRET);

    const rotatedKey = await generateSyncKey();
    const rotated = await rotateHostSecrets({
      oldSyncKey: survivingKey,
      newSyncKey: rotatedKey,
      entries: [{ hostId: HOST_A, ownerUserId: OWNER, envelope }],
    });
    const rotatedEntry = rotated[0];
    if (rotatedEntry === undefined) throw new Error("rotation dropped the only entry");

    // After: the surviving device reads the new write, the removed one cannot.
    await expect(
      openHostSecret({
        syncKey: rotatedKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: rotatedEntry.envelope.version,
        envelope: rotatedEntry.envelope,
      }),
    ).resolves.toEqual(SSH_HOST_SECRET);
    await expectOpenRejection(
      openHostSecret({
        syncKey: removedKey,
        hostId: HOST_A,
        ownerUserId: OWNER,
        version: rotatedEntry.envelope.version,
        envelope: rotatedEntry.envelope,
      }),
    );
  });
});
