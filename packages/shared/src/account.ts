import {
  AccountErrorCode as AccountErrorCodeSchema,
  type AccountErrorCode,
  AccountErrorBody,
  AccountHost,
  type AccountMe,
  AccountMe as AccountMeSchema,
  type DeviceAuthorizationResponse,
  DeviceAuthorizationResponse as DeviceAuthorizationResponseSchema,
  EmailVerificationRequiredBody,
  type InstanceInfo,
  InstanceInfo as InstanceInfoSchema,
  type AuthTokensResponse,
  AuthTokensResponse as AuthTokensResponseSchema,
  type AuthorizeTokenRequest,
  type AuthorizeUrlRequest,
  type AuthorizeUrlResponse,
  AuthorizeUrlResponse as AuthorizeUrlResponseSchema,
  type ListHostsResponse,
  ListHostsResponse as ListHostsResponseSchema,
  OrganizationRequiredBody,
  type OrganizationSummary,
  type OtpAuthenticateRequest,
  type OtpSendRequest,
  type OtpSendResponse,
  OtpSendResponse as OtpSendResponseSchema,
  DeviceTokenPollResponse as DeviceTokenPollResponseSchema,
  RefreshTokenResponse as RefreshTokenResponseSchema,
  type RegisterHostRequest,
  type RegisterHostResponse,
  RegisterHostResponse as RegisterHostResponseSchema,
  type ResendVerificationRequest,
  type VerifyEmailRequest,
  type UpdateHostRequest,
  type UpdateOrganizationRequest,
  type UpdateProfileRequest,
} from "@synara/contracts";
import { Option, Schema } from "effect";

/** Environment variable that points every client at a different account service. */
export const ACCOUNT_URL_ENV_NAME = "SYNARA_ACCOUNT_URL";

/**
 * The hosted Synara account service. Declared here, once, because both callers
 * — the `synara auth` CLI flow and the server's in-app account session — must
 * agree on which service the stored credentials belong to; a second copy would
 * eventually point one of them somewhere else.
 */
export const DEFAULT_ACCOUNT_URL = "https://api.synara.vrbty.dev";

export interface AccountUrlResolutionInput {
  readonly flag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The account service the operator explicitly chose, or `undefined` when they
 * chose none. Distinct from {@link resolveAccountUrl} because the CLI has to
 * be able to tell "unconfigured" from "configured to the default": a flow that
 * silently fell back would tell a user they are not signed in to a service
 * they never meant to use.
 */
export function resolveConfiguredAccountUrl(input: AccountUrlResolutionInput): string | undefined {
  const flag = input.flag?.trim();
  if (flag) return flag;
  const fromEnv = (input.env ?? process.env)[ACCOUNT_URL_ENV_NAME]?.trim();
  return fromEnv || undefined;
}

/** The account service to talk to, falling back to the hosted one. */
export function resolveAccountUrl(input: AccountUrlResolutionInput = {}): string {
  return resolveConfiguredAccountUrl(input) ?? DEFAULT_ACCOUNT_URL;
}

const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: on `slow_down`, the client must increase its polling
// interval by at least 5 seconds for each subsequent request.
const SLOW_DOWN_INCREMENT_SECONDS = 5;
// Bounds the poll loop even if the server never returns a terminal status
// (expired_token, access_denied, ...). 30 minutes comfortably exceeds any
// device-code TTL the server is expected to configure.
const DEFAULT_DEVICE_POLL_TIMEOUT_SECONDS = 30 * 60;

/**
 * Per-attempt deadline on cheap account-service requests. A connection that
 * is accepted and then stalls must fail the one attempt, not pin the caller
 * (a CLI command, a WebSocket RPC) forever. Long-running flows — the device
 * poll — are made of many short attempts, each individually bounded.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Per-attempt deadline on the GRANT-consuming requests: OTP/verification
 * redemption, the device-token exchange, the PKCE code exchange, and refresh.
 * Longer than {@link REQUEST_TIMEOUT_MS}, and deliberately longer than the
 * account service's own upstream grant deadline (45s): these requests spend a
 * single-use credential, so this client must never give up before the service
 * has — aborting first is how a slow-but-successful grant turns into "error"
 * shown to a user who is actually signed in.
 */
export const GRANT_REQUEST_TIMEOUT_MS = 60_000;

type FetchLike = typeof fetch;
type SleepFn = (milliseconds: number) => Promise<void>;

const UpdateHostResponse = Schema.Struct({ host: AccountHost });

/** Error thrown by every {@link AccountClient} method on a non-2xx response. */
export class AccountApiError extends Error {
  readonly code: AccountErrorCode;
  readonly status: number;

