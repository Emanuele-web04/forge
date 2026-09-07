// FILE: syncKeyPairing.test.ts
// Purpose: Locks down the transferable pairing request and the shared short-code input rules.
// Layer: Web remote-access feature tests

import type { SyncKeyPairingRequest } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  SYNC_KEY_PAIRING_INITIAL_STATE,
  decodeSyncKeyPairingRequest,
  encodeSyncKeyPairingRequest,
  normalizeSyncKeyPairingCode,
  syncKeyPairingReducer,
} from "./syncKeyPairing";

const request: SyncKeyPairingRequest = {
  recipientDeviceId: "11111111-1111-4111-8111-111111111111",
  recipientPublicJwk: {
    kty: "EC",
    crv: "P-256",
    x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  },
};

describe("Sync-Key pairing code input", () => {
  it("uppercases, filters to the unambiguous alphabet, and caps input at six characters", () => {
    expect(normalizeSyncKeyPairingCode("a-bi0c1d2e3")).toBe("ABCD2E");
  });
});

describe("transferable Sync-Key pairing requests", () => {
  it("round-trips the recipient device id and public key through one copyable blob", () => {
    expect(decodeSyncKeyPairingRequest(encodeSyncKeyPairingRequest(request))).toEqual(request);
  });

  it("accepts whitespace introduced while transferring the blob", () => {
    const encoded = encodeSyncKeyPairingRequest(request);
    expect(
      decodeSyncKeyPairingRequest(`  ${encoded.slice(0, 30)}\n${encoded.slice(30)}  `),
    ).toEqual(request);
  });

  it("rejects malformed or differently versioned requests before calling the RPC", () => {
    expect(() => decodeSyncKeyPairingRequest("not-a-pairing-request")).toThrow(/pairing request/i);
    expect(() =>
      decodeSyncKeyPairingRequest(
        encodeSyncKeyPairingRequest(request).replace("synara-sync-v1:", "synara-sync-v2:"),
      ),
    ).toThrow(/pairing request/i);
  });
});

function pairingMismatch(remainingAttempts: number): Error & {
  readonly remainingAttempts: number;
} {
  return Object.assign(new Error("That code does not match."), { remainingAttempts });
}

describe("Sync-Key pairing confirmation state", () => {
  const confirming = {
    phase: "new-confirm" as const,
    ownVerificationCode: "ABC234",
    enteredVerificationCode: "ZZZZZZ",
    pending: false,
    message: null,
    remainingAttempts: null,
  };

  it("surfaces the server-owned remaining-attempt count and clears the mistyped code", () => {
    const twoLeft = syncKeyPairingReducer(confirming, {
      type: "confirm-failed",
      error: pairingMismatch(2),
    });
    expect(twoLeft).toMatchObject({
      phase: "new-confirm",
      enteredVerificationCode: "",
      remainingAttempts: 2,
      message: expect.stringContaining("2 attempts remaining"),
    });

    const oneLeft = syncKeyPairingReducer(twoLeft, {
      type: "confirm-failed",
      error: pairingMismatch(1),
    });
    expect(oneLeft).toMatchObject({
      phase: "new-confirm",
      remainingAttempts: 1,
      message: expect.stringContaining("1 attempt remaining"),
    });
  });

  it("resets a burned pairing to the start with the device-identity warning", () => {
    const burned = syncKeyPairingReducer(confirming, {
      type: "confirm-failed",
      error: pairingMismatch(0),
    });

    expect(burned).toEqual({
      ...SYNC_KEY_PAIRING_INITIAL_STATE,
      warning:
        "Pairing was cancelled. A persistent mismatch can mean the request did not come from the device you expect. Start again on both devices.",
    });
  });

  it("does not enter success until confirmation reports completion", () => {
    expect(syncKeyPairingReducer(confirming, { type: "confirm-started" })).toMatchObject({
      phase: "new-confirm",
      pending: true,
    });
    expect(syncKeyPairingReducer(confirming, { type: "confirm-succeeded" })).toEqual({
      phase: "new-success",
    });
  });
});
