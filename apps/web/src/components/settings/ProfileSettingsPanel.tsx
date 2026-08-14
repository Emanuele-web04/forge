// FILE: ProfileSettingsPanel.tsx
// Purpose: Local-first profile / stats dashboard rendered inside Settings → Profile. Core
// stats render instantly from a fast SQL RPC; lifetime/peak token figures and the tokens/day
// heatmap stream in from a second DB-backed RPC. Centered, low-chrome layout
// with an explicit edit mode for the local name + handle.
// Layer: web profile feature (settings panel body).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ProfileStats, type ProfileTokenStats, type ProviderKind } from "@synara/contracts";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { CentralIcon } from "~/lib/central-icons";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { ActivityHeatmap } from "../profile/ActivityHeatmap";
import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTopProvider,
} from "../profile/profileSelectors";
import { ShareDialog } from "../profile/ShareDialog";
import { EditProfileDialog } from "../profile/EditProfileDialog";
import { useProfileHandle } from "../profile/useProfileHandle";
import { useProfileName } from "../profile/useProfileName";
import { useProfileAvatarColor } from "../profile/useProfileAvatarColor";
import { useProfileAvatarImage } from "../profile/useProfileAvatarImage";
import { ProfileAvatar } from "../profile/ProfileAvatar";
import {
  formatCompact,
  formatDays,
  formatNumber,
  toDisplayName,
} from "../profile/profileFormatting";

