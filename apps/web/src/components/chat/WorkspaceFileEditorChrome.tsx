import { Fragment, type ReactNode } from "react";

import { basenameOfPath } from "~/file-icons";
import {
  ChevronRightIcon,
  Redo2Icon,
  RotateCcwIcon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from "~/lib/icons";
import type { CodeEditHistoryState } from "~/components/codeEditor/pierreEdit";
import { cn } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, ChatHeaderIconButton } from "./chatHeaderControls";

export function workspaceFileEditorBreadcrumbSegments(
  workspaceRoot: string | null,
  filePath: string,
): { prefixSegments: ReadonlyArray<{ name: string; key: string }>; fileSegment: string } {
  const projectName = workspaceRoot ? basenameOfPath(workspaceRoot) : null;
  const relativeSegments = filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  const segments = projectName ? [projectName, ...relativeSegments] : relativeSegments;
  return {
    prefixSegments: segments.slice(0, -1).map((name, index) => ({
      name,
      key: segments.slice(0, index + 1).join("/"),
    })),
    fileSegment: segments.at(-1) ?? filePath,
  };
}

interface WorkspaceFileEditorHistoryActionsProps {
  history: CodeEditHistoryState;
  canRevert: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onRevert: () => void;
}

export function WorkspaceFileEditorHistoryActions(props: WorkspaceFileEditorHistoryActionsProps) {
  return (
    <>
      <ChatHeaderIconButton
        type="button"
        tone="plain"
        label="Undo"
        title="Undo"
        disabled={!props.history.canUndo}
        onClick={props.onUndo}
      >
        <Undo2Icon aria-hidden="true" className="size-3.5" />
      </ChatHeaderIconButton>
      <ChatHeaderIconButton
        type="button"
        tone="plain"
        label="Redo"
        title="Redo"
        disabled={!props.history.canRedo}
        onClick={props.onRedo}
      >
        <Redo2Icon aria-hidden="true" className="size-3.5" />
      </ChatHeaderIconButton>
      <ChatHeaderIconButton
        type="button"
        tone="plain"
        label="Revert all changes"
        title="Revert all changes"
        disabled={!props.canRevert}
        onClick={props.onRevert}
      >
        <RotateCcwIcon aria-hidden="true" className="size-3.5" />
      </ChatHeaderIconButton>
    </>
  );
}

interface WorkspaceFileEditorHeaderProps {
  workspaceRoot: string | null;
  filePath: string;
  title: string;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  actions?: ReactNode;
  onSave: () => void;
  onClose: () => void;
}

export function WorkspaceFileEditorHeader(props: WorkspaceFileEditorHeaderProps) {
  const { fileSegment, prefixSegments } = workspaceFileEditorBreadcrumbSegments(
    props.workspaceRoot,
    props.filePath,
  );

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
        <span
          className="min-w-0 shrink truncate font-medium text-foreground"
          title={props.filePath}
        >
          {fileSegment}
        </span>
        {props.dirty ? (
          <span
            aria-label="Unsaved changes"
            title="Unsaved changes"
            className="ml-2 size-1.5 shrink-0 rounded-full bg-[var(--color-text-accent)]"
          />
        ) : null}
      </nav>

      <span className="shrink-0 text-[11px] text-muted-foreground/70">{props.title}</span>

      <div className="flex shrink-0 items-center gap-1.5">
        {props.actions}
        <Button
          type="button"
          size="xs"
          variant="chrome-outline"
          className="!h-7 shrink-0 rounded-lg"
          disabled={!props.canSave || props.saving}
          onClick={props.onSave}
        >
          {props.saving ? "Saving..." : "Save"}
        </Button>
        <ChatHeaderIconButton
          type="button"
          tone="plain"
          label="Close editor"
          title="Close editor"
          onClick={props.onClose}
        >
          <XIcon aria-hidden="true" className="size-3.5" />
        </ChatHeaderIconButton>
      </div>
    </div>
  );
}

interface WorkspaceFileEditorDiscardDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function WorkspaceFileEditorDiscardDialog(props: WorkspaceFileEditorDiscardDialogProps) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" size="sm" />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" size="sm" onClick={props.onConfirm}>
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

interface WorkspaceFileEditorConflictBarProps {
  message: string;
  conflict: boolean;
  onReload: () => void;
  onOverwrite: () => void;
  onDismiss: () => void;
}

export function WorkspaceFileEditorConflictBar(props: WorkspaceFileEditorConflictBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-[var(--color-background-elevated-secondary)] px-3 py-1.5">
      <TriangleAlertIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-[var(--color-warning)]"
      />
      <p className="min-w-0 flex-1 truncate text-[11px] text-foreground/85" title={props.message}>
        {props.message}
      </p>
      {props.conflict ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="chrome-outline"
            className="!h-6 shrink-0 rounded-md text-[11px]"
            onClick={props.onReload}
          >
            Reload from disk
          </Button>
          <Button
            type="button"
            size="xs"
            variant="chrome-outline"
            className="!h-6 shrink-0 rounded-md text-[11px]"
            onClick={props.onOverwrite}
          >
            Overwrite
          </Button>
        </>
      ) : null}
      <ChatHeaderIconButton
        type="button"
        tone="plain"
        label="Dismiss"
        title="Dismiss"
        className="!size-6"
        onClick={props.onDismiss}
      >
        <XIcon aria-hidden="true" className="size-3" />
      </ChatHeaderIconButton>
    </div>
  );
}
