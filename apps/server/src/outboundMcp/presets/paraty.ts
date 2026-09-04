import type { OutboundMcpPreset } from "./index.ts";
import { paratyBitbucketPullRequestBinding } from "../../pullRequests/providers/paratyBitbucketBinding.ts";

export const PARATY_MCP_PRESET: OutboundMcpPreset = {
  id: "paraty",
  displayName: "Paraty MCP",
  endpoint: new URL("https://mcp-paraty-224371693889.europe-west1.run.app/mcp"),
  // Paraty's authorization server does not expose a dynamic registration endpoint. It
  // supports public clients (token_endpoint_auth_method=none), so Synara authenticates with
  // the same pre-registered public client id the Paraty agents toolkit uses for Codex/Claude.
  publicClientId: "mcp-paraty",
  clientMetadata: {
    client_name: "Synara",
    redirect_uris: [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  consumers: [paratyBitbucketPullRequestBinding],
};
