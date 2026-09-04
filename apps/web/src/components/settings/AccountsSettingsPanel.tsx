import type {
  AccountOrdinal,
  ProviderAccountCapabilities,
  ProviderAccountView,
  SupportedAccountProvider,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  AccountConnectDialog,
  type AccountConnectRequest,
} from "~/components/AccountConnectDialog";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import {
  ACCOUNT_BINDING_STATE_LABELS,
  ACCOUNT_SUPPORT_LEVEL_LABELS,
  accountIdentityLabel,
  accountProviderLabel,
  accountSlotLabel,
  normalizeConnectProviderParam,
  providerAccountsIntegrationStatusQueryOptions,
  providerAccountsSnapshotQueryOptions,
  SUPPORTED_ACCOUNT_PROVIDERS,
  useProviderAccountsDisconnectBinding,
  useProviderAccountsHide,
  useProviderAccountsLaunch,
  useProviderAccountsSetActive,
  useProviderAccountsUpdateCliIntegration,
} from "~/lib/providerAccountsReactQuery";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

async function confirmDestructiveAccountAction(message: string): Promise<boolean> {
  return ensureNativeApi().dialogs.confirm(message);
}

function AccountRow({
  provider,
  account,
  isActive,
  appLaunchSupported,
  onReconnect,
}: {
  provider: SupportedAccountProvider;
  account: ProviderAccountView;
  isActive: boolean;
  appLaunchSupported: boolean;
  onReconnect: (ordinal: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const setActive = useProviderAccountsSetActive();
  const disconnectBinding = useProviderAccountsDisconnectBinding();
  const hide = useProviderAccountsHide();
  const launch = useProviderAccountsLaunch();

  const isNative = account.ordinal === 0;
  const slotLabel = accountSlotLabel(provider, account.ordinal);
  const identity = accountIdentityLabel(account.identity);
  const agentState =
    !isNative && account.agent ? ACCOUNT_BINDING_STATE_LABELS[account.agent.state] : null;
  const appState = account.app
    ? `${ACCOUNT_BINDING_STATE_LABELS[account.app.state]} · ${ACCOUNT_SUPPORT_LEVEL_LABELS[account.app.supportLevel]}`
    : null;

  const hasActions =
    !isActive || (!isNative && account.agent !== undefined) || (account.app && appLaunchSupported);

  return (
    <SettingsListRow
      align="start"
      title={
        hasActions ? (
          <button
            type="button"
            className="flex items-center gap-1.5"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <span>{slotLabel}</span>
            {isActive ? <Badge variant="secondary">Active</Badge> : null}
            <DisclosureChevron open={expanded} />
          </button>
        ) : (
          <span className="flex items-center gap-1.5">
            <span>{slotLabel}</span>
            {isActive ? <Badge variant="secondary">Active</Badge> : null}
          </span>
        )
      }
      description={
        <div className="space-y-0.5">
          {identity ? <div>{identity}</div> : null}
          {agentState ? <div>Agent: {agentState}</div> : null}
          {appState ? <div>App: {appState}</div> : null}
          {isNative ? <div>Your own {accountProviderLabel(provider)} login, unmanaged.</div> : null}
          <DisclosureRegion open={expanded}>
            <div className="flex flex-wrap gap-2 pt-2">
              {!isActive ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={setActive.isPending}
                  onClick={() => setActive.mutate({ provider, ordinal: account.ordinal })}
                >
                  Make active
                </Button>
              ) : null}
              {!isNative && account.agent ? (
                <Button size="xs" variant="outline" onClick={() => onReconnect(account.ordinal)}>
                  Reconnect agent
                </Button>
              ) : null}
              {account.app && appLaunchSupported ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={launch.isPending}
                  onClick={() =>
                    launch.mutate({ provider, surface: "app", ordinal: account.ordinal })
                  }
                >
                  Open app
                </Button>
              ) : null}
              {!isNative && account.agent ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disconnectBinding.isPending}
                  onClick={() => {
                    void confirmDestructiveAccountAction(
                      `Disconnect the agent for ${slotLabel}? Its stored credential is deleted.`,
                    ).then((confirmed) => {
                      if (!confirmed) return;
                      disconnectBinding.mutate({
                        provider,
                        ordinal: account.ordinal,
                        surface: "agent",
                      });
                    });
                  }}
                >
                  Disconnect agent
                </Button>
              ) : null}
              {!isNative && account.app ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disconnectBinding.isPending}
                  onClick={() => {
                    void confirmDestructiveAccountAction(
                      `Disconnect the app for ${slotLabel}? Its stored credential is deleted.`,
                    ).then((confirmed) => {
                      if (!confirmed) return;
                      disconnectBinding.mutate({
                        provider,
                        ordinal: account.ordinal,
                        surface: "app",
                      });
                    });
                  }}
                >
                  Disconnect app
                </Button>
              ) : null}
              {!isNative ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={hide.isPending}
                  onClick={() => {
                    void confirmDestructiveAccountAction(
                      `Hide ${slotLabel}? It disappears from menus, but its credentials stay on this machine and it can be unhidden later.`,
                    ).then((confirmed) => {
                      if (!confirmed) return;
                      hide.mutate({ provider, ordinal: account.ordinal });
                    });
                  }}
                >
                  Hide
                </Button>
              ) : null}
            </div>
            {!isNative ? (
              <div className="pt-1 text-muted-foreground text-xs">
                Hide only removes the account from menus. Its credentials stay on this machine and
                the account can be unhidden later.
              </div>
            ) : null}
          </DisclosureRegion>
        </div>
      }
    />
  );
}

