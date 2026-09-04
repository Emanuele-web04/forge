import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { describe, expect, it } from "vitest";

import {
  OutboundMcpOAuthMetadataError,
  validateOutboundMcpAuthorizationServerUrl,
  validateOutboundMcpAuthorizationUrl,
  validateOutboundMcpOAuthDiscoveryState,
} from "./oauthMetadataPolicy.ts";

const AUTHORIZATION_SERVER_URL = "https://auth.example.test/tenant";

describe("validateOutboundMcpAuthorizationServerUrl", () => {
  it("rejects an invalid stored authority without retaining its sensitive URL", () => {
    let caught: unknown;
    try {
      validateOutboundMcpAuthorizationServerUrl(
        "http://auth.example.test/private?client_secret=synthetic-secret",
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ category: "invalid-metadata" });
    expect(JSON.stringify(caught)).not.toContain("private");
    expect(JSON.stringify(caught)).not.toContain("synthetic-secret");
  });
});

function discoveryState(
  overrides: Partial<NonNullable<OAuthDiscoveryState["authorizationServerMetadata"]>> = {},
): OAuthDiscoveryState {
  return {
    authorizationServerUrl: AUTHORIZATION_SERVER_URL,
    authorizationServerMetadata: {
      issuer: AUTHORIZATION_SERVER_URL,
      authorization_endpoint: "https://auth.example.test/oauth/authorize",
      token_endpoint: "https://auth.example.test/oauth/token",
      registration_endpoint: "https://auth.example.test/oauth/register",
      revocation_endpoint: "https://auth.example.test/oauth/revoke",
      response_types_supported: ["code"],
      ...overrides,
    },
  };
}

describe("validateOutboundMcpOAuthDiscoveryState", () => {
  it("accepts HTTPS metadata pinned to the exact discovered authorization server", () => {
    expect(
      validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl: AUTHORIZATION_SERVER_URL,
        state: discoveryState(),
      }),
    ).toMatchObject({ authorizationServerUrl: AUTHORIZATION_SERVER_URL });
  });

  it("rejects metadata whose issuer differs from the pinned authorization server", () => {
    expect(() =>
      validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl: AUTHORIZATION_SERVER_URL,
        state: discoveryState({ issuer: "https://other.example.test/tenant" }),
      }),
    ).toThrowError(OutboundMcpOAuthMetadataError);
    expect(() =>
      validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl: AUTHORIZATION_SERVER_URL,
        state: discoveryState({ issuer: "https://other.example.test/tenant" }),
      }),
    ).toThrowError(expect.objectContaining({ category: "authorization-server-mismatch" }));
  });

  it.each(["authorization_endpoint", "token_endpoint"] as const)(
    "rejects metadata missing required %s",
    (field) => {
      const state = discoveryState();
      delete (state.authorizationServerMetadata as unknown as Record<string, unknown>)[field];

      expect(() =>
        validateOutboundMcpOAuthDiscoveryState({
          pinnedAuthorizationServerUrl: AUTHORIZATION_SERVER_URL,
          state,
        }),
      ).toThrowError(expect.objectContaining({ category: "invalid-metadata" }));
    },
  );

  it.each([
    ["authorization_endpoint", "https://other.example.test/oauth/authorize"],
    ["token_endpoint", "https://other.example.test/oauth/token"],
    ["registration_endpoint", "https://other.example.test/oauth/register"],
    ["revocation_endpoint", "https://other.example.test/oauth/revoke"],
  ] as const)("rejects a cross-origin %s", (field, endpoint) => {
    expect(() =>
      validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl: AUTHORIZATION_SERVER_URL,
        state: discoveryState({ [field]: endpoint }),
      }),
    ).toThrowError(expect.objectContaining({ category: "endpoint-origin" }));
  });

  it("rejects a non-HTTPS issuer without retaining its path or query", () => {
    let caught: unknown;
    try {
      validateOutboundMcpOAuthDiscoveryState({
        pinnedAuthorizationServerUrl: AUTHORIZATION_SERVER_URL,
        state: discoveryState({ issuer: "http://auth.example.test/private?code=sensitive-code" }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ category: "invalid-metadata" });
    expect(JSON.stringify(caught)).not.toContain("private");
    expect(JSON.stringify(caught)).not.toContain("sensitive-code");
  });
});

describe("validateOutboundMcpAuthorizationUrl", () => {
  it("accepts authorization parameters only on the validated metadata endpoint", () => {
    expect(
      validateOutboundMcpAuthorizationUrl({
        state: discoveryState(),
        authorizationUrl: new URL(
          "https://auth.example.test/oauth/authorize?response_type=code&state=fixture",
        ),
      }).pathname,
    ).toBe("/oauth/authorize");
  });

  it("rejects a captured authorization URL on another path or origin", () => {
    for (const authorizationUrl of [
      new URL("https://auth.example.test/unvalidated?state=fixture"),
      new URL("https://other.example.test/oauth/authorize?state=fixture"),
    ]) {
      expect(() =>
        validateOutboundMcpAuthorizationUrl({ state: discoveryState(), authorizationUrl }),
      ).toThrowError(expect.objectContaining({ category: "authorization-url-mismatch" }));
    }
  });

  it("rejects conflicting values for query parameters fixed by the metadata endpoint", () => {
    expect(() =>
      validateOutboundMcpAuthorizationUrl({
        state: discoveryState({
          authorization_endpoint: "https://auth.example.test/oauth/authorize?tenant=fixed",
        }),
        authorizationUrl: new URL(
          "https://auth.example.test/oauth/authorize?tenant=fixed&tenant=attacker&state=fixture",
        ),
      }),
    ).toThrowError(expect.objectContaining({ category: "authorization-url-mismatch" }));
  });
});
