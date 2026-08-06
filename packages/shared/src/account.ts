import {
  AccountErrorCode as AccountErrorCodeSchema,
  type AccountErrorCode,
  AccountErrorBody,
  AccountHost,
  type AccountMe,
  AccountMe as AccountMeSchema,
  type DeviceAuthorizationResponse,
  DeviceAuthorizationResponse as DeviceAuthorizationResponseSchema,
  type InstanceInfo,
  InstanceInfo as InstanceInfoSchema,
  type ListHostsResponse,
  ListHostsResponse as ListHostsResponseSchema,
  OrganizationRequiredBody,
  type OrganizationSummary,
  type RegisterHostRequest,
  type RegisterHostResponse,
  RegisterHostResponse as RegisterHostResponseSchema,
  TrimmedNonEmptyString,
  type UpdateHostRequest,
} from "@synara/contracts";
import { Option, Schema } from "effect";

const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: on `slow_down`, the client must increase its polling
// interval by at least 5 seconds for each subsequent request.
const SLOW_DOWN_INCREMENT_SECONDS = 5;
// Bounds the poll loop even if the server never returns a terminal status
// (expired_token, access_denied, ...). 30 minutes comfortably exceeds any
// device-code TTL the server is expected to configure.
const DEFAULT_DEVICE_POLL_TIMEOUT_SECONDS = 30 * 60;

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

/** The identity of the WorkOS client the CLI authenticates as, from `/instance`. */
export interface WorkosClientOptions {
  clientId: string;
  workosApiUrl: string;
}

export interface DeviceTokenSuccess {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name?: string };
}

/**
 * The subset of WorkOS's authenticate response this client depends on, decoded
 * rather than cast: an unannounced shape change must fail loudly here instead
 * of persisting `undefined` as someone's access token.
 */
const WorkosAuthenticateSuccess = Schema.Struct({
  // Trimmed-nonempty, not merely a string: a present-but-blank token decodes
  // fine and would be persisted as a live-looking session that fails on every
  // later call, with nothing pointing back here.
  access_token: TrimmedNonEmptyString,
  refresh_token: TrimmedNonEmptyString,
  /**
   * Echoed by WorkOS when the grant named an organization. Optional because it
   * is absent from an org-less refresh and from the device grant; when it *is*
   * present the caller checks it against what was asked for.
   */
  organization_id: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    first_name: Schema.optional(Schema.NullOr(Schema.String)),
    last_name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
type WorkosAuthenticateSuccess = typeof WorkosAuthenticateSuccess.Type;

interface DeviceErrorBody {
  error: string;
  error_description: string;
}

function isDeviceErrorBody(value: unknown): value is DeviceErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).error === "string" &&
    typeof (value as Record<string, unknown>).error_description === "string"
  );
}

/**
 * Maps a WorkOS OAuth error response to an `AccountApiError`. OAuth error
 * codes (`invalid_grant`, `expired_token`, `access_denied`, ...) aren't part
 * of the `AccountErrorCode` contract, so they always surface as
 * `internal_error` — callers that need to distinguish cases should match on
 * `message`, which carries the raw `error_description`.
 */
function toDeviceApiError(response: Response, raw: unknown): AccountApiError {
  const description = isDeviceErrorBody(raw) ? raw.error_description : undefined;
  return new AccountApiError({
    code: "internal_error",
    status: response.status,
    message: description ?? `Request failed with status ${response.status}`,
  });
}

/**
 * WorkOS returns the user's name split in two, either half of which can be
 * absent. Recombining here keeps every caller from re-deciding what to do with
 * a half-populated name.
 */
function toDeviceTokenSuccess(raw: unknown, expectedOrganizationId?: string): DeviceTokenSuccess {
  const body: WorkosAuthenticateSuccess = Schema.decodeUnknownSync(WorkosAuthenticateSuccess)(raw);
  // Only meaningful when WorkOS echoed the field; it omits it for an org-less
  // grant, and an absent value is not evidence of a mismatch.
  if (
    expectedOrganizationId !== undefined &&
    expectedOrganizationId.length > 0 &&
    typeof body.organization_id === "string" &&
    body.organization_id !== expectedOrganizationId
  ) {
    throw new AccountApiError({
      code: "internal_error",
      status: 502,
      message: `Refresh returned a token for organization ${body.organization_id}, not the requested ${expectedOrganizationId}`,
    });
  }
  const name = [body.user.first_name, body.user.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    user: {
      id: body.user.id,
      email: body.user.email,
      ...(name.length > 0 ? { name } : {}),
    },
  };
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface CreateAccountClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  sleep?: SleepFn;
}

export interface PollDeviceTokenOptions extends WorkosClientOptions {
  interval?: number;
  expiresIn?: number;
}

