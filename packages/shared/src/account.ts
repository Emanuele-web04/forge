import {
  AccountErrorCode as AccountErrorCodeSchema,
  type AccountErrorCode,
  AccountErrorBody,
  AccountHost,
  type AccountMe,
  AccountMe as AccountMeSchema,
  type InstanceInfo,
  InstanceInfo as InstanceInfoSchema,
  type ListHostsResponse,
  ListHostsResponse as ListHostsResponseSchema,
  type ListSessionsResponse,
  ListSessionsResponse as ListSessionsResponseSchema,
  type RegisterHostRequest,
  type RegisterHostResponse,
  RegisterHostResponse as RegisterHostResponseSchema,
  type UpdateHostRequest,
} from "@synara/contracts";
import { Option, Schema } from "effect";

const DEVICE_CLIENT_ID = "synara-cli";
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 section 3.5: on `slow_down`, the client must increase its polling
// interval by at least 5 seconds for each subsequent request.
const SLOW_DOWN_INCREMENT_SECONDS = 5;

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

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
}

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
  clientId?: string;
}

export interface AccountClient {
  instance(): Promise<InstanceInfo>;
  me(token: string): Promise<AccountMe>;
  listHosts(token: string): Promise<ListHostsResponse>;
  registerHost(token: string, request: RegisterHostRequest): Promise<RegisterHostResponse>;
  updateHost(hostToken: string, hostId: string, request: UpdateHostRequest): Promise<AccountHost>;
  deleteHost(token: string, hostId: string): Promise<void>;
  listSessions(token: string): Promise<ListSessionsResponse>;
  deleteSession(token: string, sessionId: string): Promise<void>;
  requestDeviceCode(): Promise<DeviceCodeResponse>;
  pollDeviceToken(deviceCode: string, options?: { interval?: number }): Promise<DeviceTokenSuccess>;
}

export function createAccountClient(options: CreateAccountClientOptions): AccountClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const clientId = options.clientId ?? DEVICE_CLIENT_ID;

  async function toAccountApiError(response: Response): Promise<AccountApiError> {
    const raw: unknown = await response.json().catch(() => null);

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
      throw await toAccountApiError(response);
    }
    const json: unknown = await response.json();
    return Schema.decodeUnknownSync(schema)(json);
  }

  async function requestEmpty(path: string, init: RequestInit): Promise<void> {
    const response = await fetchFn(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw await toAccountApiError(response);
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

    async listSessions(token) {
      return requestJson(
        "/api/v1/sessions",
        { method: "GET", headers: authHeaders(token) },
        ListSessionsResponseSchema,
      );
    },

    async deleteSession(token, sessionId) {
      await requestEmpty(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: authHeaders(token),
      });
    },

    async requestDeviceCode() {
      const response = await fetchFn(`${baseUrl}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
      });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const description = isDeviceErrorBody(raw) ? raw.error_description : undefined;
        throw new AccountApiError({
          code: "internal_error",
          status: response.status,
          message: description ?? `Request failed with status ${response.status}`,
        });
      }
      const body = raw as {
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete: string;
        expires_in: number;
        interval: number;
      };
      return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        verificationUriComplete: body.verification_uri_complete,
        expiresIn: body.expires_in,
        interval: body.interval,
      };
    },

    async pollDeviceToken(deviceCode, pollOptions) {
      let interval = pollOptions?.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS;

      for (;;) {
        await sleep(interval * 1000);

        const response = await fetchFn(`${baseUrl}/api/auth/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: clientId,
          }),
        });

        if (response.ok) {
          const body = (await response.json()) as {
            access_token: string;
            token_type: string;
            expires_in: number;
            scope: string;
          };
          return {
            accessToken: body.access_token,
            tokenType: body.token_type,
            expiresIn: body.expires_in,
            scope: body.scope,
          };
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
          throw new AccountApiError({
            code: "internal_error",
            status: response.status,
            message: raw.error_description,
          });
        }

        throw new AccountApiError({
          code: "internal_error",
          status: response.status,
          message: `Device token request failed with status ${response.status}`,
        });
      }
    },
  };
}
