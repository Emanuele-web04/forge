// FILE: rightDockPaneMeta.tsx
// Purpose: Shared semantic metadata (icon + label) for right-dock pane kinds.
// Layer: Chat right-dock UI primitives
// Exports: per-kind meta map, ordered add-menu kinds, and pane label/icon resolvers.

import type { ReactNode } from "react";

import type { LucideIcon } from "~/lib/icons";
import {
  DiffIcon,
  FileIcon,
  FoldersIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GlobeIcon,
  InfoIcon,
  MessageCircleIcon,
  TerminalIcon,
} from "~/lib/icons";
import {
  RIGHT_DOCK_PANE_KINDS,
  type RightDockPane,
  type RightDockPaneKind,
} from "~/rightDockStore.logic";
import { CHAT_SURFACE_CHIP_ICON_CLASS_NAME, SurfaceChipIcon } from "./chatHeaderControls";
import { FileEntryIcon } from "./FileEntryIcon";

export interface RightDockPaneMeta {
  label: string;
  Icon: LucideIcon;
}

export interface RightDockLauncherItem extends RightDockPaneMeta {
  kind: RightDockPaneKind;
}

export const RIGHT_DOCK_PANE_META: Record<RightDockPaneKind, RightDockPaneMeta> = {
  browser: { label: "Browser", Icon: GlobeIcon },
  diff: { label: "Diff", Icon: DiffIcon },
  explorer: { label: "Explorer", Icon: FoldersIcon },
  file: { label: "File", Icon: FileIcon },
  terminal: { label: "Terminal", Icon: TerminalIcon },
  sidechat: { label: "Side chats", Icon: MessageCircleIcon },
  git: { label: "Git", Icon: GitCommitIcon },
  pullRequest: { label: "Pull request", Icon: GitPullRequestIcon },
};

// Neutral fallback for any pane kind we no longer recognize (e.g. stale
// persisted state). Persisted dock state is sanitized on rehydrate, so this is
// only a defensive guard to keep a single bad pane from crashing render.
const FALLBACK_RIGHT_DOCK_PANE_META: RightDockPaneMeta = {
  label: "Panel",
  Icon: InfoIcon,
};

// Always resolve pane meta through this helper instead of indexing the map
// directly, so an unknown kind degrades gracefully rather than throwing.
export function getRightDockPaneMeta(kind: RightDockPaneKind): RightDockPaneMeta {
  return RIGHT_DOCK_PANE_META[kind] ?? FALLBACK_RIGHT_DOCK_PANE_META;
}

// Add-menu / quick triggers follow the canonical kind order from the single
// source of truth, so they stay in sync as kinds are added or removed. The
// "file" kind is intentionally excluded: single-file preview tabs are opened by
// clicking a file reference in chat, while the add menu offers the richer
// "explorer" pane (file tree + search + viewer) in its place.
export const RIGHT_DOCK_ADD_MENU_KINDS: readonly RightDockPaneKind[] = RIGHT_DOCK_PANE_KINDS.filter(
  (kind) => kind !== "file" && kind !== "pullRequest",
);

// Empty-dock launchers prioritize the everyday workspace tools. Review only
// appears when the selected diff scope contains changes, Git is gated by
// repository discovery, and Explorer needs a concrete workspace. Context-only
// file and pull-request panes continue to open from their owning surfaces.
const RIGHT_DOCK_LAUNCHER_ORDER: readonly RightDockPaneKind[] = [
  "diff",
  "terminal",
  "browser",
  "explorer",
  "sidechat",
  "git",
];

const RIGHT_DOCK_LAUNCHER_LABELS: Partial<Record<RightDockPaneKind, string>> = {
  diff: "Review",
  explorer: "Files",
  sidechat: "Side chats",
  git: "Source control",
};

export function resolveRightDockLauncherItems(input: {
  hasWorkspace: boolean;
  hasGitRepository: boolean;
  hasReview: boolean;
}): readonly RightDockLauncherItem[] {
  return RIGHT_DOCK_LAUNCHER_ORDER.flatMap((kind) => {
    if (kind === "diff" && !input.hasReview) {
      return [];
    }
    if (kind === "git" && !input.hasGitRepository) {
      return [];
    }
    if (kind === "explorer" && !input.hasWorkspace) {
      return [];
    }
    const meta = getRightDockPaneMeta(kind);
    return [
      {
        kind,
        Icon: meta.Icon,
        label: RIGHT_DOCK_LAUNCHER_LABELS[kind] ?? meta.label,
      },
    ];
  });
}

// Resolves a tab label, preferring caller-provided per-pane overrides (e.g. the
// embedded sidechat thread title) before falling back to the kind label.
export function resolveRightDockPaneLabel(
  pane: RightDockPane,
  overrides?: Record<string, string | undefined>,
): string {
  return overrides?.[pane.id] ?? getRightDockPaneMeta(pane.kind).label;
}

// Resolves a tab glyph: file panes show the per-file-type icon (matching the
// pane header and explorer rows), every other pane uses its kind icon. The file
// glyph inherits the tab's muted foreground color (colorMode="inherit") instead
// of its extension color, so dock tabs read like the changed-file rows rather
// than carrying a loud per-type tint.
export function resolveRightDockPaneIcon(pane: RightDockPane): ReactNode {
  if (pane.kind === "file" && pane.filePath) {
    return (
      <FileEntryIcon
        pathValue={pane.filePath}
        kind="file"
        colorMode="inherit"
        className={CHAT_SURFACE_CHIP_ICON_CLASS_NAME}
      />
    );
  }
  return <SurfaceChipIcon icon={getRightDockPaneMeta(pane.kind).Icon} />;
}
