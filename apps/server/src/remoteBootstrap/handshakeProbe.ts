// FILE: handshakeProbe.ts
// Purpose: The transport half of the provisioning handshake — ask the remote
//          server, through the tunnel, who it thinks it is. The DECISION about
//          whether that answer is acceptable stays in provisioningHandshake.ts;
//          this file only fetches a claim and refuses to invent one.
// Layer: Server / remote broker
// Exports: probeHandshakeOverTunnel, HandshakeProbeError
//
// What is NOT sent
// ----------------
// Only the credential this broker minted for THIS environment. No provider
// credential, no API key, no user token ever crosses this boundary — the remote
// authenticates its own providers, and readiness DETECTS what is signed in
// there rather than supplying it. If you find yourself adding a field to this
// request, that is the rule to check it against.

import * as Http from "node:http";

import { PROVISIONING_IDENTITY_ROUTE_PATH } from "@synara/contracts";
import { TUNNEL_LOOPBACK_ADDRESS } from "@synara/shared/remoteCommand";

import type { ProvisioningClaim, RemoteCredential } from "./provisioningHandshake";

export class HandshakeProbeError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "HandshakeProbeError";
  }
}

/**
 * How long one attempt may wait. Short: the request travels a tunnel that is
 * already up, to a server that answers this route from memory.
 */
const ATTEMPT_TIMEOUT_MS = 5_000;

/** Total budget for the server to come up and answer. */
const DEFAULT_DEADLINE_MS = 60_000;
const RETRY_INTERVAL_MS = 500;

/** Largest identity document we will read. Bounds a hostile or wrong upstream. */
const MAX_BODY_BYTES = 64 * 1024;

export interface HandshakeProbeInput {
  readonly localPort: number;
  readonly credential: RemoteCredential;
  readonly deadlineMs?: number;
  /** Test seam. */
  readonly request?: typeof Http.request;
}

interface AttemptOutcome {
  readonly status: number;
  readonly body: string;
}

function attempt(input: HandshakeProbeInput): Promise<AttemptOutcome> {
  return new Promise((resolve, reject) => {
    const issue = input.request ?? Http.request;
    const req = issue(
      {
        host: TUNNEL_LOOPBACK_ADDRESS,
        port: input.localPort,
        method: "GET",
        path: PROVISIONING_IDENTITY_ROUTE_PATH,
        headers: {
          // The ONLY thing we send. Bearer, because that is the scheme the
          // remote's own auth layer checks; nothing here is a cookie, so no
          // browser-owned credential can reach it.
          authorization: `Bearer ${input.credential.token}`,
          accept: "application/json",
        },
      },
      (response) => {
        let body = "";
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk, "utf8");
          if (bytes > MAX_BODY_BYTES) {
            response.destroy();
            reject(new HandshakeProbeError("The remote server's identity response was too large."));
            return;
          }
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        response.on("error", (cause) =>
          reject(new HandshakeProbeError("The remote server's identity response failed.", { cause })),
        );
      },
    );
    req.setTimeout(ATTEMPT_TIMEOUT_MS, () => {
      req.destroy(new HandshakeProbeError("The remote server did not answer in time."));
    });
    req.on("error", (cause) =>
      reject(
        cause instanceof HandshakeProbeError
          ? cause
          : new HandshakeProbeError("Could not reach the remote server through the tunnel.", {
              cause,
            }),
      ),
    );
    req.end();
  });
}

/**
 * Turn a response into a CLAIM, never into a verdict.
 *
 * Every field is read defensively and left `undefined` when it is not a
 * string, because `verifyProvisioningHandshake` is default-deny: an absent
 * field is a refusal there. Coercing `null` to `""` or defaulting
 * `authenticated` to true would each turn a refusal into an acceptance, which
 * is the one direction this parser must never fail in.
 */
function parseClaim(outcome: AttemptOutcome): ProvisioningClaim {
  // A 401 is a real answer: the remote is up and rejected our credential. It
  // must produce an UNAUTHENTICATED claim rather than a retry, so the verdict
  // says "did not accept the provisioned credential" instead of timing out.
  if (outcome.status !== 200) {
    return {
      environmentId: undefined,
      serverVersion: undefined,
      acceptedToken: undefined,
      authenticated: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.body);
  } catch {
    parsed = undefined;
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const asString = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  return {
    environmentId: asString(record.environmentId),
    serverVersion: asString(record.serverVersion),
    acceptedToken: asString(record.acceptedToken),
    // Strictly `=== true`. Any other value — a truthy string, a 1, an absent
    // field — is not an assertion of authentication.
    authenticated: record.authenticated === true,
  };
}

/**
 * Ask the remote who it is, retrying only while the failure means "not up yet".
 *
 * A connection refused is expected for the first few hundred milliseconds after
 * the supervisor starts the unit, so it retries. A 401 does NOT retry: it is a
 * definitive answer, and returning it immediately is what makes the resulting
 * verdict say what actually went wrong.
 */
export async function probeHandshakeOverTunnel(
  input: HandshakeProbeInput,
): Promise<ProvisioningClaim> {
  const deadline = Date.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  let lastError: unknown;
  for (;;) {
    try {
      return parseClaim(await attempt(input));
    } catch (cause) {
      lastError = cause;
    }
    if (Date.now() >= deadline) {
      throw new HandshakeProbeError(
        "The remote server never answered the provisioning handshake.",
        { cause: lastError },
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
}
