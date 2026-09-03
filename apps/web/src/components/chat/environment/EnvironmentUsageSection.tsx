// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — one compact menu per enabled provider.

import type { ProviderKind, ServerProviderUsageSnapshot } from "@synara/contracts";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

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

function EnvironmentProviderUsageRow({
  provider,
  snapshot,
  onVisibilityChange,
}: {
  provider: ProviderKind;
  snapshot: ServerProviderUsageSnapshot | undefined;
  onVisibilityChange: (provider: ProviderKind, visible: boolean) => void;
}) {
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  // The batch snapshot is an enrichment, not a gate: when the provider's live fetch fails or is
  // missing from the batch, the menu model still blends local archives and thread rate limits, so
  // the row must render regardless. Only an explicitly disabled provider hides the row.
  const model = useProviderUsageMenuModel(provider, { providerSnapshot: snapshot });

  const enabled = settingsQuery.data?.providers[provider].enabled !== false;
  // Nothing displayable yet (first fetch still running, sign-in required, or the provider
  // exposes no usage): hide the row — it appears once any source yields data.
  const visible = enabled && (model.rows.length > 0 || model.usageLines.length > 0);

  useEffect(() => {
    onVisibilityChange(provider, visible);
    return () => onVisibilityChange(provider, false);
  }, [provider, visible, onVisibilityChange]);

  if (!visible) {
    return null;
  }

  const providerName = providerUsageDisplayName(provider);
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
  const [visibleProviders, setVisibleProviders] = useState<ReadonlySet<ProviderKind>>(new Set());

  const handleVisibilityChange = useCallback((provider: ProviderKind, visible: boolean) => {
    setVisibleProviders((prev) => {
      if (prev.has(provider) === visible) {
        return prev;
      }
      const next = new Set(prev);
      if (visible) {
        next.add(provider);
      } else {
        next.delete(provider);
      }
      return next;
    });
  }, []);

  const snapshotsByProvider = useMemo(() => {
    const map = new Map<ProviderKind, ServerProviderUsageSnapshot>();
    for (const entry of usageQuery.data ?? []) {
      if (!map.has(entry.provider)) {
        map.set(entry.provider, entry);
      }
    }
    return map;
  }, [usageQuery.data]);

  const providers = settingsQuery.data?.providers;
  const enabledProviders = useMemo<ProviderKind[]>(() => {
    // While settings are still loading the batch defines the row set; each row rechecks the
    // live settings projection once it arrives so a just-disabled provider stops lingering.
    if (!providers) {
      return (usageQuery.data ?? []).map((entry) => entry.provider);
    }
    return (Object.keys(providers) as ProviderKind[]).filter(
      (provider) => providers[provider].enabled !== false,
    );
  }, [providers, usageQuery.data]);

  const rows = enabledProviders.map((provider) => (
    <EnvironmentProviderUsageRow
      key={provider}
      provider={provider}
      snapshot={snapshotsByProvider.get(provider)}
      onVisibilityChange={handleVisibilityChange}
    />
  ));

  if (enabledProviders.length === 0) {
    return null;
  }
  // Rows stay mounted while invisible so they can report once any source yields data; only the
  // labeled section itself is gated, so an all-empty state never renders a dangling "Usage" label.
  if (!enabledProviders.some((provider) => visibleProviders.has(provider))) {
    return <>{rows}</>;
  }

  return <EnvironmentLabeledSection label="Usage">{rows}</EnvironmentLabeledSection>;
}
