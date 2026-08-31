// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — one compact menu per enabled provider.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  buildProviderUsageMenuModel,
  ProviderUsageMenuPopup,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { MenuTrigger } from "~/components/ui/menu";
import { resolveProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { deriveAccountRateLimits, type ProviderRateLimit } from "~/lib/rateLimits";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { useStore } from "~/store";
import { createAccountRateLimitThreadsSelector } from "~/storeSelectors";

import { resolveEnvironmentProviderUsageSummary } from "./EnvironmentUsageSection.logic";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

const selectAccountRateLimitThreads = createAccountRateLimitThreadsSelector();

function EnvironmentProviderUsageRow({
  snapshot,
  threadRateLimits,
}: {
  snapshot: ServerProviderUsageSnapshot;
  threadRateLimits: ReadonlyArray<ProviderRateLimit>;
}) {
  const provider = snapshot.provider;
  const providerName = providerUsageDisplayName(provider);
  const usageSummary = resolveProviderUsageSummary({
    provider,
    accountRateLimits: threadRateLimits,
    authoritativeLiveSnapshot: snapshot,
  });
  const model = buildProviderUsageMenuModel({
    provider,
    providerSnapshot: snapshot,
    usageSummary: { ...usageSummary, isLoading: false },
  });
  const summary = resolveEnvironmentProviderUsageSummary({
    providerName,
    rows: model.rows,
    snapshot,
    hasUsageLines: model.usageLines.length > 0,
  });

  return (
    <ProviderUsageMenuPopup provider={provider} model={model} align="start" showUsageLines={true}>
      <MenuTrigger
        render={
          <button
            type="button"
            className={ENVIRONMENT_ROW_CLASS_NAME}
            aria-label={summary.ariaLabel}
          />
        }
      >
        <EnvironmentRowBody
          icon={
            <ProviderIcon
              provider={provider}
              tone="header"
              className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
            />
          }
          label={providerName}
          trailing={
            <span className="flex items-center gap-1.5">
              {summary.rows.length > 0 ? (
                <span className="flex flex-col items-end gap-0.5 text-[length:var(--app-font-size-chat-meta,10px)] leading-none">
                  {summary.rows.map((row) => (
                    <span key={row.id} className="flex items-baseline gap-1.5">
                      <span className="text-[var(--color-text-foreground-secondary)]">
                        {row.label}
                      </span>
                      <span className="min-w-7 text-right text-[var(--color-text-foreground)]">
                        {row.remainingLabel}
                      </span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-[length:var(--app-font-size-chat-meta,10px)] text-[var(--color-text-foreground-secondary)]">
                  {summary.statusLabel}
                </span>
              )}
              <EnvironmentRowChevron />
            </span>
          }
        />
      </MenuTrigger>
    </ProviderUsageMenuPopup>
  );
}

export function EnvironmentUsageSection() {
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const threads = useStore(selectAccountRateLimitThreads);
  const threadRateLimits = useMemo(() => deriveAccountRateLimits(threads), [threads]);
  // The server already filters the batch. Rechecking the live settings projection prevents a
  // just-disabled provider from lingering while React Query refreshes the previous batch.
  const snapshots = (usageQuery.data ?? []).filter(
    (snapshot) => settingsQuery.data?.providers[snapshot.provider].enabled !== false,
  );

  if (snapshots.length === 0) {
    return null;
  }

  return (
    <EnvironmentLabeledSection label="Usage">
      {snapshots.map((snapshot) => (
        <EnvironmentProviderUsageRow
          key={snapshot.provider}
          snapshot={snapshot}
          threadRateLimits={threadRateLimits}
        />
      ))}
    </EnvironmentLabeledSection>
  );
}
