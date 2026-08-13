import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  ACCOUNT_ENDPOINT_URL_MAX_LENGTH,
  ACCOUNT_NAME_MAX_LENGTH,
  AccountHostEndpoint,
  AccountErrorBody,
  AccountHost,
  AccountMe,
  InstanceInfo,
  OrganizationRequiredBody,
  UpdateProfileRequest,
} from "./account";

const decodeInstanceInfo = Schema.decodeUnknownSync(InstanceInfo);
const decodeAccountHost = Schema.decodeUnknownSync(AccountHost);
const decodeAccountMe = Schema.decodeUnknownSync(AccountMe);
const decodeOrganizationRequired = Schema.decodeUnknownSync(OrganizationRequiredBody);

function hostPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "host_1",
    environmentId: "env-1",
    name: "My Laptop",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: true,
    linked: true,
    keyGeneration: 2,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AccountHostEndpoint", () => {
  it("rejects an invalid transport literal", () => {
    expect(() =>
      Schema.decodeUnknownSync(AccountHostEndpoint)({
        url: "https://example.com",
        transport: "vpn",
      }),
    ).toThrow();
  });

  it("bounds each endpoint URL", () => {
    const prefix = "https://";
    const atLimit = `${prefix}${"a".repeat(ACCOUNT_ENDPOINT_URL_MAX_LENGTH - prefix.length)}`;
    expect(
      Schema.decodeUnknownSync(AccountHostEndpoint)({ url: atLimit, transport: "lan" }).url,
    ).toHaveLength(ACCOUNT_ENDPOINT_URL_MAX_LENGTH);
    expect(() =>
      Schema.decodeUnknownSync(AccountHostEndpoint)({ url: `${atLimit}a`, transport: "lan" }),
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
  it("requires ownership and link state after the keypair cutover", () => {
    expect(decodeAccountHost(hostPayload())).toMatchObject({
      ownerUserId: "user_1",
      discoverable: true,
      linked: true,
      keyGeneration: 2,
    });
    const { ownerUserId: _omitted, ...withoutOwner } = hostPayload();
    expect(() => decodeAccountHost(withoutOwner)).toThrow();
  });

  it("rejects the retired public endpoint transport", () => {
    expect(() =>
      decodeAccountHost(
        hostPayload({ endpoints: [{ url: "https://relay.example.com", transport: "public" }] }),
      ),
    ).toThrow();
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
