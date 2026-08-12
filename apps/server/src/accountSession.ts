/**
 * accountSession - the in-app account session, as the RPC handlers need it.
 *
 * The app never holds account credentials: the server owns the stored
 * credential file and every WorkOS round trip, and this module is the whole of
 * that. It is a thin adapter over `accountAuth` (the credential file, token
 * refresh, workspace scoping) and `AccountClient` (the HTTP surface) — the
 * `synara auth` CLI flow and the in-app flow share both, and the only thing
 * this adds is the parts a GUI needs and a terminal does not: a status that
 * reports "signed out" instead of throwing, a device poll the server runs on
 * the client's behalf, and the in-app email OTP grant.
 *
 * Two ways in, converging immediately. Email OTP sign-in happens inside
 * the app and the emailed code is pass-through — forwarded to the account
 * service, held nowhere here. SSO ("Continue with Google/Apple/GitHub")
 * takes the authorization-code + PKCE grant with a loopback redirect and the
 * system browser. Both end in `establishSession`, so workspace scoping and
 * credential persistence cannot drift between them.
 *
 * @module accountSession
 */
import { randomUUID } from "node:crypto";

import type {
  AccountAuthenticateOtpInput,
  AccountUsageSummaryInput,
  AccountBeginSsoInput,
  AccountBeginSsoResult,
  AccountCompleteSsoInput,
  AccountMe,
  AccountSendOtpInput,
  AccountSendOtpResult,
  AccountStatus,
  AccountUpdateProfileInput,
  InstanceInfo,
  UsageSummary,
} from "@synara/contracts";
import {
  AccountApiError,
  createAccountClient,
  DEFAULT_ACCOUNT_URL,
  resolveAccountUrl,
  type AccountClient,
} from "@synara/shared/account";

import {
  readAccountCredentials,
  readAccountFile,
  scopeTokenToWorkspace,
  selectOrganization,
  SessionExpiredError,
  withFreshAccessToken,
  withLockedAccountFile,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
} from "./accountAuth";
import {
  createPkcePair,
  createSsoState,
  startSsoCallbackListener,
  type SsoCallbackListener,
} from "./accountSsoCallback";

const SIGNED_OUT: AccountStatus = { state: "signed-out" };

/**
 * How many loopback PKCE attempts may be live at once. Each one holds an open
 * HTTP listener, so the bound is much tighter than the device map's; evicting
 * the oldest closes its listener, costing only an abandoned attempt.
 */
const MAX_TRACKED_SSO_ATTEMPTS = 4;

/**
 * How long the loopback listener waits for the browser to come back. This
 * bounds the HUMAN leg — reading a consent screen, picking a Google account —
 * so it is generous (10 minutes), unlike the per-request grant deadline,
 * which bounds only the server-to-provider exchange call once the code is in
 * hand.
 */
const SSO_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What a slow provider surfaces when nothing was persisted. Deliberately not
 * "unavailable": the grant may still have completed upstream, so the message
 * must promise neither failure nor a dead code.
 */
const PROVIDER_SLOW_MESSAGE =
  "The identity provider is responding slowly and the sign-in did not finish. It may still complete — if it doesn't, your code should still work; try again.";

/**
 * Whether a sign-in failure says nothing about the credential — a timed-out
 * attempt (408/504), a rate answer (429), or a provider/service fault (5xx).
 * These are the failures after which the grant may have SUCCEEDED upstream,
 * so the caller re-checks persisted status before reporting anything.
 * Classified refusals (wrong code, expired, multi-org) are terminal and pass
 * through untouched.
 */
function isTransientSignInFailure(error: unknown): boolean {
  return (
    error instanceof AccountApiError &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
  );
}

export interface AccountSessionOptions {
  /** Where the credential file lives — the server's Synara home. */
  readonly baseDir: string;
  /**
   * The account service to talk to. Defaults to the configured one, falling
   * back to {@link DEFAULT_ACCOUNT_URL}: a user clicking "sign in" has opted
   * into the hosted service by doing so, which is why this flow takes the
   * default where the CLI refuses to.
   */
  readonly accountUrl?: string | undefined;
  /** Injectable for tests; production builds one per call from `accountUrl`. */
  readonly client?: AccountClient;
}

