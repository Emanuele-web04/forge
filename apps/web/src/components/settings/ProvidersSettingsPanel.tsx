// FILE: ProvidersSettingsPanel.tsx
// Purpose: Own provider picker, update, and CLI installation settings workflows.
// Layer: Settings panel

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettings,
} from "@synara/contracts";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { pluralize } from "@synara/shared/text";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type MouseEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";

import type { AppSettings, AppSettingsBinding } from "~/appSettings";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { CentralIcon } from "~/lib/central-icons";
import { DownloadIcon, ExternalLinkIcon, Loader2Icon } from "~/lib/icons";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { sameProviderOrder } from "~/providerOrdering";
import {
  getVisibleProviderUpdateStatuses,
  isProviderLatestVersionKnowable,
  isProviderUpdateActive,
  shouldOfferProviderUpdateAction,
  shouldPromptProviderUpdate,
  shouldShowProviderUpdateStatus,
  withProviderUpdateTimeout,
} from "~/providerUpdates";
import { SETTINGS_TARGETS } from "~/settingsNavigation";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_INSET_RADIUS_CLASS_NAME,
  SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME } from "~/surfaceStyles";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ProviderIcon } from "../ProviderIcon";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";
import { SettingResetButton, useSettingsRestoreSignal } from "./SettingControls";
import { SettingsListRow, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type ProviderInstallTextKey =
  | "claudeBinaryPath"
  | "codexBinaryPath"
  | "codexHomePath"
  | "cursorBinaryPath"
  | "cursorApiEndpoint"
  | "antigravityBinaryPath"
  | "grokBinaryPath"
  | "droidBinaryPath"
  | "kiloBinaryPath"
  | "kiloServerUrl"
  | "openCodeBinaryPath"
  | "openCodeServerUrl"
  | "piBinaryPath"
  | "piAgentDir";
type ProviderInstallPasswordKey = "kiloServerPassword" | "openCodeServerPassword";
type ProviderInstallPasswordConfiguredKey =
  | "kiloServerPasswordConfigured"
  | "openCodeServerPasswordConfigured";
type ProviderInstallBooleanKey = "openCodeExperimentalWebSockets";

type ProviderInstallTextField = {
  readonly kind: "text";
  readonly settingsKey: ProviderInstallTextKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: ReactNode;
};
type ProviderInstallPasswordField = {
  readonly kind: "password";
  readonly settingsKey: ProviderInstallPasswordKey;
  readonly configuredKey: ProviderInstallPasswordConfiguredKey;
  readonly label: string;
  readonly placeholder: string;
  readonly description: ReactNode;
};
type ProviderInstallBooleanField = {
  readonly kind: "boolean";
  readonly settingsKey: ProviderInstallBooleanKey;
  readonly label: string;
  readonly description: ReactNode;
};
type ProviderInstallField =
  | ProviderInstallTextField
  | ProviderInstallPasswordField
  | ProviderInstallBooleanField;
type ProviderInstallSettings = {
  readonly provider: ProviderKind;
  readonly docs: ReadonlyArray<{ readonly label: string; readonly href: string }>;
  readonly fields: readonly ProviderInstallField[];
};

const PROVIDER_VISIBILITY_OPTIONS: ReadonlyArray<{ provider: ProviderKind; title: string }> =
  PROVIDER_DESCRIPTORS.map((descriptor) => ({
    provider: descriptor.kind,
    title: descriptor.displayName,
  }));

const PROVIDER_INSTALL_SETTINGS: readonly ProviderInstallSettings[] = [
  {
    provider: "codex",
    docs: [
      { label: "Install", href: "https://help.openai.com/en/articles/11096431" },
      { label: "Update", href: "https://help.openai.com/en/articles/11096431" },
      { label: "Config", href: "https://github.com/openai/codex/blob/main/docs/config.md" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "codexBinaryPath",
        label: "Codex binary path",
        placeholder: "Codex binary path",
        description: (
          <>
            Leave blank to use <code>codex</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "codexHomePath",
        label: "CODEX_HOME path",
        placeholder: "CODEX_HOME",
        description: "Optional custom Codex home and config directory.",
      },
    ],
  },
  {
    provider: "claudeAgent",
    docs: [
      { label: "Install", href: "https://code.claude.com/docs/en/installation" },
      { label: "Update", href: "https://code.claude.com/docs/en/installation#update-claude-code" },
      { label: "Config", href: "https://code.claude.com/docs/en/settings" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "claudeBinaryPath",
        label: "Claude binary path",
        placeholder: "Claude binary path",
        description: (
          <>
            Leave blank to use <code>claude</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "cursor",
    docs: [
      { label: "Install", href: "https://docs.cursor.com/en/cli/installation" },
      { label: "Update", href: "https://docs.cursor.com/en/cli/installation#updates" },
      { label: "Config", href: "https://docs.cursor.com/en/cli/overview" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "cursorBinaryPath",
        label: "Cursor binary path",
        placeholder: "Cursor Agent or Cursor CLI path",
        description: (
          <>
            Leave blank to use <code>cursor-agent</code> from your PATH. Cursor editor CLI paths are
            accepted too.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "cursorApiEndpoint",
        label: "Cursor API endpoint",
        placeholder: "https://api2.cursor.sh",
        description: "Optional Cursor API endpoint override passed to `cursor-agent -e`.",
      },
    ],
  },
  {
    provider: "antigravity",
    docs: [
      { label: "Install", href: "https://antigravity.google/docs/cli-using" },
      { label: "Reference", href: "https://antigravity.google/docs/cli-reference" },
      { label: "Hooks", href: "https://antigravity.google/docs/hooks" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "antigravityBinaryPath",
        label: "Antigravity binary path",
        placeholder: "Antigravity CLI binary path",
        description: (
          <>
            Leave blank to use <code>agy</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "grok",
    docs: [
      { label: "Install", href: "https://docs.x.ai/build/overview" },
      { label: "Headless", href: "https://docs.x.ai/build/cli/headless-scripting" },
      { label: "Config", href: "https://docs.x.ai/build/overview" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "grokBinaryPath",
        label: "Grok binary path",
        placeholder: "Grok binary path",
        description: (
          <>
            Leave blank to use <code>grok</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "droid",
    docs: [
      {
        label: "Quickstart",
        href: "https://docs.factory.ai/cli/getting-started/quickstart.md",
      },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "droidBinaryPath",
        label: "Droid binary path",
        placeholder: "droid",
        description: (
          <>
            Leave blank to use <code>droid</code> from your PATH.
          </>
        ),
      },
    ],
  },
  {
    provider: "kilo",
    docs: [
      { label: "Install", href: "https://kilo.ai/docs/cli" },
      { label: "Update", href: "https://kilo.ai/docs/cli" },
      { label: "Config", href: "https://kilo.ai/docs/cli#configuration" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "kiloBinaryPath",
        label: "Kilo binary path",
        placeholder: "Kilo binary path",
        description: (
          <>
            Leave blank to use <code>kilo</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "kiloServerUrl",
        label: "Kilo server URL",
        placeholder: "http://127.0.0.1:4096",
        description: "Optional existing Kilo server URL. Leave blank to spawn a local server.",
      },
      {
        kind: "password",
        settingsKey: "kiloServerPassword",
        configuredKey: "kiloServerPasswordConfigured",
        label: "Kilo server password",
        placeholder: "Kilo server password",
        description: "Optional password for an externally managed Kilo server.",
      },
    ],
  },
  {
    provider: "opencode",
    docs: [
      { label: "Install", href: "https://opencode.ai/docs/" },
      { label: "Update", href: "https://opencode.ai/docs/cli/" },
      { label: "Config", href: "https://opencode.ai/docs/config/" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "openCodeBinaryPath",
        label: "OpenCode binary path",
        placeholder: "OpenCode binary path",
        description: (
          <>
            Leave blank to use <code>opencode</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "openCodeServerUrl",
        label: "OpenCode server URL",
        placeholder: "http://127.0.0.1:4096",
        description: "Optional existing OpenCode server URL. Leave blank to spawn a local server.",
      },
      {
        kind: "password",
        settingsKey: "openCodeServerPassword",
        configuredKey: "openCodeServerPasswordConfigured",
        label: "OpenCode server password",
        placeholder: "OpenCode server password",
        description: "Optional password for an externally managed OpenCode server.",
      },
      {
        kind: "boolean",
        settingsKey: "openCodeExperimentalWebSockets",
        label: "OpenAI response WebSockets",
        description:
          "Use Opencode's experimental OpenAI response WebSocket transport for managed local servers.",
      },
    ],
  },
  {
    provider: "pi",
    docs: [
      { label: "Install", href: "https://pi.dev/docs/latest" },
      { label: "Update", href: "https://pi.dev/docs/latest/settings" },
      { label: "Config", href: "https://pi.dev/docs/latest/settings" },
    ],
    fields: [
      {
        kind: "text",
        settingsKey: "piBinaryPath",
        label: "Pi binary path",
        placeholder: "Pi binary path",
        description: (
          <>
            Leave blank to use <code>pi</code> from your PATH.
          </>
        ),
      },
      {
        kind: "text",
        settingsKey: "piAgentDir",
        label: "Pi agent directory",
        placeholder: "Pi agent directory",
        description: "Optional custom Pi agent directory for auth, models, skills, and commands.",
      },
    ],
  },
];

function isProviderInstallFieldDirty(
  field: ProviderInstallField,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return field.kind === "password"
    ? settings[field.configuredKey] !== defaults[field.configuredKey]
    : settings[field.settingsKey] !== defaults[field.settingsKey];
}

function isProviderInstallConfigDirty(
  config: ProviderInstallSettings,
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return config.fields.some((field) => isProviderInstallFieldDirty(field, settings, defaults));
}

export function isProviderInstallSettingsDirty(
  settings: AppSettings,
  defaults: AppSettings,
): boolean {
  return PROVIDER_INSTALL_SETTINGS.some((config) =>
    isProviderInstallConfigDirty(config, settings, defaults),
  );
}

function createProviderInstallDisclosureState(
  settings: AppSettings,
): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [
      config.provider,
      config.fields.some((field) =>
        field.kind === "password"
          ? settings[field.configuredKey]
          : Boolean(settings[field.settingsKey]),
      ),
    ]),
  ) as Record<ProviderKind, boolean>;
}

function createClosedProviderInstallDisclosureState(): Record<ProviderKind, boolean> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.map((config) => [config.provider, false]),
  ) as Record<ProviderKind, boolean>;
}

export function createProviderInstallResetPatch(defaults: AppSettings): Partial<AppSettings> {
  return Object.fromEntries(
    PROVIDER_INSTALL_SETTINGS.flatMap((config) =>
      config.fields.map((field) => [field.settingsKey, defaults[field.settingsKey]]),
    ),
  ) as Partial<AppSettings>;
}

function setProviderListMembership(
  current: ReadonlyArray<ProviderKind>,
  provider: ProviderKind,
  included: boolean,
): ProviderKind[] {
  const withoutTarget = current.filter((entry) => entry !== provider);
  return included ? [...withoutTarget, provider] : withoutTarget;
}

function isProviderPickerProviderEnabled(
  providerStatus: Pick<ServerProviderStatus, "available"> | null | undefined,
  isHidden: boolean,
): boolean {
  return providerStatus?.available === true && !isHidden;
}

function SortableProviderVisibilityRow(props: {
  option: { provider: ProviderKind; title: string };
  providerStatus: ServerProviderStatus | undefined;
  statusReconciled: boolean;
  isHidden: boolean;
  onHiddenChange: (hidden: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.option.provider });
  const isChecking = !props.statusReconciled || props.providerStatus === undefined;
  const isAvailable = props.providerStatus?.available === true;
  const isEnabled = isProviderPickerProviderEnabled(props.providerStatus, props.isHidden);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        SETTINGS_OUTLINED_SURFACE_CLASS_NAME,
        "flex items-center justify-between gap-3 px-3 py-2.5",
        isDragging && "z-10 opacity-80 shadow-lg",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={cn(
            "inline-flex size-6 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing",
            ELEVATED_HOVER_SURFACE_RAISED_TEXT_CLASS_NAME,
            SETTINGS_INSET_RADIUS_CLASS_NAME,
          )}
          aria-label={`Reorder ${props.option.title}`}
          {...attributes}
          {...listeners}
        >
          <CentralIcon name="dot-grid-2x3" className="size-4" />
        </button>
        <ProviderIcon provider={props.option.provider} className="size-4 shrink-0" />
        <span className="min-w-0">
          <span className="block truncate text-sm text-foreground">{props.option.title}</span>
          <span className="block text-[11px] text-muted-foreground">
            {isChecking ? "Checking" : isAvailable ? "Installed" : "CLI not installed"}
          </span>
        </span>
      </div>
      <Switch
        checked={isEnabled}
        disabled={isChecking || !isAvailable}
        onCheckedChange={(checked) => props.onHiddenChange(!Boolean(checked))}
        aria-label={
          isChecking
            ? `Checking ${props.option.title} CLI availability`
            : isAvailable
              ? `Show ${props.option.title} in the provider picker`
              : `${props.option.title} CLI is not installed`
        }
      />
    </div>
  );
}

function ProviderDocsLinks({ docs }: { docs: ProviderInstallSettings["docs"] }) {
  return (
    <div className={cn(SETTINGS_OUTLINED_SURFACE_CLASS_NAME, "px-3 py-2.5")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs font-medium text-foreground">CLI docs</span>
        <div className="flex flex-wrap gap-2">
          {docs.map((doc) => (
            <Button
              key={`${doc.label}:${doc.href}`}
              variant="outline"
              size="sm"
              render={<a href={doc.href} target="_blank" rel="noreferrer" />}
            >
              <span>{doc.label}</span>
              <ExternalLinkIcon className="size-3" />
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

function formatProviderVersion(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function providerUpdateStatusLabel(provider: ServerProviderStatus): string | null {
  const state = provider.updateState?.status;
  if (state === "queued") return "Update queued";
  if (state === "running") return "Updating";
  if (state === "succeeded") return "Updated";
  if (state === "failed") return "Update failed";
  if (state === "unchanged") return "Still outdated";
  const advisory = provider.versionAdvisory;
  if (advisory?.status === "behind_latest" && advisory.latestVersion) {
    const currentVersion = formatProviderVersion(advisory.currentVersion);
    const latestVersion = formatProviderVersion(advisory.latestVersion);
    return currentVersion ? `${currentVersion} -> ${latestVersion}` : `Latest ${latestVersion}`;
  }
  const currentVersion = formatProviderVersion(provider.version);
  return currentVersion ? `Current ${currentVersion}` : null;
}

function providerUpdateFailureMessage(provider: ServerProviderStatus | undefined): string | null {
  const state = provider?.updateState;
  if (!state || (state.status !== "failed" && state.status !== "unchanged")) return null;
  return state.output?.trim() || state.message || "The provider update did not complete.";
}

function ProviderUpdateAction(props: {
  providerStatus: ServerProviderStatus;
  active: boolean;
  disabled: boolean;
  onUpdate: (provider: ProviderKind) => void;
}) {
  const advisory = props.providerStatus.versionAdvisory;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={props.disabled}
      title={advisory?.updateCommand ? `Run ${advisory.updateCommand}` : undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        props.onUpdate(props.providerStatus.provider);
      }}
    >
      {props.active ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : (
        <DownloadIcon className="size-3.5" />
      )}
      {props.active ? "Updating" : "Update"}
    </Button>
  );
}

function ProviderInstallFieldControl(props: {
  field: ProviderInstallField;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const id = `provider-install-${props.field.settingsKey}`;
  if (props.field.kind === "boolean") {
    return (
      <label
        htmlFor={id}
        className="flex items-start justify-between gap-3 rounded-md border border-border/70 bg-background/60 px-3 py-2"
      >
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">{props.field.label}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {props.field.description}
          </span>
        </span>
        <Switch
          id={id}
          checked={props.settings[props.field.settingsKey]}
          onCheckedChange={(checked) =>
            props.updateSettings({ [props.field.settingsKey]: Boolean(checked) })
          }
        />
      </label>
    );
  }

  const configured =
    props.field.kind === "password" ? props.settings[props.field.configuredKey] : false;
  const isPassword = props.field.kind === "password";
  return (
    <label htmlFor={id} className="block">
      <span className="block text-xs font-medium text-foreground">{props.field.label}</span>
      <DebouncedSettingTextInput
        id={id}
        size="sm"
        variant="soft"
        className="mt-1"
        value={isPassword ? "" : props.settings[props.field.settingsKey]}
        onCommit={(nextValue) =>
          props.updateSettings({ [props.field.settingsKey]: nextValue } as Partial<AppSettings>)
        }
        placeholder={
          isPassword && configured
            ? "Configured — enter a replacement or leave blank"
            : props.field.placeholder
        }
        type={isPassword ? "password" : undefined}
        autoComplete={isPassword ? "new-password" : undefined}
        spellCheck={false}
      />
      <span className="mt-1 block text-xs text-muted-foreground">{props.field.description}</span>
    </label>
  );
}

function ProviderToolRow(props: {
  config: ProviderInstallSettings;
  open: boolean;
  settings: AppSettings;
  defaults: AppSettings;
  hiddenProviderSet: ReadonlySet<ProviderKind>;
  serverSettings: Pick<ServerSettings, "providers" | "enableProviderUpdateChecks"> | null;
  providerStatus: ServerProviderStatus | undefined;
  updatingProviders: ReadonlySet<ProviderKind>;
  onOpenChange: (open: boolean) => void;
  onUpdate: (provider: ProviderKind) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const title = PROVIDER_DISPLAY_NAMES[props.config.provider];
  const isDirty = isProviderInstallConfigDirty(props.config, props.settings, props.defaults);
  const showProviderUpdateStatus = props.providerStatus
    ? shouldShowProviderUpdateStatus({
        provider: props.providerStatus,
        hiddenProviderSet: props.hiddenProviderSet,
        serverSettings: props.serverSettings,
      })
    : false;
  const updateAdvisory = props.providerStatus?.versionAdvisory;
  const providerUpdateSuppressed =
    updateAdvisory?.status === "behind_latest" && !showProviderUpdateStatus;
  const currentProviderVersion = formatProviderVersion(props.providerStatus?.version);
  const providerUpdateLabel = props.providerStatus
    ? !props.settings.enableProviderUpdateChecks
      ? currentProviderVersion
        ? `Current ${currentProviderVersion}`
        : null
      : providerUpdateSuppressed
        ? null
        : providerUpdateStatusLabel(props.providerStatus)
    : null;
  const updateActive = Boolean(
    (props.providerStatus && isProviderUpdateActive(props.providerStatus)) ||
    props.updatingProviders.has(props.config.provider),
  );
  const showUpdateButton = props.providerStatus
    ? shouldPromptProviderUpdate(props.providerStatus) &&
      (showProviderUpdateStatus || updateAdvisory?.status === "unknown")
    : false;
  // Self-updating CLIs never report a latest version, so the update stays available
  // inside the panel rather than as a header badge that can never be satisfied.
  const showSelfManagedUpdate = props.providerStatus
    ? shouldOfferProviderUpdateAction(props.providerStatus) &&
      !isProviderLatestVersionKnowable(props.providerStatus)
    : false;

  return (
    <Collapsible open={props.open} onOpenChange={props.onOpenChange}>
      <div className="border-t border-border/70 first:border-t-0">
        <div className="flex min-h-11 items-center gap-2 px-3 py-2">
          <CollapsibleTrigger
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground">{title}</span>
            {isDirty ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">Custom</span>
            ) : null}
            {providerUpdateLabel ? (
              <span
                className={cn(
                  "shrink-0 text-[11px]",
                  updateAdvisory?.status === "behind_latest"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {providerUpdateLabel}
              </span>
            ) : null}
            <DisclosureChevron
              open={props.open}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </CollapsibleTrigger>
          {showUpdateButton && props.providerStatus ? (
            <ProviderUpdateAction
              providerStatus={props.providerStatus}
              active={updateActive}
              disabled={updateActive}
              onUpdate={props.onUpdate}
            />
          ) : null}
        </div>

        <CollapsiblePanel>
          <div className="border-t border-border/70 bg-muted/20 px-3 py-3">
            <div className="space-y-3">
              <ProviderDocsLinks docs={props.config.docs} />
              {showProviderUpdateStatus && updateAdvisory?.status === "behind_latest" ? (
                <div className="text-xs text-muted-foreground">
                  {updateAdvisory.canUpdate && updateAdvisory.updateCommand ? (
                    <>
                      <span>Command: </span>
                      <code className="font-mono">{updateAdvisory.updateCommand}</code>
                    </>
                  ) : (
                    "A newer version is available, but Synara could not identify a safe one-click update command for this installation."
                  )}
                </div>
              ) : null}
              {showSelfManagedUpdate && props.providerStatus ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    {title} manages its own releases, so Synara cannot tell whether a newer version
                    exists. Run the update to be sure.
                  </div>
                  <ProviderUpdateAction
                    providerStatus={props.providerStatus}
                    active={updateActive}
                    disabled={updateActive}
                    onUpdate={props.onUpdate}
                  />
                </div>
              ) : null}
              {props.config.fields.map((field) => (
                <ProviderInstallFieldControl
                  key={field.settingsKey}
                  field={field}
                  settings={props.settings}
                  updateSettings={props.updateSettings}
                />
              ))}
            </div>
          </div>
        </CollapsiblePanel>
      </div>
    </Collapsible>
  );
}

export type ProvidersSettingsPanelProps = AppSettingsBinding & {
  readonly active: boolean;
  readonly resetEpoch: number;
  readonly updateSettingsAndWait: (patch: Partial<AppSettings>) => Promise<void>;
};

export function ProvidersSettingsPanel({
  settings,
  defaults,
  updateSettings,
  updateSettingsAndWait,
  active,
  resetEpoch,
}: ProvidersSettingsPanelProps) {
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localProviderStatuses = useProviderStatusesForLocalConfig();
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [openInstallProviders, setOpenInstallProviders] = useState<Record<ProviderKind, boolean>>(
    () => createProviderInstallDisclosureState(settings),
  );
  const [updatingProviders, setUpdatingProviders] = useState<ReadonlySet<ProviderKind>>(
    () => new Set(),
  );
  const providerEnablementMutationInFlightRef = useRef(false);
  const [providerEnablementMutationPending, setProviderEnablementMutationPending] = useState(false);
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const hiddenProviderCount = hiddenProviderSet.size;
  const disabledProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.disabledProviders),
    [settings.disabledProviders],
  );
  const enabledProviderCount = PROVIDER_VISIBILITY_OPTIONS.length - disabledProviderSet.size;
  const providerVisibilityOptionsByProvider = useMemo(
    () => new Map(PROVIDER_VISIBILITY_OPTIONS.map((option) => [option.provider, option])),
    [],
  );
  const orderedProviderVisibilityOptions = useMemo(
    () =>
      settings.providerOrder.flatMap((provider) => {
        const option = providerVisibilityOptionsByProvider.get(provider);
        return option ? [option] : [];
      }),
    [providerVisibilityOptionsByProvider, settings.providerOrder],
  );
  const providerVisibilitySensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const isProviderOrderDirty = !sameProviderOrder(settings.providerOrder, defaults.providerOrder);
  const providerStatusByProvider = useMemo(
    () => new Map(localProviderStatuses.map((status) => [status.provider, status])),
    [localProviderStatuses],
  );
  const availableProviderCount = orderedProviderVisibilityOptions.filter(
    (option) => providerStatusByProvider.get(option.provider)?.available === true,
  ).length;
  const visibleAvailableProviderCount = orderedProviderVisibilityOptions.filter(
    (option) =>
      providerStatusByProvider.get(option.provider)?.available === true &&
      !hiddenProviderSet.has(option.provider),
  ).length;
  const hasPendingProviderStatuses =
    !providerStatusesReconciled ||
    orderedProviderVisibilityOptions.some(
      (option) => !providerStatusByProvider.has(option.provider),
    );
  const providerUpdateServerSettings = useMemo(
    () =>
      serverSettingsQuery.data
        ? {
            ...serverSettingsQuery.data,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }
        : null,
    [serverSettingsQuery.data, settings.enableProviderUpdateChecks],
  );
  const outdatedProviderStatuses = useMemo(
    () =>
      getVisibleProviderUpdateStatuses({
        providers: serverConfigQuery.data?.providers ?? [],
        hiddenProviders: settings.hiddenProviders,
        serverSettings: providerUpdateServerSettings,
      }),
    [providerUpdateServerSettings, serverConfigQuery.data?.providers, settings.hiddenProviders],
  );
  const outdatedProviderCount = outdatedProviderStatuses.length;
  const installSettingsDirty = isProviderInstallSettingsDirty(settings, defaults);

  const updateProviderEnablement = useCallback(
    async (disabledProviders: ProviderKind[]) => {
      if (providerEnablementMutationInFlightRef.current) return;
      providerEnablementMutationInFlightRef.current = true;
      setProviderEnablementMutationPending(true);
      try {
        await updateSettingsAndWait({ disabledProviders });
      } finally {
        providerEnablementMutationInFlightRef.current = false;
        setProviderEnablementMutationPending(false);
      }
    },
    [updateSettingsAndWait],
  );

  useSettingsRestoreSignal(resetEpoch, () => {
    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
  });

  const handleProviderOrderDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = settings.providerOrder.indexOf(active.id as ProviderKind);
      const toIndex = settings.providerOrder.indexOf(over.id as ProviderKind);
      if (fromIndex < 0 || toIndex < 0) return;
      updateSettings({ providerOrder: arrayMove([...settings.providerOrder], fromIndex, toIndex) });
    },
    [settings.providerOrder, updateSettings],
  );

  const runProviderUpdate = useCallback(
    async (provider: ProviderKind) => {
      if (updatingProviders.has(provider)) return;
      setUpdatingProviders((current) => new Set(current).add(provider));
      await withProviderUpdateTimeout({
        provider,
        request: ensureNativeApi().server.updateProvider({ provider }),
      })
        .then((result) => {
          const refreshedProvider = result.providers.find((status) => status.provider === provider);
          const failureMessage = providerUpdateFailureMessage(refreshedProvider);
          if (failureMessage) {
            const manualCommand = refreshedProvider?.versionAdvisory?.updateCommand?.trim();
            toastManager.add({
              type: "error",
              title: `Could not update ${PROVIDER_DISPLAY_NAMES[provider]}`,
              description: manualCommand
                ? `${failureMessage}\n\nCopy the command below to update manually in a terminal.`
                : failureMessage,
              ...(manualCommand ? { data: { copyText: manualCommand } } : {}),
            });
            return;
          }
          toastManager.add({
            type: "success",
            title: `${PROVIDER_DISPLAY_NAMES[provider]} update finished`,
            description: "New sessions will use the refreshed provider.",
          });
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not update ${PROVIDER_DISPLAY_NAMES[provider]}`,
            description: error instanceof Error ? error.message : "The provider update failed.",
          });
        })
        .finally(async () => {
          await queryClient
            .invalidateQueries({ queryKey: serverQueryKeys.config() })
            .catch(() => undefined);
          setUpdatingProviders((current) => {
            const next = new Set(current);
            next.delete(provider);
            return next;
          });
        });
    },
    [queryClient, updatingProviders],
  );

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSection title="Provider activity">
        <SettingsRow
          title="Enabled providers"
          description="Disabling a provider stops its background health checks, model and command discovery, updates, and new turns. Existing threads stay visible and continue after you re-enable it; a turn already running is not interrupted."
          status={
            providerEnablementMutationPending
              ? "Saving provider activity"
              : `${enabledProviderCount} of ${PROVIDER_VISIBILITY_OPTIONS.length} enabled`
          }
          resetAction={
            disabledProviderSet.size > 0 && !providerEnablementMutationPending ? (
              <SettingResetButton
                label="enabled providers"
                onClick={() => void updateProviderEnablement([...defaults.disabledProviders])}
              />
            ) : null
          }
        >
          <div
            className={cn(
              "mt-4",
              SETTINGS_INSET_LIST_CLASS_NAME,
              SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
            )}
          >
            {orderedProviderVisibilityOptions.map((option) => {
              const enabled = !disabledProviderSet.has(option.provider);
              return (
                <SettingsListRow
                  key={option.provider}
                  title={
                    <span className="flex items-center gap-2">
                      <ProviderIcon provider={option.provider} className="size-4 shrink-0" />
                      <span>{option.title}</span>
                    </span>
                  }
                  description={enabled ? "Background activity allowed" : "Disabled on the server"}
                  actions={
                    <Switch
                      checked={enabled}
                      disabled={!serverSettingsQuery.data || providerEnablementMutationPending}
                      onCheckedChange={(checked) =>
                        void updateProviderEnablement(
                          setProviderListMembership(
                            settings.disabledProviders,
                            option.provider,
                            !Boolean(checked),
                          ),
                        )
                      }
                      aria-label={`${enabled ? "Disable" : "Enable"} ${option.title}`}
                    />
                  }
                />
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Provider picker">
        <SettingsRow
          title="Available CLIs"
          description="Show or hide installed providers in the picker and drag them into your preferred order. Hiding a provider here does not disable its server activity."
          status={
            serverConfigQuery.isPending || hasPendingProviderStatuses
              ? "Checking installed CLIs"
              : availableProviderCount === 0
                ? "No CLIs detected"
                : visibleAvailableProviderCount < availableProviderCount
                  ? `${visibleAvailableProviderCount} of ${availableProviderCount} installed shown`
                  : isProviderOrderDirty
                    ? `${availableProviderCount} installed · custom order`
                    : `${availableProviderCount} installed`
          }
          resetAction={
            hiddenProviderCount > 0 || isProviderOrderDirty ? (
              <SettingResetButton
                label="provider picker"
                onClick={() =>
                  updateSettings({
                    hiddenProviders: defaults.hiddenProviders,
                    providerOrder: defaults.providerOrder,
                  })
                }
              />
            ) : null
          }
        >
          <DndContext
            sensors={providerVisibilitySensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleProviderOrderDragEnd}
          >
            <SortableContext
              items={orderedProviderVisibilityOptions.map((option) => option.provider)}
              strategy={verticalListSortingStrategy}
            >
              <div className="mt-4 space-y-2">
                {orderedProviderVisibilityOptions.map((option) => (
                  <SortableProviderVisibilityRow
                    key={option.provider}
                    option={option}
                    providerStatus={providerStatusByProvider.get(option.provider)}
                    statusReconciled={providerStatusesReconciled}
                    isHidden={hiddenProviderSet.has(option.provider)}
                    onHiddenChange={(hidden) =>
                      updateSettings({
                        hiddenProviders: setProviderListMembership(
                          settings.hiddenProviders,
                          option.provider,
                          hidden,
                        ),
                      })
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </SettingsRow>
      </SettingsSection>

      <div id={SETTINGS_TARGETS.providerUpdates}>
        <SettingsSection title="Updates">
          <SettingsRow
            title="Automatic CLI update checks"
            description="Check Codex, Claude, and other provider CLIs for newer versions in the background."
            resetAction={
              settings.enableProviderUpdateChecks !== defaults.enableProviderUpdateChecks ? (
                <SettingResetButton
                  label="CLI update checks"
                  onClick={() =>
                    updateSettings({
                      enableProviderUpdateChecks: defaults.enableProviderUpdateChecks,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.enableProviderUpdateChecks}
                onCheckedChange={(checked) =>
                  updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                }
                aria-label="Automatic CLI update checks"
              />
            }
          />

          <SettingsRow
            title="Provider updates"
            description="Review installed provider tools that Synara can safely update."
            status={
              !settings.enableProviderUpdateChecks
                ? "Automatic checks off"
                : outdatedProviderCount > 0
                  ? `${outdatedProviderCount} ${pluralize(outdatedProviderCount, "update")} available`
                  : "No provider updates detected"
            }
          >
            {settings.enableProviderUpdateChecks && outdatedProviderStatuses.length > 0 ? (
              <div
                className={cn(
                  "mt-4",
                  SETTINGS_INSET_LIST_CLASS_NAME,
                  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
                )}
              >
                {outdatedProviderStatuses.map((providerStatus) => {
                  const updateActive =
                    isProviderUpdateActive(providerStatus) ||
                    updatingProviders.has(providerStatus.provider);
                  const updateLabel = providerUpdateStatusLabel(providerStatus);
                  return (
                    <SettingsListRow
                      key={providerStatus.provider}
                      title={PROVIDER_DISPLAY_NAMES[providerStatus.provider]}
                      description={updateLabel || undefined}
                      actions={
                        providerStatus.versionAdvisory?.canUpdate ? (
                          <ProviderUpdateAction
                            providerStatus={providerStatus}
                            active={updateActive}
                            disabled={updateActive}
                            onUpdate={(provider) => void runProviderUpdate(provider)}
                          />
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Manual update</span>
                        )
                      }
                    />
                  );
                })}
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      </div>

      <div>
        <SettingsSection title="Provider tools">
          <SettingsRow
            title="Installed CLIs"
            description="Review provider versions and update tools. Open a row only when you need binary overrides."
            status={
              !settings.enableProviderUpdateChecks
                ? "Automatic checks off"
                : outdatedProviderCount > 0
                  ? `${outdatedProviderCount} ${pluralize(outdatedProviderCount, "update")} available`
                  : "No provider updates detected"
            }
            resetAction={
              installSettingsDirty ? (
                <SettingResetButton
                  label="provider tools"
                  onClick={() => {
                    updateSettings(createProviderInstallResetPatch(defaults));
                    setOpenInstallProviders(createClosedProviderInstallDisclosureState());
                  }}
                />
              ) : null
            }
          >
            <div className="mt-4">
              <div className={SETTINGS_INSET_LIST_CLASS_NAME}>
                {PROVIDER_INSTALL_SETTINGS.map((config) => (
                  <ProviderToolRow
                    key={config.provider}
                    config={config}
                    open={openInstallProviders[config.provider]}
                    settings={settings}
                    defaults={defaults}
                    hiddenProviderSet={hiddenProviderSet}
                    serverSettings={providerUpdateServerSettings}
                    providerStatus={providerStatusByProvider.get(config.provider)}
                    updatingProviders={updatingProviders}
                    onOpenChange={(open) =>
                      setOpenInstallProviders((existing) => ({
                        ...existing,
                        [config.provider]: open,
                      }))
                    }
                    onUpdate={(provider) => void runProviderUpdate(provider)}
                    updateSettings={updateSettings}
                  />
                ))}
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>
      </div>
    </div>
  );
}