function ProviderAccountsSection({
  provider,
  activeOrdinal,
  accounts,
  capabilities,
  onConnect,
}: {
  provider: SupportedAccountProvider;
  activeOrdinal: AccountOrdinal | null;
  accounts: ReadonlyArray<ProviderAccountView>;
  capabilities: ProviderAccountCapabilities | null;
  onConnect: (request: AccountConnectRequest) => void;
}) {
  const currentActiveOrdinal = activeOrdinal ?? 0;
  const oauthSupported = capabilities !== null && capabilities.agent.oauth !== "unsupported";
  const apiKeySupported = capabilities !== null && capabilities.agent.apiKey !== "unsupported";
  const connectable = oauthSupported || apiKeySupported;
  // Desktop app launching stays hidden while the provider's app surface is
  // unsupported: the launch would always fail server-side.
  const appLaunchSupported =
    capabilities !== null && capabilities.app.supportLevel !== "unsupported";

  return (
    <SettingsSection title={accountProviderLabel(provider)}>
      {accounts.map((account) => (
        <AccountRow
          key={account.ordinal}
          provider={provider}
          account={account}
          isActive={account.ordinal === (activeOrdinal ?? 0)}
          appLaunchSupported={appLaunchSupported}
          onReconnect={(ordinal) =>
            capabilities !== null
              ? onConnect({
                  provider,
                  capabilities,
                  reconnectOrdinal: ordinal,
                  currentActiveOrdinal,
                })
              : undefined
          }
        />
      ))}
      {connectable && capabilities !== null ? (
        <SettingsListRow
          title={
            <span className="flex items-center gap-2">
              <ProviderIcon provider={provider} tone="header" className="size-3.5 shrink-0" />
              <span>Add {accountProviderLabel(provider)} account</span>
            </span>
          }
          description={
            oauthSupported
              ? "Connect another account with browser sign-in or an API key."
              : "Connect another account with an API key."
          }
          actions={
            <Button
              size="xs"
              variant="outline"
              onClick={() => onConnect({ provider, capabilities, currentActiveOrdinal })}
            >
              Connect
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function CliIntegrationSection() {
  const statusQuery = useQuery(providerAccountsIntegrationStatusQueryOptions());
  const update = useProviderAccountsUpdateCliIntegration();
  const status = statusQuery.data ?? null;
  const unavailable = status?.platformSupported === false;

  const pathHintNeeded =
    status?.launcherInstalled === true &&
    status.shimDirOnPath === false &&
    status.shimDir !== undefined;
  const pathCommand = pathHintNeeded ? `export PATH="${status.shimDir}:$PATH"` : null;

  const description = unavailable
    ? "Terminal launcher isn't supported on Windows yet. Managed accounts still work inside Synara sessions."
    : status?.launcherInstalled
      ? pathHintNeeded
        ? `Shims installed. Add ${status.shimDir} to the front of your PATH so terminal launches use the active managed account.`
        : "Provider shims are installed and terminal launches use the active managed account."
      : "Install provider shims so terminal launches use the active managed account.";

  return (
    <SettingsSection title="CLI integration">
      <SettingsListRow
        title="Terminal launcher"
        description={
          pathCommand !== null ? (
            <div className="space-y-1.5">
              <div>{description}</div>
              <div className="flex items-center gap-2">
                <code className="truncate font-mono text-xs">{pathCommand}</code>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    void copyTextToClipboard(pathCommand).then(
                      () => toastManager.add({ type: "success", title: "Copied PATH command" }),
                      () =>
                        toastManager.add({ type: "error", title: "Couldn't copy PATH command" }),
                    );
                  }}
                >
                  Copy
                </Button>
              </div>
            </div>
          ) : (
            description
          )
        }
        actions={
          unavailable || status === null ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={update.isPending}
              onClick={() => update.mutate({ enabled: !status.launcherInstalled })}
            >
              {status.launcherInstalled ? "Uninstall" : "Install"}
            </Button>
          )
        }
      />
    </SettingsSection>
  );
}

export function AccountsSettingsPanel({
  active,
  connectProvider,
}: {
  active: boolean;
  /** Provider whose connect dialog opens automatically (deep link from "Add account"). */
  connectProvider?: string | null;
}) {
  const snapshotQuery = useQuery(providerAccountsSnapshotQueryOptions({ enabled: active }));
  const [connectRequest, setConnectRequest] = useState<AccountConnectRequest | null>(null);
  const [consumedConnectProvider, setConsumedConnectProvider] = useState<string | null>(null);

  const providers = snapshotQuery.data?.providers ?? [];
  const requestedProvider =
    active && typeof connectProvider === "string"
      ? normalizeConnectProviderParam(connectProvider)
      : null;
  const requestedEntry =
    requestedProvider !== null && requestedProvider !== consumedConnectProvider
      ? (providers.find((candidate) => candidate.provider === requestedProvider) ?? null)
      : null;

  useEffect(() => {
    if (requestedEntry === null || requestedEntry.capabilities === null) return;
    setConsumedConnectProvider(requestedEntry.provider);
    setConnectRequest({
      provider: requestedEntry.provider,
      capabilities: requestedEntry.capabilities,
      currentActiveOrdinal: requestedEntry.activeOrdinal ?? 0,
    });
  }, [requestedEntry]);

  if (!active) {
    return null;
  }

  return (
    <div className="space-y-6">
      {snapshotQuery.isError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <span>Couldn't load accounts. Check that the server is running, then retry.</span>
          <Button size="xs" variant="outline" onClick={() => void snapshotQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {SUPPORTED_ACCOUNT_PROVIDERS.map((provider) => {
        const entry = providers.find((candidate) => candidate.provider === provider) ?? null;
        return (
          <ProviderAccountsSection
            key={provider}
            provider={provider}
            activeOrdinal={entry?.activeOrdinal ?? null}
            accounts={entry?.accounts ?? []}
            capabilities={entry?.capabilities ?? null}
            onConnect={setConnectRequest}
          />
        );
      })}
      <CliIntegrationSection />
      <AccountConnectDialog
        request={connectRequest}
        onOpenChange={(open) => {
          if (!open) setConnectRequest(null);
        }}
      />
    </div>
  );
}
