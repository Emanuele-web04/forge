// FILE: providerUsage/credentials.ts
// Purpose: Credential resolution helpers for the usage fetchers — JSON files (read + atomic
// write-back for rotated tokens), macOS Keychain reads (via the `security` CLI), OAuth refresh,
// JWT expiry decoding, and hex/JSON keychain payload decoding. Read helpers are defensive and
// resolve to null/false on failure; the write helper throws so callers can react to a stranded
// rotation (a rotated refresh token that wasn't persisted invalidates the CLI's login).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { promisify } from "node:util";

import { fetchJson } from "./http";

const execFileAsync = promisify(execFile);

const KEYCHAIN_TIMEOUT_MS = 5_000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/** Build a short, non-secret identity for cache partitioning without retaining credentials. */
export function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url").slice(0, 18);
}

export type OAuthRefreshResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly idToken?: string;
      readonly expiresAtMs?: number;
    }
  | {
      readonly ok: false;
      /** HTTP status of the token-endpoint response; undefined on a transport failure. */
      readonly status?: number;
      /** OAuth error code from a 4xx body (e.g. "refresh_token_reused"), when identifiable. */
      readonly errorCode?: string;
    };

export async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Persist a credential JSON file atomically (temp file + rename in the same directory) with
 * owner-only permissions, so a crash mid-write can never leave a truncated auth file and a
 * concurrent reader always sees either the old or the new credential. Throws on failure.
 */
export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const directory = nodePath.dirname(path);
  const tempPath = nodePath.join(
    directory,
    `.${nodePath.basename(path)}.tmp-${process.pid}-${Date.now().toString(36)}`,
  );
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, path);
  } catch (cause) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw cause;
  }
}

/** Extract the OAuth error code from a token-endpoint 4xx body, tolerating the common shapes:
 * `{error: {code}}`, `{error: {error}}`, `{error: "code"}`, `{code}`. */
function oauthErrorCode(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    const code = nested.code ?? nested.error;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
}

/**
 * Redeem a refresh token with the provider's token endpoint. Never logs secrets. Returns a
 * discriminated result so callers can tell a bad refresh token (`errorCode`, e.g.
 * `refresh_token_reused`) from a transient endpoint failure — the two demand opposite reactions
 * (re-read the CLI's rotated credential vs. retry later).
 */
export async function refreshOAuthAccessToken(input: {
  service: string;
  refreshUrl: string;
  allowedOrigins: ReadonlyArray<string>;
  refreshToken: string;
  clientId: string;
  /** Google-style token endpoints require the confidential-client secret next to `client_id`. */
  clientSecret?: string;
  scope?: string;
  /** OAuth token endpoints commonly require form encoding; JSON stays for the ones that don't. */
  bodyFormat?: "json" | "form";
  timeoutMs?: number;
}): Promise<OAuthRefreshResult> {
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  };
  if (input.clientSecret) {
    body.client_secret = input.clientSecret;
  }
  if (input.scope) {
    body.scope = input.scope;
  }
  const bodyFormat = input.bodyFormat ?? "json";

  let response: Awaited<ReturnType<typeof fetchJson>>;
  try {
    response = await fetchJson({
      service: input.service,
      url: input.refreshUrl,
      allowedOrigins: input.allowedOrigins,
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type":
          bodyFormat === "form" ? "application/x-www-form-urlencoded" : "application/json",
      },
      body,
      bodyFormat,
      timeoutMs: input.timeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS,
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    const errorCode = response.status < 500 ? oauthErrorCode(response.json) : undefined;
    return { ok: false, status: response.status, ...(errorCode ? { errorCode } : {}) };
  }
  const json = response.json;
  if (!json || typeof json !== "object") {
    return { ok: false, status: response.status };
  }

  const record = json as Record<string, unknown>;
  const asToken = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const accessToken = asToken(record.access_token);
  if (!accessToken) {
    return { ok: false, status: response.status };
  }

  const refreshToken = asToken(record.refresh_token);
  const idToken = asToken(record.id_token);
  const expiresInSeconds =
    typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
      ? record.expires_in
      : undefined;

  return {
    ok: true,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(expiresInSeconds !== undefined
      ? { expiresAtMs: Date.now() + expiresInSeconds * 1000 }
      : {}),
  };
}

/**
 * Read a generic-password secret from the macOS Keychain. Returns the raw secret string (the
 * caller decodes hex/JSON as needed), or null on any platform other than darwin / on failure.
 * Read-only: we never call `add-generic-password`.
 */
export async function readKeychainPassword(input: {
  service: string;
  account?: string;
  platform: NodeJS.Platform;
}): Promise<string | null> {
  if (input.platform !== "darwin") {
    return null;
  }
  const args = ["find-generic-password", "-s", input.service, "-w"];
  if (input.account) {
    args.push("-a", input.account);
  }
  try {
    const { stdout } = await execFileAsync("security", args, { timeout: KEYCHAIN_TIMEOUT_MS });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Some CLIs store the JSON credential in the keychain hex-encoded (Claude Code on macOS),
 * others store raw JSON. Try direct JSON first, then hex-decode then parse.
 */
export function decodeKeychainJson(value: string): unknown | null {
  const trimmed = value.trim();
  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct !== null) {
    return direct;
  }

  const hex = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  if (hex.length % 2 === 0 && /^[0-9a-fA-F]+$/u.test(hex)) {
    try {
      return tryParse(Buffer.from(hex, "hex").toString("utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

/** Decode a JWT's `exp` claim into epoch milliseconds, or null when not parseable. */
export function decodeJwtExpMs(jwt: string | undefined): number | null {
  if (!jwt) {
    return null;
  }
  const parts = jwt.split(".");
  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }
  try {
    const base64 = payloadPart.replace(/-/gu, "+").replace(/_/gu, "/");
    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}
