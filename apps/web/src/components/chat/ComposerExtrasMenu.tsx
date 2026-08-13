// FILE: ComposerExtrasMenu.tsx
// Purpose: Hosts the composer `+` menu for attachments and quick composer mode toggles.
// Layer: Chat composer presentation
// Depends on: shared menu primitives, icon buttons, and caller-owned composer state callbacks.

import { type ProviderInteractionMode } from "@synara/contracts";
import { useId, useRef, type ChangeEvent } from "react";

import { BugIcon, ListTodoIcon, MessageCircleIcon, PaperclipIcon, PlusIcon } from "~/lib/icons";
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

export const ComposerExtrasMenu = function ComposerExtrasMenu(props: {
  interactionMode: ProviderInteractionMode;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  onAddAttachments: (files: File[]) => void;
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
