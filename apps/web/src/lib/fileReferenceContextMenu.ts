// FILE: fileReferenceContextMenu.ts
// Purpose: Right-click menu shared by file rows, file previews, and chat file
//          links (editor explorer, changed-file lists, dock file pane).
// Layer: Web UI helpers
// Exports: showFileReferenceContextMenu, getRevealInFolderLabel

import { formatSelectionLabel, type ChatFileReference } from "~/lib/chatReferences";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

export function getRevealInFolderLabel(platform: string): string {
  if (isWindowsPlatform(platform)) {
    return "Open in Explorer";
  }
  if (isMacPlatform(platform)) {
    return "Reveal in Finder";
  }
  return "Show in folder";
}

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
export async function showFileReferenceContextMenu(input: {
  path: string;
  /** Absolute path to reveal in the platform file manager. Omit when the
   * surface only knows a repository-relative path. */
  revealPath?: string;
  position: { x: number; y: number };
  /** Line/column range from source views, or a quoted snippet from surfaces
   * without stable source lines (rendered markdown preview). */
  selection?: Omit<ChatFileReference, "path"> | null;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const revealPath =
    input.revealPath && typeof window !== "undefined" && window.desktopBridge
      ? input.revealPath
      : undefined;
  const reference: ChatFileReference = {
    path: input.path,
    ...input.selection,
  };
  const rangeLabel = formatSelectionLabel(reference);
  const hasSnippet = typeof reference.snippet === "string" && reference.snippet.trim().length > 0;
  const clicked = await api.contextMenu.show(
    [
      ...(input.onReferenceInChat
        ? [
            {
              id: "reference-in-chat" as const,
              label: rangeLabel
                ? `Reference ${rangeLabel} in chat`
                : hasSnippet
                  ? "Reference selection in chat"
                  : "Reference in chat",
            },
          ]
        : []),
      ...(input.onAskWhyInChat
        ? [
            {
              id: "ask-why-in-chat" as const,
              label: rangeLabel ? `Ask why ${rangeLabel} changed` : "Ask why this changed",
            },
          ]
        : []),
      ...(revealPath
        ? [
            {
              id: "reveal-in-folder" as const,
              label: getRevealInFolderLabel(getNavigatorPlatform()),
            },
          ]
        : []),
      { id: "copy-path" as const, label: "Copy path" },
    ],
    input.position,
  );
  if (clicked === "reference-in-chat") {
    input.onReferenceInChat?.(reference);
    return;
  }
  if (clicked === "ask-why-in-chat") {
    input.onAskWhyInChat?.(reference);
    return;
  }
  if (clicked === "reveal-in-folder" && revealPath) {
    try {
      await api.shell.showInFolder(revealPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to reveal file",
        description:
          error instanceof Error ? error.message : "An unknown error occurred opening the file.",
      });
    }
    return;
  }
  if (clicked === "copy-path") {
    await copyTextToClipboard(input.path);
  }
}
