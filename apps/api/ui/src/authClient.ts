// FILE: ui/src/authClient.ts
// Purpose: Single BetterAuth browser client for every ceremony page.
// Layer: Account UI data access
// Depends on: better-auth react client, device-authorization client plugin.

import { createAuthClient } from "better-auth/react";
import { deviceAuthorizationClient } from "better-auth/client/plugins";

// The UI is always served from the same origin as the API, so the origin is
// resolved at runtime rather than baked in at build time: one bundle works for
// localhost, a preview deploy, and a self-hosted instance alike.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: "/api/auth",
  plugins: [deviceAuthorizationClient()],
});
