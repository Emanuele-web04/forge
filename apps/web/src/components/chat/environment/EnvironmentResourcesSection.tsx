// FILE: EnvironmentResourcesSection.tsx
// Purpose: Environment panel row/menu for the Orca-parity resource manager:
// live CPU/RSS per terminal session grouped project > worktree, per-session
// kill, orphan cleanup, workspace cleanup, provider restart, disk scan (Beta).
// Layer: Environment panel section
// Depends on: resource React Query helpers and the shared Environment row skin.

import { useState } from "react";

import type { ResourceProcessSnapshot, ResourceWorkspaceCandidate } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBytes } from "@synara/shared/formatBytes";

import { showConfirmDialogFallback } from "~/confirmDialogFallback";
import { ensureNativeApi } from "~/nativeApi";
import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { DevicePowerIcon, RefreshCwIcon, TerminalIcon, TrashCanIcon, XIcon } from "~/lib/icons";
import {
  resourceCleanWorkspacesMutationOptions,
  resourceKillAllSessionsMutationOptions,
  resourceKillSessionMutationOptions,
  resourceRestartDaemonMutationOptions,
  resourceScanDiskMutationOptions,
  resourceSnapshotQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

type ResourceSortMode = "rss" | "cpu" | "name";

function formatCpu(cpuPct: number): string {
  return `${(Math.round(cpuPct * 10) / 10).toFixed(1)}%`;
}

function sessionLabel(session: ResourceProcessSnapshot): string {
  return session.terminalId ?? session.provider ?? `pid ${session.pid}`;
}

const TREE_GRID_CLASS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-[0.5rem]";
const CPU_CELL_CLASS =
  "w-11 shrink-0 text-right text-[11px] tabular-nums text-[var(--color-text-foreground-secondary)]";
const RSS_CELL_CLASS =
  "w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-[var(--color-text-foreground-secondary)]";
const RSS_CELL_STRONG_CLASS =
  "w-[4.5rem] shrink-0 text-right text-[11px] tabular-nums text-[var(--color-text-foreground)]";
const KILL_BUTTON_CLASS =
  "inline-flex size-6 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground/70 opacity-0 transition-colors hover:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] hover:text-destructive group-hover:opacity-100 data-highlighted:bg-[color-mix(in_srgb,var(--destructive)_12%,transparent)] data-highlighted:text-destructive data-highlighted:opacity-100 data-disabled:opacity-0";
const HEADER_ACTION_CLASS =
  "inline-flex h-5 items-center justify-center rounded-md px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)]";

function Sparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return <span className="inline-block w-12" aria-hidden />;
  const width = 48;
  const height = 14;
  const max = Math.max(...values, 0.1);
  const points = values
    .map(
      (value, index) =>
        `${((index / (values.length - 1)) * width).toFixed(1)},${(height - (value / max) * (height - 2) - 1).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      className="shrink-0 text-muted-foreground/40"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  );
}

function sortProcesses(
  processes: readonly ResourceProcessSnapshot[],
  mode: ResourceSortMode,
): ResourceProcessSnapshot[] {
  switch (mode) {
    case "cpu":
      return processes.toSorted((left, right) => right.cpuPct - left.cpuPct);
    case "name":
      return processes.toSorted((left, right) =>
        sessionLabel(left).localeCompare(sessionLabel(right)),
      );
    case "rss":
    default:
      return processes.toSorted((left, right) => right.rssBytes - left.rssBytes);
  }
}

function SessionRow({
  session,
  killing,
  onKill,
}: {
  session: ResourceProcessSnapshot;
  killing: boolean;
  onKill: (session: ResourceProcessSnapshot) => void;
}) {
  const label = sessionLabel(session);
  return (
    <div className={cn("group py-0.5 pl-6 pr-2.5", TREE_GRID_CLASS)}>
      <span className="relative flex size-2 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute size-2 rounded-full bg-success/25" />
        <span className="relative size-1 rounded-full bg-success" />
      </span>
      <span className="min-w-0 truncate text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]">
        {label}
      </span>
      <span className={CPU_CELL_CLASS}>{formatCpu(session.cpuPct)}</span>
      <span className={RSS_CELL_CLASS}>{formatBytes(session.rssBytes)}</span>
      <MenuItem
        closeOnClick={false}
        disabled={killing}
        onClick={() => onKill(session)}
        aria-label={`Kill ${label}`}
        title={`Kill ${label} (cannot be undone)`}
        className={KILL_BUTTON_CLASS}
      >
        {killing ? (
          <RefreshCwIcon className="size-3 animate-spin" />
        ) : (
          <XIcon className="size-3.5" />
        )}
      </MenuItem>
    </div>
  );
}

function CollapsibleNode({
  name,
  nameClassName,
  cpuPct,
  rssBytes,
  history,
  bodyClassName,
  children,
}: {
  name: string;
  nameClassName: string;
  cpuPct: number;
  rssBytes: number;
  history: readonly number[];
  bodyClassName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          TREE_GRID_CLASS,
          "px-2 text-left outline-none hover:bg-[var(--color-background-elevated-secondary)]",
          bodyClassName,
        )}
      >
        <DisclosureChevron open={open} className="size-3 text-muted-foreground/60" />
        <span className={cn("min-w-0 truncate", nameClassName)}>{name}</span>
        <Sparkline values={history} />
        <span className={CPU_CELL_CLASS}>{formatCpu(cpuPct)}</span>
        <span className={RSS_CELL_STRONG_CLASS}>{formatBytes(rssBytes)}</span>
      </button>
      {open ? <div className="flex flex-col">{children}</div> : null}
    </div>
  );
}

const WORKTREE_NAME_CLASS =
  "text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)]";
const PROJECT_NAME_CLASS =
  "text-[length:var(--app-font-size-ui,12px)] font-medium uppercase tracking-wide text-[var(--color-text-foreground)]";

function ResourcesPlaceholder({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
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

async function confirmAndRun(message: string, run: () => void): Promise<void> {
  const confirmed = await showConfirmDialogFallback(`${message} This cannot be undone.`);
  if (confirmed) run();
}

function FooterButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-[0.5rem] px-2 py-1 text-left text-[length:var(--app-font-size-ui,12px)] outline-none hover:bg-[var(--color-background-elevated-secondary)] disabled:opacity-50",
        danger ? "text-destructive" : "text-[var(--color-text-foreground)]",
      )}
    >
      {children}
      <span aria-hidden className="text-muted-foreground/50">
        ›
      </span>
    </button>
  );
}

export function EnvironmentResourcesSection({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient();
  const snapshotQuery = useQuery(resourceSnapshotQueryOptions(enabled));
  const killSessionMutation = useMutation(resourceKillSessionMutationOptions({ queryClient }));
  const killAllMutation = useMutation(resourceKillAllSessionsMutationOptions({ queryClient }));
  const cleanMutation = useMutation(resourceCleanWorkspacesMutationOptions({ queryClient }));
  const scanMutation = useMutation(resourceScanDiskMutationOptions());
  const restartMutation = useMutation(resourceRestartDaemonMutationOptions({ queryClient }));

  const [sortMode, setSortMode] = useState<ResourceSortMode>("rss");
  const [cleanPreview, setCleanPreview] = useState<readonly ResourceWorkspaceCandidate[] | null>(
    null,
  );
  const [showDiskDetails, setShowDiskDetails] = useState(false);

  const snapshot = snapshotQuery.data;
  const projects = snapshot?.projects ?? [];
  const orphans = snapshot?.unattributed ?? [];
  const killingKey = killSessionMutation.isPending
    ? (killSessionMutation.variables?.terminalId ?? String(killSessionMutation.variables?.pid))
    : null;

  const cycleSort = () =>
    setSortMode((mode) => (mode === "rss" ? "cpu" : mode === "cpu" ? "name" : "rss"));

  const handleKill = (session: ResourceProcessSnapshot) =>
    confirmAndRun(`Kill ${sessionLabel(session)} (${formatBytes(session.rssBytes)} RSS)?`, () =>
      killSessionMutation.mutate({
        ...(session.terminalId ? { terminalId: session.terminalId } : {}),
        pid: session.pid,
      }),
    );

  const handleKillOrphans = () => {
    if (orphans.length === 0) return;
    const noun = orphans.length === 1 ? "process" : "processes";
    void confirmAndRun(`End ${orphans.length} orphan terminal ${noun}?`, () => {
      for (const orphan of orphans) {
        killSessionMutation.mutate({ pid: orphan.pid });
      }
    });
  };

  const handleKillAll = () => {
    const count = snapshot?.sessionCount ?? 0;
    if (count === 0) return;
    const noun = count === 1 ? "session" : "sessions";
    void confirmAndRun(`Kill all ${count} terminal ${noun}?`, () => killAllMutation.mutate());
  };

  const handleRestartDaemon = () =>
    confirmAndRun(
      "Restart the provider runtime? All provider sessions stop and respawn lazily on the next turn. In-flight turns will be interrupted.",
      () =>
        confirmAndRun("Really restart now? Confirm a second time to proceed.", () =>
          restartMutation.mutate(),
        ),
    );

  const handleCleanPreview = () => {
    setCleanPreview(null);
    cleanMutation.mutate(
      { dryRun: true },
      {
        onSuccess: (result) => setCleanPreview(result.candidates),
      },
    );
  };

  const handleCleanExecute = () => {
    if (!cleanPreview || cleanPreview.length === 0) return;
    const reclaimable = cleanPreview.reduce((sum, candidate) => sum + candidate.bytes, 0);
    const noun = cleanPreview.length === 1 ? "workspace" : "workspaces";
    void confirmAndRun(
      `Remove ${cleanPreview.length} ${noun} and reclaim ${formatBytes(reclaimable)}? Snapshots are kept before removal and dirty worktrees are skipped.`,
      () =>
        cleanMutation.mutate(
          { dryRun: false, paths: cleanPreview.map((candidate) => candidate.path) },
          { onSuccess: () => setCleanPreview(null) },
        ),
    );
  };

  const handleScan = () => {
    setShowDiskDetails(false);
    scanMutation.mutate({});
  };

  const handleCancelScan = async () => {
    try {
      const api = ensureNativeApi();
      await api.server.cancelResourceDiskScan();
    } finally {
      scanMutation.reset();
    }
  };

  const busy =
    snapshotQuery.isFetching ||
    killSessionMutation.isPending ||
    killAllMutation.isPending ||
    cleanMutation.isPending ||
    restartMutation.isPending;

  const trailing = (
    <>
      {snapshotQuery.isLoading || !snapshot ? (
        <EnvironmentRowChevron />
      ) : (
        <span className="flex items-center gap-1.5">
          <span className="text-[11px] tabular-nums text-[var(--color-text-foreground-secondary)]">
            {formatCpu(snapshot.totalCpuPct)} · {formatBytes(snapshot.totalRssBytes)}
          </span>
        </span>
      )}
      <EnvironmentRowChevron />
    </>
  );

  const diskReport = scanMutation.data;

  return (
    <Menu>
      <MenuTrigger render={<button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} />}>
        <EnvironmentRowBody
          icon={<TerminalIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label="Resources"
          trailing={trailing}
        />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-[22rem] min-w-[22rem]">
        <div className="flex items-center justify-between gap-2 pb-0.5 pl-2 pr-3 pt-px">
          <span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/50">
            {snapshotQuery.isLoading
              ? "Sampling processes…"
              : snapshot
                ? `${formatCpu(snapshot.totalCpuPct)} · ${formatBytes(snapshot.totalRssBytes)} Σ RSS · ${snapshot.sessionCount} sessions`
                : "Resource snapshot unavailable"}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <MenuItem
              closeOnClick={false}
              onClick={cycleSort}
              aria-label={`Sort by ${sortMode === "rss" ? "CPU" : sortMode === "cpu" ? "name" : "RSS"}`}
              title={`Sort: ${sortMode.toUpperCase()} (click to change)`}
              className={HEADER_ACTION_CLASS}
            >
              {sortMode}
            </MenuItem>
            <MenuItem
              closeOnClick={false}
              disabled={snapshotQuery.isFetching}
              onClick={() => void snapshotQuery.refetch()}
              aria-label="Refresh resource snapshot"
              title="Refresh"
              className={cn(HEADER_ACTION_CLASS, "px-0")}
            >
              <RefreshCwIcon className={cn("size-3", snapshotQuery.isFetching && "animate-spin")} />
            </MenuItem>
          </div>
        </div>

        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-2 pb-1">
          <span className="w-3" aria-hidden />
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
            Name
          </span>
          <span className="w-12" aria-hidden />
          <span className="w-11 text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
            CPU
          </span>
          <span className="w-[4.5rem] text-right text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
            RSS
          </span>
        </div>

        {snapshotQuery.isLoading ? (
          <ResourcesPlaceholder
            icon={<RefreshCwIcon className="size-4 animate-spin" />}
            title="Sampling processes"
          />
        ) : snapshotQuery.isError || !snapshot ? (
          <ResourcesPlaceholder
            icon={<TerminalIcon className="size-4" />}
            title="Couldn't sample processes"
            subtitle={
              snapshotQuery.error instanceof Error
                ? snapshotQuery.error.message
                : "The sampler failed. Try refreshing."
            }
          />
        ) : projects.length === 0 && orphans.length === 0 ? (
          <ResourcesPlaceholder
            icon={<TerminalIcon className="size-4" />}
            title="No sessions running"
            subtitle="Terminal sessions will appear here."
          />
        ) : (
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {projects.map((project) => (
              <CollapsibleNode
                key={project.id}
                name={project.name}
                nameClassName={PROJECT_NAME_CLASS}
                cpuPct={project.cpuPct}
                rssBytes={project.rssBytes}
                history={project.history}
                bodyClassName="py-1"
              >
                {project.worktrees.map((node) => (
                  <CollapsibleNode
                    key={node.path}
                    name={node.name}
                    nameClassName={WORKTREE_NAME_CLASS}
                    cpuPct={node.cpuPct}
                    rssBytes={node.rssBytes}
                    history={node.history}
                    bodyClassName="py-0.5"
                  >
                    {sortProcesses(node.processes, sortMode).map((session) => (
                      <SessionRow
                        key={session.terminalId ?? session.pid}
                        session={session}
                        killing={killingKey === (session.terminalId ?? String(session.pid))}
                        onKill={(child) => void handleKill(child)}
                      />
                    ))}
                  </CollapsibleNode>
                ))}
              </CollapsibleNode>
            ))}
            {orphans.length > 0 ? (
              <div className="flex flex-col">
                <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                  Orphaned · {orphans.length}
                </div>
                {sortProcesses(orphans, sortMode).map((orphan) => (
                  <SessionRow
                    key={orphan.pid}
                    session={orphan}
                    killing={killingKey === String(orphan.pid)}
                    onKill={(session) => void handleKill(session)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )}

        <div className="mt-1 border-t border-[color:var(--color-border-light)] pt-1">
          <FooterButton onClick={handleCleanPreview} disabled={cleanMutation.isPending || busy}>
            <span className="flex items-center gap-2">
              {cleanMutation.isPending ? (
                <RefreshCwIcon className="size-3.5 animate-spin" />
              ) : (
                <TrashCanIcon className="size-3.5" />
              )}
              {cleanMutation.isPending ? "Scanning workspaces…" : "Clean up workspaces"}
            </span>
          </FooterButton>
          {cleanPreview ? (
            <div className="flex flex-col gap-0.5 px-2 py-1">
              {cleanPreview.length === 0 ? (
                <span className="text-[11px] text-muted-foreground/70">
                  Nothing reclaimable — active and retained worktrees are kept.
                </span>
              ) : (
                <>
                  {cleanPreview.slice(0, 8).map((candidate) => (
                    <div
                      key={candidate.path}
                      className="flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
                        {candidate.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--color-text-foreground-secondary)]">
                        {formatBytes(candidate.bytes)}
                      </span>
                    </div>
                  ))}
                  {cleanPreview.length > 8 ? (
                    <span className="text-[11px] text-muted-foreground/60">
                      +{cleanPreview.length - 8} more
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleCleanExecute()}
                    disabled={cleanMutation.isPending}
                    className="mt-0.5 flex w-full items-center justify-center gap-2 rounded-[0.5rem] bg-destructive px-2 py-1 text-[12px] font-medium text-white outline-none hover:opacity-90 disabled:opacity-50"
                  >
                    Remove {cleanPreview.length}{" "}
                    {cleanPreview.length === 1 ? "workspace" : "workspaces"} (
                    {formatBytes(cleanPreview.reduce((sum, c) => sum + c.bytes, 0))})
                  </button>
                </>
              )}
            </div>
          ) : null}
          {orphans.length > 0 ? (
            <FooterButton onClick={() => void handleKillOrphans()} disabled={busy}>
              <span>
                End {orphans.length} orphan terminal{orphans.length === 1 ? "" : "s"}
              </span>
            </FooterButton>
          ) : null}
          <FooterButton
            onClick={() => void handleKillAll()}
            disabled={busy || (snapshot?.sessionCount ?? 0) === 0}
            danger
          >
            <span>Kill all sessions</span>
          </FooterButton>
          <FooterButton onClick={() => void handleRestartDaemon()} disabled={busy} danger>
            <span className="flex items-center gap-2">
              {restartMutation.isPending ? (
                <RefreshCwIcon className="size-3.5 animate-spin" />
              ) : (
                <DevicePowerIcon className="size-3.5" />
              )}
              Restart provider runtime
            </span>
          </FooterButton>
        </div>

        <div className="mt-1 border-t border-[color:var(--color-border-light)] px-2 pb-1 pt-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
              Disk usage · Beta
            </span>
            <div className="flex shrink-0 items-center gap-1">
              {scanMutation.isPending ? (
                <MenuItem
                  closeOnClick={false}
                  onClick={() => void handleCancelScan()}
                  aria-label="Cancel disk scan"
                  className={HEADER_ACTION_CLASS}
                >
                  Cancel
                </MenuItem>
              ) : (
                <MenuItem
                  closeOnClick={false}
                  onClick={handleScan}
                  aria-label="Scan disk usage"
                  className={HEADER_ACTION_CLASS}
                >
                  <RefreshCwIcon className="mr-1 size-2.5" />
                  Scan
                </MenuItem>
              )}
              {diskReport ? (
                <MenuItem
                  closeOnClick={false}
                  onClick={() => setShowDiskDetails((value) => !value)}
                  aria-label="Review disk usage details"
                  className={HEADER_ACTION_CLASS}
                >
                  Review
                </MenuItem>
              ) : null}
            </div>
          </div>
          {scanMutation.isPending ? (
            <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground/70">
              <RefreshCwIcon className="size-3 animate-spin" />
              Scanning worktree disk usage…
            </div>
          ) : diskReport ? (
            <div className="flex flex-col gap-0.5 py-0.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground/70">Scanned</span>
                <span className="tabular-nums text-[var(--color-text-foreground)]">
                  {formatBytes(diskReport.totalBytes)}
                </span>
              </div>
              {showDiskDetails
                ? diskReport.entries.slice(0, 8).map((entry) => (
                    <div
                      key={entry.path}
                      className="flex items-center justify-between gap-2 text-[11px]"
                    >
                      <span
                        className="min-w-0 truncate text-muted-foreground/70"
                        title={entry.path}
                      >
                        {entry.path.split("/").slice(-2).join("/")}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--color-text-foreground-secondary)]">
                        {formatBytes(entry.bytes)}
                      </span>
                    </div>
                  ))
                : null}
            </div>
          ) : (
            <div className="py-0.5 text-[11px] text-muted-foreground/60">
              Disk usage hasn&apos;t been scanned yet.
            </div>
          )}
        </div>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
