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
 * Two ways in, converging immediately. Email OTP sign-in happens inside the
 * app and the emailed code is pass-through — forwarded to the account
 * service, held nowhere here. SSO ("Continue with Google/GitHub") takes the
 * device grant and the system browser. Both end in `establishSession`, so
 * workspace scoping and credential persistence cannot drift between them.
 *
 * @module accountSession
 */
import type {
  AccountAuthenticateOtpInput,
  AccountBeginSignInResult,
  AccountMe,
  AccountResendVerificationEmailInput,
  AccountSendOtpInput,
  AccountSendOtpResult,
  AccountStatus,
  AccountUpdateProfileInput,
  AccountVerifyEmailInput,
  InstanceInfo,
} from "@synara/contracts";
import {
  AccountApiError,
  createAccountClient,
  DEFAULT_ACCOUNT_URL,
  OrganizationRequiredError,
  resolveAccountUrl,
  type AccountClient,
} from "@synara/shared/account";

import {
  readAccountCredentials,
  readAccountFile,
  scopeTokenToWorkspace,
  SessionExpiredError,
  withFreshAccessToken,
  withLockedAccountFile,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
} from "./accountAuth";

const SIGNED_OUT: AccountStatus = { state: "signed-out" };

/**
 * How many outstanding sign-in attempts stay completable. A user retrying a
 * few times is ordinary; hundreds are not, and the map must not grow with
 * them.
 */
const MAX_TRACKED_DEVICE_AUTHORIZATIONS = 16;

/** A device authorization this server issued and can still poll for. */
interface PendingDeviceAuthorization {
  readonly deviceCode: string;
  readonly verificationUriComplete: string;
  readonly interval: number;
  readonly expiresIn: number;
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
   * Redeems the emailed 6-digit code plus the pending authentication token an
   * `email_verification_required` refusal carried. The pair is a bearer-ish
   * secret with the credential handling rules: never log or persist the input.
   * Success takes the same `establishSession` path as every other sign-in.
   */
  verifyEmail(input: AccountVerifyEmailInput): Promise<AccountStatus>;
  /** Asks the identity provider to email a fresh verification code. */
  resendVerificationEmail(input: AccountResendVerificationEmailInput): Promise<void>;
  /** Starts the SSO path — the browser hand-off for Google/GitHub. */
  beginSignIn(): Promise<AccountBeginSignInResult>;
  completeSignIn(input: { readonly deviceCode: string }): Promise<AccountStatus>;
  updateProfile(input: AccountUpdateProfileInput): Promise<AccountMe>;
  signOut(): Promise<void>;
  /**
   * Whether `url` is the device-verification page of the account service this
   * session talks to. The RPC handler asks before opening a browser, so this
   * method can never become a general "open any URL for me" primitive.
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
   * Device authorizations this process has issued, keyed by device code.
   *
   * Two things depend on it. The poll needs the interval and deadline WorkOS
   * set, and the client should not be trusted to echo them back — a client
   * that asked for a one-second interval would have the server hammer WorkOS
   * on its behalf. And the browser hand-off needs to know that a URL is one we
   * issued, which is what keeps `openVerificationUrl` from becoming a general
   * "open any URL for me" primitive.
   *
   * Bounded by {@link MAX_TRACKED_DEVICE_AUTHORIZATIONS}: a client that starts
   * sign-ins in a loop must not grow it without limit. Evicting the oldest
   * only ever costs an abandoned attempt, whose device code is expiring at
   * WorkOS anyway.
   */
  const pendingAuthorizations = new Map<string, PendingDeviceAuthorization>();

