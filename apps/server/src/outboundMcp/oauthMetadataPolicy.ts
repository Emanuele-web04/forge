import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { Schema } from "effect";

export class OutboundMcpOAuthMetadataError extends Schema.TaggedErrorClass<OutboundMcpOAuthMetadataError>()(
  "OutboundMcpOAuthMetadataError",
  { category: Schema.String },
) {
  override get message(): string {
    return `Outbound MCP OAuth metadata was rejected (${this.category}).`;
  }
}

function metadataError(category: string): OutboundMcpOAuthMetadataError {
  return new OutboundMcpOAuthMetadataError({ category });
}

function httpsUrl(value: string, category = "invalid-metadata"): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw metadataError(category);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw metadataError(category);
  }
  return url;
}

function sameUrl(left: URL, right: URL): boolean {
  return left.href === right.href;
}

export function validateOutboundMcpAuthorizationServerUrl(value: string): string {
  return httpsUrl(value).href;
}

export function validateOutboundMcpOAuthDiscoveryState(input: {
  readonly pinnedAuthorizationServerUrl: string;
  readonly state: OAuthDiscoveryState;
}): OAuthDiscoveryState {
  const pinned = httpsUrl(input.pinnedAuthorizationServerUrl);
  const selected = httpsUrl(input.state.authorizationServerUrl);
  if (!sameUrl(pinned, selected)) {
    throw metadataError("authorization-server-mismatch");
  }

  const metadata = input.state.authorizationServerMetadata;
  if (metadata === undefined) throw metadataError("invalid-metadata");
  const issuer = httpsUrl(metadata.issuer);
  if (!sameUrl(pinned, issuer)) {
    throw metadataError("authorization-server-mismatch");
  }

  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
    if (typeof endpoint !== "string") throw metadataError("invalid-metadata");
    if (httpsUrl(endpoint).origin !== issuer.origin) throw metadataError("endpoint-origin");
  }
  for (const endpoint of [metadata.registration_endpoint, metadata.revocation_endpoint]) {
    if (endpoint === undefined) continue;
    if (typeof endpoint !== "string") throw metadataError("invalid-metadata");
    if (httpsUrl(endpoint).origin !== issuer.origin) throw metadataError("endpoint-origin");
  }

  const advertisedServers = input.state.resourceMetadata?.authorization_servers;
  if (
    advertisedServers !== undefined &&
    (advertisedServers.length === 0 ||
      advertisedServers.some((server) => !sameUrl(httpsUrl(server), pinned)))
  ) {
    throw metadataError("authorization-server-mismatch");
  }
  return input.state;
}

export function validateOutboundMcpAuthorizationUrl(input: {
  readonly state: OAuthDiscoveryState;
  readonly authorizationUrl: URL;
}): URL {
  const validatedState = validateOutboundMcpOAuthDiscoveryState({
    pinnedAuthorizationServerUrl: input.state.authorizationServerUrl,
    state: input.state,
  });
  const expected = httpsUrl(
    validatedState.authorizationServerMetadata!.authorization_endpoint,
    "authorization-url-mismatch",
  );
  const captured = httpsUrl(input.authorizationUrl.href, "authorization-url-mismatch");
  if (captured.origin !== expected.origin || captured.pathname !== expected.pathname) {
    throw metadataError("authorization-url-mismatch");
  }
  for (const name of new Set(expected.searchParams.keys())) {
    const expectedValues = expected.searchParams.getAll(name);
    const capturedValues = captured.searchParams.getAll(name);
    if (
      capturedValues.length !== expectedValues.length ||
      capturedValues.some((value, index) => value !== expectedValues[index])
    ) {
      throw metadataError("authorization-url-mismatch");
    }
  }
  return captured;
}
