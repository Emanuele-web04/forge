// FILE: ComputerSettingsPanel.tsx
// Purpose: Own the Computer use settings panel: desktop backend status and computer-control preferences.
// Layer: Settings UI components
// Exports: ComputerSettingsPanel

import {
  COMPUTER_HYPRLAND_BACKEND,
  COMPUTER_KWIN_BACKEND,
  COMPUTER_MAC_BACKEND,
  COMPUTER_NESTED_KWIN_BACKEND,
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  COMPUTER_RELEASE_HOTKEY_BACKENDS,
  type ComputerCapabilities,
  type ComputerPermission,
} from "@synara/contracts";
import {
  COMPUTER_PERMISSION_LABELS,
  listComputerPermissions,
} from "@synara/shared/computerPermissions";
import { useQuery } from "@tanstack/react-query";

import type { AppSettingsBinding } from "~/appSettings";
import {
  computerBackendIsVisibleDesktop,
  computerLastFailureNote,
  computerReconnectsNote,
  computerStatusNeedsSetup,
  resolveComputerAvailabilityView,
} from "~/components/ComputerPanel.logic";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import {
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  computerStatusQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { SettingResetButton } from "./SettingControls";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionShell,
  SettingsSection,
} from "./SettingsPanelPrimitives";

/** Stable identity, so the provision hook's toast copy is not rebuilt every render. */
const EMPTY_PERMISSIONS: readonly ComputerPermission[] = [];

const BACKEND_DISPLAY_NAMES: Record<string, string> = {
  [COMPUTER_KWIN_BACKEND]: "KWin plugin (KDE)",
  [COMPUTER_HYPRLAND_BACKEND]: "Hyprland plugin",
  [COMPUTER_NESTED_KWIN_BACKEND]: "Isolated agent desktop (nested KWin)",
  [COMPUTER_MAC_BACKEND]: "macOS desktop",
  fake: "Test backend",
};

/** Ordered to read as a sentence of abilities, most consequential first. */
const CAPABILITY_LABELS: ReadonlyArray<{
  readonly key: keyof ComputerCapabilities;
  readonly label: string;
}> = [
  { key: "capture", label: "screen capture" },
  { key: "input", label: "input" },
  { key: "windows", label: "window listing" },
  { key: "windowBounds", label: "window geometry" },
  { key: "stacking", label: "stacking order" },
  { key: "focus", label: "keyboard focus" },
  { key: "raise", label: "window raising" },
  { key: "clipboard", label: "clipboard" },
  { key: "ghostCursor", label: "ghost cursor" },
];

/**
 * The abilities to read out. `captureAvailable` is live health, not a static
 * capability: a backend can advertise capture and still be unable to take a
 * frame because the OS has not granted it, and listing "screen capture" in that
 * state is the panel telling the user something the desktop cannot do.
 */
