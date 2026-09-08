/**
 * accountSsoCallback - the loopback half of the desktop PKCE SSO flow.
 *
 * The authorization-code grant needs somewhere for the browser to deliver the
 * code, and on a desktop that is a one-shot HTTP listener on 127.0.0.1: bound
 * to an ephemeral port, alive for exactly one sign-in attempt, and shut down
 * on completion, timeout, or cancellation. This module owns that listener and
 * the PKCE pair generation; it knows nothing about WorkOS, the account
 * service, or session persistence — accountSession composes it.
 *
 * The authorization code and the PKCE verifier are credentials: neither is
 * ever logged, echoed into a response body, or attached to an error.
 *
 * @module accountSsoCallback
 */
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/** The PKCE pair: the secret the exchange proves, and its one-way challenge. */
export interface PkcePair {
  /** Stays with the server until the code exchange; never travels earlier. */
  readonly codeVerifier: string;
  /** S256(verifier), base64url — safe to put in the authorize URL. */
  readonly codeChallenge: string;
}

/**
 * A fresh PKCE verifier/challenge pair (RFC 7636, S256). 32 random bytes
 * base64url-encoded is 43 characters — inside the RFC's 43–128 bound.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** A random `state` value binding the authorize redirect to this attempt. */
export function createSsoState(): string {
  return randomBytes(16).toString("base64url");
}

/** The path the redirect URI uses; registered as part of the loopback URI. */
const CALLBACK_PATH = "/callback";

/**
 * The page the browser lands on. Static by design: nothing from the request —
 * not the code, not the state, not an error description — may be echoed into
 * it, because this page is the one part of the flow an outsider can render by
 * guessing the port.
 */
const SUCCESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Synara</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:1.2rem">Signed in</h1>
<p>You can close this window and return to Synara.</p></div></body>`;

const FAILURE_PAGE = `<!doctype html><meta charset="utf-8"><title>Synara</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1 style="font-size:1.2rem">Sign-in not completed</h1>
<p>You can close this window and try again from Synara.</p></div></body>`;

export interface SsoCallbackListener {
  /** Where the browser will be redirected: `http://127.0.0.1:<port>/callback`. */
  readonly redirectUri: string;
  /**
   * Resolves with the authorization code once the browser delivers a callback
   * whose `state` matches; rejects on a state mismatch, a provider-reported
   * error, the timeout, or {@link close}. Safe to call before or after the
   * callback arrives — the outcome is latched.
   */
  waitForCode(): Promise<string>;
  /** Shuts the listener down; idempotent, and called on every outcome. */
  close(): void;
}

export interface StartSsoCallbackListenerOptions {
  /** The `state` the authorize URL carries; a callback without it is refused. */
  readonly state: string;
  /** Hard deadline on the whole attempt; the listener dies with it. */
  readonly timeoutMs: number;
}

/**
 * Starts the one-shot loopback listener. Bound to 127.0.0.1 only — never a
 * wildcard — on an ephemeral port, single-use: the first terminal callback
 * settles the outcome and every later request gets a 404. A callback whose
 * `state` does not match the attempt's is a terminal failure, not something
 * to keep waiting through: the redirect that arrived was not the one this
 * attempt sent the browser to produce.
 */
export function startSsoCallbackListener(
  options: StartSsoCallbackListenerOptions,
): Promise<SsoCallbackListener> {
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const outcome = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Latched promise: a rejection before anyone calls waitForCode must not
  // become an unhandled rejection.
  outcome.catch(() => {});
  let settled = false;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (settled || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }

    const fail = (status: number, reason: string) => {
      settled = true;
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(FAILURE_PAGE);
      // The reason is this module's own wording, never a request field.
      settle?.reject(new Error(reason));
      finish();
    };

    // The provider reports a user-side refusal (cancelled at the consent
    // screen) via `error`; its value is untrusted and is not read.
    if (url.searchParams.has("error")) {
      fail(200, "The sign-in was cancelled or denied in the browser.");
      return;
    }
    if (url.searchParams.get("state") !== options.state) {
      fail(400, "The sign-in callback did not match this attempt. Start a new sign-in.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      fail(400, "The sign-in callback carried no authorization code. Start a new sign-in.");
      return;
    }

    settled = true;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(SUCCESS_PAGE);
    settle?.resolve(code);
    finish();
  });

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      settle?.reject(new Error("The sign-in attempt timed out. Start a new one."));
    }
    finish();
  }, options.timeoutMs);
  // The timer must never keep the server process alive on its own.
  timer.unref();

  function finish(): void {
    clearTimeout(timer);
    server.close();
    // Idle keep-alive connections (the browser's) would otherwise hold the
    // listener open past close().
    server.closeAllConnections?.();
  }

  return new Promise<SsoCallbackListener>((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    // Loopback only: this listener must never be reachable from another host.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolveStart({
        redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
        waitForCode: () => outcome,
        close: () => {
          if (!settled) {
            settled = true;
            settle?.reject(new Error("The sign-in attempt was cancelled."));
          }
          finish();
        },
      });
    });
  });
}
