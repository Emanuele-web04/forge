// FILE: AdvancedSettingsPanel.tsx
// Purpose: Own advanced settings state and workflows for auth, keybindings, and recovery.
// Layer: Settings UI components
// Exports: AdvancedSettingsPanel

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { logoutCurrentBrowserSession } from "~/authLogout";
import { APP_VERSION } from "~/branding";
import { resolveAndPersistPreferredEditor } from "~/editorPreferences";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { serverAuthSessionQueryOptions, serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SETTINGS_INSET_LIST_CLASS_NAME } from "~/settingsPanelStyles";
import { useStore } from "~/store";
import { createAllThreadsMessagelessSelector, createThreadShellsSelector } from "~/storeSelectors";
import { useSettingsRestoreSignal } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function AdvancedSettingsPanel(props: {
  active: boolean;
  onOpenReleaseHistory: () => void;
  resetEpoch: number;
}) {
  const configQuery = useQuery(serverConfigQueryOptions());
  const authSessionQuery = useQuery(serverAuthSessionQueryOptions());
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  // Keep these subscriptions inside the only panel that uses recovery eligibility.
  const threadShells = useStore(useMemo(() => createThreadShellsSelector(), []));
  const allThreadsMessageless = useStore(useMemo(() => createAllThreadsMessagelessSelector(), []));
  const projectCount = useStore((store) => store.projects.length);
  const threadsHydrated = useStore((store) => store.threadsHydrated);

  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [isRepairingLocalState, setIsRepairingLocalState] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showRecoveryTools, setShowRecoveryTools] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);

  useSettingsRestoreSignal(props.resetEpoch, () => {
    setShowRecoveryTools(false);
    setOpenKeybindingsError(null);
  });

  const keybindingsConfigPath = configQuery.data?.keybindingsConfigPath ?? null;
  const availableEditors = configQuery.data?.availableEditors;
  const shouldOfferRecoveryTools = useMemo(() => {
    if (!threadsHydrated || projectCount === 0) return false;
    return threadShells.length === 0 || allThreadsMessageless;
  }, [allThreadsMessageless, projectCount, threadShells.length, threadsHydrated]);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenKeybindingsError("No available editors found.");
      setIsOpeningKeybindings(false);
      return;
    }
    void ensureNativeApi()
      .shell.openInEditor(keybindingsConfigPath, editor)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [availableEditors, keybindingsConfigPath]);

  const repairLocalState = useCallback(async () => {
    if (isRepairingLocalState) return;
    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      [
        "Repair local state?",
        "This rebuilds local project indexes and refreshes project snapshots.",
        "It keeps existing chats in place, but it may take a moment.",
      ].join("\n"),
    );
    if (!confirmed) return;

    setIsRepairingLocalState(true);
    await api.orchestration
      .repairState()
      .then((snapshot) => {
        syncServerReadModel(snapshot);
        toastManager.add({
          type: "success",
          title: "Local state repaired",
          description: "Project indexes were rebuilt without clearing existing chats.",
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Repair failed",
          description: error instanceof Error ? error.message : "Unable to repair local state.",
        });
      })
      .finally(() => {
        setIsRepairingLocalState(false);
      });
  }, [isRepairingLocalState, syncServerReadModel]);

  const logoutCurrentSession = useCallback(async () => {
    if (isLoggingOut) return;
    const api = readNativeApi() ?? ensureNativeApi();
    setIsLoggingOut(true);
    const result = await logoutCurrentBrowserSession({
      confirm: () =>
        api.dialogs.confirm(
          "Sign out this browser?\n\nIts session and every live connection opened with it will be revoked.",
        ),
      logout: () => api.server.logoutAuthSession(),
      navigate: (path) => window.location.assign(path),
      onError: (error) =>
        toastManager.add({
          type: "error",
          title: "Sign out failed",
          description: error instanceof Error ? error.message : "Unable to revoke this session.",
        }),
    });
    if (result !== "redirecting") setIsLoggingOut(false);
  }, [isLoggingOut]);

  if (!props.active) return null;

  return (
    <div className="space-y-6">
      {authSessionQuery.data?.authenticated ? (
        <SettingsSection title="Session">
          <SettingsRow
            title="This browser"
            description="Revoke this browser session and close every live Synara connection it owns. A fresh pairing link is required to reconnect."
            status={`Authenticated as ${authSessionQuery.data.role ?? "client"}.`}
            control={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={isLoggingOut}
                onClick={() => void logoutCurrentSession()}
              >
                {isLoggingOut ? "Signing out..." : "Sign out"}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Developer tools">
        <SettingsRow
          title="Keybindings"
          description="Open the persisted `keybindings.json` file to edit advanced bindings directly."
          status={
            <>
              <span className="block break-all font-mono text-[11px] text-foreground">
                {keybindingsConfigPath ?? "Resolving keybindings path..."}
              </span>
              {openKeybindingsError ? (
                <span className="mt-1 block text-destructive">{openKeybindingsError}</span>
              ) : (
                <span className="mt-1 block">Opens in your preferred editor.</span>
              )}
            </>
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!keybindingsConfigPath || isOpeningKeybindings}
              onClick={openKeybindingsFile}
            >
              {isOpeningKeybindings ? "Opening..." : "Open file"}
            </Button>
          }
        />

        <SettingsRow
          title="Recovery tools"
          description="Rebuild local project indexes without clearing existing chats when the local state gets out of sync."
          status={
            shouldOfferRecoveryTools
              ? "Visible because projects exist but no chat history is currently available."
              : "Shown automatically only when recovery actions are relevant."
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!shouldOfferRecoveryTools || isRepairingLocalState}
              onClick={() => void repairLocalState()}
            >
              {isRepairingLocalState ? "Repairing..." : "Repair state"}
            </Button>
          }
        >
          {shouldOfferRecoveryTools ? (
            <div className="mt-3 border-t border-border/70 pt-3">
              <button
                type="button"
                className="flex w-full items-center justify-between text-left"
                aria-expanded={showRecoveryTools}
                onClick={() => setShowRecoveryTools((current) => !current)}
              >
                <span className="text-xs font-medium text-muted-foreground">What this does</span>
                <DisclosureChevron
                  open={showRecoveryTools}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </button>
              <DisclosureRegion
                open={showRecoveryTools}
                contentClassName={cn(
                  "mt-3 px-3 py-3 text-xs text-muted-foreground",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                )}
              >
                <div>
                  Rebuilds local project indexes and refreshes project snapshots. Existing chats
                  stay in place.
                </div>
              </DisclosureRegion>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="About">
        <SettingsRow
          title="Version"
          description="Current application version."
          control={<code className="text-xs font-medium text-muted-foreground">{APP_VERSION}</code>}
        />
        <SettingsRow
          title="Release history"
          description="A running log of every update, newest first. Same notes the post-update dialog shows, kept here so you can revisit them any time."
          control={
            <Button size="sm" variant="outline" onClick={props.onOpenReleaseHistory}>
              View release history
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}
