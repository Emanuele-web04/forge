// FILE: WorkspaceFilePreviewHeader.tsx
// Purpose: Editor-style header for the shared workspace file preview — a path
//          breadcrumb (project › …dirs › file) on the left, and an overflow
//          menu + "Open in editor" split button on the right. Shared by the
//          right-dock file/explorer panes and the editor center pane so every
//          surface reads identically. The header is a `header-actions` inline-size
//          query container, so the breadcrumb collapses dir-first then truncates
//          the filename, and the controls (markdown toggle, "Open") shed their
//          text labels for icons as the pane narrows — no overlap at any width.
// Layer: Chat/editor file-preview UI
// Exports: WorkspaceFilePreviewHeader

import { isWorkspaceRelativePathSafe, joinWorkspaceRelativePath } from "@synara/shared/path";
import { Fragment } from "react";

import { basenameOfPath } from "~/file-icons";
import type { ChatFileReference } from "~/lib/chatReferences";
import { ChevronRightIcon, EllipsisIcon, EyeIcon, FileIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, ChatHeaderIconButton } from "./chatHeaderControls";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { OpenInPicker } from "./OpenInPicker";

interface WorkspaceFilePreviewHeaderProps {
  workspaceRoot: string | null;
  filePath: string;
  /** Markdown files get an inline Source/Preview segmented switcher. */
  isMarkdown: boolean;
  /** True while the rendered preview is shown; false for the source view. */
  markdownPreviewEnabled: boolean;
  onMarkdownPreviewChange: (rendered: boolean) => void;
  /** Whole-file chat actions, surfaced in the overflow menu when wired. */
  onReferenceInChat?: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  /** Shown when the preview only holds a partial read of a large file. */
  truncated?: boolean;
  /** Marks the currently open source buffer as different from its saved version. */
  dirty?: boolean;
  /** Short reason the current source cannot be edited safely. */
  readOnlyReason?: string | null;
}

// Source (raw file, where selecting text yields a precise line/column chat
// reference) vs. Preview (rendered markdown, read-only — browse + task lists).
// Ordered Source-first so the interactive mode reads as the primary surface.
const MARKDOWN_VIEW_SEGMENTS = [
  {
    rendered: false,
    label: "Source",
    title: "Source view — select text to reference exact lines in chat",
    Icon: FileIcon,
  },
  {
    rendered: true,
    label: "Preview",
    title: "Rendered preview — browse and toggle task lists",
    Icon: EyeIcon,
  },
] as const;

