import type { EnvironmentId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { AccountApiError, createAccountClient, OrganizationRequiredError } from "./account";

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

function refreshedBody() {
  return {
    accessToken: "access-2",
    refreshToken: "refresh-2",
    user: { id: "user_1", email: "ada@example.com", name: "Ada" },
  };
}

function refreshedResponse(): Response {
  return jsonResponse(refreshedBody());
}

describe("createAccountClient", () => {
  describe("instance", () => {
    it("decodes a valid instance info response", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          version: "1.2.3",
          authMode: "workos",
          clientId: "client_01ABC",
          workosApiUrl: "https://api.workos.com",
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.instance();

      expect(result).toEqual({
        version: "1.2.3",
        authMode: "workos",
        clientId: "client_01ABC",
        workosApiUrl: "https://api.workos.com",
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
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          organization: { id: "org_1", name: "Personal" },
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.me("device-token-1");

      expect(result).toEqual({
        id: "u1",
        name: "Ada",
        email: "ada@example.com",
        organization: { id: "org_1", name: "Personal" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/me`,
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: "Bearer device-token-1" }),
        }),
      );
    });

    // The organization is what the caller acts inside; a response missing it
    // means the server did not resolve one, which is not a usable session.
    it("rejects a response with no organization", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ id: "u1", name: "Ada", email: "ada@example.com" }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.me("device-token-1")).rejects.toThrow();
    });

    it("throws OrganizationRequiredError with the choices on a 403", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: "organization_required",
            message: "Pick a workspace",
            organizations: [
              { id: "org_1", name: "Personal" },
              { id: "org_2", name: "Acme" },
            ],
          },
          { status: 403 },
        ),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const error = await client.me("orgless-token").catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(OrganizationRequiredError);
      // Not an AccountApiError: the caller recovers by refreshing into one of
      // these, and the generic branch would have hidden the list entirely.
      expect(error).not.toBeInstanceOf(AccountApiError);
      expect((error as OrganizationRequiredError).organizations).toEqual([
        { id: "org_1", name: "Personal" },
        { id: "org_2", name: "Acme" },
      ]);
      expect((error as Error).message).toBe("Pick a workspace");
    });

    it("throws OrganizationRequiredError even when the choice list is empty", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "organization_required", message: "No workspace", organizations: [] },
            { status: 403 },
          ),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.me("orgless-token")).rejects.toBeInstanceOf(OrganizationRequiredError);
    });

    // A 403 that is not about organizations must stay an AccountApiError, or
    // the CLI would prompt for a workspace over an unrelated refusal.
    it("keeps an ordinary 403 as an AccountApiError", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: "token_revoked", message: "Revoked" }, { status: 403 }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const error = await client.me("revoked").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AccountApiError);
      expect(error).not.toBeInstanceOf(OrganizationRequiredError);
    });

    it("raises the organization prompt from every route, not just /me", async () => {
      const body = {
        error: "organization_required",
        message: "Pick a workspace",
        organizations: [{ id: "org_1", name: "Personal" }],
      };
      // A fresh Response per call: a body can only be read once, so a shared
      // one would make the second assertion fail for the wrong reason.
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(body, { status: 403 })));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.listHosts("t")).rejects.toBeInstanceOf(OrganizationRequiredError);
      await expect(client.deleteHost("t", "host_1")).rejects.toBeInstanceOf(
        OrganizationRequiredError,
      );
      await expect(
        client.startHostLink("t", {
          environmentId: ENVIRONMENT_ID,
          name: "Mac",
          platform: "darwin",
          kind: "local",
        }),
      ).rejects.toBeInstanceOf(OrganizationRequiredError);
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

    // A hung endpoint must fail the one attempt at the per-attempt deadline
    // — never pin the caller. Every request carries an abort signal, and the
    // platform's timeout abort surfaces as a transient 408 whose message
    // names only the path (request bodies on credential routes carry
    // secrets).
    it("arms every request with a timeout signal and maps its abort to a transient 408", async () => {
      const seenSignals: Array<AbortSignal | null | undefined> = [];
      const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        seenSignals.push(init.signal);
        // What undici throws when the AbortSignal.timeout fires mid-request.
        return Promise.reject(new DOMException("The operation timed out", "TimeoutError"));
      });
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.me("access-1")).rejects.toMatchObject({
        code: "internal_error",
        status: 408,
        message: "Request to /api/v1/me timed out",
      });
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
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
        ownerUserId: "user_1",
        discoverable: true,
        linked: true,
        keyGeneration: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ hosts: [host] }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.listHosts("device-token-1");

      expect(result).toEqual({ hosts: [host] });
    });
  });

  describe("host link and HostProof routes", () => {
    it("starts and completes the nonce-row link flow without a challenge JWT", async () => {
      const host = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        environmentId: "env-1",
        name: "my-mac",
        platform: "darwin",
        kind: "local",
        endpoints: [],
        ownerUserId: "user_1",
        discoverable: true,
        linked: true,
        keyGeneration: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            challengeId: "550e8400-e29b-41d4-a716-446655440001",
            nonce: "nonce",
            hostId: host.id,
            expiresAt: "2026-01-01T00:10:00.000Z",
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ host }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const request = {
        environmentId: ENVIRONMENT_ID,
        name: "my-mac",
        platform: "darwin" as const,
        kind: "local" as const,
      };
      const started = await client.startHostLink("device-token-1", request);
      const result = await client.completeHostLink({
        challengeId: started.challengeId,
        proof: "signed-host-link-proof",
      });

      expect(started).not.toHaveProperty("challengeJwt");
      expect(result).toEqual({ host });
      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("expected fetch to have been called");
      expect(call[0]).toBe(`${BASE_URL}/api/v1/hosts/link/start`);
      expect(call[1]).toMatchObject({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer device-token-1",
          "content-type": "application/json",
        }),
      });
      expect(JSON.parse(call[1].body as string)).toEqual(request);
      expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE_URL}/api/v1/hosts/link/complete`);
      expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("headers.authorization");
    });

    it("supports the complete device-code challenge flow", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            deviceCode: "device_code",
            userCode: "ABCDEFGH",
            verificationUri: "https://app.example/link",
            expiresAt: "2026-01-01T00:10:00.000Z",
            interval: 5,
          }),
        )
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(
          jsonResponse({
            challengeId: "550e8400-e29b-41d4-a716-446655440001",
            nonce: "nonce",
          }),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const device = await client.startDeviceHostLink();
      await client.approveDeviceHostLink("session-token", { userCode: device.userCode });
      const challenge = await client.exchangeDeviceHostLink({ deviceCode: device.deviceCode });

      expect(challenge.nonce).toBe("nonce");
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        `${BASE_URL}/api/v1/hosts/link/device`,
        `${BASE_URL}/api/v1/hosts/link/approve`,
        `${BASE_URL}/api/v1/hosts/link/device/token`,
      ]);
    });

    it("uses HostProof authentication for host lifecycle calls", async () => {
      const host = {
        id: "550e8400-e29b-41d4-a716-446655440000",
        environmentId: "env-1",
        name: "renamed",
        platform: "darwin",
        kind: "local",
        endpoints: [],
        ownerUserId: "user_1",
        discoverable: true,
        linked: true,
        keyGeneration: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ host }))
        .mockResolvedValueOnce(jsonResponse({ ticket: "relay-ticket" }))
        .mockResolvedValueOnce(
          jsonResponse({
            discoverable: true,
            ownerUserId: "user_1",
            orgId: "org_1",
            ownerInOrg: true,
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ host }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await client.replaceHostEndpoints("proof", host.id, []);
      await client.requestRelayTicket("proof", host.id);
      await client.getHostAuthorization("proof", host.id);
      await client.unlinkHost("proof", host.id);

      for (const [, init] of fetchMock.mock.calls) {
        expect(init.headers).toEqual(expect.objectContaining({ authorization: "HostProof proof" }));
      }
    });
  });

  describe("updateHost", () => {
    it("patches with an owner session and returns the updated host", async () => {
      const host = {
        id: "h1",
        environmentId: "env-1",
        name: "renamed",
        platform: "darwin",
        kind: "local",
        endpoints: [],
        ownerUserId: "user_1",
        discoverable: true,
        linked: true,
        keyGeneration: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      };
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ host }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      expect(await client.updateHost("session-token", "h1", { name: "renamed" })).toEqual(host);
      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/hosts/h1`,
        expect.objectContaining({
          method: "PATCH",
          headers: expect.objectContaining({ authorization: "Bearer session-token" }),
        }),
      );
    });
  });

  describe("deleteHost", () => {
    it("uses the owner session as a bearer header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(204));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await client.deleteHost("session-token", "h1");

      expect(fetchMock).toHaveBeenCalledWith(
        `${BASE_URL}/api/v1/hosts/h1`,
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({ authorization: "Bearer session-token" }),
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

  describe("refreshAccessToken", () => {
    it("posts the refresh to the account service and returns the rotated pair", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          accessToken: "access-2",
          refreshToken: "refresh-2",
          user: { id: "user_1", email: "ada@example.com", name: "Ada" },
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      const result = await client.refreshAccessToken({ refreshToken: "refresh-1" });

      expect(result).toEqual({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        user: { id: "user_1", email: "ada@example.com", name: "Ada" },
      });
      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("expected fetch to have been called");
      // Proxied, like the poll: the provider is invisible on this wire.
      expect(call[0]).toBe(`${BASE_URL}/api/v1/auth/refresh`);
      expect(JSON.parse(call[1].body as string)).toEqual({ refreshToken: "refresh-1" });
    });

    // The account authorizes on the organization claim alone, and the
    // provider only mints it when the grant names an organization. Dropping
    // this field is how a refresh silently produces a token every host route
    // then refuses.
    it("sends organizationId when a workspace is named", async () => {
      const fetchMock = vi.fn().mockResolvedValue(refreshedResponse());
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await client.refreshAccessToken({ refreshToken: "refresh-1", organizationId: "org_42" });

      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("expected fetch to have been called");
      expect(JSON.parse(call[1].body as string)).toEqual({
        refreshToken: "refresh-1",
        organizationId: "org_42",
      });
    });

    // Omitted rather than sent empty: a blank organizationId fails schema
    // validation server-side, where an absent one is the ordinary org-less
    // refresh.
    it("omits organizationId entirely when none is given", async () => {
      const fetchMock = vi.fn().mockResolvedValue(refreshedResponse());
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await client.refreshAccessToken({ refreshToken: "refresh-1", organizationId: "" });

      const call = fetchMock.mock.calls[0];
      if (call === undefined) throw new Error("expected fetch to have been called");
      expect(JSON.parse(call[1].body as string)).not.toHaveProperty("organizationId");
    });

    it("throws instead of returning undefined tokens when the success body loses a field", async () => {
      // Persisting `undefined` as an access token would look like a signed-in
      // session that fails on every later call, with nothing pointing here.
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          accessToken: "access-2",
          user: { id: "user_1", email: "ada@example.com" },
        }),
      );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.refreshAccessToken({ refreshToken: "refresh-1" })).rejects.toThrow();
    });

    // A blank or whitespace token decodes as a string but is not a credential.
    // Storing one produces a session that looks live and fails every call.
    it.each([
      ["accessToken", { accessToken: "   " }],
      ["refreshToken", { refreshToken: "" }],
    ])("throws when %s is present but blank", async (_field, override) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ ...refreshedBody(), ...override }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.refreshAccessToken({ refreshToken: "refresh-1" })).rejects.toThrow();
    });

    /**
     * The whole point of naming an organization is the claim the resulting
     * token carries. If the service answers with a different organization
     * than the one asked for, persisting the pair would silently put this
     * machine in the wrong workspace — with the caller believing otherwise.
     */
    it("throws rather than returning a token for a different organization", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ ...refreshedBody(), organizationId: "org_other" }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(
        client.refreshAccessToken({ refreshToken: "refresh-1", organizationId: "org_42" }),
      ).rejects.toThrow(/organization/i);
    });

    it("accepts a response echoing the organization that was requested", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ ...refreshedBody(), organizationId: "org_42" }));
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(
        client.refreshAccessToken({ refreshToken: "refresh-1", organizationId: "org_42" }),
      ).resolves.toMatchObject({ accessToken: expect.any(String) });
    });

    // The service does not always echo the field; its absence is not a
    // mismatch.
    it("accepts a response that omits organizationId", async () => {
      const fetchMock = vi.fn().mockResolvedValue(refreshedResponse());
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(
        client.refreshAccessToken({ refreshToken: "refresh-1", organizationId: "org_42" }),
      ).resolves.toMatchObject({ accessToken: expect.any(String) });
    });

    it("throws AccountApiError with the service's message when the refresh token is spent", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { error: "unauthorized", message: "The session has expired — sign in again" },
            { status: 401 },
          ),
        );
      const client = createAccountClient({ baseUrl: BASE_URL, fetch: fetchMock });

      await expect(client.refreshAccessToken({ refreshToken: "burned" })).rejects.toMatchObject({
        code: "unauthorized",
        status: 401,
        message: "The session has expired — sign in again",
      });
    });
  });
});
