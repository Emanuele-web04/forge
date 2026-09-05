// FILE: useProjectFileChangeSubscription.ts
// Purpose: Keep one visible workspace-file watcher subscribed for a panel.
// Layer: Web query invalidation hook

import { WS_PROJECT_FILE_WATCH_CAPABILITY, type ProjectFileChangeEvent } from "@synara/contracts";
import { useEffect, useSyncExternalStore } from "react";

import {
  onNativeApiServerCapabilitiesChange,
  readNativeApi,
  readNativeApiServerCapability,
} from "../nativeApi";

const subscribeFileWatchCapability = (listener: () => void) =>
  onNativeApiServerCapabilitiesChange(listener);
const readFileWatchCapability = () =>
  readNativeApiServerCapability(WS_PROJECT_FILE_WATCH_CAPABILITY);
const readServerFileWatchCapability = () => false;

export function useProjectFileChangeSubscription(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled: boolean;
  onChange: (event: ProjectFileChangeEvent) => void;
}): void {
  const capabilityAvailable = useSyncExternalStore(
    subscribeFileWatchCapability,
    readFileWatchCapability,
    readServerFileWatchCapability,
  );

  useEffect(() => {
    if (!input.enabled || !capabilityAvailable || !input.cwd || !input.relativePath) {
      return;
    }
    const api = readNativeApi();
    return api?.projects.onFileChange?.(
      { cwd: input.cwd, relativePath: input.relativePath },
      input.onChange,
    );
  }, [capabilityAvailable, input.cwd, input.enabled, input.onChange, input.relativePath]);
}
