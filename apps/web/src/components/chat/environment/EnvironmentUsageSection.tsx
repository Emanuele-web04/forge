// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — one compact menu per enabled provider.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";

import {
  ProviderUsageMenuPopup,
  useProviderUsageMenuModel,
} from "~/components/ProviderUsageMenuControl";
import { ProviderIcon } from "~/components/ProviderIcon";
import { MenuTrigger } from "~/components/ui/menu";
import {
  serverAllProviderUsageQueryOptions,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";

import { resolveEnvironmentProviderUsageSummary } from "./EnvironmentUsageSection.logic";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

function EnvironmentProviderUsageRow({ snapshot }: { snapshot: ServerProviderUsageSnapshot }) {
  const provider = snapshot.provider;
  const providerName = providerUsageDisplayName(provider);
  // The parent owns the one batch query. Supplying its snapshot prevents every row from
  // starting another batch plus provider-scoped request while retaining thread-derived fallback.
  const model = useProviderUsageMenuModel(provider, { providerSnapshot: snapshot });
  const summary = resolveEnvironmentProviderUsageSummary({
    providerName,
    rows: model.rows,
    snapshot,
  });

  return (
    <ProviderUsageMenuPopup provider={provider} model={model} align="start">
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
        <EnvironmentProviderUsageRow key={snapshot.provider} snapshot={snapshot} />
      ))}
    </EnvironmentLabeledSection>
  );
}