export function ProfileSettingsPanel() {
  const coreQuery = useQuery(serverProfileStatsQueryOptions());
  const tokenQuery = useQuery(serverProfileTokenStatsQueryOptions());

  if (coreQuery.isPending) {
    return <ProfileSkeleton />;
  }
  if (coreQuery.isError || !coreQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <p className="text-sm text-muted-foreground">Couldn’t load your local stats.</p>
        <Button variant="outline" size="sm" onClick={() => void coreQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <ProfileContent
      stats={coreQuery.data}
      tokenStats={tokenQuery.data ?? null}
      tokensPending={tokenQuery.isPending}
    />
  );
}

function ProfileContent({
  stats,
  tokenStats,
  tokensPending,
}: {
  stats: ProfileStats;
  tokenStats: ProfileTokenStats | null;
  tokensPending: boolean;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const defaultName = toDisplayName(stats.identity.homeDirBasename);
  const { name, setName } = useProfileName(defaultName);
  const { handle, setHandle } = useProfileHandle(stats.identity.defaultHandle);
  const { color: avatarColor, setColor: setAvatarColor } = useProfileAvatarColor();
  const { image: avatarImage, setImage: setAvatarImage } = useProfileAvatarImage();

  // Tokens/day when available, prompts/day otherwise — shared with ShareCard.
  const heatmap = selectProfileHeatmap(stats, tokenStats);
  const topProvider = selectProfileTopProvider(stats, tokenStats);
  const modelUsage = selectProfileModelUsage(stats, tokenStats);
  const peakHourLabel = formatPeakHourLabel(stats.activeHours.startHour);
  const mostWorkedProjectLabel = formatMostWorkedProjectLabel(stats.mostWorkedProject);

  return (
    <div className="flex min-w-0 flex-col gap-7">
      {/* Action row */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
          <CentralIcon name="share-os" />
          Share
        </Button>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
          <CentralIcon name="pencil" />
          Edit
        </Button>
      </div>

      {/* Centered identity header */}
      <header className="flex flex-col items-center gap-3 text-center">
        <ProfileAvatar
          initials={stats.identity.initials}
          color={avatarColor}
          image={avatarImage}
          className="size-16 shadow-sm"
          textClassName="text-xl"
        />
        <div className="flex flex-col items-center gap-1.5">
          <h2 className="text-2xl font-semibold tracking-tight">{name}</h2>
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>{handle}</span>
            <span aria-hidden>·</span>
            <span className="rounded-full border px-1.5 py-px text-xs text-muted-foreground">
              Synara
            </span>
          </div>
        </div>
      </header>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 divide-x divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        <StatTile
          label="Lifetime tokens"
          value={tokensPending ? null : formatCompact(tokenStats?.lifetimeTotalTokens ?? null)}
        />
        <StatTile
          label="Peak day"
          value={tokensPending ? null : formatCompact(tokenStats?.peakDayTokens ?? null)}
        />
        <StatTile label="Total prompts" value={formatNumber(stats.activity.totalPromptsSent)} />
        <StatTile label="Current streak" value={formatDays(stats.activity.currentStreakDays)} />
        <StatTile label="Longest streak" value={formatDays(stats.activity.longestStreakDays)} />
      </div>

      {/* Heatmap */}
      <section className="flex min-w-0 flex-col gap-3">
        <h3 className="text-sm font-medium">Activity</h3>
        {tokensPending ? (
          <Skeleton className="h-28 w-full rounded-lg" />
        ) : (
          <ActivityHeatmap
            cells={heatmap.cells}
            fill
            radius={5}
            gap={3}
            tooltip
            tooltipUnit={heatmap.unit}
            showMonths
            monthsPosition="bottom"
          />
        )}
      </section>

      {/* Insights + plugins */}
      <div className="grid gap-x-12 gap-y-7 md:grid-cols-2">
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Activity insights</h3>
          <dl className="flex flex-col gap-2.5">
            <InsightRow
              label="Most used provider"
              value={
                topProvider.provider
                  ? `${formatProviderLabel(topProvider.provider)}${
                      topProvider.percent !== null ? ` · ${topProvider.percent}%` : ""
                    }`
                  : "—"
              }
            />
            <InsightRow
              label="Most used reasoning"
              value={
                stats.insights.topReasoning
                  ? `${capitalize(stats.insights.topReasoning)}${
                      stats.insights.topReasoningPercent !== null
                        ? ` · ${stats.insights.topReasoningPercent}%`
                        : ""
                    }`
                  : "—"
              }
            />
            <InsightRow label="Most active hour" value={peakHourLabel} />
            <InsightRow label="Most worked project" value={mostWorkedProjectLabel} />
            <InsightRow
              label="Skills explored"
              value={formatNumber(stats.insights.skillsExplored)}
            />
            <InsightRow
              label="Total skills used"
              value={formatNumber(stats.insights.totalSkillsUsed)}
            />
            <InsightRow label="Total threads" value={formatNumber(stats.activity.totalThreads)} />
          </dl>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium">Most used plugins</h3>
          {stats.skills.length > 0 ? (
            <ul className="flex flex-col gap-2.5">
              {stats.skills.slice(0, 6).map((skill) => (
                <li
                  key={`${skill.kind}:${skill.name}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted/60">
                      <CentralIcon
                        name={skill.kind === "agent" ? "agent" : "building-blocks"}
                        className="size-3"
                      />
                    </span>
                    <span className="truncate text-sm">{skill.displayName}</span>
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {formatNumber(skill.runCount)} runs
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No skills or agents used yet.</p>
          )}
        </section>
      </div>

      {/* Model usage */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Model usage</h3>
        {modelUsage.entries.length > 0 ? (
          <ul className="grid grid-cols-1 gap-x-12 gap-y-3 sm:grid-cols-2">
            {modelUsage.entries.slice(0, 6).map((entry) => (
              <ModelUsageRow
                key={`${entry.provider}:${entry.model}`}
                provider={entry.provider}
                model={entry.model}
                percent={entry.percent}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No model activity yet.</p>
        )}
      </section>

      <ShareDialog
        stats={stats}
        tokenStats={tokenStats}
        displayName={name}
        handle={handle}
        avatarColor={avatarColor}
        avatarImage={avatarImage}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      <EditProfileDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        initials={stats.identity.initials}
        name={name}
        handle={handle}
        avatarColor={avatarColor}
        avatarImage={avatarImage}
        onSave={({
          name: nextName,
          handle: nextHandle,
          avatarColor: nextColor,
          avatarImage: nextImage,
        }) => {
          setName(nextName);
          setHandle(nextHandle);
          setAvatarColor(nextColor);
          setAvatarImage(nextImage);
        }}
      />
    </div>
  );
}

// ── Small pieces ───────────────────────────────────────────────────────

function StatTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-3">
      {value === null ? (
        <Skeleton className="h-4 w-12" />
      ) : (
        <span className="text-sm font-normal tabular-nums text-foreground">{value}</span>
      )}
      <span className="text-sm font-normal text-muted-foreground">{label}</span>
    </div>
  );
}

function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-normal tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatHour(hour: number): string {
  const normalized = ((hour % 24) + 24) % 24;
  if (normalized === 0) return "12 AM";
  if (normalized === 12) return "12 PM";
  return normalized < 12 ? `${normalized} AM` : `${normalized - 12} PM`;
}

function formatPeakHourLabel(startHour: number | null): string {
  return startHour === null ? "—" : formatHour(startHour);
}

function formatMostWorkedProjectLabel(project: ProfileStats["mostWorkedProject"]): string {
  if (!project) {
    return "—";
  }
  const promptLabel = project.promptCount === 1 ? "prompt" : "prompts";
  return `${project.title} · ${formatNumber(project.promptCount)} ${promptLabel}`;
}

function formatProviderLabel(provider: ProviderKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "cursor":
      return "Cursor";
    case "antigravity":
      return "Antigravity";
    case "grok":
      return "Grok";
    case "droid":
      return "Droid";
    case "kilo":
      return "Kilo";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
  }
}

function ModelUsageRow({
  provider,
  model,
  percent,
}: {
  provider: ProviderKind | "unknown";
  model: string;
  percent: number;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          {provider !== "unknown" ? (
            <ProviderIcon provider={provider} className="size-3.5 shrink-0" />
          ) : (
            <CentralIcon name="chart-2" className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{model}</span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{percent}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--info)]"
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
    </li>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col items-center gap-7">
      <Skeleton className="size-16 rounded-full" />
      <div className="flex flex-col items-center gap-1.5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-[72px] w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="grid w-full gap-7 md:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    </div>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}
