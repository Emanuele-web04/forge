import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ACCOUNT_ENDPOINT_URL_MAX_LENGTH,
  ACCOUNT_HOST_ENDPOINTS_MAX,
  ACCOUNT_NAME_MAX_LENGTH,
  AccountErrorBody,
  AccountHost,
  AccountMe,
  InstanceInfo,
  OrganizationRequiredBody,
  RegisterHostRequest,
  UpdateProfileRequest,
} from "./account";

const decodeRegisterHostRequest = Schema.decodeUnknownSync(RegisterHostRequest);
const decodeInstanceInfo = Schema.decodeUnknownSync(InstanceInfo);
const decodeAccountHost = Schema.decodeUnknownSync(AccountHost);
const decodeAccountMe = Schema.decodeUnknownSync(AccountMe);
const decodeOrganizationRequired = Schema.decodeUnknownSync(OrganizationRequiredBody);

function endpointAt(index: number) {
  return { url: `https://host-${index}.example.com`, transport: "lan" };
}

function hostPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "host_1",
    environmentId: "env-1",
    name: "My Laptop",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    registeredByUserId: "user_1",
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("RegisterHostRequest", () => {
  it("decodes a valid registration request", () => {
    const parsed = decodeRegisterHostRequest({
      environmentId: "env-1",
      name: "My Laptop",
      platform: "darwin",
      kind: "local",
      endpoints: [{ url: "https://example.com", transport: "lan" }],
    });

    expect(parsed.name).toBe("My Laptop");
    expect(parsed.platform).toBe("darwin");
    expect(parsed.endpoints[0]?.transport).toBe("lan");
    expect(parsed.appVersion).toBeUndefined();
  });

  it("rejects an invalid transport literal", () => {
    expect(() =>
      decodeRegisterHostRequest({
        environmentId: "env-1",
        name: "My Laptop",
        platform: "darwin",
        kind: "local",
        endpoints: [{ url: "https://example.com", transport: "vpn" }],
      }),
    ).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() =>
      decodeRegisterHostRequest({
        environmentId: "env-1",
        name: "",
        platform: "darwin",
        kind: "local",
        endpoints: [{ url: "https://example.com", transport: "lan" }],
      }),
    ).toThrow();
  });

  // Request fields are explicitly bounded; the boundary passes, one-over fails.
  it("accepts a name at the maximum length and rejects one character over", () => {
    const base = {
      environmentId: "env-1",
      platform: "darwin",
      kind: "local",
      endpoints: [],
    };
    expect(
      decodeRegisterHostRequest({ ...base, name: "a".repeat(ACCOUNT_NAME_MAX_LENGTH) }).name,
    ).toHaveLength(ACCOUNT_NAME_MAX_LENGTH);
    expect(() =>
      decodeRegisterHostRequest({ ...base, name: "a".repeat(ACCOUNT_NAME_MAX_LENGTH + 1) }),
    ).toThrow();
  });

  it("caps the endpoints array at the maximum and rejects one entry over", () => {
    const base = {
      environmentId: "env-1",
      name: "My Laptop",
      platform: "darwin",
      kind: "local",
    };
    expect(
      decodeRegisterHostRequest({
        ...base,
        endpoints: Array.from({ length: ACCOUNT_HOST_ENDPOINTS_MAX }, (_, index) =>
          endpointAt(index),
        ),
      }).endpoints,
    ).toHaveLength(ACCOUNT_HOST_ENDPOINTS_MAX);
    expect(() =>
      decodeRegisterHostRequest({
        ...base,
        endpoints: Array.from({ length: ACCOUNT_HOST_ENDPOINTS_MAX + 1 }, (_, index) =>
          endpointAt(index),
        ),
      }),
    ).toThrow();
  });

  it("bounds each endpoint URL", () => {
    const base = {
      environmentId: "env-1",
      name: "My Laptop",
      platform: "darwin",
      kind: "local",
    };
    const prefix = "https://";
    const atLimit = `${prefix}${"a".repeat(ACCOUNT_ENDPOINT_URL_MAX_LENGTH - prefix.length)}`;
    expect(
      decodeRegisterHostRequest({ ...base, endpoints: [{ url: atLimit, transport: "lan" }] })
        .endpoints,
    ).toHaveLength(1);
    expect(() =>
      decodeRegisterHostRequest({
        ...base,
        endpoints: [{ url: `${atLimit}a`, transport: "lan" }],
      }),
    ).toThrow();
  });
});

