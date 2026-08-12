import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { useAppSettings } from "../appSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { useStore } from "../store";
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
  const projectCount = useStore((store) => store.projects.length);
  const imperativeOpen = useOnboardingDialogStore((store) => store.isOpen);
  const setImperativeOpen = useOnboardingDialogStore((store) => store.setOpen);

  const [gate, setGate] = useState<OnboardingGate>("pending");
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
    setGate("hidden");
    latchedRef.current = true;
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