export const WorkspaceFilePreviewHeader = function WorkspaceFilePreviewHeader(
  props: WorkspaceFilePreviewHeaderProps,
) {
  const { filePath, workspaceRoot } = props;

  // Out-of-workspace previews (e.g. a session's scratch directory under the
  // OS temp dir) arrive as absolute paths; everything in-workspace is relative.
  const fileIsOutsideWorkspace = !isWorkspaceRelativePathSafe(filePath);

  // Breadcrumb segments: project folder name, then each path part. Splitting
  // here (vs. rendering the raw string) lets the directory prefix collapse
  // first under width pressure while the filename stays pinned. Absolute
  // paths drop the project prefix — they live outside the workspace.
  const projectName =
    fileIsOutsideWorkspace || !workspaceRoot ? null : basenameOfPath(workspaceRoot);
  const relativeSegments = filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  const segments = projectName ? [projectName, ...relativeSegments] : relativeSegments;
  // Key each crumb by its cumulative path so repeated folder names (e.g. two
  // `src` dirs at different depths) still get stable, unique React keys.
  const prefixSegments = segments.slice(0, -1).map((name, index) => ({
    name,
    key: segments.slice(0, index + 1).join("/"),
  }));
  const fileSegment = segments.at(-1) ?? filePath;

  const { onReferenceInChat, onAskWhyInChat } = props;
  const referenceWholeFile = () => {
    onReferenceInChat?.({ path: filePath });
  };
  const askWhyWholeFile = () => {
    onAskWhyInChat?.({ path: filePath });
  };

  const hasChatActions = Boolean(onReferenceInChat || onAskWhyInChat);

  return (
    <div
      className={cn(
        "@container/header-actions flex h-10 w-full shrink-0 items-center gap-2 px-3",
        CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
      )}
    >
      <nav
        aria-label="File path"
        className="flex min-w-0 flex-1 items-center text-[12px] leading-none"
      >
        {/* Dir prefix shrinks far faster than the filename (shrink-[9999]), so under
            width pressure it collapses to nothing before the filename gives up any
            room; only once the prefix is gone does the filename itself truncate.
            This keeps the filename pinned-yet-bounded so it never overflows into the
            controls on its right. */}
        <span className="flex min-w-0 shrink-[9999] items-center overflow-hidden">
          {prefixSegments.map((segment) => (
            <Fragment key={segment.key}>
              <span className="truncate text-muted-foreground/80">{segment.name}</span>
              <ChevronRightIcon
                aria-hidden="true"
                className="mx-0.5 size-3 shrink-0 text-muted-foreground/40"
              />
            </Fragment>
          ))}
        </span>
        <span className="min-w-0 shrink truncate font-medium text-foreground" title={filePath}>
          {fileSegment}
        </span>
        {props.dirty ? (
          <span
            className="ml-1.5 size-1.5 shrink-0 rounded-full bg-foreground/75"
            role="status"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          />
        ) : null}
      </nav>

      {props.truncated ? (
        <span className="hidden shrink-0 text-[10px] text-muted-foreground/70 @sm/header-actions:inline">
          Shown partially
        </span>
      ) : props.readOnlyReason ? (
        <span
          className="hidden max-w-32 shrink-0 truncate text-[10px] text-muted-foreground/70 @sm/header-actions:inline"
          title={props.readOnlyReason}
        >
          Read-only
        </span>
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5">
        {props.isMarkdown ? (
          <div
            role="radiogroup"
            aria-label="Markdown view"
            className="flex h-7 shrink-0 items-center rounded-lg bg-[var(--color-background-elevated-secondary)] p-0.5"
          >
            {MARKDOWN_VIEW_SEGMENTS.map((segment) => {
              const selected = segment.rendered === props.markdownPreviewEnabled;
              return (
                <button
                  key={segment.label}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  title={segment.title}
                  className={cn(
                    "flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
                    selected
                      ? "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => props.onMarkdownPreviewChange(segment.rendered)}
                >
                  <segment.Icon aria-hidden="true" className="size-3.5 shrink-0" />
                  {/* Label collapses to icon-only on a narrow pane; the title +
                      sr-only text keep both modes labelled for a11y/tooltips. */}
                  <span className="sr-only @sm/header-actions:not-sr-only">{segment.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {hasChatActions ? (
          <Menu>
            <MenuTrigger render={<ChatHeaderIconButton label="More actions" tone="plain" />}>
              <EllipsisIcon aria-hidden="true" className="size-3.5" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
              {onReferenceInChat ? (
                <MenuItem onClick={referenceWholeFile}>Reference in chat</MenuItem>
              ) : null}
              {onAskWhyInChat ? (
                <MenuItem onClick={askWhyWholeFile}>Ask why this changed</MenuItem>
              ) : null}
            </ComposerPickerMenuPopup>
          </Menu>
        ) : null}

        {/* Responsive (default) mode: the "Open" label rides the same
            `header-actions` container declared on this header, so it shows on a
            wide pane and collapses to the editor icon when the pane is narrow. */}
        <OpenInPicker
          openInTarget={
            fileIsOutsideWorkspace || !workspaceRoot
              ? filePath
              : joinWorkspaceRelativePath(workspaceRoot, filePath)
          }
        />
      </div>
    </div>
  );
};
