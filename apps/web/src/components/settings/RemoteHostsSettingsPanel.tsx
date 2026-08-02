// FILE: RemoteHostsSettingsPanel.tsx
// Purpose: The "Remote hosts" settings section — the surface that makes the
//          remote-host feature reachable: add, list, connect, disconnect, remove.
// Layer: Settings UI
// Exports: RemoteHostsSettingsPanel
//
// Every decision this panel makes lives in remoteHostsModel.ts and every string
// in remoteHostsCopy.ts, so the component is assembly only.

import type {
  RemoteHostConfig,
  RemoteHostConnectivityStatus,
  RemoteHostFingerprintResult,
  RemoteHostId,
  ServerSettingsView,
} from "@synara/contracts";
import { removeRemoteHost, upsertRemoteHost } from "@synara/shared/remoteHostDraft";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { AddRemoteHostDialog } from "./AddRemoteHostDialog";
import {
  ADD_HOST_BUTTON,
  CANCEL_BUTTON,
  CONNECT_BUTTON,
  DISCONNECT_BUTTON,
  EMPTY_STATE_BODY,
  EMPTY_STATE_TITLE,
  REMOTE_HOSTS_SECTION_TITLE,
  REMOVE_BUTTON,
  REMOVE_CONFIRM_BODY,
  removeConfirmTitle,
} from "./remoteHostsCopy";
import { type AddHostStage, addHostStageFromProbe, connectivityLabelFor } from "./remoteHostsModel";
import { SettingsCard, SettingsEmptyState, SettingsSectionShell } from "./SettingsPanelPrimitives";

/**
 * The probe target used when adding a host.
 *
 * `~` is the one directory every SSH account has, so "can Synara reach this
 * host" is not conflated with "does some project directory exist there".
 */
const ADD_PROBE_TARGET = { cwd: "~", args: [], versionArgs: ["--version"] } as const;

export interface RemoteHostsSettingsPanelProps {
  readonly active: boolean;
}

