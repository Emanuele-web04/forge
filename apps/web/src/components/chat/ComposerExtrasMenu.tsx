// FILE: ComposerExtrasMenu.tsx
// Purpose: Hosts the composer `+` menu for attachments and quick composer mode toggles.
// Layer: Chat composer presentation
// Depends on: shared menu primitives, icon buttons, and caller-owned composer state callbacks.

import { type ProviderInteractionMode } from "@synara/contracts";
import { useId, useRef, type ChangeEvent } from "react";

import {
  BugIcon,
  GitPullRequestIcon,
  ListTodoIcon,
  MessageCircleIcon,
  PaperclipIcon,
  PlusIcon,
} from "~/lib/icons";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Availability of the composer work-item attach affordance, resolved by the
 * caller from the server's `workItems.availability` probe. `hidden` removes the
 * item (no GitHub remote); `disabled` keeps it visible but inert with the
 * server's hint as the exact tooltip.
 */
export type ComposerWorkItemAttachStatus =
  | { status: "hidden" }
  | { status: "enabled" }
  | { status: "disabled"; tooltip: string };

export const ComposerExtrasMenu = function ComposerExtrasMenu(props: {
  interactionMode: ProviderInteractionMode;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  onAddAttachments: (files: File[]) => void;
  workItemAttach: ComposerWorkItemAttachStatus;
  onAttachWorkItem: () => void;
  onToggleFastMode: () => void;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Reset the hidden input so selecting the same file twice still emits a change event.
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      props.onAddAttachments(files);
    }
    event.target.value = "";
  };

  return (
    <>
      <input
        id={inputId}
        ref={fileInputRef}
        data-testid="composer-file-input"
        type="file"
        multiple
        className="sr-only"
        onChange={handleFileInputChange}
      />
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="chrome"
              className="shrink-0 rounded-md"
              aria-label="Composer extras"
            />
          }
        >
          <PlusIcon aria-hidden="true" className="size-4 text-primary" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="start">
          <MenuItem
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            <PaperclipIcon className="size-4 shrink-0" />
            Add files
          </MenuItem>
          {props.workItemAttach.status === "disabled" ? (
            // aria-disabled (not the `disabled` prop): the item must stay
            // hoverable so the tooltip with the exact gh hint can appear, while
            // remaining inert — no onClick, so activation does nothing.
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuItem aria-disabled="true" className="opacity-55">
                    <GitPullRequestIcon className="size-4 shrink-0" />
                    Attach issue or PR
                  </MenuItem>
                }
              />
              <TooltipPopup side="right" sideOffset={8}>
                <span className="inline-flex max-w-64 items-center gap-1 px-0.5 py-0.5">
                  <span>{props.workItemAttach.tooltip}</span>
                </span>
              </TooltipPopup>
            </Tooltip>
          ) : props.workItemAttach.status === "enabled" ? (
            <MenuItem onClick={props.onAttachWorkItem}>
              <GitPullRequestIcon className="size-4 shrink-0" />
              Attach issue or PR
            </MenuItem>
          ) : null}

          <MenuSeparator />
          <MenuSub>
            <MenuSubTrigger>Mode</MenuSubTrigger>
            <ComposerPickerMenuSubPopup>
              <MenuRadioGroup
                value={props.interactionMode}
                onValueChange={(value) => {
                  if (value === "default" || value === "plan" || value === "debug") {
                    props.onInteractionModeChange(value);
                  }
                }}
              >
                <MenuRadioItem value="default">
                  <span className="inline-flex items-center gap-2">
                    <MessageCircleIcon className="size-4 shrink-0" />
                    Default
                  </span>
                </MenuRadioItem>
                <MenuRadioItem value="plan">
                  <span className="inline-flex items-center gap-2">
                    <ListTodoIcon className="size-4 shrink-0" />
                    Plan
                  </span>
                </MenuRadioItem>
                <MenuRadioItem value="debug">
                  <span className="inline-flex items-center gap-2">
                    <BugIcon className="size-4 shrink-0" />
                    Debug
                  </span>
                </MenuRadioItem>
              </MenuRadioGroup>
            </ComposerPickerMenuSubPopup>
          </MenuSub>

          {props.supportsFastMode ? (
            <>
              <MenuSeparator />
              <MenuSub>
                <MenuSubTrigger>Fast</MenuSubTrigger>
                <ComposerPickerMenuSubPopup>
                  <MenuRadioGroup
                    value={props.fastModeEnabled ? "fast" : "normal"}
                    onValueChange={(value) => {
                      const shouldEnableFast = value === "fast";
                      if (shouldEnableFast === props.fastModeEnabled) return;
                      props.onToggleFastMode();
                    }}
                  >
                    <MenuRadioItem value="normal">Default</MenuRadioItem>
                    <MenuRadioItem value="fast">Fast</MenuRadioItem>
                  </MenuRadioGroup>
                </ComposerPickerMenuSubPopup>
              </MenuSub>
            </>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
    </>
  );
};
