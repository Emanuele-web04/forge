// FILE: EnvironmentAutomationsSection.tsx
// Purpose: Shows heartbeat automations attached to the active thread inside the Environment panel.
// Layer: Environment panel section
// Exports: EnvironmentAutomationsSection, EnvironmentAutomationPanelItem
// Depends on: automation shared formatters and Environment panel row primitives.

import type { AutomationDefinition } from "@synara/contracts";

import { formatCadence } from "~/routes/-automations.shared";
import { ClockIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";

export interface EnvironmentAutomationPanelItem {
  readonly definition: AutomationDefinition;
}

export function EnvironmentAutomationsSection({
  automations,
  onOpenAutomation,
}: {
  readonly automations: readonly EnvironmentAutomationPanelItem[];
  readonly onOpenAutomation: (definition: AutomationDefinition) => void;
}) {
  if (automations.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <EnvironmentSectionLabel>Automations</EnvironmentSectionLabel>
      {automations.map(({ definition }) => {
        const cadence = definition.enabled ? formatCadence(definition.schedule) : "Paused";
        return (
          <EnvironmentRow
            key={definition.id}
            icon={
              <ClockIcon
                className={cn(
                  ENVIRONMENT_ROW_ICON_CLASS_NAME,
                  !definition.enabled && "text-[var(--color-text-foreground-secondary)]",
                )}
                aria-hidden
              />
            }
            label={<span className="truncate">{definition.name}</span>}
            trailing={
              <span className="max-w-24 truncate text-[var(--color-text-foreground-secondary)]">
                {cadence}
              </span>
            }
            aria-label={`Open automation ${definition.name}`}
            title={`${definition.name} - ${cadence}`}
            onClick={() => onOpenAutomation(definition)}
          />
        );
      })}
    </div>
  );
}