export function RemoteHostsSettingsPanel({ active }: RemoteHostsSettingsPanelProps) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const hosts = settingsQuery.data?.remoteHosts ?? [];

  const [addOpen, setAddOpen] = useState(false);
  const [stage, setStage] = useState<AddHostStage>({ kind: "form" });
  const [fingerprint, setFingerprint] = useState<RemoteHostFingerprintResult | undefined>(
    undefined,
  );
  const [addError, setAddError] = useState<string | undefined>(undefined);
  const [connectivity, setConnectivity] = useState<
    Readonly<Record<string, RemoteHostConnectivityStatus>>
  >({});
  const [pendingRemoval, setPendingRemoval] = useState<RemoteHostConfig | undefined>(undefined);

  const writeHosts = useCallback(
    async (next: readonly RemoteHostConfig[]) => {
      const updated = await ensureNativeApi().server.updateSettings({ remoteHosts: next });
      queryClient.setQueryData<ServerSettingsView>(serverQueryKeys.settings(), updated);
    },
    [queryClient],
  );

  const probeMutation = useMutation({
    mutationFn: async (host: RemoteHostConfig) =>
      ensureNativeApi().server.probeRemoteHost({ host, target: ADD_PROBE_TARGET }),
  });

  /**
   * Adds a host.
   *
   * Readiness does not gate this: any answer that is not a connection failure
   * persists the host. A host with no agent installed is still worth adding.
   */
  const runAdd = useCallback(
    async (host: RemoteHostConfig) => {
      setAddError(undefined);
      setStage({ kind: "checking" });
      try {
        const result = await probeMutation.mutateAsync(host);
        setConnectivity((current) => ({ ...current, [host.hostId]: result.connectivity }));
        const nextStage = addHostStageFromProbe(result.probe);
        setStage(nextStage);

        if (nextStage.kind === "host-key-unknown") {
          // Fetch the fingerprint ONLY now, and only for first contact: it is
          // what the user compares before trusting. Without one there is no
          // trust button (see canTrustHostKey).
          const scanned = await ensureNativeApi().server.getRemoteHostFingerprint({ host });
          setFingerprint(scanned);
          return;
        }
        if (nextStage.kind === "ready") {
          await writeHosts(upsertRemoteHost(hosts, host));
          setAddOpen(false);
          setStage({ kind: "form" });
        }
      } catch (cause) {
        setStage({ kind: "form" });
        setAddError(cause instanceof Error ? cause.message : "This host could not be added.");
      }
    },
    [hosts, probeMutation, writeHosts],
  );

  /**
   * Retries with the key accepted on FIRST USE only.
   *
   * `accept-new` pins the key now and still refuses a CHANGED key later; it is
   * not "off", which the schema cannot express.
   */
  const trustAndConnect = useCallback(
    (host: RemoteHostConfig) => {
      setFingerprint(undefined);
      void runAdd({ ...host, hostKeyVerification: "accept-new" });
    },
    [runAdd],
  );

  const disconnect = useCallback((hostId: RemoteHostId) => {
    // Disconnect KEEPS the host. It only drops the local connectivity state, so
    // the row stays and can be reconnected.
    setConnectivity((current) => {
      const next = { ...current };
      delete next[hostId];
      return next;
    });
  }, []);

  /**
   * Removes a host — a LOCAL forget.
   *
   * It drops the entry from settings and does nothing over SSH. It deliberately
   * does NOT uninstall: `uninstallRemoteServer` runs `rm -rf` over the install
   * root, and the remote thread database lives inside that root, so uninstalling
   * here would destroy the user's remote threads and make the confirmation copy
   * ("threads … stay on the host itself") false.
   */
  const confirmRemoval = useCallback(async () => {
    if (!pendingRemoval) return;
    await writeHosts(removeRemoteHost(hosts, pendingRemoval.hostId));
    disconnect(pendingRemoval.hostId);
    setPendingRemoval(undefined);
  }, [disconnect, hosts, pendingRemoval, writeHosts]);

  if (!active) return null;

  return (
    <>
      <SettingsSectionShell
        title={REMOTE_HOSTS_SECTION_TITLE}
        action={
          <Button
            variant="chrome"
            size="sm"
            onClick={() => {
              setStage({ kind: "form" });
              setFingerprint(undefined);
              setAddError(undefined);
              setAddOpen(true);
            }}
          >
            {ADD_HOST_BUTTON}
          </Button>
        }
      >
        {hosts.length === 0 ? (
          <SettingsEmptyState>
            <div className="space-y-1">
              <div className="font-medium text-foreground">{EMPTY_STATE_TITLE}</div>
              <div>{EMPTY_STATE_BODY}</div>
            </div>
          </SettingsEmptyState>
        ) : (
          <SettingsCard>
            {hosts.map((host) => {
              const status = connectivity[host.hostId];
              const connected = status !== undefined && status.state !== "down";
              return (
                <div key={host.hostId} className="px-4 py-3">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="truncate text-sm font-medium">{host.label}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {host.destination}
                        {status ? ` · ${connectivityLabelFor(status.state)}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {connected ? (
                        <Button size="xs" variant="outline" onClick={() => disconnect(host.hostId)}>
                          {DISCONNECT_BUTTON}
                        </Button>
                      ) : (
                        <Button size="xs" variant="outline" onClick={() => void runAdd(host)}>
                          {CONNECT_BUTTON}
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        onClick={() => setPendingRemoval(host)}
                      >
                        {REMOVE_BUTTON}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </SettingsCard>
        )}
      </SettingsSectionShell>

      <AddRemoteHostDialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) {
            setStage({ kind: "form" });
            setFingerprint(undefined);
          }
        }}
        stage={stage}
        fingerprint={fingerprint}
        error={addError}
        onSubmit={(host) => void runAdd(host)}
        onTrustAndConnect={trustAndConnect}
      />

      <Dialog
        open={pendingRemoval !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(undefined);
        }}
      >
        <DialogPopup>
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>{removeConfirmTitle(pendingRemoval?.label ?? "")}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="px-5">
            <p className="text-sm text-foreground/90">{REMOVE_CONFIRM_BODY}</p>
          </DialogPanel>
          <DialogFooter className="px-5 pb-5">
            <Button variant="outline" onClick={() => setPendingRemoval(undefined)}>
              {CANCEL_BUTTON}
            </Button>
            <Button variant="destructive" onClick={() => void confirmRemoval()}>
              {REMOVE_BUTTON}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
