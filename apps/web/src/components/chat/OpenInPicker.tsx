// FILE: OpenInPicker.tsx
// Purpose: Render the chat/file header "Open In" controls for the active editor target.
// Layer: Chat header action
// Depends on: shared editor metadata, native shell bridge, and preferred editor state.

import { type EditorId, type ResolvedKeybindingsConfig } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useEditorLaunchers, type EditorLaunchers } from "~/hooks/useEditorLaunchers";
import { ChevronDownIcon } from "~/lib/icons";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  Menu,
  MenuRadioGroup,
  MenuRadioItem,
  MenuShortcut,
  MenuTrigger,
  MenuItem,
  MenuSeparator,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  ChatHeaderSplitDivider,
  ChatHeaderSplitGroup,
  CHAT_HEADER_SPLIT_LEADING_CLASS_NAME,
  CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME,
} from "./chatHeaderControls";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];

interface OpenInPickerPrimaryAction {
  onClick: () => void;
  disabled?: boolean;
  icon?: ReactNode;
}

interface OpenInPickerProps {
  // Editor config is optional: callers that already hold it (e.g. the chat
  // header) pass it through, while standalone surfaces (file-preview headers)
  // omit it and let the picker self-fetch.
  keybindings?: ResolvedKeybindingsConfig;
  availableEditors?: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  // "responsive" (default) hides the "Open" label until the `header-actions`
  // inline-size container (declared on an ancestor — the chat header and the
  // file-preview header both do) is wide enough; "always" keeps it visible
  // regardless, for surfaces that don't establish that container.
  labelMode?: "responsive" | "always";
  // Pins the primary "Open" action to a specific editor for this surface without
  // mutating the shared preferred-editor setting. The PDF viewer uses this to default
  // to the OS viewer (e.g. Preview) while still listing installed editors.
  defaultEditor?: EditorId;
  // Lets a file surface reuse the installed-editor menu while its main action
  // stays in-app. Omitting this preserves the normal preferred-editor action.
  primaryAction?: OpenInPickerPrimaryAction;
  // Surface-specific actions appended after the shared installed-editor list.
  // OpenInPicker owns the separator so callers cannot create malformed menus.
  additionalMenuItems?: ReactNode;
  /** Optional surface-specific display priority; unlisted installed editors follow in catalog order. */
  menuEditorOrder?: ReadonlyArray<EditorId>;
  groupLabel?: string;
  menuLabel?: string;
}

type OpenInPickerContentProps = OpenInPickerProps & {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
};

export function OpenInPicker(props: OpenInPickerProps) {
  if (props.keybindings !== undefined && props.availableEditors !== undefined) {
    return (
      <OpenInPickerContent
        {...props}
        keybindings={props.keybindings}
        availableEditors={props.availableEditors}
      />
    );
  }
  return <OpenInPickerWithConfig {...props} />;
}

function OpenInPickerWithConfig(props: OpenInPickerProps) {
  // The query-owning wrapper mounts only for standalone surfaces. Rows that
  // receive config from ChatView avoid both the subscription and a QueryClient
  // dependency in isolated rendering/tests.
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  return (
    <OpenInPickerContent
      {...props}
      keybindings={props.keybindings ?? serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS}
      availableEditors={
        props.availableEditors ??
        serverConfigQuery.data?.availableEditors ??
        EMPTY_AVAILABLE_EDITORS
      }
    />
  );
}

function OpenInPickerContent({ primaryAction, ...props }: OpenInPickerContentProps) {
  return primaryAction ? (
    <PrimaryActionOpenInPicker {...props} primaryAction={primaryAction} />
  ) : (
    <EditorActionOpenInPicker {...props} />
  );
}

interface OpenInPickerFrameProps {
  labelMode: "responsive" | "always";
  groupLabel: string;
  menuLabel: string;
  primaryAction: OpenInPickerPrimaryAction;
  onMenuOpenChange?: (open: boolean) => void;
  menuContent: ReactNode;
}

