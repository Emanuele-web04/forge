// FILE: ProfileSettingsPanel.tsx
// Purpose: Local-first profile / stats dashboard rendered inside Settings → Profile. Core
// stats render instantly from a fast SQL RPC; lifetime/peak token figures and the tokens/day
// heatmap stream in from a second DB-backed RPC. Signed-in users get a
// This device / Account toggle: the Account view renders the account-wide
// usage summary through the same sections (device-only rows hidden). Centered,
// low-chrome layout with an explicit edit mode for the local name + handle.
// Layer: web profile feature (settings panel body).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { type ProfileStats, type ProfileTokenStats, type ProviderKind } from "@synara/contracts";
import {
  serverProfileStatsQueryOptions,
  serverProfileTokenStatsQueryOptions,
} from "~/lib/serverReactQuery";
import { accountUsageSummaryQueryOptions } from "~/lib/accountReactQuery";
import { localDayKey, selectAccountUsageView } from "~/lib/accountUsageAdapter";
import { useAccount } from "~/hooks/useAccount";
import { CentralIcon } from "~/lib/central-icons";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ActivityHeatmap, heatmapTooltipText } from "@synara/profile-ui/heatmap";
import { InsightRow, ModelUsageRow, StatTileGrid } from "@synara/profile-ui/sections";
import { providerLabel } from "@synara/profile-ui/provider-icon";
import {
  selectProfileHeatmap,
  selectProfileModelUsage,
  selectProfileTopProvider,
} from "../profile/profileSelectors";
import { ShareDialog } from "../profile/ShareDialog";
import { EditProfileDialog } from "../profile/EditProfileDialog";
import { useProfileIdentity } from "../profile/useProfileIdentity";
import { ProfileAvatar } from "@synara/profile-ui/avatar";
import {
  formatCompact,
  formatDays,
  formatHourLabel,
  formatNumber,
  toDisplayName,
} from "@synara/profile-ui/formatting";
import { SettingsSegmentedControl } from "./SettingControls";

type StatsScope = "device" | "account";

const SCOPE_OPTIONS = [
  { value: "device", label: "This device" },
  { value: "account", label: "Account" },
] as const satisfies readonly { value: StatsScope; label: string }[];

export function ProfileSettingsPanel() {
  const coreQuery = useQuery(serverProfileStatsQueryOptions());
  const tokenQuery = useQuery(serverProfileTokenStatsQueryOptions());
  const { me } = useAccount();
  const [scope, setScope] = useState<StatsScope>("device");

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
      // Signed out: no toggle, the device view is the whole panel.
      scope={me ? scope : "device"}
      onScopeChange={me ? setScope : null}
    />
  );
}

