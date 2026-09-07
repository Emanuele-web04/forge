// FILE: useOnboarding.ts
// Purpose: Decide when the welcome tour opens (first run with no ordinary projects) and
//          persist completion to both server settings and local storage.
// Layer: Web hook
// Depends on: app settings, server settings query, orchestration store, spaces membership rule.

import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "../appSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resolveOnboardingGate, type OnboardingGate } from "./logic";
import { useOnboardingDialogStore } from "./onboardingDialogStore";

const ONBOARDING_STORAGE_KEY = "synara:onboarding:v1";

const OnboardingStorageSchema = Schema.Struct({
  completedAt: Schema.NullOr(Schema.String),
});
type OnboardingStorage = typeof OnboardingStorageSchema.Type;

const INITIAL_STORAGE: OnboardingStorage = { completedAt: null };

export interface UseOnboardingResult {
  readonly isOpen: boolean;
  /** Marks the tour finished (or skipped) and closes it. */
  readonly complete: () => void;
  readonly onOpenChange: (open: boolean) => void;
}

export function useOnboarding(): UseOnboardingResult {
  const [storage, setStorage] = useLocalStorage(
    ONBOARDING_STORAGE_KEY,
    INITIAL_STORAGE,
    OnboardingStorageSchema,
  );
  const { settings, updateSettings } = useAppSettings();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  // The Home chat and Studio containers are created automatically, so "no projects yet"
  // must count ordinary projects only or the tour would never show.
  const projectCount = useStore(
    (store) =>
      store.projects.filter((project) =>
        isOrdinarySpaceProject(project, { homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
      ).length,
  );
  const imperativeOpen = useOnboardingDialogStore((store) => store.isOpen);
  const setImperativeOpen = useOnboardingDialogStore((store) => store.setOpen);

  const [gate, setGate] = useState<OnboardingGate>("pending");
  // Latch the first non-pending decision: projects created during the tour (or by the
  // desktop bootstrap) must not flip the dialog closed mid-flow.
  const latchedRef = useRef(false);

  const settingsSettled = settingsQuery.isSuccess || settingsQuery.isError;
  const serverCompletedAt = settingsQuery.data?.onboardingCompletedAt ?? null;
  const localCompletedAt = storage.completedAt;

  useEffect(() => {
    if (latchedRef.current) {
      return;
    }
    const resolved = resolveOnboardingGate({
      threadsHydrated,
      settingsSettled,
      settingsAvailable: settingsQuery.isSuccess,
      projectCount,
      serverCompletedAt,
      localCompletedAt,
    });
    if (resolved === "pending") {
      return;
    }
    latchedRef.current = true;
    setGate(resolved);
  }, [
    threadsHydrated,
    settingsSettled,
    settingsQuery.isSuccess,
    projectCount,
    serverCompletedAt,
    localCompletedAt,
  ]);

  const complete = () => {
    const completedAt = new Date().toISOString();
    setStorage({ completedAt });
    if (settings.onboardingCompletedAt === null) {
      updateSettings({ onboardingCompletedAt: completedAt });
    }
    latchedRef.current = true;
    setGate("hidden");
    setImperativeOpen(false);
  };

  const onOpenChange = (open: boolean) => {
    if (open) {
      setImperativeOpen(true);
      return;
    }
    complete();
  };

  return {
    isOpen: gate === "show" || imperativeOpen,
    complete,
    onOpenChange,
  };
}
