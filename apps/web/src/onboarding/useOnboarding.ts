// FILE: useOnboarding.ts
// Purpose: Decide when the welcome tour opens (first run with no ordinary projects), keep that
//          decision revisable until authoritative data lands, and persist completion to the
//          server with a local fallback that is reconciled on later launches.
// Layer: Web hook
// Depends on: app settings, server settings query, orchestration store, spaces membership rule.

import { useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useEffect, useRef } from "react";

import { useAppSettings } from "../appSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { isOrdinarySpaceProject } from "../lib/spaces";
import { useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { resolveOnboardingCompletionToReconcile, resolveOnboardingGate } from "./logic";
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
  const { updateSettingsAndWait } = useAppSettings();
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
  const isOpen = useOnboardingDialogStore((store) => store.isOpen);
  const openReason = useOnboardingDialogStore((store) => store.openReason);
  const engaged = useOnboardingDialogStore((store) => store.engaged);
  const openStore = useOnboardingDialogStore((store) => store.open);
  const closeStore = useOnboardingDialogStore((store) => store.close);

  const settingsSettled = settingsQuery.isSuccess || settingsQuery.isError;
  const settingsAvailable = settingsQuery.isSuccess;
  const serverCompletedAt = settingsQuery.data?.onboardingCompletedAt ?? null;
  const localCompletedAt = storage.completedAt;

  const gate = resolveOnboardingGate({
    threadsHydrated,
    settingsSettled,
    projectCount,
    serverCompletedAt,
    localCompletedAt,
  });

  // Open on the first "show"; revise a first-run open back to closed if authoritative data
  // later proves the install is configured (desktop can hydrate from a transient empty
  // startup snapshot, and an errored settings query can recover with a server marker), but
  // only while the user is still reading the intro/tour and has made no setup choices.
  useEffect(() => {
    if (gate === "show" && !isOpen) {
      openStore("first-run");
      return;
    }
    if (gate === "hidden" && isOpen && openReason === "first-run" && !engaged) {
      closeStore();
    }
  }, [closeStore, engaged, gate, isOpen, openReason, openStore]);

  // Reconcile the server marker once per session: a completion whose write failed, or an
  // installation that predates the tour. Failures leave the local marker in place so the
  // next launch retries.
  const reconcileAttemptedRef = useRef(false);
  const completedAtToReconcile = resolveOnboardingCompletionToReconcile({
    threadsHydrated,
    settingsAvailable,
    projectCount,
    serverCompletedAt,
    localCompletedAt,
    now: new Date().toISOString(),
  });
  useEffect(() => {
    if (completedAtToReconcile === null || reconcileAttemptedRef.current) {
      return;
    }
    reconcileAttemptedRef.current = true;
    void updateSettingsAndWait({ onboardingCompletedAt: completedAtToReconcile });
  }, [completedAtToReconcile, updateSettingsAndWait]);

  const complete = () => {
    const completedAt = new Date().toISOString();
    // Local first so the gate flips to hidden synchronously; the server write is awaited
    // through the settings mutation queue and, if it fails, reconciled on the next launch.
    setStorage({ completedAt });
    closeStore();
    if (serverCompletedAt === null) {
      void updateSettingsAndWait({ onboardingCompletedAt: completedAt });
    }
  };

  const onOpenChange = (open: boolean) => {
    if (!open) {
      complete();
    }
  };

  return {
    isOpen,
    complete,
    onOpenChange,
  };
}