function capabilitySummary(capabilities: ComputerCapabilities, captureAvailable: boolean): string {
  const enabled = CAPABILITY_LABELS.filter(
    (entry) => capabilities[entry.key] && (entry.key !== "capture" || captureAvailable),
  ).map((entry) => entry.label);
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

export function ComputerSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const statusQuery = useQuery({
    ...computerStatusQueryOptions(),
    enabled: active,
    // Health can flip (reconnecting, recovered) while the panel is open.
    refetchInterval: active ? COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });

  const status = statusQuery.data;
  /**
   * The grants the OS is withholding, named. The availability message already
   * explains what to do; the row below is the checklist — the thing a user can
   * glance at after flipping a switch to see whether the other one is still off.
   */
  const missingPermissions =
    status?.availability.kind === "permission-required"
      ? status.availability.missing
      : EMPTY_PERMISSIONS;
  // The same provision the chat's setup card runs, through the same hook: one
  // call in flight at a time whichever surface started it, and one account of
  // what happened. This surface keeps that account inline rather than as a
  // toast, because it has room for it and is where the user is already looking.
  const setup = useProvisionComputer({ missing: missingPermissions });

  if (!active) return null;

  const availabilityView = statusQuery.isError
    ? {
        kind: "blocked" as const,
        title: "Computer status is unavailable",
        description:
          statusQuery.error instanceof Error && statusQuery.error.message
            ? statusQuery.error.message
            : "The server could not be reached.",
      }
    : resolveComputerAvailabilityView(status?.availability, status?.health);
  const backend =
    status?.availability.kind === "available" ? (status.availability.backend ?? null) : null;
  const health = status?.health;
  // How this backend shares the machine, in the user's terms. macOS is the one
  // backend with no seat of its own: it drives the desktop the human is looking
  // at. Elsewhere, the emergency release is a shortcut the compositor plugin
  // (KWin or Hyprland) registers with the compositor — no other backend binds
  // it, and a nested offscreen session never hears the human's keys, so only a
  // visible plugin-backed desktop may promise it.
  const capabilitiesDescription =
    backend === COMPUTER_MAC_BACKEND
      ? "The agent shares your desktop and uses a separate cursor. Supported apps accept input in background windows. Apps that need foreground input are brought forward; Synara reports this and stops typing if you switch to another app."
      : backend !== null &&
          COMPUTER_RELEASE_HOTKEY_BACKENDS.includes(backend) &&
          status?.capabilities.visibleDesktop === true
        ? `The agent drives its own seat, so your cursor and focus stay untouched. Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} at any time to stop it from acting on the desktop, and press it again to let it resume.`
        : "The agent drives its own seat, so your cursor and focus stay untouched.";
  /**
   * Screen capture is granted separately from input on every backend that has a
   * permission model at all, so a desktop can be fully driveable and still
   * blind.
   *
   * The two readings differ on purpose. `captureUnavailable` is "nothing has
   * proved capture works", which is also true of a backend nobody has engaged
   * yet — enough to offer Set up, not enough to accuse the OS of refusing.
   * `captureBlocked` is the refusal itself: a helper that is running and still
   * cannot see. Only that one earns a warning, and without it the card is
   * entirely green while every screenshot fails.
   */
  const captureUnavailable = health?.captureAvailable === false;
  const captureBlocked = captureUnavailable && health?.status === "connected";
  /**
   * The backend can drive the desktop, but not invisibly: one rung of its input
   * delivery is missing on this OS version, so reaching a background window
   * means briefly bringing it forward. Worth a row of its own because the
   * symptom — windows jumping to the front while the agent types — otherwise
   * looks like a bug in Synara rather than a limitation of the release.
   */
  const backgroundInputDegraded = health?.backgroundInputDegraded === true;
  const paneAutoOpenApplies = !computerBackendIsVisibleDesktop(status);
  // Shared with the chat's setup card, which asks the same question of the same
  // status after pressing the same server-side Set up.
  const needsSetup = computerStatusNeedsSetup(status);
  // The same two sentences the pane's health badge composes, from the same
  // helpers: one account of a supervision state, however it is surfaced.
  const healthNotes = [
    computerReconnectsNote(health),
    availabilityView.kind === "ready" ? computerLastFailureNote(health) : null,
  ].filter((note): note is string => note !== null);

  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="Desktop backend"
        action={
          <div className="flex items-center gap-2">
            {/* Offered whenever the desktop is not ready. Setting up installs
                whatever this backend still needs — on Linux, distribution
                packages through the system's own authorization dialog and
                Synara's compositor plugin into the user's home; on macOS, the
                native helper plus the Accessibility and Screen Recording grants
                macOS asks for — and boots the agent's desktop. */}
            {needsSetup && !statusQuery.isError ? (
              <Button
                size="xs"
                variant="default"
                disabled={setup.isPending}
                onClick={setup.provision}
              >
                {setup.isPending ? "Setting up…" : "Set up"}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={statusQuery.isFetching || setup.isPending}
              onClick={() => void statusQuery.refetch()}
            >
              {statusQuery.isFetching ? "Checking…" : "Refresh"}
            </Button>
          </div>
        }
      >
        <SettingsCard>
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    availabilityView.kind === "ready"
                      ? "bg-emerald-500"
                      : availabilityView.kind === "checking"
                        ? "animate-pulse bg-amber-500"
                        : "bg-red-500",
                  )}
                />
                {availabilityView.title}
              </span>
            }
            description={availabilityView.description}
            status={[setup.note, ...healthNotes].filter(Boolean).join(" ") || undefined}
          />
          {backend ? (
            <SettingsRow
              title="Backend"
              description="Which computer backend serves perception and input."
              control={
                <span className="text-sm text-muted-foreground">
                  {BACKEND_DISPLAY_NAMES[backend] ?? backend}
                </span>
              }
            />
          ) : null}
          {missingPermissions.length > 0 ? (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-red-500" />
                  {`${listComputerPermissions(missingPermissions)} ${missingPermissions.length === 1 ? "is" : "are"} not allowed yet`}
                </span>
              }
              description="Turn Synara on for each of these in System Settings › Privacy & Security, then press Set up."
              status={missingPermissions
                .map((permission) => COMPUTER_PERMISSION_LABELS[permission])
                .join(" · ")}
            />
          ) : null}
          {captureBlocked && missingPermissions.length === 0 ? (
            <SettingsRow
              title={
                <span className="flex items-center gap-2">
                  <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
                  Screen capture is not allowed yet
                </span>
              }
              description={
                backend === COMPUTER_MAC_BACKEND
                  ? "The agent can act on the desktop but cannot see it, so screenshots fail. Turn Synara on in System Settings › Privacy & Security › Screen Recording, then press Set up to reconnect."
                  : "The agent can act on the desktop but cannot see it, so screenshots fail. Press Set up to reconnect."
              }
            />
          ) : null}
          {backgroundInputDegraded ? (
            <SettingsRow
              title="Typing into background windows brings them forward"
              description="This version of macOS can't deliver typing into background web views, so the agent briefly brings those apps forward and then restores yours."
            />
          ) : null}
          {status && availabilityView.kind === "ready" ? (
            <SettingsRow
              title="Capabilities"
              description={capabilitiesDescription}
              status={capabilitySummary(status.capabilities, !captureBlocked)}
            />
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      {/* Hidden on a backend that drives the visible desktop, where the server
          never requests a pane at all (`ComputerManager.surfacePaneForAgent`
          returns early): the agent's actions are already happening on the screen
          the user is looking at. A switch that cannot change anything is worse
          than an absent one — it reads as a feature that is broken. */}
      {paneAutoOpenApplies ? (
        <SettingsSection title="Computer pane">
          <SettingsRow
            title="Open automatically"
            description="Open the Computer pane the first time an agent acts on the desktop in a chat. Closing the pane keeps it closed for the rest of that chat's run."
            resetAction={
              settings.autoOpenComputerPane !== defaults.autoOpenComputerPane ? (
                <SettingResetButton
                  label="open automatically"
                  onClick={() =>
                    updateSettings({ autoOpenComputerPane: defaults.autoOpenComputerPane })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.autoOpenComputerPane}
                onCheckedChange={(checked) =>
                  updateSettings({ autoOpenComputerPane: Boolean(checked) })
                }
                aria-label="Open the Computer pane automatically when an agent drives the desktop"
              />
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Computer control">
        <SettingsRow
          title="Enable by default"
          description="Make computer tools available to agents unless you turn them off in a conversation."
          resetAction={
            settings.allowComputerControlInNewChats !== defaults.allowComputerControlInNewChats ? (
              <SettingResetButton
                label="computer control default"
                onClick={() =>
                  updateSettings({
                    allowComputerControlInNewChats: defaults.allowComputerControlInNewChats,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.allowComputerControlInNewChats}
              onCheckedChange={(checked) =>
                updateSettings({ allowComputerControlInNewChats: Boolean(checked) })
              }
              aria-label="Enable computer control by default"
            />
          }
        />
        <SettingsRow
          title="How agents use the desktop"
          description="Agents can call computer tools when they need them. The selected model must support images and tool calls. Actions and clipboard reads follow the conversation's approval mode; full-access conversations run them without asking. Set up checks the macOS permissions, and the conversation offers setup guidance if access is missing."
        />
      </SettingsSection>
    </div>
  );
}
