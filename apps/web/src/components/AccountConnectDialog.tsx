import type {
  ProviderAccountCapabilities,
  ProviderAccountsConnectStatus,
  SupportedAccountProvider,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { cn } from "~/lib/utils";
import {
  ACCOUNT_PROVIDER_API_KEY_DOCS,
  accountProviderLabel,
  providerAccountsConnectStatusQueryOptions,
  providerAccountsQueryKeys,
  useProviderAccountsBeginConnect,
  useProviderAccountsCancelConnect,
  useProviderAccountsSetActive,
} from "~/lib/providerAccountsReactQuery";

export interface AccountConnectRequest {
  readonly provider: SupportedAccountProvider;
  readonly capabilities: ProviderAccountCapabilities;
  /** Present when reconnecting an existing slot instead of adding a new one. */
  readonly reconnectOrdinal?: number;
  /** The provider's active ordinal when the dialog opened, so the success state can offer to keep it. */
  readonly currentActiveOrdinal?: number;
}

export function AccountConnectDialog({
  request,
  onOpenChange,
}: {
  request: AccountConnectRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        {request !== null ? (
          <AccountConnectDialogBody request={request} onOpenChange={onOpenChange} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function AccountConnectDialogBody({
  request,
  onOpenChange,
}: {
  request: AccountConnectRequest;
  onOpenChange: (open: boolean) => void;
}) {
  const { provider, capabilities, reconnectOrdinal, currentActiveOrdinal } = request;
  const oauthSupported = capabilities.agent.oauth !== "unsupported";
  const apiKeySupported = capabilities.agent.apiKey !== "unsupported";

  const [method, setMethod] = useState<"oauth" | "apiKey">(oauthSupported ? "oauth" : "apiKey");
  const [apiKey, setApiKey] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [connectedMethod, setConnectedMethod] = useState<"oauth" | "apiKey" | null>(null);

  const beginConnect = useProviderAccountsBeginConnect();
  const cancelConnect = useProviderAccountsCancelConnect();
  const setActive = useProviderAccountsSetActive();
  const statusQuery = useQuery(providerAccountsConnectStatusQueryOptions({ operationId }));
  const status: ProviderAccountsConnectStatus | undefined = statusQuery.data;
  const queryClient = useQueryClient();

  // A successful connect changes the account roster, so refresh the snapshot
  // the rest of the UI reads from as soon as polling reports success.
  const succeeded = status?.state === "succeeded";
  useEffect(() => {
    if (succeeded) {
      void queryClient.invalidateQueries({ queryKey: providerAccountsQueryKeys.snapshot() });
    }
  }, [succeeded, queryClient]);

  // After a failure or cancellation, return to the method chooser (keeping the
  // selected method) so the user can immediately retry or switch methods.
  const failureDetail =
    status?.state === "failed"
      ? (status.error ?? "Connection failed.")
      : status?.state === "cancelled"
        ? "Connection cancelled."
        : null;
  useEffect(() => {
    if (failureDetail !== null) {
      setOperationId(null);
      setLocalError(failureDetail);
    }
  }, [failureDetail]);

  const providerLabel = accountProviderLabel(provider);
  const title =
    reconnectOrdinal !== undefined
      ? `Reconnect ${providerLabel} ${reconnectOrdinal}`
      : `Connect ${providerLabel} account`;

  const busy = beginConnect.isPending || status?.state === "pending";

  const begin = (kind: "agent-oauth" | "agent-api-key") => {
    setLocalError(null);
    setConnectedMethod(kind === "agent-api-key" ? "apiKey" : "oauth");
    beginConnect.mutate(
      kind === "agent-oauth"
        ? {
            kind,
            provider,
            ...(reconnectOrdinal !== undefined ? { ordinal: reconnectOrdinal } : {}),
          }
        : {
            kind,
            provider,
            apiKey: apiKey.trim(),
            ...(reconnectOrdinal !== undefined ? { ordinal: reconnectOrdinal } : {}),
          },
      {
        onSuccess: (result) => {
          setApiKey("");
          setOperationId(result.operationId);
        },
        onError: (error) => {
          setLocalError(error instanceof Error ? error.message : "Connection failed.");
        },
      },
    );
  };

  const close = () => {
    if (
      operationId !== null &&
      (status?.state === "pending" || status?.state === "waiting-for-user")
    ) {
      cancelConnect.mutate({ operationId });
    }
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {method === "oauth"
            ? `Sign in with your browser to add a managed ${providerLabel} account.`
            : `Store an API key for a managed ${providerLabel} account. The key is kept on this machine only.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          {oauthSupported && apiKeySupported && operationId === null ? (
            <div role="radiogroup" aria-label="Connection method" className="flex gap-2">
              {(
                [
                  ["oauth", "Browser sign-in"],
                  ["apiKey", "API key"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  size="xs"
                  role="radio"
                  aria-checked={method === value}
                  variant={method === value ? "secondary" : "outline"}
                  className={cn(method === value && "ring-1 ring-ring")}
                  onClick={() => setMethod(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}

          {method === "apiKey" && operationId === null ? (
            <form
              className="space-y-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (apiKey.trim().length > 0 && !busy) begin("agent-api-key");
              }}
            >
              <label className="block text-sm font-medium" htmlFor="account-connect-api-key">
                {providerLabel} API key
              </label>
              <Input
                id="account-connect-api-key"
                type="password"
                size="lg"
                value={apiKey}
                placeholder={`${providerLabel} API key`}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Create a key in{" "}
                <a
                  href={ACCOUNT_PROVIDER_API_KEY_DOCS[provider]}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  the {providerLabel} console
                </a>
                . It is stored on this machine only.
              </p>
            </form>
          ) : null}

          {operationId !== null && status !== undefined ? (
            <div className="space-y-2 text-sm">
              {status.state === "pending" || status.state === "waiting-for-user" ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Spinner className="size-4" />
                  <span>
                    {status.state === "waiting-for-user"
                      ? "Waiting for you to finish signing in…"
                      : "Starting sign-in…"}
                  </span>
                </div>
              ) : null}
              {status.verificationUrl !== undefined ? (
                <p>
                  Open{" "}
                  <a
                    href={status.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    this sign-in link
                  </a>{" "}
                  in your browser to continue.
                </p>
              ) : null}
              {status.userCode !== undefined ? (
                <p>
                  Enter code <code className="font-mono font-semibold">{status.userCode}</code> when
                  prompted.
                </p>
              ) : null}
              {status.state === "succeeded" ? (
                <ConnectSuccessMessage
                  providerLabel={providerLabel}
                  ordinal={status.ordinal}
                  method={connectedMethod}
                  isReconnect={reconnectOrdinal !== undefined}
                  currentActiveOrdinal={currentActiveOrdinal}
                />
              ) : null}
            </div>
          ) : null}

          {localError !== null ? <p className="text-destructive text-sm">{localError}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {status?.state === "succeeded" ? (
          <>
            {reconnectOrdinal === undefined &&
            currentActiveOrdinal !== undefined &&
            status.ordinal !== undefined &&
            currentActiveOrdinal !== status.ordinal ? (
              <Button
                size="sm"
                variant="outline"
                disabled={setActive.isPending}
                onClick={() => setActive.mutate({ provider, ordinal: currentActiveOrdinal })}
              >
                Keep {providerLabel} {currentActiveOrdinal} active
              </Button>
            ) : null}
            <Button size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={close}>
              {status?.state === "pending" || status?.state === "waiting-for-user"
                ? "Cancel sign-in"
                : "Close"}
            </Button>
            {operationId === null ? (
              <Button
                size="sm"
                disabled={busy || (method === "apiKey" && apiKey.trim().length === 0)}
                onClick={() => begin(method === "oauth" ? "agent-oauth" : "agent-api-key")}
              >
                {busy ? "Connecting…" : "Connect"}
              </Button>
            ) : null}
          </>
        )}
      </DialogFooter>
    </>
  );
}

function ConnectSuccessMessage({
  providerLabel,
  ordinal,
  method,
  isReconnect,
  currentActiveOrdinal,
}: {
  providerLabel: string;
  ordinal: number | undefined;
  method: "oauth" | "apiKey" | null;
  isReconnect: boolean;
  currentActiveOrdinal: number | undefined;
}) {
  const slot = ordinal !== undefined ? `${providerLabel} ${ordinal}` : `${providerLabel} account`;
  const becameActive = !isReconnect && (ordinal === undefined || ordinal !== currentActiveOrdinal);
  return (
    <div className="space-y-1">
      <p>
        {method === "apiKey"
          ? `API key saved for ${slot}. It will be verified on first use.`
          : `Connected as ${slot}.`}
      </p>
      {becameActive ? <p>{slot} is now the active account for new threads.</p> : null}
    </div>
  );
}
