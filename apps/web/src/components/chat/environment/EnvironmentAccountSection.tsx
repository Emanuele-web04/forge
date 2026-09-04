import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ProviderIcon } from "~/components/ProviderIcon";
import {
  accountSlotLabel,
  providerAccountsSnapshotQueryOptions,
  providerAccountsThreadBindingQueryOptions,
} from "~/lib/providerAccountsReactQuery";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRow,
} from "./EnvironmentRow";

export function EnvironmentAccountSection({
  threadId,
  enabled,
  onClose,
}: {
  threadId: ThreadId;
  enabled: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const bindingQuery = useQuery(providerAccountsThreadBindingQueryOptions({ threadId, enabled }));
  const binding = bindingQuery.data?.binding ?? null;
  const snapshotQuery = useQuery(
    providerAccountsSnapshotQueryOptions({ enabled: enabled && binding !== null }),
  );

  if (!binding) {
    return null;
  }

  const account =
    snapshotQuery.data?.providers
      .find((entry) => entry.provider === binding.provider)
      ?.accounts.find((candidate) => candidate.ordinal === binding.ordinal) ?? null;
  const caveat =
    account?.agent?.state === "needs-auth"
      ? "Needs sign-in"
      : account?.agent !== undefined && account.agent.generation !== binding.agentGeneration
        ? "Reconnected since this thread started"
        : null;
  const label = accountSlotLabel(binding.provider, binding.ordinal);

  return (
    <EnvironmentLabeledSection label="Account">
      <EnvironmentRow
        icon={
          <ProviderIcon
            provider={binding.provider}
            tone="header"
            className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
          />
        }
        label={label}
        trailing={
          caveat !== null ? (
            <span className="shrink-0 text-warning text-xs">{caveat}</span>
          ) : undefined
        }
        onClick={() => {
          void navigate({ to: "/settings", search: { section: "accounts" } });
          onClose();
        }}
      />
    </EnvironmentLabeledSection>
  );
}
