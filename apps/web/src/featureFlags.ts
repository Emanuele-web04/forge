import { useSyncExternalStore } from "react";

export type FeatureFlag =
  | {
      id: "trigger-action-failed-toasts";
      kind: "action";
      label: string;
      description: string;
    }
  | {
      id: ToggleFeatureFlagId;
      kind: "toggle";
      label: string;
      description: string;
      defaultEnabled: boolean;
    };

export type ToggleFeatureFlagId =
  | "persist-action-failed-debug-toasts"
  | "pin-git-progress-toast-preview"
  | "show-debug-task-banner";

type FeatureFlagState = Record<ToggleFeatureFlagId, boolean>;

const FEATURE_FLAG_STORAGE_KEY = "synara:feature-flags";

const DEFAULT_FEATURE_FLAG_STATE: FeatureFlagState = {
  "persist-action-failed-debug-toasts": false,
  "pin-git-progress-toast-preview": false,
  "show-debug-task-banner": false,
};

export const FEATURE_FLAGS: readonly FeatureFlag[] = [
  {
    id: "trigger-action-failed-toasts",
    kind: "action",
    label: "Trigger action failed toasts",
    description: "Show stacked Git action failure toasts for local UI testing.",
  },
  {
    id: "persist-action-failed-debug-toasts",
    kind: "toggle",
    label: "Keep debug error toasts open",
    description: "Disable auto-dismiss for locally triggered error toasts.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["persist-action-failed-debug-toasts"],
  },
  {
    id: "pin-git-progress-toast-preview",
    kind: "toggle",
    label: "Pin git progress toast",
    description: "Keep a looping git progress toast visible for styling.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["pin-git-progress-toast-preview"],
  },
  {
    id: "show-debug-task-banner",
    kind: "toggle",
    label: "Show debug task banner",
    description: "Render a local sample active task banner for UI testing.",
    defaultEnabled: DEFAULT_FEATURE_FLAG_STATE["show-debug-task-banner"],
  },
];

const listeners = new Set<() => void>();
let memoryState = DEFAULT_FEATURE_FLAG_STATE;
let cachedRawFeatureFlagState: string | null | undefined;
let cachedFeatureFlagState = DEFAULT_FEATURE_FLAG_STATE;

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function normalizeFeatureFlagState(value: unknown): FeatureFlagState {
  if (!value || typeof value !== "object") {
    return DEFAULT_FEATURE_FLAG_STATE;
  }

  const record = value as Partial<Record<ToggleFeatureFlagId, unknown>>;
  return {
    "persist-action-failed-debug-toasts":
      typeof record["persist-action-failed-debug-toasts"] === "boolean"
        ? record["persist-action-failed-debug-toasts"]
        : DEFAULT_FEATURE_FLAG_STATE["persist-action-failed-debug-toasts"],
    "pin-git-progress-toast-preview":
      typeof record["pin-git-progress-toast-preview"] === "boolean"
        ? record["pin-git-progress-toast-preview"]
        : DEFAULT_FEATURE_FLAG_STATE["pin-git-progress-toast-preview"],
    "show-debug-task-banner":
      typeof record["show-debug-task-banner"] === "boolean"
        ? record["show-debug-task-banner"]
        : DEFAULT_FEATURE_FLAG_STATE["show-debug-task-banner"],
  };
}

function readFeatureFlagState(): FeatureFlagState {
  if (!canUseLocalStorage()) {
    return memoryState;
  }

  try {
    const raw = window.localStorage.getItem(FEATURE_FLAG_STORAGE_KEY);
    if (raw === cachedRawFeatureFlagState) {
      return cachedFeatureFlagState;
    }

    const nextState = normalizeFeatureFlagState(raw ? JSON.parse(raw) : null);
    cachedRawFeatureFlagState = raw;
    cachedFeatureFlagState = nextState;
    return nextState;
  } catch {
    // Do not cache a raw value whose parse/read failed. Otherwise a later read of
    // that same value would match the cache key and resurrect the previous state.
    cachedRawFeatureFlagState = undefined;
    cachedFeatureFlagState = DEFAULT_FEATURE_FLAG_STATE;
    return DEFAULT_FEATURE_FLAG_STATE;
  }
}

function writeFeatureFlagState(state: FeatureFlagState): void {
  memoryState = state;

  if (canUseLocalStorage()) {
    try {
      const raw = JSON.stringify(state);
      window.localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, raw);
      cachedRawFeatureFlagState = raw;
      cachedFeatureFlagState = state;
    } catch {
      // Local feature flags are best-effort developer tools.
    }
  }

  for (const listener of listeners) {
    listener();
  }
}

function subscribeFeatureFlags(listener: () => void): () => void {
  listeners.add(listener);

  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === FEATURE_FLAG_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setFeatureFlagEnabled(id: ToggleFeatureFlagId, enabled: boolean): void {
  writeFeatureFlagState({
    ...readFeatureFlagState(),
    [id]: enabled,
  });
}

export function useFeatureFlags(): FeatureFlagState {
  return useSyncExternalStore(
    subscribeFeatureFlags,
    readFeatureFlagState,
    () => DEFAULT_FEATURE_FLAG_STATE,
  );
}
