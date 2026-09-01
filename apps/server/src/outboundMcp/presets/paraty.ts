import type { OutboundMcpPreset } from "./index.ts";

export const PARATY_MCP_PRESET: OutboundMcpPreset = {
  id: "paraty",
  displayName: "Paraty MCP",
  endpoint: new URL("https://mcp-paraty-224371693889.europe-west1.run.app/mcp"),
  clientMetadata: {
    client_name: "Synara",
    redirect_uris: [],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
  consumers: [],
};
