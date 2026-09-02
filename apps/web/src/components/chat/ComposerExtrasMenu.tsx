// FILE: ComposerExtrasMenu.tsx
// Purpose: Hosts the composer `+` menu for attachments and quick composer mode toggles.
// Layer: Chat composer presentation
// Depends on: shared menu primitives, icon buttons, and caller-owned composer state callbacks.

import type {
  DesktopAppSnapState,
  DesktopAppSnapWindowEntry,
  ProviderInteractionMode,
  ThreadId,
} from "@synara/contracts";
import { useId, useRef, useState, type ChangeEvent } from "react";

import { insertAppSnapCaptureIntoDraft } from "~/appSnapIntake";
import {
  BugIcon,
  ListTodoIcon,
  MessageCircleIcon,
  PaperclipIcon,
  PlusIcon,
  WindowIcon,
} from "~/lib/icons";
import { toastManager } from "../ui/toast";
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

const APP_SNAP_MAX_WINDOWS_HEIGHT_CLASS = "max-h-80 overflow-y-auto";

function AppSnapWindowRowContent(props: { window: DesktopAppSnapWindowEntry }) {
  const appName = props.window.appName?.trim() || "Captured app";
  const windowTitle = props.window.windowTitle?.trim() || null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {props.window.appIconDataUrl ? (
        <img src={props.window.appIconDataUrl} alt="" className="size-4 shrink-0 rounded-[4px]" />
      ) : (
        <WindowIcon className="size-4 shrink-0" />
      )}
      <span className="min-w-0">
        <span className="block truncate">{appName}</span>
        {windowTitle ? (
          <span className="block truncate text-xs text-muted-foreground">{windowTitle}</span>
        ) : null}
      </span>
    </span>
  );
}

export const ComposerExtrasMenu = function ComposerExtrasMenu(props: {
  interactionMode: ProviderInteractionMode;
  supportsFastMode: boolean;
  fastModeEnabled: boolean;
  threadId?: ThreadId;
  onAddAttachments: (files: File[]) => void;
  onToggleFastMode: () => void;
  onInteractionModeChange: (mode: ProviderInteractionMode) => void;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const appSnapRequestIdRef = useRef(0);
  const [appSnapSubmenuOpen, setAppSnapSubmenuOpen] = useState(false);
  const [appSnapWindows, setAppSnapWindows] = useState<DesktopAppSnapWindowEntry[] | null>(null);
  const [appSnapState, setAppSnapState] = useState<DesktopAppSnapState | null>(null);
  const [appSnapError, setAppSnapError] = useState<string | null>(null);
  const [appSnapBusy, setAppSnapBusy] = useState(false);

  const appSnapBridge = window.desktopBridge?.appSnap;
  const appSnapAvailable = Boolean(props.threadId && appSnapBridge);

  const loadAppSnapWindows = () => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    const requestId = ++appSnapRequestIdRef.current;
    setAppSnapWindows(null);
    setAppSnapError(null);
    setAppSnapState(null);
    void Promise.all([bridge.getState(), bridge.listWindows()])
      .then(([state, windows]) => {
        if (appSnapRequestIdRef.current !== requestId) return;
        setAppSnapState(state);
        setAppSnapWindows(windows);
      })
      .catch((error) => {
        if (appSnapRequestIdRef.current !== requestId) return;
        setAppSnapError(error instanceof Error ? error.message : "Could not list windows.");
      });
  };

  const captureAppSnapWindow = (windowId: number) => {
    const bridge = window.desktopBridge?.appSnap;
    const threadId = props.threadId;
    if (!bridge || !threadId || appSnapBusy) return;
    setAppSnapBusy(true);
    void bridge
      .captureWindow({ windowId })
      .then(async (capture) => {
        const result = await insertAppSnapCaptureIntoDraft(threadId, capture);
        toastManager.add({
          type: result === "unverified" ? "warning" : "success",
          title: result === "unverified" ? "AppSnap added with a warning" : "AppSnap added",
          description:
            result === "unverified"
              ? "The capture is attached, but Synara could not verify its draft metadata. If it is missing after a reload, Synara will attach it again."
              : "The window was added to this composer.",
          data: { allowCrossThreadVisibility: true },
        });
        await bridge.acknowledgeCapture(capture.id).catch(() => undefined);
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "AppSnap failed",
          description: error instanceof Error ? error.message : "Could not capture the window.",
          data: { allowCrossThreadVisibility: true },
        });
      })
      .finally(() => {
        setAppSnapBusy(false);
      });
  };

  // Reset the hidden input so selecting the same file twice still emits a change event.
  const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      props.onAddAttachments(files);
    }
    event.target.value = "";
  };

  const appSnapListening = appSnapState?.status === "ready";

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

          {appSnapAvailable ? (
            <MenuSub
              onOpenChange={(open) => {
                setAppSnapSubmenuOpen(open);
                if (open) loadAppSnapWindows();
              }}
            >
              <MenuSubTrigger>
                <WindowIcon className="size-4 shrink-0" />
                Attach window
              </MenuSubTrigger>
              <ComposerPickerMenuSubPopup className={APP_SNAP_MAX_WINDOWS_HEIGHT_CLASS}>
                {appSnapSubmenuOpen ? (
                  appSnapError ? (
                    <MenuItem disabled>{appSnapError}</MenuItem>
                  ) : appSnapState && !appSnapListening ? (
                    <MenuItem disabled>Enable AppSnap in Settings</MenuItem>
                  ) : appSnapWindows === null ? (
                    <MenuItem disabled>Loading windows…</MenuItem>
                  ) : appSnapWindows.length === 0 ? (
                    <MenuItem disabled>No other app windows are visible.</MenuItem>
                  ) : (
                    appSnapWindows.map((window) => (
                      <MenuItem
                        key={window.windowId}
                        disabled={appSnapBusy}
                        onClick={() => {
                          captureAppSnapWindow(window.windowId);
                        }}
                      >
                        <AppSnapWindowRowContent window={window} />
                      </MenuItem>
                    ))
                  )
                ) : null}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
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
