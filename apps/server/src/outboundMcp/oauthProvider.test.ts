import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";

import { makeOAuthClientProvider } from "./oauthProvider.ts";
import {
  formatOutboundMcpError,
  redactOutboundMcpLifecycleMetadata,
} from "./redaction.ts";

const clientMetadata: OAuthClientMetadata = {
  redirect_uris: ["http://127.0.0.1:58090/oauth/callback"],
  client_name: "Synara",
};

describe("makeOAuthClientProvider", () => {
  it("binds the SDK provider to one credential record and authorization attempt", async () => {
    let clientInformation: OAuthClientInformationMixed | undefined = {
      client_id: "registered-client",
    };
    let tokens: OAuthTokens | undefined = {
      access_token: "access-token",
      token_type: "Bearer",
    };
    let verifier: string | null = null;
    let authorizationUrl: URL | null = null;
    const invalidations: Array<"all" | "client" | "tokens" | "verifier" | "discovery"> = [];

    const provider = makeOAuthClientProvider({
      redirectUrl: new URL("http://127.0.0.1:58090/oauth/callback"),
      clientMetadata,
      state: "attempt-state",
      credentials: {
        clientInformation: () => clientInformation,
        saveClientInformation: (value) => {
          clientInformation = value;
        },
        tokens: () => tokens,
        saveTokens: (value) => {
          tokens = value;
        },
        invalidate: (scope) => {
          invalidations.push(scope);
        },
      },
      attempt: {
        saveCodeVerifier: (value) => {
          verifier = value;
        },
        codeVerifier: () => {
          if (verifier === null) throw new Error("No code verifier saved");
          return verifier;
        },
      },
      captureAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
      validateResource: async (serverUrl, resource) =>
        resource === undefined ? new URL(serverUrl) : new URL(resource),
    });

    expect(provider.redirectUrl).toEqual(new URL("http://127.0.0.1:58090/oauth/callback"));
    expect(provider.clientMetadata).toEqual(clientMetadata);
    expect(await provider.state?.()).toBe("attempt-state");
    expect(await provider.clientInformation()).toEqual({ client_id: "registered-client" });

    await provider.saveClientInformation?.({ client_id: "rotated-client" });
    await provider.saveTokens({
      access_token: "rotated-access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });
    await provider.saveCodeVerifier("pkce-verifier");
    await provider.redirectToAuthorization(new URL("https://auth.paraty.example/authorize"));
    await provider.invalidateCredentials?.("tokens");

    expect(await provider.clientInformation()).toEqual({ client_id: "rotated-client" });
    expect(await provider.tokens()).toMatchObject({ access_token: "rotated-access-token" });
    expect(await provider.codeVerifier()).toBe("pkce-verifier");
    expect(authorizationUrl).toEqual(new URL("https://auth.paraty.example/authorize"));
    expect(invalidations).toEqual(["tokens"]);
    expect(
      await provider.validateResourceURL?.(
        "https://mcp.paraty.example/mcp",
        "https://mcp.paraty.example/resource",
      ),
    ).toEqual(new URL("https://mcp.paraty.example/resource"));
  });
});

describe("outbound MCP redaction", () => {
  it("removes OAuth secrets from serialized lifecycle metadata", () => {
    const metadata = redactOutboundMcpLifecycleMetadata({
      connectionId: "paraty",
      accessToken: "access-token",
      nested: {
        refresh_token: "refresh-token",
        authorizationCode: "authorization-code",
        codeVerifier: "pkce-verifier",
        status: "connected",
      },
    });
    const serialized = JSON.stringify(metadata);

    expect(serialized).toContain("paraty");
    expect(serialized).toContain("connected");
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refresh-token");
    expect(serialized).not.toContain("authorization-code");
    expect(serialized).not.toContain("pkce-verifier");
  });

  it("formats errors without known secrets or sensitive URL query parameters", () => {
    const formatted = formatOutboundMcpError(
      new Error(
        "OAuth failed: access-token refresh-token authorization-code pkce-verifier " +
          "https://localhost/callback?code=authorization-code&state=attempt-state",
      ),
      ["access-token", "refresh-token", "authorization-code", "pkce-verifier", "attempt-state"],
    );

    expect(formatted).toContain("OAuth failed");
    expect(formatted).not.toContain("access-token");
    expect(formatted).not.toContain("refresh-token");
    expect(formatted).not.toContain("authorization-code");
    expect(formatted).not.toContain("pkce-verifier");
    expect(formatted).not.toContain("attempt-state");
  });
});
