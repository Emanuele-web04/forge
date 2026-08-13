import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { useEffect, useRef, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { findProviderStatus, isProviderUsable } from "~/lib/providerAvailability";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { ProviderConnectTerminal } from "./ProviderConnectTerminal";

const UNPROBED_AUTH_PROVIDERS: ReadonlySet<ProviderKind> = new Set([
  "opencode",
  "kilo",
  "pi",
  "grok",
  "droid",
]);

function providerStatusBadge(
  provider: ProviderKind,
  status: ServerProviderStatus | null,
): { label: string; variant: "success" | "warning" | "outline" } {
  if (!status || !status.available) {
    return { label: "Not installed", variant: "outline" };
  }
  if (UNPROBED_AUTH_PROVIDERS.has(provider)) {
    return { label: "Detected", variant: "success" };
  }
  if (isProviderUsable(status)) {
    return { label: "Connected", variant: "success" };
  }
  return { label: "Needs sign-in", variant: "warning" };
}

export function ProvidersStep() {
  const statuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const [connectingProvider, setConnectingProvider] = useState<ProviderKind | null>(null);

  const refreshedOnEntryRef = useRef(false);
  useEffect(() => {
    if (refreshedOnEntryRef.current) {
      return;
    }
    refreshedOnEntryRef.current = true;
    void refreshProviderStatuses({ silent: true });
  }, [refreshProviderStatuses]);

  const toggleConnect = (provider: ProviderKind) => {
    if (connectingProvider === provider) {
      setConnectingProvider(null);
      void refreshProviderStatuses({ silent: true });
      return;
    }
    setConnectingProvider(provider);
  };

  return (
    <div className="space-y-1">
      {PROVIDER_DESCRIPTORS.map((descriptor) => {
        const status = findProviderStatus(statuses, descriptor.kind);
        const badge = providerStatusBadge(descriptor.kind, status);
        const signInCommand = descriptor.usage?.signInCommand;
        const canConnectInline =
          signInCommand !== undefined && homeDir !== null && status?.available === true;
        const isConnecting = connectingProvider === descriptor.kind;
        return (
          <div key={descriptor.kind} className="rounded-lg border border-transparent">
            <div className="flex items-center gap-3 px-2 py-2">
              <ProviderIcon provider={descriptor.kind} className="size-5 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm text-foreground">{descriptor.displayName}</span>
                {status?.version ? (
                  <span className="text-xs text-muted-foreground">v{status.version}</span>
                ) : null}
              </span>
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {canConnectInline && badge.label !== "Connected" && badge.label !== "Detected" ? (
                <Button size="sm" variant="outline" onClick={() => toggleConnect(descriptor.kind)}>
                  {isConnecting ? "Done" : "Connect"}
                </Button>
              ) : null}
              {!status?.available ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href={descriptor.installDocsHref} target="_blank" rel="noreferrer" />}
                >
                  Setup guide
                </Button>
              ) : null}
            </div>
            {canConnectInline ? (
              <DisclosureRegion open={isConnecting} contentClassName="px-2 pb-2">
                {isConnecting && signInCommand !== undefined && homeDir !== null ? (
                  <ProviderConnectTerminal
                    provider={descriptor.kind}
                    signInCommand={signInCommand}
                    cwd={homeDir}
                  />
                ) : null}
              </DisclosureRegion>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