  constructor(params: { code: AccountErrorCode; status: number; message: string }) {
    super(params.message);
    this.name = "AccountApiError";
    this.code = params.code;
    this.status = params.status;
  }
}

/**
 * Thrown when the account refuses a call because the token is not scoped to a
 * workspace the caller belongs to. Recoverable, unlike a plain
 * {@link AccountApiError}: `organizations` is what the caller may refresh
 * into, so the cure is a refresh carrying `organizationId` and a retry — never
 * a fresh sign-in.
 */
export class OrganizationRequiredError extends Error {
  readonly organizations: readonly OrganizationSummary[];

  constructor(params: { message: string; organizations: readonly OrganizationSummary[] }) {
    super(params.message);
    this.name = "OrganizationRequiredError";
    this.organizations = params.organizations;
  }
}

/**
 * Thrown when a sign-in or sign-up was refused because the email address is
 * not verified yet. Recoverable in-app, unlike a plain {@link AccountApiError}:
 * WorkOS has already emailed a 6-digit code, and redeeming it together with
 * `pendingAuthenticationToken` completes the sign-in. The token is a
 * bearer-ish secret — never log or persist an instance of this error.
 */
export class EmailVerificationRequiredError extends Error {
  readonly pendingAuthenticationToken: string;
  readonly email: string;
  readonly emailVerificationId: string;

  constructor(params: {
    message: string;
    pendingAuthenticationToken: string;
    email: string;
    emailVerificationId: string;
  }) {
    super(params.message);
    this.name = "EmailVerificationRequiredError";
    this.pendingAuthenticationToken = params.pendingAuthenticationToken;
    this.email = params.email;
    this.emailVerificationId = params.emailVerificationId;
  }
}

export interface DeviceTokenSuccess {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name?: string | undefined };
}

/**
 * Whether a failed poll attempt said nothing about the flow itself — a
 * timed-out attempt (408) or a service/provider fault (5xx). Safe to retry
 * for the idempotent device poll. A 429 is deliberately NOT here: the
 * service's rate answer is actionable flow feedback (the caller is polling
 * too fast) and surfaces as-is, like RFC 8628's terminal statuses.
 */
