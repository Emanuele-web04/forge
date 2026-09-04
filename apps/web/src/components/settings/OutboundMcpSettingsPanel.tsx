// FILE: OutboundMcpSettingsPanel.tsx
// Purpose: Settings surface for Synara-owned outbound MCP services and inbound agent MCP access.
// Layer: Settings UI components
// Depends on: outbound MCP React Query helpers and existing external MCP settings panel.

import type { OutboundMcpConnection, OutboundMcpConnectionStatus } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import {
  invalidateOutboundMcpConnections,
  openOutboundMcpAuthorizationFromUserGesture,
  outboundMcpConnectionsQueryOptions,
  outboundMcpDisconnectMutationOptions,
} from "~/lib/outboundMcpReactQuery";
import { cn } from "~/lib/utils";
import { settingRowAnchorId } from "~/settingsNavigation";
import { ExternalMcpSettingsPanel } from "./ExternalMcpSettingsPanel";
import {
  SettingsEmptyState,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const PARATY_MCP_PRESET_ID = "paraty";
const PARATY_MCP_DISPLAY_NAME = "Paraty MCP";

type ConnectionAction = {
  readonly kind: "connect";
  readonly label: "Connect" | "Reconnect" | "Retry";
};

type OutboundMcpConnectionView = Pick<
  OutboundMcpConnection,
  "id" | "presetId" | "displayName" | "status" | "lastValidatedAt" | "errorCategory"
>;

export type OutboundMcpDisconnectConfirmation = {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
};

export function buildOutboundMcpDisconnectConfirmation(
  displayName: string,
): OutboundMcpDisconnectConfirmation {
  return {
    title: `Disconnect ${displayName}?`,
    description:
      "Credentials and cached service state are removed from this device. Projects and pull request pins stay in Synara.",
    confirmLabel: "Disconnect",
  };
}

function formatValidationTime(value: string): string {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return value;
  return new Date(milliseconds).toLocaleString();
}

function connectionStatusLabel(status: OutboundMcpConnectionStatus): string {
  if (status === "authorizing") return "Authorizing";
  if (status === "connected") return "Connected";
  if (status === "reconnect-required") return "Reconnect required";
  if (status === "incompatible") return "Incompatible service";
  if (status === "temporarily-unavailable") return "Temporarily unavailable";
  return "Disconnected";
}

function connectionStatusTone(status: OutboundMcpConnectionStatus): string {
  if (status === "connected") return "bg-green-500";
  if (status === "authorizing" || status === "temporarily-unavailable") return "bg-amber-500";
  if (status === "incompatible" || status === "reconnect-required") return "bg-destructive";
  return "bg-muted-foreground";
}

function connectionDescription(status: OutboundMcpConnectionStatus): string {
  if (status === "authorizing") return "Finish authorization in the browser.";
  if (status === "connected") {
    return "Synara can use this service for supported Bitbucket pull request reads.";
  }
  if (status === "reconnect-required") return "Reconnect to restore access.";
  if (status === "incompatible") {
    return "The connected service is missing the Bitbucket pull request capability Synara needs.";
  }
  if (status === "temporarily-unavailable") return "Retry when the service is reachable.";
  return "Connect Synara to Paraty MCP for read-only Bitbucket pull requests in supported Paraty repositories.";
}

function connectionIssueCopy(
  status: OutboundMcpConnectionStatus,
  errorCategory: string | null,
): string | null {
  if (status === "reconnect-required") {
    return "Stored credentials need a fresh authorization before Synara can use this service.";
  }
  if (status === "incompatible") {
    return "The service is reachable, but its advertised tools do not match the Bitbucket pull request access Synara expects.";
  }
  if (status !== "temporarily-unavailable") return null;
  if (errorCategory === "rate-limited") {
    return "The service is limiting requests. Retry after a short wait.";
  }
  if (errorCategory === "network" || errorCategory === "timeout") {
    return "The service could not be reached reliably. Retry when the connection is stable.";
  }
  return "The service is temporarily unavailable. Retry keeps existing projects and pins unchanged.";
}

function connectionAction(status: OutboundMcpConnectionStatus): ConnectionAction | null {
  if (status === "disconnected") {
    return { kind: "connect", label: "Connect" };
  }
  if (status === "reconnect-required") return { kind: "connect", label: "Reconnect" };
  if (status === "temporarily-unavailable") return { kind: "connect", label: "Retry" };
  return null;
}

function paratyConnectionFromList(
  connections: readonly OutboundMcpConnection[] | undefined,
): OutboundMcpConnectionView | null {
  const matched = connections?.find((connection) => connection.presetId === PARATY_MCP_PRESET_ID);
  if (!matched) return null;
  return {
    id: matched.id,
    presetId: matched.presetId,
    displayName: matched.displayName,
    status: matched.status,
    lastValidatedAt: matched.lastValidatedAt,
    errorCategory: matched.errorCategory,
  };
}

function OutboundMcpConnectionStatusDot({
  status,
}: {
  readonly status: OutboundMcpConnectionStatus;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 rounded-full", connectionStatusTone(status))}
    />
  );
}

function OutboundMcpConnectionCard({
  connection,
  disabled,
  onAuthorize,
  onDisconnect,
}: {
  readonly connection: OutboundMcpConnectionView;
  readonly disabled: boolean;
  readonly onAuthorize: (presetId: string) => void;
  readonly onDisconnect: (connection: OutboundMcpConnectionView) => void;
}) {
  const action = connectionAction(connection.status);
  const issueCopy = connectionIssueCopy(connection.status, connection.errorCategory);
  const authorizing = connection.status === "authorizing";
  const canDisconnect =
    connection.status === "connected" ||
    connection.status === "reconnect-required" ||
    connection.status === "incompatible" ||
    connection.status === "temporarily-unavailable";

  const status = (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${connection.displayName} connection status`}
      className="space-y-1"
    >
      <div className="flex items-center gap-1.5">
        <OutboundMcpConnectionStatusDot status={connection.status} />
        <span>{connectionStatusLabel(connection.status)}</span>
      </div>
      {connection.lastValidatedAt ? (
        <div>
          Last validated{" "}
          <time dateTime={connection.lastValidatedAt}>
            {formatValidationTime(connection.lastValidatedAt)}
          </time>
          .
        </div>
      ) : null}
      {issueCopy ? <div>{issueCopy}</div> : null}
    </div>
  );

  return (
    <SettingsRow
      title={connection.displayName}
      description={connectionDescription(connection.status)}
      status={status}
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          {action ? (
            <Button
              size="xs"
              variant={connection.status === "temporarily-unavailable" ? "outline" : "default"}
              disabled={disabled}
              aria-label={`${action.label} ${connection.displayName}`}
              onClick={() => onAuthorize(connection.presetId)}
            >
              {action.label}
            </Button>
          ) : null}
          {authorizing ? (
            <>
              <Button size="xs" disabled aria-label={`Authorizing ${connection.displayName}`}>
                Authorizing {connection.displayName}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                aria-label={`Retry ${connection.displayName}`}
                onClick={() => onAuthorize(connection.presetId)}
              >
                Retry
              </Button>
            </>
          ) : null}
          {canDisconnect ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={disabled}
              aria-label={`Disconnect ${connection.displayName}`}
              onClick={() => onDisconnect(connection)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

export function OutboundMcpSettingsPanel({ active }: { readonly active: boolean }) {
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(outboundMcpConnectionsQueryOptions({ enabled: active }));
  const disconnectMutation = useMutation(outboundMcpDisconnectMutationOptions(queryClient));
  const [authorizingPresetId, setAuthorizingPresetId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<OutboundMcpConnectionView | null>(
    null,
  );
  const loadingInitialConnections = connectionsQuery.data == null && connectionsQuery.isFetching;

  const paratyConnection = useMemo(() => {
    const listedConnection = paratyConnectionFromList(connectionsQuery.data?.connections);
    if (listedConnection) return listedConnection;
    return {
      id: PARATY_MCP_PRESET_ID,
      presetId: PARATY_MCP_PRESET_ID,
      displayName: PARATY_MCP_DISPLAY_NAME,
      status: "disconnected",
      lastValidatedAt: null,
      errorCategory: null,
    } satisfies OutboundMcpConnectionView;
  }, [connectionsQuery.data?.connections]);

  useEffect(() => {
    if (!active) setPendingDisconnect(null);
  }, [active]);

  const disconnectConfirmation = pendingDisconnect
    ? buildOutboundMcpDisconnectConfirmation(pendingDisconnect.displayName)
    : null;
  const serviceBusy =
    authorizingPresetId !== null ||
    disconnectMutation.isPending ||
    (connectionsQuery.isFetching && connectionsQuery.data == null);

  const beginAuthorization = async (presetId: string) => {
    if (authorizingPresetId !== null) return;
    setAuthorizingPresetId(presetId);
    try {
      const result = await openOutboundMcpAuthorizationFromUserGesture({ presetId, queryClient });
      if (result.status === "opened") {
        toastManager.add({
          type: "success",
          title: "Authorization opened",
          description: "Finish the Paraty MCP authorization in the browser.",
        });
      } else if (result.status === "blocked") {
        toastManager.add({
          type: "warning",
          title: "Authorization window was blocked",
          description: "Allow popups for Synara, then click Connect Paraty MCP again.",
        });
      } else {
        toastManager.add({
          type: "warning",
          title: "Authorization was not opened",
          description: "Retry starts a new Paraty MCP authorization attempt.",
        });
      }
    } catch {
      await invalidateOutboundMcpConnections(queryClient);
      toastManager.add({
        type: "error",
        title: "Could not start authorization",
        description: "Synara could not prepare the Paraty MCP authorization. Try again.",
      });
    } finally {
      setAuthorizingPresetId(null);
    }
  };

  const disconnectPendingConnection = async () => {
    if (!pendingDisconnect) return;
    const connectionId = pendingDisconnect.id;
    try {
      await disconnectMutation.mutateAsync({ connectionId });
      setPendingDisconnect(null);
      toastManager.add({
        type: "success",
        title: "Service disconnected",
        description:
          "Credentials and cached service state were removed. Projects and pull request pins remain.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not disconnect service",
        description: "Synara could not remove the local service credentials. Try again.",
      });
    }
  };

  return (
    <div className={active ? "space-y-6" : "hidden"} hidden={!active}>
      <SettingsSection title="Services Synara uses">
        {connectionsQuery.isError && connectionsQuery.data == null ? (
          <SettingsEmptyState layout="status" tone="destructive">
            Synara could not load service connections. Retry from Settings after the local server is
            reachable.
          </SettingsEmptyState>
        ) : loadingInitialConnections ? (
          <SettingsEmptyState layout="status">
            <div
              role="status"
              aria-busy="true"
              aria-live="polite"
              aria-atomic="true"
              aria-label="Loading Paraty MCP connection"
            >
              Loading Paraty MCP connection…
            </div>
          </SettingsEmptyState>
        ) : (
          <OutboundMcpConnectionCard
            connection={paratyConnection}
            disabled={serviceBusy}
            onAuthorize={(presetId) => void beginAuthorization(presetId)}
            onDisconnect={setPendingDisconnect}
          />
        )}
      </SettingsSection>

      <SettingsSectionShell title="Agents connected to Synara">
        <div
          id={settingRowAnchorId("External agent MCP connections")}
          className="scroll-mt-24 space-y-6"
        >
          <ExternalMcpSettingsPanel active={active} embedded />
        </div>
      </SettingsSectionShell>

      <AlertDialog
        open={active && pendingDisconnect !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisconnect(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{disconnectConfirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{disconnectConfirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={disconnectMutation.isPending}
              onClick={() => void disconnectPendingConnection()}
            >
              {disconnectMutation.isPending
                ? "Disconnecting..."
                : disconnectConfirmation?.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
