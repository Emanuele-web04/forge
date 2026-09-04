import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type MaybePromise<A> = A | Promise<A>;
type CredentialInvalidationScope = "all" | "client" | "tokens" | "verifier" | "discovery";

export interface OAuthProviderInput {
  readonly redirectUrl: string | URL;
  readonly clientMetadata: OAuthClientMetadata;
  readonly state: string;
  readonly credentials: {
    readonly clientInformation: () => MaybePromise<OAuthClientInformationMixed | undefined>;
    readonly saveClientInformation: (value: OAuthClientInformationMixed) => MaybePromise<void>;
    readonly tokens: () => MaybePromise<OAuthTokens | undefined>;
    readonly saveTokens: (value: OAuthTokens) => MaybePromise<void>;
    readonly invalidate: (scope: CredentialInvalidationScope) => MaybePromise<void>;
  };
  readonly attempt: {
    readonly saveCodeVerifier: (value: string) => MaybePromise<void>;
    readonly codeVerifier: () => MaybePromise<string>;
  };
  readonly captureAuthorizationUrl: (url: URL) => MaybePromise<void>;
  readonly validateResource: (
    serverUrl: string | URL,
    resource?: string,
  ) => Promise<URL | undefined>;
}

export function makeOAuthClientProvider(input: OAuthProviderInput): OAuthClientProvider {
  return {
    redirectUrl: input.redirectUrl,
    clientMetadata: input.clientMetadata,
    state: () => input.state,
    clientInformation: () => input.credentials.clientInformation(),
    saveClientInformation: (value) => input.credentials.saveClientInformation(value),
    tokens: () => input.credentials.tokens(),
    saveTokens: (value) => input.credentials.saveTokens(value),
    redirectToAuthorization: (url) => input.captureAuthorizationUrl(url),
    saveCodeVerifier: (value) => input.attempt.saveCodeVerifier(value),
    codeVerifier: () => input.attempt.codeVerifier(),
    invalidateCredentials: (scope) => input.credentials.invalidate(scope),
    validateResourceURL: (serverUrl, resource) => input.validateResource(serverUrl, resource),
  };
}
