// FILE: _chat.link.tsx
// Purpose: Registers the device-code approval screen under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";
import { DeviceLinkApproval } from "~/components/hosts/DeviceLinkApproval";

export const Route = createFileRoute("/_chat/link")({
  component: DeviceLinkApproval,
});
