// FILE: EnvironmentLocalServersSection.tsx
// Purpose: Environment panel "Ports" menu: workspace-grouped listening ports plus
//          a collapsible external section, with open/copy/stop actions per port.
// Layer: Environment panel section
// Depends on: server local-server React Query helpers, shared port grouping, and
//          the shared Environment row skin.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import {
  groupListeningPorts,
  toPortProjectSources,
  type ListeningPortRow,
  type PortProjectSource,
} from "@synara/shared/localServers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { DisclosureRegion } from "../../ui/DisclosureRegion";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { toastManager } from "../../ui/toast";
import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";
import {
  CopyIcon,
  ExternalLinkIcon,
  FolderIcon,
  PlugIcon,
  RefreshCwIcon,
  StopFilledIcon,
} from "~/lib/icons";
import {
  serverConfigQueryOptions,
  serverLocalServersQueryOptions,
  serverStopLocalServerMutationOptions,
} from "~/lib/serverReactQuery";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { cn } from "~/lib/utils";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

function describePortsSummary(workspaceCount: number, externalCount: number): string {
  if (workspaceCount === 0 && externalCount === 0) {
    return "No listening ports";
  }
  const workspaceLabel = `${workspaceCount} workspace`;
  return externalCount === 0 ? workspaceLabel : `${workspaceLabel} · ${externalCount} external`;
}

const ICON_BUTTON_CLASS_NAME =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground/70 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:text-muted-foreground/30 data-disabled:hover:bg-transparent data-disabled:hover:text-muted-foreground/30";

/** Compact, non-closing icon action used for the menu's Refresh affordance. */
function PortsRefreshButton({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <MenuItem
      closeOnClick={false}
      disabled={refreshing}
      onClick={onRefresh}
      aria-label="Refresh ports"
      title="Refresh"
      className={cn(ICON_BUTTON_CLASS_NAME, "size-5")}
    >
      <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
    </MenuItem>
  );
}

function PortRowAction({
  label,
  title,
  disabled,
  onClick,
  children,
  closeOnClick = false,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  closeOnClick?: boolean;
}) {
  return (
    <MenuItem
      closeOnClick={closeOnClick}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={title}
      className={ICON_BUTTON_CLASS_NAME}
    >
      {children}
    </MenuItem>
  );
}

/**
 * A single listening port: bold port number, process name + bind address, and
 * open/copy/stop icon actions. Only the stop button carries a red accent.
 */
function ListeningPortRowView({
  row,
  stopping,
  onOpen,
  onCopy,
  onStop,
}: {
  row: ListeningPortRow;
  stopping: boolean;
  onOpen: (row: ListeningPortRow) => void;
  onCopy: (row: ListeningPortRow) => void;
  onStop: (row: ListeningPortRow) => void;
}) {
  const stopHint = `Stop ${row.displayName} on port ${row.port}`;
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[0.5rem] py-0.5 pl-2 pr-1">
      <span
        className="w-12 shrink-0 text-[15px] font-semibold tabular-nums text-[var(--color-text-foreground)]"
        title={`Port ${row.port}`}
      >
        {row.port}
      </span>

      <span className="min-w-0">
        <span
          className="block truncate text-[length:var(--app-font-size-ui,12px)] font-normal leading-tight text-[var(--color-text-foreground)]"
          title={row.displayName}
        >
          {row.displayName}
        </span>
        <span
          className="mt-0.5 block truncate text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums leading-tight text-muted-foreground/65"
          title={row.address}
        >
          {row.address}
        </span>
      </span>

      <span className="flex shrink-0 items-center">
        <PortRowAction
          label={`Open ${row.address} in browser`}
          title={`Open ${row.address} in browser`}
          disabled={!row.url}
          onClick={() => onOpen(row)}
        >
          <ExternalLinkIcon className="size-3.5" />
        </PortRowAction>
        <PortRowAction
          label={`Copy ${row.address}`}
          title="Copy address"
          onClick={() => onCopy(row)}
        >
          <CopyIcon className="size-3.5" />
        </PortRowAction>
        <PortRowAction
          label={stopHint}
          title={stopHint}
          disabled={stopping}
          onClick={() => onStop(row)}
        >
          {stopping ? (
            <RefreshCwIcon className="size-3.5 animate-spin" />
          ) : (
            <StopFilledIcon className="size-3.5 text-destructive/80" />
          )}
        </PortRowAction>
      </span>
    </div>
  );
}

