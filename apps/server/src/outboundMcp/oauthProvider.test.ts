import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";

import { makeOAuthClientProvider } from "./oauthProvider.ts";

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