function OpenInPickerFrame(props: OpenInPickerFrameProps) {
  return (
    <ChatHeaderSplitGroup label={props.groupLabel}>
      <ChatHeaderButton
        tone="outline"
        className={CHAT_HEADER_SPLIT_LEADING_CLASS_NAME}
        disabled={props.primaryAction.disabled ?? false}
        onClick={props.primaryAction.onClick}
      >
        {props.primaryAction.icon ?? null}
        <span
          className={cn(
            "font-normal",
            props.labelMode === "always"
              ? "ml-0.5"
              : "sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5",
          )}
        >
          Open
        </span>
      </ChatHeaderButton>
      <ChatHeaderSplitDivider />
      <Menu {...(props.onMenuOpenChange ? { onOpenChange: props.onMenuOpenChange } : {})}>
        <MenuTrigger
          render={
            <ChatHeaderIconButton
              label={props.menuLabel}
              tone="outline"
              className={CHAT_HEADER_SPLIT_TRAILING_CLASS_NAME}
            />
          }
        >
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </MenuTrigger>
        {props.menuContent}
      </Menu>
    </ChatHeaderSplitGroup>
  );
}

function EditorActionOpenInPicker(props: OpenInPickerContentProps) {
  const launchers = useEditorLaunchers(props);
  const PrimaryIcon = launchers.primaryOption?.Icon;

  return (
    <OpenInPickerFrame
      labelMode={props.labelMode ?? "responsive"}
      groupLabel={props.groupLabel ?? "Open in editor"}
      menuLabel={props.menuLabel ?? "Editor options"}
      primaryAction={{
        disabled: !launchers.preferredEditor || !props.openInTarget,
        icon: PrimaryIcon ? <PrimaryIcon aria-hidden="true" className="size-3.5" /> : null,
        onClick: () => launchers.openInEditor(launchers.preferredEditor),
      }}
      menuContent={
        <OpenInPickerMenuPopup
          launchers={launchers}
          openInTarget={props.openInTarget}
          additionalMenuItems={props.additionalMenuItems}
          menuEditorOrder={props.menuEditorOrder}
        />
      }
    />
  );
}

type PrimaryActionOpenInPickerProps = OpenInPickerContentProps & {
  primaryAction: OpenInPickerPrimaryAction;
};

function PrimaryActionOpenInPicker({ primaryAction, ...props }: PrimaryActionOpenInPickerProps) {
  const [launcherMenuMounted, setLauncherMenuMounted] = useState(false);

  return (
    <OpenInPickerFrame
      labelMode={props.labelMode ?? "responsive"}
      groupLabel={props.groupLabel ?? "Open in editor"}
      menuLabel={props.menuLabel ?? "Editor options"}
      primaryAction={primaryAction}
      onMenuOpenChange={(open) => {
        if (open) setLauncherMenuMounted(true);
      }}
      menuContent={launcherMenuMounted ? <OpenInPickerMenuWithLaunchers {...props} /> : null}
    />
  );
}

function OpenInPickerMenuWithLaunchers(props: OpenInPickerContentProps) {
  const launchers = useEditorLaunchers(props);
  return (
    <OpenInPickerMenuPopup
      launchers={launchers}
      openInTarget={props.openInTarget}
      additionalMenuItems={props.additionalMenuItems}
      menuEditorOrder={props.menuEditorOrder}
    />
  );
}

function OpenInPickerMenuPopup({
  launchers,
  openInTarget,
  additionalMenuItems,
  menuEditorOrder,
}: {
  launchers: EditorLaunchers;
  openInTarget: string | null;
  additionalMenuItems: ReactNode;
  menuEditorOrder: ReadonlyArray<EditorId> | undefined;
}) {
  const { options, preferredEditor, openFavoriteShortcutLabel, setDefaultEditor, openInEditor } =
    launchers;
  const displayedOptions = menuEditorOrder
    ? [
        ...menuEditorOrder.flatMap((editorId) => options.filter(({ value }) => value === editorId)),
        ...options.filter(({ value }) => !menuEditorOrder.includes(value)),
      ]
    : options;

  return (
    <ComposerPickerMenuPopup align="end" side="bottom" className="w-44 min-w-44">
      {displayedOptions.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
      <MenuRadioGroup
        value={preferredEditor ?? ""}
        onValueChange={(value) => setDefaultEditor(value as EditorId)}
      >
        {displayedOptions.map(({ label, Icon, value }) => (
          <MenuRadioItem
            key={value}
            preserveChildLayout
            trailing={
              value === preferredEditor && openFavoriteShortcutLabel ? (
                <MenuShortcut>{openFavoriteShortcutLabel}</MenuShortcut>
              ) : null
            }
            value={value}
            disabled={!openInTarget}
            onClick={() => openInEditor(value)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0">
                <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              </span>
              <span className="truncate">{label}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {additionalMenuItems ? (
        <>
          <MenuSeparator />
          {additionalMenuItems}
        </>
      ) : null}
    </ComposerPickerMenuPopup>
  );
}
