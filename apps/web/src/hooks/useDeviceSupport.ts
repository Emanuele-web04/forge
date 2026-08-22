// FILE: useDeviceSupport.ts
// Purpose: Report whether the connected server can run device (iOS Simulator) sessions.
// Layer: Web capability hook
// Exports: useDeviceSupport
// Depends on: server environment query

import { useQuery } from "@tanstack/react-query";

import { serverEnvironmentQueryOptions } from "~/lib/serverReactQuery";

/**
 * The simulator engine lives in apps/server and shells out to the user's Xcode,
 * so support follows the *server's* platform, not the browser's. A Mac browser
 * pointed at a Linux server has no simulators, and a Windows browser pointed at
 * a Mac server does. Until the environment resolves this is false, which keeps
 * the add-menu entry from flickering in and out on a cold start.
 */
export function useDeviceSupport(): boolean {
  const environmentQuery = useQuery(serverEnvironmentQueryOptions());
  return environmentQuery.data?.platform.os === "darwin";
}