export interface RefreshAccessTokenOptions extends WorkosClientOptions {
  refreshToken: string;
  /**
   * Which workspace to authenticate into. WorkOS puts the resulting `org_id`
   * claim in the access token, and the account authorizes on that claim alone
   * — so a refresh without this yields a token the host routes will refuse.
   */
  organizationId?: string;
}

export interface AccountClient {
  instance(): Promise<InstanceInfo>;
  me(token: string): Promise<AccountMe>;
  listHosts(token: string): Promise<ListHostsResponse>;
  registerHost(token: string, request: RegisterHostRequest): Promise<RegisterHostResponse>;
  updateHost(hostToken: string, hostId: string, request: UpdateHostRequest): Promise<AccountHost>;
  deleteHost(token: string, hostId: string): Promise<void>;
  requestDeviceCode(): Promise<DeviceAuthorizationResponse>;
  pollDeviceToken(deviceCode: string, options: PollDeviceTokenOptions): Promise<DeviceTokenSuccess>;
  refreshAccessToken(options: RefreshAccessTokenOptions): Promise<DeviceTokenSuccess>;
}

export function createAccountClient(options: CreateAccountClientOptions): AccountClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  /**
   * The device-grant poll and the refresh grant both go straight to WorkOS
   * rather than through this instance: only the initial authorization request
   * needs the API key the service holds.
   */
  function workosAuthenticate(
    workosApiUrl: string,
    body: Record<string, string>,
  ): Promise<Response> {
    return fetchFn(`${workosApiUrl.replace(/\/+$/, "")}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * The error a failed response represents. Tried in order of specificity:
   * `organization_required` also decodes as the generic error body (it is a
   * real error code), so checking it second would collapse a recoverable
   * workspace prompt into an opaque 403.
   */
  async function toRequestError(
    response: Response,
  ): Promise<AccountApiError | OrganizationRequiredError> {
    const raw: unknown = await response.json().catch(() => null);

    const organizationRequired = Schema.decodeUnknownOption(OrganizationRequiredBody)(raw);
    if (Option.isSome(organizationRequired)) {
      return new OrganizationRequiredError({
        message: organizationRequired.value.message,
        organizations: organizationRequired.value.organizations,
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

  async function requestJson<S extends Schema.Top & { readonly DecodingServices: never }>(
    path: string,
    init: RequestInit,
    schema: S,
  ): Promise<S["Type"]> {
    const response = await fetchFn(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw await toRequestError(response);
    }
    const json: unknown = await response.json();
    return Schema.decodeUnknownSync(schema)(json);
  }

  async function requestEmpty(path: string, init: RequestInit): Promise<void> {
    const response = await fetchFn(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw await toRequestError(response);
    }
  }

  return {
    async instance() {
      return requestJson("/api/v1/instance", { method: "GET" }, InstanceInfoSchema);
    },

    async me(token) {
      return requestJson(
        "/api/v1/me",
        { method: "GET", headers: authHeaders(token) },
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

    async pollDeviceToken(deviceCode, pollOptions) {
      let interval = pollOptions.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS;
      const deadlineMs = (pollOptions.expiresIn ?? DEFAULT_DEVICE_POLL_TIMEOUT_SECONDS) * 1000;
      let elapsedMs = 0;

      for (;;) {
        await sleep(interval * 1000);
        elapsedMs += interval * 1000;

        // Client-side bound: without this, a misbehaving server that never
        // returns a terminal status (only `authorization_pending`) would
        // keep this loop running forever.
        if (elapsedMs > deadlineMs) {
          throw new AccountApiError({
            code: "internal_error",
            status: 408,
            message: "Device authorization timed out",
          });
        }

        const response = await workosAuthenticate(pollOptions.workosApiUrl, {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: pollOptions.clientId,
        });

        if (response.ok) {
          return toDeviceTokenSuccess(await response.json());
        }

        const raw: unknown = await response.json().catch(() => null);
        if (isDeviceErrorBody(raw)) {
          if (raw.error === "authorization_pending") {
            continue;
          }
          if (raw.error === "slow_down") {
            interval += SLOW_DOWN_INCREMENT_SECONDS;
            continue;
          }
        }

        throw toDeviceApiError(response, raw);
      }
    },

    async refreshAccessToken(refreshOptions) {
      const response = await workosAuthenticate(refreshOptions.workosApiUrl, {
        grant_type: "refresh_token",
        refresh_token: refreshOptions.refreshToken,
        client_id: refreshOptions.clientId,
        ...(refreshOptions.organizationId
          ? { organization_id: refreshOptions.organizationId }
          : {}),
      });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw toDeviceApiError(response, raw);
      }
      return toDeviceTokenSuccess(raw, refreshOptions.organizationId);
    },
  };
}
