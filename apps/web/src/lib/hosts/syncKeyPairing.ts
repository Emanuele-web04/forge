// FILE: syncKeyPairing.ts
// Purpose: Encode the public pairing request for copy/paste and normalize its verification code.
// Layer: Web remote-access feature logic

import { SyncKeyPairingRequest } from "@synara/contracts";
import { Schema } from "effect";

import { normalizeUnambiguousCode } from "./enrollment";

export const SYNC_KEY_PAIRING_CODE_LENGTH = 6;
export const SYNC_KEY_PAIRING_CODE_GROUP_SIZE = 3;

export type SyncKeyPairingState =
  | {
      readonly phase: "start";
      readonly warning: string | null;
      readonly error: string | null;
    }
  | { readonly phase: "new-starting" }
  | {
      readonly phase: "new-request";
      readonly transferableRequest: string;
      readonly pending: boolean;
      readonly message: string | null;
    }
  | {
      readonly phase: "new-confirm";
      readonly ownVerificationCode: string;
      readonly enteredVerificationCode: string;
      readonly pending: boolean;
      readonly message: string | null;
      readonly remainingAttempts: number | null;
    }
  | { readonly phase: "new-success" }
  | {
      readonly phase: "existing-request";
      readonly transferableRequest: string;
      readonly pending: boolean;
      readonly message: string | null;
    }
  | { readonly phase: "existing-code"; readonly ownVerificationCode: string };

export type SyncKeyPairingAction =
  | { readonly type: "new-started" }
  | { readonly type: "new-start-failed"; readonly message: string }
  | { readonly type: "new-request-ready"; readonly transferableRequest: string }
  | { readonly type: "receive-started" }
  | { readonly type: "receive-failed"; readonly message: string }
  | { readonly type: "receive-succeeded"; readonly verificationCode: string }
  | { readonly type: "existing-started" }
  | { readonly type: "request-changed"; readonly value: string }
  | { readonly type: "offer-started" }
  | { readonly type: "offer-failed"; readonly message: string }
  | { readonly type: "offer-succeeded"; readonly verificationCode: string }
  | { readonly type: "verification-changed"; readonly value: string }
  | { readonly type: "confirm-started" }
  | { readonly type: "confirm-failed"; readonly error: unknown; readonly message?: string }
  | { readonly type: "confirm-succeeded" }
  | { readonly type: "reset" };

export const SYNC_KEY_PAIRING_INITIAL_STATE: Extract<
  SyncKeyPairingState,
  { readonly phase: "start" }
> = {
  phase: "start",
  warning: null,
  error: null,
};

export const SYNC_KEY_PAIRING_BURNED_WARNING =
  "Pairing was cancelled. A persistent mismatch can mean the request did not come from the device you expect. Start again on both devices.";

const PAIRING_REQUEST_PREFIX = "synara-sync-v1:";

export function normalizeSyncKeyPairingCode(raw: string): string {
  return normalizeUnambiguousCode(raw, SYNC_KEY_PAIRING_CODE_LENGTH);
}

function readRemainingAttempts(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("remainingAttempts" in error)) return null;
  const value = (error as { readonly remainingAttempts: unknown }).remainingAttempts;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3
    ? value
    : null;
}

export function syncKeyPairingReducer(
  state: SyncKeyPairingState,
  action: SyncKeyPairingAction,
): SyncKeyPairingState {
  switch (action.type) {
    case "new-started":
      return { phase: "new-starting" };
    case "new-start-failed":
      return { ...SYNC_KEY_PAIRING_INITIAL_STATE, error: action.message };
    case "new-request-ready":
      return {
        phase: "new-request",
        transferableRequest: action.transferableRequest,
        pending: false,
        message: null,
      };
    case "receive-started":
      return state.phase === "new-request" ? { ...state, pending: true, message: null } : state;
    case "receive-failed":
      return state.phase === "new-request"
        ? { ...state, pending: false, message: action.message }
        : state;
    case "receive-succeeded":
      return {
        phase: "new-confirm",
        ownVerificationCode: action.verificationCode,
        enteredVerificationCode: "",
        pending: false,
        message: null,
        remainingAttempts: null,
      };
    case "existing-started":
      return {
        phase: "existing-request",
        transferableRequest: "",
        pending: false,
        message: null,
      };
    case "request-changed":
      return state.phase === "existing-request"
        ? { ...state, transferableRequest: action.value, message: null }
        : state;
    case "offer-started":
      return state.phase === "existing-request"
        ? { ...state, pending: true, message: null }
        : state;
    case "offer-failed":
      return state.phase === "existing-request"
        ? { ...state, pending: false, message: action.message }
        : state;
    case "offer-succeeded":
      return { phase: "existing-code", ownVerificationCode: action.verificationCode };
    case "verification-changed":
      return state.phase === "new-confirm"
        ? {
            ...state,
            enteredVerificationCode: normalizeSyncKeyPairingCode(action.value),
            message: null,
            remainingAttempts: null,
          }
        : state;
    case "confirm-started":
      return state.phase === "new-confirm" ? { ...state, pending: true, message: null } : state;
    case "confirm-failed": {
      if (state.phase !== "new-confirm") return state;
      const remainingAttempts = readRemainingAttempts(action.error);
      if (remainingAttempts === 0) {
        return { ...SYNC_KEY_PAIRING_INITIAL_STATE, warning: SYNC_KEY_PAIRING_BURNED_WARNING };
      }
      if (remainingAttempts !== null) {
        return {
          ...state,
          enteredVerificationCode: "",
          pending: false,
          remainingAttempts,
          message: `That code does not match. ${remainingAttempts} ${
            remainingAttempts === 1 ? "attempt" : "attempts"
          } remaining before pairing is cancelled.`,
        };
      }
      return {
        ...state,
        pending: false,
        message: action.message ?? "Could not confirm pairing. Try again.",
      };
    }
    case "confirm-succeeded":
      return state.phase === "new-confirm" ? { phase: "new-success" } : state;
    case "reset":
      return SYNC_KEY_PAIRING_INITIAL_STATE;
  }
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/**
 * The request contains only the recipient device id and public key. Encoding
 * it as one versioned blob makes it a single copy/paste without inventing a
 * relay, rendezvous service, or a second RPC.
 */
export function encodeSyncKeyPairingRequest(request: SyncKeyPairingRequest): string {
  return `${PAIRING_REQUEST_PREFIX}${encodeBase64Url(JSON.stringify(request))}`;
}

export function decodeSyncKeyPairingRequest(raw: string): SyncKeyPairingRequest {
  try {
    const compact = raw.replace(/\s/g, "");
    if (!compact.startsWith(PAIRING_REQUEST_PREFIX)) throw new Error("invalid prefix");
    const json = decodeBase64Url(compact.slice(PAIRING_REQUEST_PREFIX.length));
    return Schema.decodeUnknownSync(SyncKeyPairingRequest)(JSON.parse(json));
  } catch {
    throw new Error("That pairing request is not valid. Copy it again from the new device.");
  }
}
