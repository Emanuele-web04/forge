// FILE: editorMetadata.ts
// Purpose: Resolve the shared web-facing labels and icons for supported editors.
// Layer: Web UI metadata
// Exports: editor option builders used by the chat header and open-in picker.

import { EDITORS, type EditorId } from "@synara/contracts";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";
import { createElement, useState } from "react";
import type { Icon } from "./components/Icons";
import {
  AndroidStudioIcon,
  AntigravityIcon,
  CLionIcon,
  CursorIcon,
  DataGripIcon,
  GhosttyIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  JetBrainsIcon,
  OpenCodeIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  SublimeTextIcon,
  TerminalAppIcon,
  VisualStudioCode,
  WarpIcon,
  WebStormIcon,
  WindsurfIcon,
  XcodeIcon,
  Zed,
} from "./components/Icons";
import { FolderClosed } from "./components/FolderClosed";
import { AppsIcon } from "./lib/icons";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";
import { resolveWsHttpUrl } from "./lib/wsHttpUrl";

export interface EditorOption {
  readonly value: EditorId;
  readonly label: string;
  readonly Icon: Icon;
}

const EDITOR_ICONS: Partial<Record<EditorId, Icon>> = {
  cursor: CursorIcon,
  trae: OpenCodeIcon,
  vscode: VisualStudioCode,
  "vscode-insiders": VisualStudioCode,
  vscodium: VisualStudioCode,
  zed: Zed,
  windsurf: WindsurfIcon,
  sublime: SublimeTextIcon,
  antigravity: AntigravityIcon,
  ghostty: GhosttyIcon,
  muxy: TerminalAppIcon,
  terminal: TerminalAppIcon,
  iterm: TerminalAppIcon,
  warp: WarpIcon,
  xcode: XcodeIcon,
  idea: IntelliJIdeaIcon,
  webstorm: WebStormIcon,
  pycharm: PyCharmIcon,
  phpstorm: PhpStormIcon,
  goland: GoLandIcon,
  clion: CLionIcon,
  rider: RiderIcon,
  rubymine: RubyMineIcon,
  datagrip: DataGripIcon,
  rustrover: JetBrainsIcon,
  "android-studio": AndroidStudioIcon,
  // Reuse the sidebar's closed-project folder glyph so "Open in folder" matches.
  "file-manager": FolderClosed,
  "system-default": AppsIcon,
};

const NATIVE_EDITOR_ICON_COMPONENTS = new Map<EditorId, Icon>();

export function resolveEditorNativeIconUrl(editorId: EditorId): string {
  const params = new URLSearchParams({ id: editorId });
  return resolveWsHttpUrl(`${EDITOR_ICON_ROUTE_PATH}?${params.toString()}`);
}

function resolveNativeEditorIcon(editorId: EditorId): Icon {
  const cached = NATIVE_EDITOR_ICON_COMPONENTS.get(editorId);
  if (cached) return cached;

  const FallbackIcon = resolveEditorIcon(editorId);
  const EditorNativeIcon: Icon = ({ className, style, ...props }) => {
    const [failed, setFailed] = useState(false);
    if (failed) {
      return createElement(FallbackIcon, { className, style, ...props });
    }

    return createElement(
      "svg",
      {
        ...props,
        className,
        fill: "none",
        style,
        viewBox: "0 0 1 1",
        xmlns: "http://www.w3.org/2000/svg",
      },
      createElement("image", {
        height: 1,
        href: resolveEditorNativeIconUrl(editorId),
        preserveAspectRatio: "xMidYMid meet",
        width: 1,
        onError: () => setFailed(true),
      }),
    );
  };

  NATIVE_EDITOR_ICON_COMPONENTS.set(editorId, EditorNativeIcon);
  return EditorNativeIcon;
}

// Build labels from the shared catalog so newly supported editors appear without
// duplicating the editor list across multiple UI components.
export function resolveEditorLabel(editorId: EditorId, platform: string): string {
  if (editorId === "file-manager") {
    return isMacPlatform(platform) ? "Finder" : isWindowsPlatform(platform) ? "Explorer" : "Files";
  }

  if (editorId === "system-default") {
    // macOS PDFs open in Preview by default; Windows/Linux use whatever viewer is
    // registered as the system handler, so keep the label generic off-Mac.
    return isMacPlatform(platform) ? "Preview" : "Default app";
  }

  return EDITORS.find((editor) => editor.id === editorId)?.label ?? editorId;
}

// Keep the header/picker resilient even when a brand-specific icon does not exist yet.
export function resolveEditorIcon(editorId: EditorId): Icon {
  return EDITOR_ICONS[editorId] ?? OpenCodeIcon;
}

// Build a single option for an editor id that may not appear in the platform's
// installed-editor catalog (e.g. the always-available "system-default" opener that
// surfaces opt into without it being part of `availableEditors`).
export function resolveEditorOption(editorId: EditorId, platform: string): EditorOption {
  return {
    value: editorId,
    label: resolveEditorLabel(editorId, platform),
    Icon: resolveNativeEditorIcon(editorId),
  };
}

export function resolveAvailableEditorOptions(
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
): ReadonlyArray<EditorOption> {
  const availableEditorIds = new Set(availableEditors);
  return EDITORS.filter((editor) => availableEditorIds.has(editor.id)).map((editor) => ({
    value: editor.id,
    label: resolveEditorLabel(editor.id, platform),
    Icon: resolveNativeEditorIcon(editor.id),
  }));
}