/** Centered placeholder for loading / error / empty states inside the menu body. */
function PortsPlaceholder({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-3 text-center">
      <span className="text-muted-foreground/40">{icon}</span>
      <span className="text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
        {title}
      </span>
      {subtitle ? (
        <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/60">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

export function EnvironmentLocalServersSection({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const projects = useStore((store) => store.projects);
  const configQuery = useQuery({ ...serverConfigQueryOptions(), enabled });
  const localServersQuery = useQuery(serverLocalServersQueryOptions({ enabled, includeAll: true }));
  const stopLocalServerMutation = useMutation(
    serverStopLocalServerMutationOptions({ queryClient }),
  );
  const [externalOpen, setExternalOpen] = useState<boolean | null>(null);

  const projectSources: PortProjectSource[] = useMemo(
    () =>
      toPortProjectSources(
        projects.map((project) => ({
          id: project.id,
          title: project.name,
          cwd: project.cwd,
          // `sources` only exists on bases with multi-source projects; probe
          // instead of accessing so this compiles on upstream too.
          sources: "sources" in project && Array.isArray(project.sources) ? project.sources : [],
        })),
        configQuery.data?.homeDir ?? null,
      ),
    [projects, configQuery.data],
  );
  const grouped = useMemo(
    () => groupListeningPorts(localServersQuery.data?.servers ?? [], projectSources),
    [localServersQuery.data, projectSources],
  );

  const isBusy = localServersQuery.isFetching || stopLocalServerMutation.isPending;
  const activeStoppingPid = stopLocalServerMutation.variables?.pid ?? null;
  const externalExpanded = externalOpen ?? grouped.workspaceCount === 0;

  const handleOpen = (row: ListeningPortRow) => {
    if (!row.url) {
      return;
    }
    const api = readNativeApi();
    if (!api) {
      return;
    }
    void api.shell.openExternal(row.url).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: `Unable to open ${row.address}`,
        description: error instanceof Error ? error.message : "Unable to open the port URL.",
      });
    });
  };

  const handleCopy = (row: ListeningPortRow) => {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      return;
    }
    const value = row.url ?? row.address;
    void clipboard.writeText(value).then(
      () => {
        toastManager.add({ type: "success", title: `Copied ${value}` });
      },
      () => {
        // Clipboard writes can reject without user gesture; nothing actionable to surface.
      },
    );
  };

  const handleStop = (row: ListeningPortRow) => {
    stopLocalServerMutation.mutate({ pid: row.pid, port: row.port });
  };

  const renderRow = (row: ListeningPortRow) => (
    <ListeningPortRowView
      key={`${row.port}:${row.pid}`}
      row={row}
      stopping={activeStoppingPid === row.pid && stopLocalServerMutation.isPending}
      onOpen={handleOpen}
      onCopy={handleCopy}
      onStop={handleStop}
    />
  );

  const trailing = (
    <>
      {isBusy ? (
        <RefreshCwIcon className="size-3 animate-spin text-[var(--color-text-foreground-secondary)]" />
      ) : (
        <span className="flex items-center gap-1.5">
          {grouped.workspaceCount > 0 ? (
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
          ) : null}
          <span className="text-[11px] tabular-nums text-[var(--color-text-foreground-secondary)]">
            {grouped.totalCount}
          </span>
        </span>
      )}
      <EnvironmentRowChevron />
    </>
  );

  return (
    <Menu>
      <MenuTrigger render={<button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} />}>
        <EnvironmentRowBody
          icon={<PlugIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Ports"
          trailing={trailing}
        />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-80 min-w-80">
        <div className="flex items-center justify-between gap-2 pb-0.5 pl-2 pr-3 pt-px">
          <span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/50">
            {localServersQuery.isLoading
              ? "Scanning ports…"
              : describePortsSummary(grouped.workspaceCount, grouped.externalCount)}
          </span>
          <PortsRefreshButton
            refreshing={localServersQuery.isFetching}
            onRefresh={() => void localServersQuery.refetch()}
          />
        </div>

        {localServersQuery.isLoading ? (
          <PortsPlaceholder
            icon={<RefreshCwIcon className="size-4 animate-spin" />}
            title="Scanning local ports"
          />
        ) : localServersQuery.isError ? (
          <PortsPlaceholder
            icon={<PlugIcon className="size-4" />}
            title="Couldn't scan local ports"
            subtitle={
              localServersQuery.error instanceof Error
                ? localServersQuery.error.message
                : "The scan failed. Try refreshing."
            }
          />
        ) : grouped.totalCount === 0 ? (
          <PortsPlaceholder
            icon={<PlugIcon className="size-4" />}
            title="No listening ports"
            subtitle="Processes listening on localhost will appear here."
          />
        ) : (
          <div className="flex flex-col gap-0.5">
            {grouped.groups.map((group) => (
              <div key={group.projectId}>
                <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5">
                  <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                  <span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground">
                    {group.projectTitle}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                    {group.rows.length}
                  </span>
                </div>
                {group.rows.map(renderRow)}
              </div>
            ))}

            {grouped.external.length > 0 ? (
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setExternalOpen(!externalExpanded)}
                  aria-expanded={externalExpanded}
                  className="flex w-full items-center gap-1 rounded-[0.5rem] px-2 py-1 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
                >
                  <DisclosureChevron open={externalExpanded} className="size-3.5" />
                  <span className="text-[length:var(--app-font-size-ui-xs,10px)] font-medium uppercase tracking-wide text-muted-foreground">
                    External ports
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                    {grouped.external.length}
                  </span>
                </button>
                <DisclosureRegion open={externalExpanded}>
                  {grouped.external.map(renderRow)}
                </DisclosureRegion>
              </div>
            ) : null}
          </div>
        )}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