export interface AccountSession {
  status(): Promise<AccountStatus>;
  /** Asks the account service to email a 6-digit sign-in code. */
  sendOtp(input: AccountSendOtpInput): Promise<AccountSendOtpResult>;
  /**
   * In-app email OTP sign-in: redeems the emailed 6-digit code, provisioning
   * the account first when the address is new. The code is a credential —
   * never log or persist the input. Success takes the same
   * `establishSession` path as every other sign-in.
   */
  authenticateOtp(input: AccountAuthenticateOtpInput): Promise<AccountStatus>;
  /**
   * Starts the desktop SSO path: authorization code + PKCE with a loopback
   * redirect, deep-linked to the chosen provider. The server owns the
   * loopback listener, the verifier, and the state; the caller only receives
   * the attempt id and the URL to open. Ends in `establishSession` like every
   * other sign-in.
   */
  beginSso(input: AccountBeginSsoInput): Promise<AccountBeginSsoResult>;
  /**
   * Waits for the loopback callback, exchanges the code (through the account
   * service — never the provider directly), and persists the session. The
   * server does the waiting, so a dropped WebSocket cannot lose a sign-in
   * that already succeeded.
   */
  completeSso(input: AccountCompleteSsoInput): Promise<AccountStatus>;
  /** Abandons a pending SSO attempt, closing its loopback listener. */
  cancelSso(input: AccountCompleteSsoInput): Promise<void>;
  updateProfile(input: AccountUpdateProfileInput): Promise<AccountMe>;
  /**
   * The account-wide usage summary — the "Account" side of the usage tab's
   * device/account toggle. Runs against the stored session with the usual
   * transparent refresh.
   */
  usageSummary(input: AccountUsageSummaryInput): Promise<UsageSummary>;
  signOut(): Promise<void>;
  /**
   * Whether `url` is the authorize URL of an SSO attempt this session
   * started. The RPC handler asks before opening a browser, so this method
   * can never become a general "open any URL for me" primitive.
   */
  isVerificationUrlAllowed(url: string): Promise<boolean>;
}

/**
 * Whether an error means "there is no usable session" rather than "something
 * went wrong". Both are states the UI renders as signed out, and neither is
 * worth surfacing as a failed RPC: the user's next action is the same either
 * way, and a modal saying "session expired" over a screen that already shows a
 * sign-in button is noise.
 */
function isSignedOut(error: unknown): boolean {
  return error instanceof SessionExpiredError || error instanceof WorkspaceAccessChangedError;
}

/**
 * Drops the session half of the stored file, keeping the host registration.
 * Sign-out is a local act: the host this machine registered is still real and
 * still reachable by its own token, and deleting the whole file would strand
 * it on the account with nothing able to remove or update it.
 *
 * The organization goes with the session — it was chosen for that sign-in, and
 * carrying it into the next one would silently re-pick a workspace the user
 * may no longer have. Runs read→write under the credential lock so a
 * concurrent rotation or host registration cannot interleave; sign-out is
 * user intent, so unlike a race-loser's clear it applies to whatever session
 * is on disk at that moment.
 */
async function clearStoredSession(baseDir: string): Promise<void> {
  await withLockedAccountFile(baseDir, async () => {
    const stored = await readAccountFile(baseDir);
    if (!stored) return;
    const {
      accessToken: _accessToken,
      refreshToken: _refreshToken,
      organizationId: _organizationId,
      ...rest
    } = stored;
    await writeAccountCredentials(baseDir, rest);
  });
}

