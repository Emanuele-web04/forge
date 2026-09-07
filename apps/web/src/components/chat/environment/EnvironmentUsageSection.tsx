// FILE: EnvironmentUsageSection.tsx
// Purpose: "Usage" section of the Environment panel — compact menu for the active provider.

import type { ProviderKind } from "@synara/contracts";
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

export function EnvironmentUsageSection({ provider }: { provider: ProviderKind }) {
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  // The batch snapshot is an enrichment, not a gate: when the provider's live fetch fails or is
  // missing from the batch, the menu model still blends local archives and thread rate limits, so
  // the row must render regardless. Only an explicitly disabled provider hides the section.
  const snapshot = (usageQuery.data ?? []).find((entry) => entry.provider === provider);
  const model = useProviderUsageMenuModel(provider, { providerSnapshot: snapshot });

  if (settingsQuery.data?.providers[provider].enabled === false) {
    return null;
  }
  // Nothing displayable yet (first fetch still running, sign-in required, or the provider
  // exposes no usage): hide the section entirely — it appears once any source yields data.
  if (model.rows.length === 0 && model.usageLines.length === 0) {
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
    <EnvironmentLabeledSection label="Usage">
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
    </EnvironmentLabeledSection>
  );
}
