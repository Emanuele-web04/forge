// FILE: ProviderUsageMenuControl.tsx
// Purpose: Shared provider-usage chip/menu used in the chat header and Environment panel.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { type ReactNode } from "react";

import { useAppSettings } from "~/appSettings";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import {
  deriveProviderUsageDisplayRows,
  selectPrimaryProviderUsageDisplayRow,
  type ProviderUsageDisplayRow,
} from "~/lib/providerUsageDisplay";
import type { OpenUsageUsageLine } from "~/lib/openUsageRateLimits";
import type { ProviderRateLimit } from "~/lib/rateLimits";
import { useStore } from "~/store";
import { createAccountRateLimitThreadsSelector } from "~/storeSelectors";

import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { ChatHeaderButton } from "./chat/chatHeaderControls";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderUsagePanelContent } from "./ProviderUsagePanelContent";
import { Menu, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface ProviderUsageMenuModel {
  menuTitle: string;
  primaryRow: ProviderUsageDisplayRow;
  rateLimits: ReadonlyArray<ProviderRateLimit>;
  usageLines: ReadonlyArray<OpenUsageUsageLine>;
  notice: string | undefined;
  isLoading: boolean;
}

// Module-level: the selector memoizes on store slices, so recreating it per render would
// defeat the memo and rebuild every thread on each streaming flush.
const selectAccountRateLimitThreads = createAccountRateLimitThreadsSelector();

export function useProviderUsageMenuModel(provider: ProviderKind): ProviderUsageMenuModel | null {
  const { settings } = useAppSettings();
  const threads = useStore(selectAccountRateLimitThreads);
  const usageSummary = useProviderUsageSummary({
    provider,
    threads,
    codexHomePath: settings.codexHomePath || null,
    fetchOpenUsageData: false,
  });
  const usageRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const primaryRow = selectPrimaryProviderUsageDisplayRow(usageRows);

  if (!primaryRow) {
    return null;
  }

  return {
    menuTitle: `${PROVIDER_DISPLAY_NAMES[provider]} usage`,
    primaryRow,
    rateLimits: usageSummary.rateLimits,
    usageLines: usageSummary.usageLines,
    notice: usageSummary.usageNotice,
    isLoading: usageSummary.isLoading,
  };
}

export function ProviderUsageMenuPopup({
  provider,
  model,
  align: alignProp,
  children,
}: {
  provider: ProviderKind;
  model: ProviderUsageMenuModel;
  align?: "start" | "end";
  children: ReactNode;
}) {
  const align = alignProp ?? "end";
  return (
    <Menu modal={false}>
      {children}
      <ComposerPickerMenuPopup align={align} side="bottom" className="w-64 min-w-64">
        <ProviderUsagePanelContent
          provider={provider}
          rateLimits={model.rateLimits}
          usageLines={model.usageLines}
          notice={model.notice}
          isLoading={model.isLoading}
          showUsageLines={false}
          showTitle={false}
          className="px-2 pb-1 pt-1"
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function ProviderUsageMenuControl({ provider }: { provider: ProviderKind }) {
  const model = useProviderUsageMenuModel(provider);

  if (!model) {
    return null;
  }

  return (
    <ProviderUsageMenuPopup provider={provider} model={model}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ChatHeaderButton
                  type="button"
                  tone="plain"
                  className="gap-1.5 px-2"
                  aria-label={model.menuTitle}
                />
              }
            >
              <ProviderIcon provider={provider} tone="header" className="size-3.5 shrink-0" />
              <span className="truncate font-normal">{model.primaryRow.remainingLabel}</span>
            </MenuTrigger>
          }
        />
        <TooltipPopup side="bottom">{model.menuTitle}</TooltipPopup>
      </Tooltip>
    </ProviderUsageMenuPopup>
  );
}
