import type { EnvironmentId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { AccountApiError, createAccountClient } from "./account";

const ENVIRONMENT_ID = "env-1" as EnvironmentId;

const BASE_URL = "https://account.example.com";

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

describe("createAccountClient", () => {
  describe("instance", () => {
    it("decodes a valid instance info response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          version: "1.2.3",
          authMethods: { emailPassword: true, social: ["github"] },
          emailDelivery: true,
          signupRestricted: false,
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.instance();

      expect(result).toEqual({
        version: "1.2.3",
        authMethods: { emailPassword: true, social: ["github"] },
        emailDelivery: true,
        signupRestricted: false,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/instance`,
        expect.objectContaining({ method: "GET" }),
      );
    });

    it("throws AccountApiError with the decoded code on an error body", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "internal_error", message: "boom" }, { status: 500 }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.instance()).rejects.toMatchObject({
        code: "internal_error",
        status: 500,
        message: "boom",
      });
    });

    it("maps a non-JSON error body to code internal_error with the raw status", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response("not json", {
          status: 502,
          headers: { "content-type": "text/plain" },
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.instance()).rejects.toBeInstanceOf(AccountApiError);
      const fetchMock2 = vi.fn().mockResolvedValue(
        new Response("not json", {
          status: 502,
          headers: { "content-type": "text/plain" },
        }),
      );
      const client2 = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock2 });
      await expect(client2.instance()).rejects.toMatchObject({
        code: "internal_error",
        status: 502,
      });
    });
  });

  describe("me", () => {
    it("sends the device token as a bearer header and decodes the response", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ id: "u1", name: "Ada", email: "ada@example.com" }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.me("device-token-1");

      expect(result).toEqual({ id: "u1", name: "Ada", email: "ada@example.com" });
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/me`,
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer device-token-1" }),
        }),
      );
    });

    it("throws AccountApiError with code unauthorized on 401", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "unauthorized", message: "Not authenticated" }, { status: 401 }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.me("bad-token")).rejects.toMatchObject({
        code: "unauthorized",
        status: 401,
        message: "Not authenticated",
      });
    });
  });

  describe("listHosts", () => {
    it("decodes a list of hosts", async () => {
      const host = {
        id: "h1",
        environmentId: "env-1",
        name: "my-mac",
        platform: "darwin",
        kind: "local",
        endpoints: [{ url: "http://localhost:1234", transport: "lan" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hosts: [host] }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.listHosts("device-token-1");

      expect(result).toEqual({ hosts: [host] });
    });
  });

  describe("registerHost", () => {
    it("posts the request body and decodes host + hostToken", async () => {
      const host = {
        id: "h1",
        environmentId: "env-1",
        name: "my-mac",
        platform: "darwin",
        kind: "local",
        endpoints: [{ url: "http://localhost:1234", transport: "lan" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ host, hostToken: "synhost_abc" }, { status: 201 }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const request = {
        environmentId: ENVIRONMENT_ID,
        name: "my-mac",
        platform: "darwin" as const,
        kind: "local" as const,
        endpoints: [{ url: "http://localhost:1234", transport: "lan" as const }],
      };
      const result = await client.registerHost("device-token-1", request);

      expect(result).toEqual({ host, hostToken: "synhost_abc" });
      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("expected fetch to have been called");
      expect(call[0]).toBe(`${BASE_URL}/api/v1/hosts`);
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer device-token-1",
          "content-type": "application/json",
        }),
      });
      expect(JSON.parse(call[1].body as string)).toEqual(request);
    });

    it("throws AccountApiError with code environment_already_linked on 409", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "environment_already_linked", message: "already linked" },
            { status: 409 },
          ),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(
        client.registerHost("device-token-1", {
          environmentId: ENVIRONMENT_ID,
          name: "my-mac",
          platform: "darwin",
          kind: "local",
          endpoints: [],
        }),
      ).rejects.toMatchObject({ code: "environment_already_linked", status: 409 });
    });
  });

  describe("updateHost", () => {
    it("patches with the host token and returns the updated host", async () => {
      const host = {
        id: "h1",
        environmentId: "env-1",
        name: "renamed",
        platform: "darwin",
        kind: "local",
        endpoints: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ host }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.updateHost("synhost_abc", "h1", { name: "renamed" });

      expect(result).toEqual(host);
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/hosts/h1`,
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ authorization: "Bearer synhost_abc" }),
        }),
      );
    });
  });

  describe("deleteHost", () => {
    it("sends whichever token it's given as a bearer header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await client.deleteHost("synhost_abc", "h1");

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/hosts/h1`,
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ authorization: "Bearer synhost_abc" }),
        }),
      );
    });

    it("works with a device token too", async () => {
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await client.deleteHost("device-token-1", "h1");

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/hosts/h1`,
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer device-token-1" }),
        }),
      );
    });

    it("throws AccountApiError with code host_not_found on 404", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "host_not_found", message: "Host not found" }, { status: 404 }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.deleteHost("token", "missing")).rejects.toMatchObject({
        code: "host_not_found",
        status: 404,
      });
    });
  });

  describe("requestDeviceCode", () => {
    it("posts to the device code endpoint and returns the typed response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          device_code: "dc1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://account.example.com/device",
          verification_uri_complete: "https://account.example.com/device?user_code=ABCD-EFGH",
          expires_in: 900,
          interval: 5,
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.requestDeviceCode();

      expect(result).toEqual({
        deviceCode: "dc1",
        userCode: "ABCD-EFGH",
        verificationUri: "https://account.example.com/device",
        verificationUriComplete: "https://account.example.com/device?user_code=ABCD-EFGH",
        expiresIn: 900,
        interval: 5,
      });
      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("expected fetch to have been called");
      expect(call[0]).toBe(`${BASE_URL}/api/auth/device/code`);
      expect(JSON.parse(call[1].body as string)).toEqual({ client_id: "synara-cli" });
    });
  });

  describe("pollDeviceToken", () => {
    it("polls through authorization_pending and resolves on success without honoring backoff timing in tests", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { error: "authorization_pending", error_description: "still waiting" },
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            { error: "authorization_pending", error_description: "still waiting" },
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: "session-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "",
          }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock, sleep });

      const result = await client.pollDeviceToken("dc1", { interval: 5 });

      expect(result).toEqual({
        accessToken: "session-token",
        tokenType: "Bearer",
        expiresIn: 3600,
        scope: "",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenNthCalledWith(1, 5000);
      expect(sleep).toHaveBeenNthCalledWith(2, 5000);
      expect(sleep).toHaveBeenNthCalledWith(3, 5000);
    });

    it("increases the interval on slow_down and keeps polling", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ error: "slow_down", error_description: "too fast" }, { status: 400 }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: "session-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "",
          }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock, sleep });

      const result = await client.pollDeviceToken("dc1", { interval: 5 });

      expect(result.accessToken).toBe("session-token");
      expect(sleep).toHaveBeenNthCalledWith(1, 5000);
      expect(sleep).toHaveBeenNthCalledWith(2, 10000);
    });

    it("throws AccountApiError with the error_description on a terminal failure", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "expired_token", error_description: "The device code has expired" },
            { status: 400 },
          ),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock, sleep });

      await expect(client.pollDeviceToken("dc1", { interval: 5 })).rejects.toMatchObject({
        code: "internal_error",
        status: 400,
        message: "The device code has expired",
      });
    });

    it("throws AccountApiError on access_denied", async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "access_denied", error_description: "The user denied the request" },
            { status: 400 },
          ),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock, sleep });

      await expect(client.pollDeviceToken("dc1", { interval: 5 })).rejects.toMatchObject({
        code: "internal_error",
        status: 400,
        message: "The user denied the request",
      });
    });
  });
});
