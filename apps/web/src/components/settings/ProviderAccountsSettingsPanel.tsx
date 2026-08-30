// FILE: ProviderAccountsSettingsPanel.tsx
// Purpose: Manage isolated Claude and Codex identities from provider settings.

import type {
  ManagedProviderAccountProvider,
  ProviderAccount,
  ProviderAccountCollection,
  ServerListProviderAccountsResult,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import {
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";

import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const PROVIDERS: ReadonlyArray<ManagedProviderAccountProvider> = ["claudeAgent", "codex"];

function providerTitle(provider: ManagedProviderAccountProvider): string {
  return provider === "claudeAgent" ? "Claude" : "Codex";
}

function updateCollection(
  current: ServerListProviderAccountsResult | undefined,
  collection: ProviderAccountCollection,
): ServerListProviderAccountsResult {
  const providers = current?.providers ?? [];
  return {
    providers: [
      ...providers.filter((entry) => entry.provider !== collection.provider),
      collection,
    ],
  };
}

function accountStatusLabel(account: ProviderAccount, systemAuthenticated: boolean): string {
  if (account.kind === "system") {
    return systemAuthenticated ? "Uses the authenticated system login" : "Uses this device's login";
  }
  switch (account.authStatus) {
    case "authenticating":
      return "Complete sign-in in the browser";
    case "authenticated":
      return account.lastAuthenticatedAt
        ? `Authenticated ${new Date(account.lastAuthenticatedAt).toLocaleString()}`
        : "Authenticated";
    case "unauthenticated":
      return "Sign-in required";
    case "error":
      return account.lastError ?? "Authentication failed";
    default:
      return "Authentication has not been verified";
  }
}

function AccountRow({
  account,
  systemAuthenticated,
  busy,
  onActivate,
  onReauthenticate,
  onDelete,
}: {
  readonly account: ProviderAccount;
  readonly systemAuthenticated: boolean;
  readonly busy: boolean;
  readonly onActivate: () => void;
  readonly onReauthenticate: () => void;
  readonly onDelete: () => void;
}) {
  const authenticating = account.authStatus === "authenticating";
  const selectable = account.kind === "system" || account.authStatus === "authenticated";
  return (
    <SettingsListRow
      align="start"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{account.authLabel ?? account.label}</span>
          {account.active ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              <CheckIcon className="size-3" /> Active
            </span>
          ) : null}
        </span>
      }
      description={accountStatusLabel(account, systemAuthenticated)}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {!account.active ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || authenticating || !selectable}
              onClick={onActivate}
            >
              Use account
            </Button>
          ) : null}
          {account.kind === "managed" ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || authenticating}
                onClick={onReauthenticate}
              >
                {authenticating ? (
                  <Loader2Icon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
                {authenticating ? "Signing in" : "Reauthenticate"}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={busy || authenticating}
                aria-label={`Delete ${account.authLabel ?? account.label}`}
                onClick={onDelete}
              >
                <TrashCanIcon className="size-3.5" />
              </Button>
            </>
          ) : null}
        </div>
      }
    />
  );
}

