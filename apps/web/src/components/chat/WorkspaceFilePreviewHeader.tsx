// FILE: WorkspaceFilePreviewHeader.tsx
// Purpose: Editor-style header for the shared workspace file preview — a path
//          breadcrumb (project › …dirs › file) on the left, and an overflow
//          menu + "Open in editor" split button on the right. Shared by the
//          right-dock file/explorer panes and the editor center pane so every
//          surface reads identically. Under width pressure the breadcrumb
//          collapses whole middle directories behind a single "…" crumb
//          (never letter-shards like "S… › O…"), keeping the nearest parent
//          folders and the filename readable; only once every directory is
//          hidden does the filename itself truncate. The header is a
//          `header-actions` inline-size query container so the "Open" control
//          sheds its text label for an icon as the pane narrows.
// Layer: Chat/editor file-preview UI
// Exports: WorkspaceFilePreviewHeader

import { isWorkspaceRelativePathSafe, joinWorkspaceRelativePath } from "@synara/shared/path";
import { Fragment, useLayoutEffect, useRef, useState } from "react";

import { basenameOfPath } from "~/file-icons";
import { useCopyFileContentsToClipboard, useCopyPathToClipboard } from "~/hooks/useCopyToClipboard";
import type { ChatFileReference } from "~/lib/chatReferences";
import { ChevronRightIcon, CodeIcon, CopyIcon, EllipsisIcon, EyeOpenIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, ChatHeaderIconButton } from "./chatHeaderControls";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { OpenInPicker } from "./OpenInPicker";
import {
  calculateBreadcrumbLayout,
  type CollapsedBreadcrumbLayout,
} from "./workspaceFilePreviewBreadcrumb";

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
  /**
   * Text contents of the previewed file, enabling the overflow menu's
   * "Copy contents" action. Null when no text is loaded (binary previews,
   * pending/failed reads).
   */
  contentsForCopy?: string | null;
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
// Icon-only by design: the title tooltip + sr-only text carry the labels.
const MARKDOWN_VIEW_SEGMENTS = [
  {
    rendered: false,
    label: "Source",
    title: "Source view — select text to reference exact lines in chat",
    Icon: CodeIcon,
  },
  {
    rendered: true,
    label: "Preview",
    title: "Rendered preview — browse and toggle task lists",
    Icon: EyeOpenIcon,
  },
] as const;

interface BreadcrumbSegment {
  name: string;
  key: string;
}

// Reserved room for the unsaved-changes dot after the filename (size-1.5 dot
// + ml-1.5 gap), plus a small epsilon absorbing fractional-width rounding.
const DIRTY_DOT_RESERVE_PX = 12;
const MEASURE_EPSILON_PX = 1;

/**
 * Breadcrumb that collapses whole middle directories behind a single "…"
 * crumb when the row runs out of room, instead of letting every crumb
 * truncate into unreadable letter-shards. A hidden mirror of the full path
 * is measured (ResizeObserver keeps it honest across pane resizes and late
 * font loads) to decide how many trailing directories still fit next to the
 * filename; the filename itself only truncates once no directory fits.
 */
