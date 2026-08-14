// FILE: ConnectionsSettingsPanel.tsx
// Purpose: The hosts pane — the machines this account can reach, the owner's
//          discoverability switch, and the devices signed in to the account.
// Layer: Settings UI components
// Exports: ConnectionsSettingsPanel

import type { AccountDevice, AccountHost } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useAccount } from "~/hooks/useAccount";
import { useDevices, useHosts } from "~/hooks/useHosts";
import { accountErrorMessage } from "~/lib/accountLogic";
import {
  canManageHost,
  hostOwnerBadgeLabel,
  hostPlatformLabel,
  readHostsApi,
} from "~/lib/hosts/api";
import {
  reachabilityLabel,
  reachabilityToneClassName,
  type HostReachability,
} from "~/lib/hosts/reachability";
import { HostsUnsupportedError } from "~/lib/hosts/queries";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { SettingsEmptyState, SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

/**
 * Relative "last used" copy. Absolute timestamps read as precision this data
 * does not have (`lastUsedAt` is historical metadata, ADR 0010), and a bare
 * ISO string in a settings row is noise.
 */
function relativeTimeLabel(iso: string | null, now: number): string {
  if (!iso) return "Never used";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Never used";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "Used just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Used ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Used ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `Used ${days}d ago`;
  return `Used ${Math.round(days / 30)}mo ago`;
}

export function ConnectionsSettingsPanel({ active }: { active: boolean }) {
  const account = useAccount();
  const signedIn = account.me !== null;
  const remote = useHosts({ enabled: active && signedIn });
  const devices = useDevices({ enabled: active && signedIn });
  const navigate = useNavigate();
  // Reachability is attempt-based (ADR 0010): the map holds what the LAST
  // probe said, per host, and a host nobody probed simply is not in it.
  const [reachability, setReachability] = useState<Readonly<Record<string, HostReachability>>>({});

  const probeHost = useCallback(async (host: AccountHost) => {
    setReachability((current) => ({ ...current, [host.id]: { state: "probing" } }));
    const check = readHostsApi()?.checkReachability;
    if (!check) {
      // No probe available on this shell: say so rather than reporting the
      // host down, which is the failure mode ADR 0010 exists to prevent.
      setReachability((current) => ({
        ...current,
        [host.id]: { state: "no-route", at: Date.now() },
      }));
      return;
    }
    try {
      const result = await check({ hostId: host.id });
      setReachability((current) => ({ ...current, [host.id]: result }));
    } catch {
      setReachability((current) => ({
        ...current,
        [host.id]: { state: "no-answer", at: Date.now() },
      }));
    }
  }, []);

  const toggleDiscoverable = useCallback(
    async (host: AccountHost, discoverable: boolean) => {
      try {
        await remote.setDiscoverable.mutateAsync({ hostId: host.id, discoverable });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: discoverable ? "Could not share host" : "Could not stop sharing host",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
      }
    },
    [remote.setDiscoverable],
  );

  const revokeDevice = useCallback(
    async (device: AccountDevice) => {
      const api = readNativeApi() ?? ensureNativeApi();
      const confirmed = await api.dialogs.confirm(
        [
          `Revoke ${device.displayName}?`,
          "",
          "This signs that device out of every host. It will need to sign in again before it can connect to anything.",
        ].join("\n"),
      );
      if (!confirmed) return;
      try {
        await devices.revokeDevice.mutateAsync({ deviceId: device.id });
        toastManager.add({
          type: "success",
          title: "Device revoked",
          description: `${device.displayName} was signed out of every host.`,
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "Could not revoke device",
          description: accountErrorMessage(cause, "Try again in a moment."),
        });
      }
    },
    [devices.revokeDevice],
  );

  const unlinkLocalHost = useCallback(async () => {
    const api = readNativeApi() ?? ensureNativeApi();
    const confirmed = await api.dialogs.confirm(
      [
        "Unlink this machine?",
        "",
        "Its key is removed from your account and other devices' sessions to it end. Synara keeps working locally.",
      ].join("\n"),
    );
    if (!confirmed) return;
    try {
      await remote.unlinkLocalHost.mutateAsync();
      toastManager.add({
        type: "success",
        title: "Machine unlinked",
        description: "This machine is no longer reachable from your other devices.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not unlink this machine",
        description: accountErrorMessage(cause, "Try again in a moment."),
      });
    }
  }, [remote.unlinkLocalHost]);

  if (!active) return null;

  if (!signedIn) {
    return (
      <div className="space-y-6">
        <SettingsSection title="Hosts">
          <div className="p-3">
            <SettingsEmptyState layout="block">
              Sign in to see the machines on your account.
            </SettingsEmptyState>
          </div>
        </SettingsSection>
      </div>
    );
  }

  const hostsError = remote.hostsQuery.error;
  const unsupported = hostsError instanceof HostsUnsupportedError;

  return (
    <div className="space-y-6">
      <SettingsSection title="Hosts">
        {remote.hostsQuery.isPending ? (
          <SettingsListRow title="Loading hosts..." />
        ) : hostsError ? (
          <div className="p-3">
            <SettingsEmptyState layout="status" tone="destructive">
              {unsupported
                ? "This Synara server is too old to manage hosts. Update the server and try again."
                : accountErrorMessage(hostsError, "Could not load your hosts.")}
            </SettingsEmptyState>
          </div>
        ) : remote.hosts.length === 0 ? (
          <div className="p-3">
            <SettingsEmptyState layout="block">
              No machines yet. Sign in on another machine to add it, or link a headless one with a
              device code.
            </SettingsEmptyState>
          </div>
        ) : (
          remote.hosts.map((host) => (
            <HostRow
              key={host.id}
              host={host}
              reachability={reachability[host.id] ?? { state: "unknown" }}
              busy={remote.setDiscoverable.isPending}
              onProbe={() => void probeHost(host)}
              onToggleDiscoverable={(next) => void toggleDiscoverable(host, next)}
            />
          ))
        )}
      </SettingsSection>

      {remote.enrollment?.host ? (
        <SettingsSection title="This machine">
          <SettingsListRow
            align="start"
            title={remote.enrollment.host.name}
            description={
              <span className="text-muted-foreground">
                Signing out unlinks this machine automatically. Unlink now to remove its key while
                staying signed in — Synara keeps working locally either way.
              </span>
            }
            actions={
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={remote.unlinkLocalHost.isPending}
                onClick={() => void unlinkLocalHost()}
              >
                {remote.unlinkLocalHost.isPending ? "Unlinking..." : "Unlink"}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Link a headless machine">
        <SettingsListRow
          align="start"
          title="Device code"
          description={
            <span className="text-muted-foreground">
              A machine without a browser prints a short code. Enter it here to approve the link.
            </span>
          }
          actions={
            <Button size="xs" variant="outline" onClick={() => void navigate({ to: "/link" })}>
              Enter a code
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Devices">
        {devices.devicesQuery.isPending ? (
          <SettingsListRow title="Loading devices..." />
        ) : devices.devicesQuery.error ? (
          <div className="p-3">
            <SettingsEmptyState layout="status" tone="destructive">
              {accountErrorMessage(devices.devicesQuery.error, "Could not load your devices.")}
            </SettingsEmptyState>
          </div>
        ) : devices.devices.length === 0 ? (
          <div className="p-3">
            <SettingsEmptyState layout="block">
              No devices are registered on this account yet.
            </SettingsEmptyState>
          </div>
        ) : (
          devices.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              busy={devices.revokeDevice.isPending}
              onRevoke={() => void revokeDevice(device)}
            />
          ))
        )}
      </SettingsSection>
    </div>
  );
}

export function HostRow({
  host,
  reachability,
  busy,
  onProbe,
  onToggleDiscoverable,
}: {
  host: AccountHost;
  reachability: HostReachability;
  busy: boolean;
  onProbe: () => void;
  onToggleDiscoverable: (discoverable: boolean) => void;
}) {
  const owned = canManageHost(host);
  return (
    <SettingsListRow
      align="start"
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{host.name}</span>
          {/* Ownership is a fact, not a status: `secondary` for both, so
              neither reads as better or worse than the other. */}
          <Badge variant="secondary" size="sm" className="shrink-0">
            {hostOwnerBadgeLabel(host)}
          </Badge>
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span>{hostPlatformLabel(host.platform)}</span>
          {/* Reachability as of the last probe — text and emphasis, never a
              colored dot (ADR 0010; the palette has no success token). */}
          <span className={cn(reachabilityToneClassName(reachability))}>
            {reachabilityLabel(reachability)}
          </span>
          {!host.linked ? (
            <span className="text-muted-foreground">
              Not linked — this machine has not completed its key exchange.
            </span>
          ) : null}
        </span>
      }
      actions={
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={reachability.state === "probing"}
            onClick={onProbe}
          >
            {reachability.state === "probing" ? "Checking..." : "Check"}
          </Button>
          {owned ? (
            <label className="flex items-center gap-2">
              <span className="text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground">
                Discoverable
              </span>
              <Switch
                checked={host.discoverable}
                disabled={busy}
                aria-label={`Share ${host.name} with your workspace`}
                onCheckedChange={onToggleDiscoverable}
              />
            </label>
          ) : null}
        </>
      }
    />
  );
}

export function DeviceRow({
  device,
  busy,
  onRevoke,
}: {
  device: AccountDevice;
  busy: boolean;
  onRevoke: () => void;
}) {
  const revoked = device.revokedAt !== null;
  return (
    <SettingsListRow
      align="start"
      title={device.displayName}
      description={
        <span className="flex flex-col gap-0.5">
          <span>{relativeTimeLabel(device.lastUsedAt, Date.now())}</span>
          {revoked ? <span className="text-muted-foreground">Revoked</span> : null}
        </span>
      }
      actions={
        revoked ? null : (
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onRevoke}>
            Revoke
          </Button>
        )
      }
    />
  );
}