export function ProviderAccountsSettingsPanel() {
  const queryClient = useQueryClient();
  const statuses = useProviderStatusesForLocalConfig();
  const [busyProvider, setBusyProvider] = useState<ManagedProviderAccountProvider | null>(null);
  const accountsQuery = useQuery({
    queryKey: serverQueryKeys.providerAccounts(),
    queryFn: () => ensureNativeApi().server.listProviderAccounts(),
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.providers.some((collection) =>
        collection.accounts.some((account) => account.authStatus === "authenticating"),
      )
        ? 1_000
        : false,
  });
  const statusByProvider = useMemo(
    () => new Map(statuses.map((status) => [status.provider, status])),
    [statuses],
  );

  const commitCollection = (collection: ProviderAccountCollection) => {
    queryClient.setQueryData<ServerListProviderAccountsResult>(
      serverQueryKeys.providerAccounts(),
      (current) => updateCollection(current, collection),
    );
  };

  const runMutation = async (
    provider: ManagedProviderAccountProvider,
    operation: () => Promise<ProviderAccountCollection>,
    success?: { readonly title: string; readonly description: string },
  ) => {
    if (busyProvider) return;
    setBusyProvider(provider);
    try {
      const collection = await operation();
      commitCollection(collection);
      if (success) toastManager.add({ type: "success", ...success });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not update ${providerTitle(provider)} account`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyProvider(null);
    }
  };

  const deleteAccount = async (account: ProviderAccount) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      [
        `Delete ${account.authLabel ?? account.label}?`,
        "Synara will stop using this login and move its managed credential directory to a recoverable local trash folder.",
        "Your Synara chats and provider session history are kept.",
      ].join("\n"),
    );
    if (!confirmed) return;
    await runMutation(
      account.provider,
      () =>
        ensureNativeApi().server.deleteProviderAccount({
          provider: account.provider,
          accountId: account.id,
        }),
      {
        title: "Account removed",
        description: "The managed login was moved to Synara's local recovery folder.",
      },
    );
  };

  return (
    <SettingsSectionShell
      title="Provider accounts"
      action={
        accountsQuery.isFetching ? (
          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="space-y-3">
        <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
          Add isolated logins and choose which identity new Claude or Codex runtime processes use.
          Switching stops that provider cleanly; the next turn resumes the same Synara chat with
          the selected account.
        </p>
        {accountsQuery.isError ? (
          <SettingsCard>
            <SettingsListRow
              title="Accounts unavailable"
              description={
                accountsQuery.error instanceof Error
                  ? accountsQuery.error.message
                  : "Could not load provider accounts."
              }
              actions={
                <Button size="xs" variant="outline" onClick={() => void accountsQuery.refetch()}>
                  Retry
                </Button>
              }
            />
          </SettingsCard>
        ) : null}
        {PROVIDERS.map((provider) => {
          const collection = accountsQuery.data?.providers.find(
            (entry) => entry.provider === provider,
          );
          const accounts = collection?.accounts ?? [];
          const systemAuthenticated =
            statusByProvider.get(provider)?.authStatus === "authenticated";
          const busy = busyProvider === provider;
          return (
            <div key={provider} className="space-y-2">
              <div className="flex items-center justify-between gap-3 px-0.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ProviderIcon provider={provider} className="size-4" />
                  {providerTitle(provider)}
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || accountsQuery.isPending}
                  onClick={() =>
                    void runMutation(
                      provider,
                      () => ensureNativeApi().server.createProviderAccount({ provider }),
                      {
                        title: `${providerTitle(provider)} sign-in started`,
                        description: "Complete authentication in the browser, then return to Synara.",
                      },
                    )
                  }
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
                  Add account
                </Button>
              </div>
              <SettingsCard
                className={cn(accountsQuery.isPending && "min-h-20 animate-pulse bg-muted/20")}
              >
                {accounts.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    systemAuthenticated={systemAuthenticated}
                    busy={busy}
                    onActivate={() =>
                      void runMutation(
                        provider,
                        () =>
                          ensureNativeApi().server.setActiveProviderAccount({
                            provider,
                            accountId: account.id,
                          }),
                        {
                          title: `${providerTitle(provider)} account changed`,
                          description: "The next turn will resume with the selected account.",
                        },
                      )
                    }
                    onReauthenticate={() =>
                      void runMutation(provider, () =>
                        ensureNativeApi().server.reauthenticateProviderAccount({
                          provider,
                          accountId: account.id,
                        }),
                      )
                    }
                    onDelete={() => void deleteAccount(account)}
                  />
                ))}
              </SettingsCard>
            </div>
          );
        })}
      </div>
    </SettingsSectionShell>
  );
}