export function createAccountSession(options: AccountSessionOptions): AccountSession {
  const { baseDir } = options;
  const configuredUrl = options.accountUrl ?? resolveAccountUrl();

  /**
   * Loopback PKCE attempts this process has started, keyed by the opaque
   * attempt id handed to the client. The verifier and state never leave an
   * entry; the authorize URL is tracked so the browser-opener allowlist can
   * honour it exactly as it honours device-verification URLs. Bounded like
   * the device map — evicting the oldest closes its listener.
   */
  const pendingSsoAttempts = new Map<
    string,
    {
      readonly listener: SsoCallbackListener;
      readonly authorizeUrl: string;
      readonly codeVerifier: string;
      /**
       * The pair a successful exchange redeemed, cached until persistence for
       * the same reason as the device path: the authorization code is
       * single-use, and a failure between exchange and persistence must
       * recover on retry instead of stranding a spent code.
       */
      redeemedToken?: { accessToken: string; refreshToken: string };
    }
  >();

  function rememberSsoAttempt(
    ssoId: string,
    attempt: {
      listener: SsoCallbackListener;
      authorizeUrl: string;
      codeVerifier: string;
    },
  ): void {
    pendingSsoAttempts.set(ssoId, attempt);
    while (pendingSsoAttempts.size > MAX_TRACKED_SSO_ATTEMPTS) {
      const oldest = pendingSsoAttempts.entries().next();
      if (oldest.done) break;
      oldest.value[1].listener.close();
      pendingSsoAttempts.delete(oldest.value[0]);
    }
  }

  /**
   * The account the stored credentials were minted against, not an ambient
   * one: pointing `SYNARA_ACCOUNT_URL` somewhere else after signing in must
   * not leave a user holding credentials they cannot use or revoke.
   */
  async function accountUrlForStoredSession(): Promise<string> {
    const stored = await readAccountFile(baseDir);
    return stored?.accountUrl ?? configuredUrl;
  }

  function clientFor(accountUrl: string): AccountClient {
    return options.client ?? createAccountClient({ baseUrl: accountUrl });
  }

  /**
   * Runs `fn` against the stored session, renewing the access token if needed.
   * Rethrows as-is: callers decide whether an expired session is a state to
   * report or a failure to surface.
   */
  async function withSession<A>(fn: (accessToken: string, client: AccountClient) => Promise<A>) {
    const accountUrl = await accountUrlForStoredSession();
    const client = clientFor(accountUrl);
    return withFreshAccessToken({ baseDir, client }, (accessToken) => fn(accessToken, client));
  }

  async function signedInStatus(me: AccountMe): Promise<AccountStatus> {
    return { state: "signed-in", me };
  }

  /**
   * Everything that happens after a sign-in produces a token pair, whichever
   * way it was produced: scope it to a workspace, persist it, and report the
   * resulting session.
   *
   * Shared by the OTP and SSO paths deliberately. The two differ only in
   * how they obtain the tokens; if workspace selection or credential
   * persistence ever diverged between them, one of the two would quietly stop
   * matching what the rest of the app expects of a signed-in machine.
   */
  async function establishSession(
    token: { accessToken: string; refreshToken: string },
    context: {
      accountUrl: string;
      client: AccountClient;
      instance: InstanceInfo;
      /**
       * Called the moment the scoped pair is durably on disk — the point after
       * which the sign-in can no longer be lost. The device path uses it to
       * retire its pending authorization: deleting earlier would let a failure
       * between redemption and persistence strand the user with a spent code
       * and nothing stored.
       */
      onPersisted?: () => void;
    },
  ): Promise<AccountStatus> {
    const { accountUrl, client, instance } = context;

    // V1 is personal-org-only and this flow has no picker, so more than one
    // workspace FAILS CLOSED — see selectOrganization.
    const scoped = await scopeTokenToWorkspace(token, {
      client,
      chooseOrganization: selectOrganization,
    });

    // A file left behind by an expired session still holds this machine's
    // host registration; carrying it forward keeps the link intact. Read and
    // write under the credential lock so nothing interleaves.
    await withLockedAccountFile(baseDir, async () => {
      const previous = await readAccountFile(baseDir);
      await writeAccountCredentials(baseDir, {
        accountUrl,
        workosClientId: instance.clientId,
        workosApiUrl: instance.workosApiUrl,
        organizationId: scoped.organizationId,
        accessToken: scoped.accessToken,
        refreshToken: scoped.refreshToken,
        ...(previous?.hostToken ? { hostToken: previous.hostToken } : {}),
        ...(previous?.hostId ? { hostId: previous.hostId } : {}),
      });
    });

    // The durable checkpoint: the scoped pair is on disk, so everything after
    // this line — the status `/me` below included — can fail without losing
    // the sign-in; `status()` recovers it from the file.
    context.onPersisted?.();

    // Not redundant on the common path: scoping's probe `/me` ran against the
    // org-less token and was refused, so this is the first `/me` the scoped
    // token answers (and it runs through withSession's renewal). Only the
    // pre-scoped self-hoster path pays a second call.
    return signedInStatus(await withSession((accessToken, c) => c.me(accessToken)));
  }

  /** The `status()` body, callable from inside the session's own methods. */
  async function readStatus(): Promise<AccountStatus> {
    // Cheap and common: no credential file means signed out without a single
    // network call, which is the state every cold start begins in.
    const credentials = await readAccountCredentials(baseDir);
    if (!credentials) return SIGNED_OUT;

    try {
      return await signedInStatus(await withSession((token, client) => client.me(token)));
    } catch (error) {
      if (isSignedOut(error)) return SIGNED_OUT;
      // A rejected token that survived the refresh attempt is a dead session
      // too — but an unreachable account is not, and reporting it as signed
      // out would make a network blip look like being logged out.
      if (error instanceof AccountApiError && error.status === 401) return SIGNED_OUT;
      throw error;
    }
  }

  /**
   * Runs a sign-in to completion, never reporting failure for an operation
   * that may have succeeded. A TRANSIENT failure (timeout, rate answer,
   * provider/service fault) after a grant call proves nothing about the
   * outcome: the provider may have completed the grant after an abort, and
   * `establishSession` may already have persisted the pair (the post-persist
   * `/me` is the classic case). So the persisted state is re-checked first,
   * and only when nothing landed on disk does the caller get an error — a
   * retryable one saying the provider was slow and the credential may still
   * be good, never a flat "unavailable" for a sign-in that might have
   * worked. Classified terminal refusals (wrong code, expired, multi-org)
   * pass through untouched.
   */
  async function signInWithRecovery(perform: () => Promise<AccountStatus>): Promise<AccountStatus> {
    try {
      return await perform();
    } catch (error) {
      if (!isTransientSignInFailure(error)) throw error;
      try {
        const recovered = await readStatus();
        if (recovered.state === "signed-in") return recovered;
      } catch {
        // The re-check itself failing changes nothing: fall through to the
        // honest retryable answer below.
      }
      throw new AccountApiError({
        code: "internal_error",
        // The original transient status survives so every retryable
        // classification downstream still recognizes it.
        status: (error as AccountApiError).status,
        message: PROVIDER_SLOW_MESSAGE,
      });
    }
  }

  return {
    status: readStatus,

    /**
     * The desktop SSO start: loopback listener first (its port names the
     * redirect URI), then the account service builds the provider's authorize
     * URL around it. Nothing is consumed yet; a failure here costs only the
     * listener, which is closed on the way out.
     */
    async beginSso(input) {
      const client = clientFor(configuredUrl);
      const pkce = createPkcePair();
      const state = createSsoState();
      const listener = await startSsoCallbackListener({
        state,
        timeoutMs: SSO_CALLBACK_TIMEOUT_MS,
      });

      let authorizeUrl: string;
      try {
        authorizeUrl = (
          await client.requestAuthorizeUrl({
            provider: input.provider,
            redirectUri: listener.redirectUri,
            codeChallenge: pkce.codeChallenge,
            state,
          })
        ).authorizeUrl;
      } catch (error) {
        listener.close();
        throw error;
      }

      const ssoId = randomUUID();
      rememberSsoAttempt(ssoId, { listener, authorizeUrl, codeVerifier: pkce.codeVerifier });
      return { ssoId, authorizeUrl };
    },

    /**
     * Waits for the browser to deliver the code, exchanges it through the
     * account service, and persists the session. The server does the waiting
     * — not the browser — so a dropped WebSocket cannot lose a sign-in that
     * already succeeded: the credentials are on disk before this returns,
     * and a reconnecting client recovers the result from `status()`.
     */
    completeSso(input) {
      return signInWithRecovery(async () => {
        const pending = pendingSsoAttempts.get(input.ssoId);
        if (!pending) {
          throw new Error("This sign-in attempt has expired. Start a new one.");
        }

        const accountUrl = configuredUrl;
        const client = clientFor(accountUrl);
        // Instance before anything can consume the code, as on every path.
        const instance = await client.instance();

        // Resumable: a previous attempt may have exchanged the single-use
        // code and failed before persistence; the cached pair makes a retry
        // of this RPC recover the sign-in instead of stranding a spent code.
        let token = pending.redeemedToken;
        if (!token) {
          const code = await pending.listener.waitForCode();
          try {
            token = await client.exchangeAuthorizeCode({
              code,
              codeVerifier: pending.codeVerifier,
            });
          } catch (error) {
            // A classified terminal refusal means the code is dead and the
            // attempt can never complete — drop it and its listener now.
            if (error instanceof AccountApiError && error.status === 401) {
              pending.listener.close();
              pendingSsoAttempts.delete(input.ssoId);
            }
            throw error;
          }
        }
        pending.redeemedToken = token;

        return establishSession(token, {
          accountUrl,
          client,
          instance,
          // Retired at the durable checkpoint, exactly like the device entry.
          // Retired only once the scoped pair is durably on disk: deleting
          // earlier would turn a failure between exchange and persistence
          // into a spent code with no session and no way to retry.
          onPersisted: () => {
            pending.listener.close();
            pendingSsoAttempts.delete(input.ssoId);
          },
        });
      });
    },

    /**
     * User-initiated abandonment: closes the listener so the port is freed
     * and a late browser callback lands on nothing. A redeemed-but-not-yet-
     * persisted pair is deliberately discarded with the entry — the user
     * asked out, and no session may appear after that.
     */
    async cancelSso(input) {
      const pending = pendingSsoAttempts.get(input.ssoId);
      if (!pending) return;
      pending.listener.close();
      pendingSsoAttempts.delete(input.ssoId);
    },

    /**
     * Thin pass-through: WorkOS creates and emails the code, and the account
     * service already reduced its answer to the address echo and expiry —
     * there is nothing to interpret here.
     */
    async sendOtp(input) {
      const client = clientFor(configuredUrl);
      return client.sendOtp(input);
    },

    /**
     * In-app email OTP sign-in. The emailed code is forwarded to the account
     * service, which proxies it to WorkOS, and is referenced nowhere after
     * this call returns — not in the credential file, not in a log, not in a
     * retry. What is persisted is the resulting token pair, exactly as for SSO.
     */
    authenticateOtp(input) {
      return signInWithRecovery(async () => {
        const accountUrl = configuredUrl;
        const client = clientFor(accountUrl);
        // Sequenced, not raced: the instance metadata is non-secret and does
        // not depend on the grant, so it is fetched BEFORE the code is spent.
        // In a Promise.all an /instance failure would discard a successful
        // redemption — the user's single-use code, gone with nothing stored.
        const instance = await client.instance();
        const token = await client.authenticateOtp(input);
        return establishSession(token, { accountUrl, client, instance });
      });
    },

    /**
     * Writes the profile, then renames the workspace when it differs.
     *
     * The profile goes FIRST because it is where the user-recoverable
     * conflict surfaces: `handle_taken` must leave everything unchanged, and
     * renaming first would make a handle conflict a permanent partial rename
     * (the org renamed, the dialog still open asking for another handle).
     * With the rename second, a handle conflict changes nothing; a rename
     * failure after a saved profile costs only re-submitting the same form,
     * which upserts the identical profile and retries the rename. The rename
     * answers with the same `/me` body, so whichever call ran last provides
     * the current answer.
     */
    async updateProfile(input) {
      const { workspaceName, ...profile } = input;
      return withSession(async (token, client) => {
        const written = await client.updateProfile(token, profile);
        if (workspaceName !== undefined && written.organization.name !== workspaceName) {
          return client.updateOrganization(token, { name: workspaceName });
        }
        return written;
      });
    },

    async usageSummary(input) {
      return withSession((token, client) => client.getUsageSummary(token, input.utcOffsetMinutes));
    },

    /**
     * Forgets this machine's session. Deliberately local-only in V1: WorkOS
     * owns the browser session and the access token is short-lived, so
     * dropping the stored credentials is what sign-out means here. The host
     * registration survives, exactly as it does across an ordinary expiry.
     */
    async signOut() {
      await clearStoredSession(baseDir);
    },

    isVerificationUrlAllowed(url) {
      // Allowed only if this server issued it. An allowlist of hosts would be
      // the obvious alternative, but the authorize page lives on whatever
      // domain the identity provider chose — a hosted AuthKit domain, a custom
      // one, a self-hoster's stand-in — so any host list would be either wrong
      // for someone or wide enough to be no check at all. What is *not*
      // ambiguous is whether this URL came out of a sign-in attempt this
      // process just started.
      for (const attempt of pendingSsoAttempts.values()) {
        if (attempt.authorizeUrl === url) return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
  };
}