function ProfileContent({
  stats,
  tokenStats,
  tokensPending,
  scope,
  onScopeChange,
}: {
  stats: ProfileStats;
  tokenStats: ProfileTokenStats | null;
  tokensPending: boolean;
  scope: StatsScope;
  onScopeChange: ((scope: StatsScope) => void) | null;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const defaultName = toDisplayName(stats.identity.homeDirBasename);
  const { name, handle, avatarColor, avatarImage, accountProfile, save } = useProfileIdentity({
    name: defaultName,
    handle: stats.identity.defaultHandle,
  });

  return (
    <div className="flex min-w-0 flex-col gap-7">
      {/* Action row: scope toggle (signed in) on the left, share/edit on the right. */}
      <div
        className={
          onScopeChange
            ? "flex items-center justify-between gap-2"
            : "flex items-center justify-end gap-2"
        }
      >
        {onScopeChange ? (
          <SettingsSegmentedControl
            value={scope}
            onValueChange={onScopeChange}
            options={SCOPE_OPTIONS}
            ariaLabel="Stats scope"
          />
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
            <CentralIcon name="share-os" />
            Share
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <CentralIcon name="pencil" />
            Edit
          </Button>
        </div>
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

      {scope === "account" ? (
        <AccountStatsBody />
      ) : (
        <DeviceStatsBody stats={stats} tokenStats={tokenStats} tokensPending={tokensPending} />
      )}

      <ShareDialog
        stats={stats}
        tokenStats={tokenStats}
        displayName={name}
        handle={handle}
        avatarColor={avatarColor}
        avatarImage={avatarImage}
        accountProfile={accountProfile}
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
        accountProfile={accountProfile}
        onSave={save}
      />
    </div>
  );
}

// ── This device ────────────────────────────────────────────────────────

function DeviceStatsBody({
  stats,
  tokenStats,
  tokensPending,
}: {
  stats: ProfileStats;
  tokenStats: ProfileTokenStats | null;
  tokensPending: boolean;
}) {
  // Tokens/day when available, prompts/day otherwise — shared with ShareCard.
  const heatmap = selectProfileHeatmap(stats, tokenStats);
  const topProvider = selectProfileTopProvider(stats, tokenStats);
  const modelUsage = selectProfileModelUsage(stats, tokenStats);

  return (
    <>
      <StatTileGrid
        tiles={[
          {
            label: "Lifetime tokens",
            value: tokensPending ? null : formatCompact(tokenStats?.lifetimeTotalTokens ?? null),
          },
          {
            label: "Peak day",
            value: tokensPending ? null : formatCompact(tokenStats?.peakDayTokens ?? null),
          },
          { label: "Total prompts", value: formatNumber(stats.activity.totalPromptsSent) },
          { label: "Current streak", value: formatDays(stats.activity.currentStreakDays) },
          { label: "Longest streak", value: formatDays(stats.activity.longestStreakDays) },
        ]}
      />

      <HeatmapSection pending={tokensPending} cells={heatmap.cells} unit={heatmap.unit} />

      <div className="grid gap-x-12 gap-y-7 md:grid-cols-2">
        <InsightsSection
          rows={[
            {
              label: "Most used provider",
              value: topProvider.provider
                ? `${providerLabel(topProvider.provider)}${
                    topProvider.percent !== null ? ` · ${topProvider.percent}%` : ""
                  }`
                : "—",
            },
            {
              label: "Most used reasoning",
              value: stats.insights.topReasoning
                ? `${capitalize(stats.insights.topReasoning)}${
                    stats.insights.topReasoningPercent !== null
                      ? ` · ${stats.insights.topReasoningPercent}%`
                      : ""
                  }`
                : "—",
            },
            { label: "Most active hour", value: formatPeakHourLabel(stats.activeHours.startHour) },
            {
              label: "Most worked project",
              value: formatMostWorkedProjectLabel(stats.mostWorkedProject),
            },
            { label: "Skills explored", value: formatNumber(stats.insights.skillsExplored) },
            { label: "Total skills used", value: formatNumber(stats.insights.totalSkillsUsed) },
            { label: "Total threads", value: formatNumber(stats.activity.totalThreads) },
          ]}
        />

        <SkillsSection
          skills={stats.skills.map((skill) => ({
            key: `${skill.kind}:${skill.name}`,
            displayName: skill.displayName,
            kind: skill.kind,
            runCount: skill.runCount,
          }))}
        />
      </div>

      <ModelUsageSection entries={modelUsage.entries} />
    </>
  );
}

// ── Account ────────────────────────────────────────────────────────────

function AccountStatsBody() {
  const usageQuery = useQuery(accountUsageSummaryQueryOptions());

  if (usageQuery.isPending) {
    return <AccountStatsSkeleton />;
  }
  if (usageQuery.isError || !usageQuery.data) {
    // Retryable error state; the scope toggle above always lets the user
    // flip back to This device.
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-muted-foreground">Couldn’t load your account stats.</p>
        <Button variant="outline" size="sm" onClick={() => void usageQuery.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const view = selectAccountUsageView(usageQuery.data, localDayKey());

  return (
    <>
      <StatTileGrid
        tiles={[
          { label: "Lifetime tokens", value: formatCompact(view.lifetimeTokens) },
          { label: "Peak day", value: formatCompact(view.peakDayTokens) },
          { label: "Total prompts", value: formatNumber(view.lifetimePrompts) },
          { label: "Current streak", value: formatDays(view.currentStreakDays) },
          { label: "Longest streak", value: formatDays(view.longestStreakDays) },
        ]}
      />

      <HeatmapSection pending={false} cells={view.heatmap.cells} unit={view.heatmap.unit} />

      <div className="grid gap-x-12 gap-y-7 md:grid-cols-2">
        {/* Most-worked project and provider quota are device-only (content/plan
            data never syncs), so those rows don't exist on the Account view. */}
        <InsightsSection
          rows={[
            {
              label: "Most used provider",
              value: view.topProvider.provider
                ? `${providerLabel(view.topProvider.provider)}${
                    view.topProvider.percent !== null ? ` · ${view.topProvider.percent}%` : ""
                  }`
                : "—",
            },
            {
              label: "Most used reasoning",
              value: view.topReasoning.reasoning
                ? `${capitalize(view.topReasoning.reasoning)}${
                    view.topReasoning.percent !== null ? ` · ${view.topReasoning.percent}%` : ""
                  }`
                : "—",
            },
            { label: "Most active hour", value: formatPeakHourLabel(view.peakHour) },
            { label: "Skills explored", value: formatNumber(view.skillsExplored) },
            { label: "Total skills used", value: formatNumber(view.totalSkillsUsed) },
            { label: "Total turns", value: formatNumber(view.lifetimeTurns) },
          ]}
        />

        <SkillsSection
          skills={view.skills.map((skill) => ({
            key: `${skill.kind}:${skill.name}`,
            displayName: skill.displayName,
            kind: skill.kind,
            runCount: skill.runCount,
          }))}
        />
      </div>

      <ModelUsageSection entries={view.models} />
    </>
  );
}

function AccountStatsSkeleton() {
  return (
    <>
      <Skeleton className="h-[72px] w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-lg" />
      <div className="grid w-full gap-7 md:grid-cols-2">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    </>
  );
}

// ── Shared sections (device + account views) ──────────────────────────

function HeatmapSection({
  pending,
  cells,
  unit,
}: {
  pending: boolean;
  cells: Parameters<typeof ActivityHeatmap>[0]["cells"];
  unit: "tokens" | "prompts";
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <h3 className="text-sm font-medium">Activity</h3>
      {pending ? (
        <Skeleton className="h-28 w-full rounded-lg" />
      ) : (
        <ActivityHeatmap
          cells={cells}
          fill
          radius={5}
          gap={3}
          renderTooltip={(cell, cellNode) => (
            <Tooltip>
              {/* delay={0}: heatmap tooltips open instantly on hover (no Base UI 600ms default). */}
              <TooltipTrigger delay={0} render={cellNode} />
              <TooltipPopup side="top" sideOffset={6}>
                {heatmapTooltipText(cell, unit)}
              </TooltipPopup>
            </Tooltip>
          )}
          showMonths
          monthsPosition="bottom"
        />
      )}
    </section>
  );
}

function InsightsSection({ rows }: { rows: readonly { label: string; value: string }[] }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Activity insights</h3>
      <dl className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <InsightRow key={row.label} label={row.label} value={row.value} />
        ))}
      </dl>
    </section>
  );
}

function SkillsSection({
  skills,
}: {
  skills: readonly {
    key: string;
    displayName: string;
    kind: "skill" | "agent";
    runCount: number;
  }[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Most used plugins</h3>
      {skills.length > 0 ? (
        <ul className="flex flex-col gap-2.5">
          {skills.slice(0, 6).map((skill) => (
            <li key={skill.key} className="flex items-center justify-between gap-3">
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
  );
}

function ModelUsageSection({
  entries,
}: {
  entries: readonly { provider: ProviderKind | "unknown"; model: string; percent: number }[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Model usage</h3>
      {entries.length > 0 ? (
        <ul className="grid grid-cols-1 gap-x-12 gap-y-3 sm:grid-cols-2">
          {entries.slice(0, 6).map((entry) => (
            <ModelUsageRow
              key={`${entry.provider}:${entry.model}`}
              icon={
                entry.provider !== "unknown" ? (
                  <ProviderIcon provider={entry.provider} className="size-3.5 shrink-0" />
                ) : (
                  <CentralIcon name="chart-2" className="size-3.5 shrink-0 text-muted-foreground" />
                )
              }
              model={entry.model}
              percent={entry.percent}
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No model activity yet.</p>
      )}
    </section>
  );
}

// ── Small pieces ───────────────────────────────────────────────────────

function formatPeakHourLabel(startHour: number | null): string {
  return startHour === null ? "—" : formatHourLabel(startHour);
}

function formatMostWorkedProjectLabel(project: ProfileStats["mostWorkedProject"]): string {
  if (!project) {
    return "—";
  }
  const promptLabel = project.promptCount === 1 ? "prompt" : "prompts";
  return `${project.title} · ${formatNumber(project.promptCount)} ${promptLabel}`;
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