describe("UpdateProfileRequest", () => {
  it("bounds the display name", () => {
    const base = { handle: "ada", avatarColor: "#22c55e" };
    const decode = Schema.decodeUnknownSync(UpdateProfileRequest);
    expect(
      decode({ ...base, displayName: "a".repeat(ACCOUNT_NAME_MAX_LENGTH) }).displayName,
    ).toHaveLength(ACCOUNT_NAME_MAX_LENGTH);
    expect(() =>
      decode({ ...base, displayName: "a".repeat(ACCOUNT_NAME_MAX_LENGTH + 1) }),
    ).toThrow();
  });
});

describe("AccountHost", () => {
  it("decodes a host carrying its registering user", () => {
    expect(decodeAccountHost(hostPayload()).registeredByUserId).toBe("user_1");
  });

  // The field is the audit trail for who linked a machine to an organization.
  // Optional, it would quietly go missing the moment a writer forgot it.
  it("rejects a host with no registeredByUserId", () => {
    const { registeredByUserId: _omitted, ...withoutUser } = hostPayload();
    expect(() => decodeAccountHost(withoutUser)).toThrow();
  });
});

describe("AccountMe", () => {
  it("decodes the caller with the organization their token is scoped to", () => {
    const parsed = decodeAccountMe({
      id: "user_1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      organization: { id: "org_1", name: "Personal — ada@example.com" },
    });
    expect(parsed.organization).toEqual({ id: "org_1", name: "Personal — ada@example.com" });
  });

  // Every authorized caller is inside an organization by construction, so a
  // response without one means the server skipped the org resolution entirely.
  it("rejects a caller with no organization", () => {
    expect(() =>
      decodeAccountMe({ id: "user_1", name: "Ada Lovelace", email: "ada@example.com" }),
    ).toThrow();
  });
});

describe("OrganizationRequiredBody", () => {
  it("decodes the 403 with the organizations the caller may refresh into", () => {
    const parsed = decodeOrganizationRequired({
      error: "organization_required",
      message: "Pick a workspace",
      organizations: [{ id: "org_1", name: "Personal" }],
    });
    expect(parsed.organizations).toEqual([{ id: "org_1", name: "Personal" }]);
  });

  it("accepts an empty organization list", () => {
    expect(
      decodeOrganizationRequired({
        error: "organization_required",
        message: "No workspace",
        organizations: [],
      }).organizations,
    ).toEqual([]);
  });

  // The client tries this shape before the generic error body, so anything
  // that is merely an error must not pass as one of these.
  it("rejects another error code and a body with no organizations", () => {
    expect(() =>
      decodeOrganizationRequired({
        error: "unauthorized",
        message: "Nope",
        organizations: [],
      }),
    ).toThrow();
    expect(() =>
      decodeOrganizationRequired({ error: "organization_required", message: "Nope" }),
    ).toThrow();
  });

  // Both shapes travel as the body of a 403; only the organizations list tells
  // them apart, and the generic decoder is deliberately the looser of the two.
  it("also decodes as the generic error body, since organization_required is a real code", () => {
    expect(
      Schema.decodeUnknownSync(AccountErrorBody)({
        error: "organization_required",
        message: "Pick a workspace",
        organizations: [{ id: "org_1", name: "Personal" }],
      }).error,
    ).toBe("organization_required");
  });
});

describe("InstanceInfo", () => {
  it("decodes the WorkOS instance descriptor", () => {
    const parsed = decodeInstanceInfo({
      version: "1.2.3",
      authMode: "workos",
      clientId: "client_01ABC",
      workosApiUrl: "https://api.workos.com",
    });

    expect(parsed).toEqual({
      version: "1.2.3",
      authMode: "workos",
      clientId: "client_01ABC",
      workosApiUrl: "https://api.workos.com",
    });
  });

  it("rejects an unknown auth mode", () => {
    expect(() =>
      decodeInstanceInfo({
        version: "1.2.3",
        authMode: "betterauth",
        clientId: "client_01ABC",
        workosApiUrl: "https://api.workos.com",
      }),
    ).toThrow();
  });

  it("rejects a blank client id", () => {
    expect(() =>
      decodeInstanceInfo({
        version: "1.2.3",
        authMode: "workos",
        clientId: "   ",
        workosApiUrl: "https://api.workos.com",
      }),
    ).toThrow();
  });
});
