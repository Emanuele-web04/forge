// FILE: useComputerSupport.ts
// Purpose: Report whether the connected server could ever drive a desktop.
// Layer: Web capability hook
// Exports: useComputerSupport
// Depends on: server environment query, cached computer status
//
// Mirrors useDeviceSupport: the desktop backend lives in apps/server, so support
// follows the *server's* platform, not the browser's — a Mac browser pointed at a
// Windows server has no desktop to drive, and a Windows browser pointed at a Mac
// server does.
//
// Deliberately answered without asking the desktop. `computer.getStatus` resolves
// the backend, which on macOS starts the helper and can put a permission dialog
// on screen; a dock launcher deciding whether to draw an icon must not be the
// thing that does that. So the free signals are used: the server's platform,
// which rules out the impossible cases outright, and the status only if some
// other surface has already fetched it — which is what narrows "Linux" down to
// "Linux with a Wayland compositor Synara can reach".

import { useQuery } from "@tanstack/react-query";

import { useCachedComputerStatus } from "~/hooks/useCachedComputerStatus";
import { serverEnvironmentQueryOptions } from "~/lib/serverReactQuery";

/** The server platforms a computer backend exists for at all. */
const COMPUTER_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux"]);

export function useComputerSupport(): boolean {
  const environmentQuery = useQuery(serverEnvironmentQueryOptions());
  const platform = environmentQuery.data?.platform.os;
  const status = useCachedComputerStatus();
  // Until the environment resolves this is false, which keeps the launcher from
  // flickering in on a cold start the way an optimistic default would.
  if (platform === undefined || !COMPUTER_CAPABLE_PLATFORMS.has(platform)) return false;
  // A backend that has already reported it can never run here — a Linux server
  // with no Wayland session Synara can reach — is a definite no, and the one the
  // platform check cannot make on its own.
  return status?.availability.kind !== "unsupported-platform";
}