function CollapsingPathBreadcrumb(props: {
  prefixSegments: BreadcrumbSegment[];
  fileSegment: string;
  filePath: string;
  dirty: boolean;
}) {
  const { prefixSegments, fileSegment, filePath, dirty } = props;
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLSpanElement>(null);
  const [collapsedLayout, setCollapsedLayout] = useState<CollapsedBreadcrumbLayout | null>(null);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    const file = fileRef.current;
    if (!nav || !measure || !file) {
      return;
    }

    const compute = () => {
      const crumbWidths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-measure="crumb"]'),
        (crumb) => crumb.getBoundingClientRect().width,
      );
      const ellipsisWidth =
        measure.querySelector<HTMLElement>('[data-measure="ellipsis"]')?.getBoundingClientRect()
          .width ?? 0;
      const nextLayout = calculateBreadcrumbLayout({
        containerWidth: nav.clientWidth,
        renderedFileWidth: file.getBoundingClientRect().width,
        prefixWidths: crumbWidths,
        ellipsisWidth,
        trailingReserveWidth: (dirty ? DIRTY_DOT_RESERVE_PX : 0) + MEASURE_EPSILON_PX,
      });
      // Keep the previous state object when nothing changed so resize frames
      // that land on the same layout skip the re-render entirely.
      setCollapsedLayout((current) => {
        if (current === nextLayout) return current;
        if (current === null || nextLayout === null) return nextLayout;
        return current.visibleTail === nextLayout.visibleTail &&
          current.showEllipsis === nextLayout.showEllipsis
          ? current
          : nextLayout;
      });
    };

    compute();
    // Observing the hidden mirror too re-measures when its natural width
    // changes without a pane resize (late-loading fonts, new file path).
    const observer = new ResizeObserver(compute);
    observer.observe(nav);
    observer.observe(measure);
    observer.observe(file);
    return () => observer.disconnect();
  }, [filePath, prefixSegments.length, dirty]);

  const visiblePrefix =
    collapsedLayout === null
      ? prefixSegments
      : prefixSegments.slice(prefixSegments.length - collapsedLayout.visibleTail);
  const showEllipsisCrumb =
    collapsedLayout !== null &&
    collapsedLayout.showEllipsis &&
    visiblePrefix.length < prefixSegments.length;

  const crumbChevron = (
    <ChevronRightIcon
      aria-hidden="true"
      className="mx-0.5 size-3 shrink-0 text-muted-foreground/40"
    />
  );

  return (
    <nav
      ref={navRef}
      aria-label="File path"
      className="relative flex min-w-0 flex-1 items-center overflow-hidden text-[12px] leading-none"
    >
      {/* Hidden mirror of the full breadcrumb at natural width, measured to
          decide how many directories fit. Absolutely positioned so it never
          affects layout; invisible so it never paints. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 flex items-center whitespace-nowrap"
      >
        <span data-measure="ellipsis" className="flex items-center">
          <span>…</span>
          {crumbChevron}
        </span>
        {prefixSegments.map((segment) => (
          <span key={segment.key} data-measure="crumb" className="flex items-center">
            <span>{segment.name}</span>
            {crumbChevron}
          </span>
        ))}
      </div>

      {showEllipsisCrumb ? (
        <span className="flex shrink-0 items-center" title={filePath}>
          <span className="text-muted-foreground/80">…</span>
          {crumbChevron}
        </span>
      ) : null}
      {visiblePrefix.map((segment) => (
        <Fragment key={segment.key}>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground/80">
            {segment.name}
          </span>
          {crumbChevron}
        </Fragment>
      ))}
      <span
        ref={fileRef}
        className="min-w-0 shrink truncate font-medium text-foreground"
        title={filePath}
      >
        {fileSegment}
      </span>
      {dirty ? (
        <span
          className="ml-1.5 size-1.5 shrink-0 rounded-full bg-foreground/75"
          role="status"
          aria-label="Unsaved changes"
          title="Unsaved changes"
        />
      ) : null}
    </nav>
  );
}

export const WorkspaceFilePreviewHeader = function WorkspaceFilePreviewHeader(
  props: WorkspaceFilePreviewHeaderProps,
) {
  const { filePath, workspaceRoot } = props;

  // Out-of-workspace previews (e.g. a session's scratch directory under the
  // OS temp dir) arrive as absolute paths; everything in-workspace is relative.
  const fileIsOutsideWorkspace = !isWorkspaceRelativePathSafe(filePath);

  // Breadcrumb segments: project folder name, then each path part. Splitting
  // here (vs. rendering the raw string) lets middle directories collapse
  // behind a "…" crumb under width pressure while the filename stays pinned.
  // Absolute paths drop the project prefix — they live outside the workspace.
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

  const { onReferenceInChat, onAskWhyInChat, contentsForCopy } = props;
  const referenceWholeFile = () => {
    onReferenceInChat?.({ path: filePath });
  };
  const askWhyWholeFile = () => {
    onAskWhyInChat?.({ path: filePath });
  };
  const copyFileContents = useCopyFileContentsToClipboard();
  const copyPathToClipboard = useCopyPathToClipboard();

  const canCopyContents = contentsForCopy != null;
  const openInTarget =
    fileIsOutsideWorkspace || !workspaceRoot
      ? filePath
      : joinWorkspaceRelativePath(workspaceRoot, filePath);

  return (
    <div
      className={cn(
        "@container/header-actions flex h-10 w-full shrink-0 items-center gap-2 px-3",
        CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
      )}
    >
      <CollapsingPathBreadcrumb
        prefixSegments={prefixSegments}
        fileSegment={fileSegment}
        filePath={filePath}
        dirty={props.dirty ?? false}
      />

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
                    "flex h-6 w-7 cursor-pointer items-center justify-center rounded-md transition-colors",
                    selected
                      ? "bg-[var(--color-background-button-secondary)] text-[var(--color-text-foreground)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => props.onMarkdownPreviewChange(segment.rendered)}
                >
                  <segment.Icon className="size-3.5 shrink-0" />
                  <span className="sr-only">{segment.label}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        <Menu>
          <MenuTrigger render={<ChatHeaderIconButton label="More actions" tone="plain" />}>
            <EllipsisIcon aria-hidden="true" className="size-3.5" />
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" side="bottom" className="w-52 min-w-52">
            <MenuItem onClick={() => copyPathToClipboard(openInTarget)}>
              <CopyIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span>Copy path</span>
            </MenuItem>
            {canCopyContents ? (
              <MenuItem
                onClick={() =>
                  copyFileContents(contentsForCopy ?? "", fileSegment, {
                    partial: props.truncated ?? false,
                  })
                }
              >
                Copy contents
              </MenuItem>
            ) : null}
            {onReferenceInChat ? (
              <MenuItem onClick={referenceWholeFile}>Reference in chat</MenuItem>
            ) : null}
            {onAskWhyInChat ? (
              <MenuItem onClick={askWhyWholeFile}>Ask why this changed</MenuItem>
            ) : null}
          </ComposerPickerMenuPopup>
        </Menu>

        {/* Responsive (default) mode: the "Open" label rides the same
            `header-actions` container declared on this header, so it shows on a
            wide pane and collapses to the editor icon when the pane is narrow. */}
        <OpenInPicker openInTarget={openInTarget} />
      </div>
    </div>
  );
};
