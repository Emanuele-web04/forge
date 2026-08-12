// FILE: useProfileHandle.ts
// Purpose: Editable, locally-persisted @handle for the Profile card. Falls back to the
// server-derived default (home-dir basename) until the user overrides it. Local-only.
// Layer: web profile feature.

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { Schema } from "effect";
import { normalizeHandle } from "@synara/profile-ui/formatting";

const PROFILE_HANDLE_STORAGE_KEY = "synara:profile:handle:v1";

// Empty string means "use the server default".
const StoredHandleSchema = Schema.String;

export function useProfileHandle(defaultHandle: string) {
  const [stored, setStored] = useLocalStorage(PROFILE_HANDLE_STORAGE_KEY, "", StoredHandleSchema);

  const handle = stored.trim().length > 0 ? normalizeHandle(stored) : defaultHandle;

  const setHandle = (next: string) => {
    const normalized = normalizeHandle(next);
    // Storing the bare default back as empty keeps "reset to default" behavior.
    setStored(normalized === defaultHandle ? "" : normalized);
  };

  const resetHandle = () => setStored("");

  return { handle, setHandle, resetHandle, isCustom: stored.trim().length > 0 } as const;
}