  function rememberAuthorization(authorization: PendingDeviceAuthorization): void {
    pendingAuthorizations.set(authorization.deviceCode, authorization);
    while (pendingAuthorizations.size > MAX_TRACKED_DEVICE_AUTHORIZATIONS) {
      const oldest = pendingAuthorizations.keys().next();
      if (oldest.done) break;
      pendingAuthorizations.delete(oldest.value);
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
    context: { accountUrl: string; client: AccountClient; instance: InstanceInfo },
  ): Promise<AccountStatus> {
    const { accountUrl, client, instance } = context;

    const scoped = await scopeTokenToWorkspace(token, {
      client,
      // V1 is personal-org-only, and this flow has no picker — so more than
      // one workspace FAILS CLOSED rather than silently taking whichever
      // the provider listed first: membership order is not a tenant-selection
      // contract, and binding the machine to an arbitrary team (whose hosts
      // it would then see, and whose name onboarding might rename) is worse
      // than asking the user to wait for workspace selection to ship.
      chooseOrganization: async (organizations) => {
        const first = organizations[0];
        if (!first) {
          throw new Error(
            "Your account has no workspace to sign in to. Contact your administrator, or create one in the WorkOS dashboard.",
          );
        }
        if (organizations.length > 1) {
          throw new AccountApiError({
            code: "multiple_organizations_unsupported",
            status: 403,
            message: "Multiple workspaces aren't supported yet",
          });
        }
        return first;
      },
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

    return signedInStatus(await withSession((accessToken, c) => c.me(accessToken)));
  }

  return {
    async status() {
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
    },

    async beginSignIn() {
      const client = clientFor(configuredUrl);
      const device = await client.requestDeviceCode();
      rememberAuthorization({
        deviceCode: device.deviceCode,
        verificationUriComplete: device.verificationUriComplete,
        interval: device.interval,
        expiresIn: device.expiresIn,
      });
      return {
        deviceCode: device.deviceCode,
        userCode: device.userCode,
        verificationUriComplete: device.verificationUriComplete,
        expiresIn: device.expiresIn,
        interval: device.interval,
      };
    },

    /**
     * Waits for the user to finish on the hosted page, then persists the
     * session. The server does the waiting — not the browser — so a dropped
     * WebSocket cannot lose a sign-in that already succeeded: the credentials
     * are on disk before this returns, and a reconnecting client recovers the
     * result from `status()`.
     */
    async completeSignIn(input) {
      // Only a code this server handed out. Polling one supplied from outside
      // would let a caller drive the sign-in of a device code they obtained
      // elsewhere and have the result persisted as this machine's session.
      const pending = pendingAuthorizations.get(input.deviceCode);
      if (!pending) {
        throw new Error("This sign-in attempt has expired. Start a new one.");
      }

      const accountUrl = configuredUrl;
      const client = clientFor(accountUrl);
      const instance = await client.instance();

      const token = await client.pollDeviceToken(input.deviceCode, {
        interval: pending.interval,
        expiresIn: pending.expiresIn,
      });

      // Redeemed. A device code is single-use, so keeping it would only leave
      // a stale entry that can never complete again.
      pendingAuthorizations.delete(input.deviceCode);

      return establishSession(token, { accountUrl, client, instance });
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
    async authenticateOtp(input) {
      const accountUrl = configuredUrl;
      const client = clientFor(accountUrl);
      const [instance, token] = await Promise.all([
        client.instance(),
        client.authenticateOtp(input),
      ]);
      return establishSession(token, { accountUrl, client, instance });
    },

    /**
     * Another way to a token pair: the verification grant. Converges on
     * `establishSession` with the other two, so workspace scoping and
     * credential persistence cannot drift no matter how the user signed in.
     */
    async verifyEmail(input) {
      const accountUrl = configuredUrl;
      const client = clientFor(accountUrl);
      const [instance, token] = await Promise.all([client.instance(), client.verifyEmail(input)]);
      return establishSession(token, { accountUrl, client, instance });
    },

    /**
     * Thin pass-through: the account service resolves the user behind the
     * verification id and answers 202 whether or not the id was live, so
     * there is nothing to interpret here.
     */
    async resendVerificationEmail(input) {
      const client = clientFor(configuredUrl);
      await client.resendVerificationEmail(input);
    },

    /**
     * Writes the profile, renaming the workspace first when it differs.
     *
     * The rename goes first because it is the call that can fail on someone
     * else's authority (WorkOS, membership), and doing it second would leave a
     * saved profile beside a rename the user watched fail. Both answer with
     * the same `/me` body, so the profile write's answer is the current one.
     */
    async updateProfile(input) {
      const { workspaceName, ...profile } = input;
      return withSession(async (token, client) => {
        if (workspaceName !== undefined) {
          const current = await client.me(token);
          if (current.organization.name !== workspaceName) {
            await client.updateOrganization(token, { name: workspaceName });
          }
        }
        return client.updateProfile(token, profile);
      });
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
      // the obvious alternative, but the verification page lives on whatever
      // domain the identity provider chose — a hosted AuthKit domain, a custom
      // one, a self-hoster's stand-in — so any host list would be either wrong
      // for someone or wide enough to be no check at all. What is *not*
      // ambiguous is whether this URL came out of a device authorization this
      // process just requested.
      for (const authorization of pendingAuthorizations.values()) {
        if (authorization.verificationUriComplete === url) return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
  };
}