function isRetryablePollFailure(error: unknown): boolean {
  return error instanceof AccountApiError && (error.status === 408 || error.status >= 500);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Rewrites the 404 a proxied auth route gets from a pre-proxy account
 * service into an actionable answer. V1 has no capability negotiation
 * (deploy ordering is api-before-clients; see the design spec), so the one
 * skew that can happen — a new client against an old api during a rolling
 * deploy or rollback — must read as "the account service is out of date",
 * not as a mysterious unknown-route failure mid-sign-in.
 */
function withProxySkewError<A>(promise: Promise<A>): Promise<A> {
  return promise.catch((error: unknown) => {
    if (error instanceof AccountApiError && error.status === 404) {
      throw new AccountApiError({
        code: "internal_error",
        status: 404,
        message:
          "The account service does not support this sign-in flow yet — it is likely an older version. Update the account service (or wait for its deploy to finish) and try again.",
      });
    }
    throw error;
  });
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface CreateAccountClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  sleep?: SleepFn;
}

export interface PollDeviceTokenOptions {
  interval?: number;
  expiresIn?: number;
}

export interface RefreshAccessTokenOptions {
  refreshToken: string;
  /**
   * Which workspace to authenticate into. The resulting access token carries
   * the organization claim the account authorizes on — so a refresh without
   * this yields a token the host routes will refuse.
   */
  organizationId?: string;
}

export interface AccountClient {
  instance(): Promise<InstanceInfo>;
  /**
   * Asks the account service to email a 6-digit sign-in code. Resolves with
   * the address echo and code expiry — deliberately the same answer whether
   * or not the address has an account.
   */
  sendOtp(request: OtpSendRequest): Promise<OtpSendResponse>;
  /**
   * In-app OTP sign-in: redeems the emailed 6-digit code. The code is a
   * credential forwarded to the account service and held nowhere: do not log
   * the argument, and do not retain it past the call. A refused code rejects
   * with `invalid_verification_code`.
   */
  authenticateOtp(request: OtpAuthenticateRequest): Promise<AuthTokensResponse>;
  /**
   * Redeems an emailed verification code against the pending authentication
   * token an `email_verification_required` refusal carried. The pair is a
   * bearer-ish secret: do not log the argument, and do not retain it past the
   * call. A refused code rejects with `invalid_verification_code`.
   */
  verifyEmail(request: VerifyEmailRequest): Promise<AuthTokensResponse>;
  /**
   * Asks the identity provider to email a fresh verification code. Resolves
   * on 2xx whether or not the id named a live verification — the service
   * deliberately does not say which, so neither can this.
   */
  resendVerificationEmail(request: ResendVerificationRequest): Promise<void>;
  me(token: string): Promise<AccountMe>;
  /** Upserts the caller's profile. Rejects a changed handle; V1 handles are immutable. */
  updateProfile(token: string, request: UpdateProfileRequest): Promise<AccountMe>;
  /** Renames the workspace — the WorkOS organization the token is scoped to. */
  updateOrganization(token: string, request: UpdateOrganizationRequest): Promise<AccountMe>;
  listHosts(token: string): Promise<ListHostsResponse>;
  registerHost(token: string, request: RegisterHostRequest): Promise<RegisterHostResponse>;
  updateHost(hostToken: string, hostId: string, request: UpdateHostRequest): Promise<AccountHost>;
  deleteHost(token: string, hostId: string): Promise<void>;
  requestDeviceCode(): Promise<DeviceAuthorizationResponse>;
  /**
   * Asks the account service for the provider's PKCE authorize URL — the
   * desktop SSO path. Only the S256 challenge and state travel; the verifier
   * stays with the caller until the exchange.
   */
  requestAuthorizeUrl(request: AuthorizeUrlRequest): Promise<AuthorizeUrlResponse>;
  /**
   * Exchanges the loopback callback's authorization code for a token pair,
   * proving possession with the PKCE verifier. Both fields are single-use
   * credentials: do not log the argument, and do not retain it past the call.
   */
  exchangeAuthorizeCode(request: AuthorizeTokenRequest): Promise<AuthTokensResponse>;
  /**
   * Polls the account service until the device authorization is approved,
   * honouring `slow_down` and bounding the loop client-side. Every leg of
   * the flow goes through the account service; the identity provider is
   * invisible on this wire.
   */
  pollDeviceToken(
    deviceCode: string,
    options?: PollDeviceTokenOptions,
  ): Promise<DeviceTokenSuccess>;
  /**
   * Redeems the refresh token through the account service for a rotated
   * pair. A 401 means the session is terminally dead (only a fresh sign-in
   * recovers); a 5xx says nothing about the token.
   */
  refreshAccessToken(options: RefreshAccessTokenOptions): Promise<DeviceTokenSuccess>;
}

export function createAccountClient(options: CreateAccountClientOptions): AccountClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  /**
   * The error a failed response represents. Tried in order of specificity:
   * `organization_required` also decodes as the generic error body (it is a
   * real error code), so checking it second would collapse a recoverable
   * workspace prompt into an opaque 403.
   */
  async function toRequestError(
    response: Response,
  ): Promise<AccountApiError | OrganizationRequiredError | EmailVerificationRequiredError> {
    const raw: unknown = await response.json().catch(() => null);

    const organizationRequired = Schema.decodeUnknownOption(OrganizationRequiredBody)(raw);
    if (Option.isSome(organizationRequired)) {
      return new OrganizationRequiredError({
        message: organizationRequired.value.message,
        organizations: organizationRequired.value.organizations,
      });
    }

    // Like organization_required: the richer body also decodes as the generic
    // one, so it must be tried first or the recoverable refusal collapses
    // into an opaque 403.
    const verificationRequired = Schema.decodeUnknownOption(EmailVerificationRequiredBody)(raw);
    if (Option.isSome(verificationRequired)) {
      return new EmailVerificationRequiredError({
        message: verificationRequired.value.message,
        pendingAuthenticationToken: verificationRequired.value.pendingAuthenticationToken,
        email: verificationRequired.value.email,
        emailVerificationId: verificationRequired.value.emailVerificationId,
      });
    }

    const decoded = Schema.decodeUnknownOption(AccountErrorBody)(raw);
    if (Option.isSome(decoded)) {
      return new AccountApiError({
        code: decoded.value.error,
        status: response.status,
        message: decoded.value.message,
      });
    }

    if (raw !== null && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const message =
        typeof obj.message === "string"
          ? obj.message
          : typeof obj.error_description === "string"
            ? obj.error_description
            : undefined;
      if (message !== undefined) {
        const code = typeof obj.error === "string" ? obj.error : undefined;
        return new AccountApiError({
          code:
            code !== undefined && Schema.is(AccountErrorCodeSchema)(code) ? code : "internal_error",
          status: response.status,
          message,
        });
      }
    }

    return new AccountApiError({
      code: "internal_error",
      status: response.status,
      message: `Request failed with status ${response.status}`,
    });
  }

  /**
   * One bounded attempt. A timeout becomes a 408 {@link AccountApiError} —
   * the transient classification (`withFreshAccessToken` treats 408 as "the
   * provider did not answer", never as a refusal of the stored session), and
   * a message that names only the path, since request bodies on credential
   * routes carry secrets.
   */
  async function boundedFetch(
    path: string,
    init: RequestInit,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    try {
      return await fetchFn(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new AccountApiError({
          code: "internal_error",
          status: 408,
          message: `Request to ${path} timed out`,
        });
      }
      throw error;
    }
  }

  async function requestJson<S extends Schema.Top & { readonly DecodingServices: never }>(
    path: string,
    init: RequestInit,
    schema: S,
    timeoutMs?: number,
  ): Promise<S["Type"]> {
    const response = await boundedFetch(path, init, timeoutMs);
    if (!response.ok) {
      throw await toRequestError(response);
    }
    const json: unknown = await response.json();
    return Schema.decodeUnknownSync(schema)(json);
  }

  async function requestEmpty(path: string, init: RequestInit): Promise<void> {
    const response = await boundedFetch(path, init);
    if (!response.ok) {
      throw await toRequestError(response);
    }
  }

  return {
    async instance() {
      return requestJson("/api/v1/instance", { method: "GET" }, InstanceInfoSchema);
    },

    async sendOtp(request) {
      return requestJson(
        "/api/v1/auth/otp/send",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        OtpSendResponseSchema,
      );
    },

    async authenticateOtp(request) {
      return requestJson(
        "/api/v1/auth/otp/authenticate",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        AuthTokensResponseSchema,
        // Grant-consuming: never abort before the service's upstream deadline.
        GRANT_REQUEST_TIMEOUT_MS,
      );
    },

    async verifyEmail(request) {
      return requestJson(
        "/api/v1/auth/verify-email",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        AuthTokensResponseSchema,
        GRANT_REQUEST_TIMEOUT_MS,
      );
    },

    async requestAuthorizeUrl(request) {
      return withProxySkewError(
        requestJson(
          "/api/v1/auth/authorize",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
          AuthorizeUrlResponseSchema,
        ),
      );
    },

    async exchangeAuthorizeCode(request) {
      return withProxySkewError(
        requestJson(
          "/api/v1/auth/authorize/token",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
          },
          AuthTokensResponseSchema,
          // Grant-consuming: the authorization code is single-use.
          GRANT_REQUEST_TIMEOUT_MS,
        ),
      );
    },

    async resendVerificationEmail(request) {
      await requestEmpty("/api/v1/auth/resend-verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    },

    async me(token) {
      return requestJson(
        "/api/v1/me",
        { method: "GET", headers: authHeaders(token) },
        AccountMeSchema,
      );
    },

    async updateProfile(token, request) {
      return requestJson(
        "/api/v1/profile",
        {
          method: "PUT",
          headers: { ...authHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        AccountMeSchema,
      );
    },

    async updateOrganization(token, request) {
      return requestJson(
        "/api/v1/organization",
        {
          method: "PATCH",
          headers: { ...authHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        AccountMeSchema,
      );
    },

    async listHosts(token) {
      return requestJson(
        "/api/v1/hosts",
        { method: "GET", headers: authHeaders(token) },
        ListHostsResponseSchema,
      );
    },

    async registerHost(token, request) {
      return requestJson(
        "/api/v1/hosts",
        {
          method: "POST",
          headers: { ...authHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        RegisterHostResponseSchema,
      );
    },

    async updateHost(hostToken, hostId, request) {
      const decoded = await requestJson(
        `/api/v1/hosts/${encodeURIComponent(hostId)}`,
        {
          method: "PATCH",
          headers: { ...authHeaders(hostToken), "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        UpdateHostResponse,
      );
      return decoded.host;
    },

    async deleteHost(token, hostId) {
      await requestEmpty(`/api/v1/hosts/${encodeURIComponent(hostId)}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
    },

    async requestDeviceCode() {
      return requestJson(
        "/api/v1/auth/device",
        { method: "POST" },
        DeviceAuthorizationResponseSchema,
      );
    },

    async pollDeviceToken(deviceCode, pollOptions = {}) {
      let interval = pollOptions.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS;
      const deadlineMs = (pollOptions.expiresIn ?? DEFAULT_DEVICE_POLL_TIMEOUT_SECONDS) * 1000;
      // Two clocks, both bounding the loop. Accumulated planned sleep is the
      // deterministic bound (it advances even under an injected instant
      // sleep); the wall clock also counts request time, so a sequence of
      // slow attempts still stops at the provider-issued absolute expiry
      // instead of stretching the authorization's life client-side.
      const deadlineAt = Date.now() + deadlineMs;
      let elapsedMs = 0;

      const expired = () => elapsedMs > deadlineMs || Date.now() > deadlineAt;
      const timedOut = () =>
        new AccountApiError({
          code: "internal_error",
          status: 408,
          message: "Device authorization timed out",
        });

      for (;;) {
        await sleep(interval * 1000);
        elapsedMs += interval * 1000;

        // Client-side bound: without this, a misbehaving server that never
        // returns a terminal status would keep this loop running forever.
        if (expired()) throw timedOut();

        // Proxied through the account service — the client never talks to
        // the identity provider directly, so a self-hosted or generic-OIDC
        // backend needs no client change. Non-granted outcomes are values on
        // a 200; a thrown error here is a real fault, never flow state.
        let poll;
        try {
          poll = await withProxySkewError(
            requestJson(
              "/api/v1/auth/device/token",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ deviceCode }),
              },
              DeviceTokenPollResponseSchema,
              // Each attempt may be the one that redeems the single-use
              // device code, so it gets the grant deadline.
              GRANT_REQUEST_TIMEOUT_MS,
            ),
          );
        } catch (error) {
          // Polling is idempotent, so a transient fault (a timed-out
          // attempt, a provider blip) is retried on the next tick rather
          // than aborting a sign-in the user may be mid-way through
          // approving. The deadlines above still bound the loop; anything
          // terminal propagates.
          if (isRetryablePollFailure(error) && !expired()) continue;
          throw error;
        }

        if (poll.status === "granted") {
          return poll.tokens;
        }
        if (poll.status === "pending") {
          continue;
        }
        if (poll.status === "slow_down") {
          // RFC 8628 section 3.5: increase the polling interval by at least
          // 5 seconds for each slow_down.
          interval += SLOW_DOWN_INCREMENT_SECONDS;
          continue;
        }
        throw new AccountApiError({
          code: "unauthorized",
          status: 401,
          message:
            poll.status === "denied"
              ? "The sign-in was denied"
              : "The sign-in attempt expired — start a new one",
        });
      }
    },

    async refreshAccessToken(refreshOptions) {
      const refreshed = await withProxySkewError(
        requestJson(
          "/api/v1/auth/refresh",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              refreshToken: refreshOptions.refreshToken,
              ...(refreshOptions.organizationId
                ? { organizationId: refreshOptions.organizationId }
                : {}),
            }),
          },
          RefreshTokenResponseSchema,
          // Grant-consuming: the refresh token is single-use.
          GRANT_REQUEST_TIMEOUT_MS,
        ),
      );
      // Only meaningful when the service echoed the field; an absent echo is
      // not evidence of a mismatch.
      if (
        refreshOptions.organizationId !== undefined &&
        refreshOptions.organizationId.length > 0 &&
        typeof refreshed.organizationId === "string" &&
        refreshed.organizationId !== refreshOptions.organizationId
      ) {
        throw new AccountApiError({
          code: "internal_error",
          status: 502,
          message: `Refresh returned a token for organization ${refreshed.organizationId}, not the requested ${refreshOptions.organizationId}`,
        });
      }
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        user: refreshed.user,
      };
    },
  };
}
