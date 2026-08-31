// FILE: useComposerDropzone.ts
// Purpose: Share composer paste/drop handling for image attachments and file references.
// Layer: Web composer hook
// Exports: useComposerDropzone

import { useEffect, useRef, type ClipboardEvent, type DragEvent } from "react";

import { CHAT_FILE_REFERENCE_DRAG_TYPE } from "~/lib/chatReferences";
import { isDroppedComposerDirectory, splitDroppedComposerFiles } from "~/lib/composerDropPaths";

export interface ComposerDropzoneFileSplit {
  readonly imageFiles: File[];
  readonly genericFiles: File[];
}

export function collectComposerClipboardFiles(
  clipboardData: Pick<DataTransfer, "files" | "items">,
): File[] {
  const files = Array.from(clipboardData.files);
  const seen = new Set(files.map(fileIdentity));
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file") continue;
    try {
      const file = item.getAsFile();
      if (!file || seen.has(fileIdentity(file))) continue;
      files.push(file);
      seen.add(fileIdentity(file));
    } catch {
      continue;
    }
  }
  return files;
}

function fileIdentity(file: File): string {
  return `${file.name}\0${file.size}\0${file.type}\0${file.lastModified}`;
}

export function splitComposerDropzoneFiles(files: Iterable<File>): ComposerDropzoneFileSplit {
  const imageFiles: File[] = [];
  const genericFiles: File[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
    } else {
      genericFiles.push(file);
    }
  }
  return { imageFiles, genericFiles };
}

export type ComposerDropzoneGenericFileMode = "accept" | "reject" | "fallthrough";

export function shouldHandleComposerDropzoneFiles(
  files: ComposerDropzoneFileSplit,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  if (files.imageFiles.length > 0) {
    return true;
  }
  if (files.genericFiles.length > 0) {
    return genericFiles !== "fallthrough";
  }
  return false;
}

export function shouldBlockDisabledComposerDropzoneTransfer(
  disabled: boolean,
  types: readonly string[],
): boolean {
  return disabled && (types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE) || types.includes("Files"));
}

export function shouldResetComposerDropzoneAfterUnhandledFileDrop(
  files: ComposerDropzoneFileSplit,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  return !shouldHandleComposerDropzoneFiles(files, genericFiles);
}

export function shouldPreventDefaultForUnhandledFileDrop(
  files: ComposerDropzoneFileSplit,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  return (
    shouldResetComposerDropzoneAfterUnhandledFileDrop(files, genericFiles) &&
    genericFiles !== "fallthrough"
  );
}

function hasContainsMethod(value: unknown): value is { contains: (target: unknown) => boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "contains" in value &&
    typeof (value as { contains?: unknown }).contains === "function"
  );
}

// Drag events bubble through every child under the bound dropzone. Treat only
// transitions across the dropzone boundary as state changes.
export function isComposerDropzoneInternalDragTransition(
  currentTarget: unknown,
  relatedTarget: unknown,
): boolean {
  if (!relatedTarget || !hasContainsMethod(currentTarget)) {
    return false;
  }
  try {
    return currentTarget.contains(relatedTarget);
  } catch {
    return false;
  }
}

function isComposerHandledDragForMode(
  dataTransfer: DataTransfer,
  genericFiles: ComposerDropzoneGenericFileMode,
): boolean {
  if (dataTransfer.types.includes(CHAT_FILE_REFERENCE_DRAG_TYPE)) {
    return true;
  }
  if (!dataTransfer.types.includes("Files")) {
    return false;
  }
  if (genericFiles !== "fallthrough") {
    return true;
  }
  const items = Array.from(dataTransfer.items);
  if (items.length === 0) {
    return true;
  }
  return items.some(
    (item) =>
      item.kind === "file" && (item.type.startsWith("image/") || isDroppedComposerDirectory(item)),
  );
}

export function useComposerDropzone(input: {
  readonly disabled?: boolean;
  readonly addImages: (files: readonly File[]) => void;
  readonly fileSupport:
    | {
        readonly genericFiles: "accept";
        readonly addFiles: (files: readonly File[]) => void;
      }
    | {
        readonly genericFiles: "reject";
        readonly onUnsupportedFiles: (files: readonly File[]) => void;
      }
    | {
        readonly genericFiles: "fallthrough";
      };
  readonly appendReferenceText?: ((text: string) => void) | undefined;
  /** Absolute paths from desktop OS drops that should become @mentions (folders). */
  readonly appendPathMentions?: ((paths: readonly string[]) => void) | undefined;
  readonly focusComposer?: (() => void) | undefined;
  readonly dragDepthRef?: { current: number } | undefined;
  readonly setIsDragOverComposer: (dragging: boolean) => void;
}) {
  const {
    addImages,
    fileSupport,
    appendReferenceText,
    appendPathMentions,
    disabled = false,
    focusComposer,
    setIsDragOverComposer,
  } = input;
  const internalDragDepthRef = useRef(0);
  const dragDepthRef = input.dragDepthRef ?? internalDragDepthRef;

  const handleSplitFiles = (files: ComposerDropzoneFileSplit): boolean => {
    if (disabled) return false;
    if (!shouldHandleComposerDropzoneFiles(files, fileSupport.genericFiles)) {
      return false;
    }
    if (files.imageFiles.length > 0) {
      addImages(files.imageFiles);
    }
    if (files.genericFiles.length > 0) {
      if (fileSupport.genericFiles === "accept") {
        fileSupport.addFiles(files.genericFiles);
      } else if (fileSupport.genericFiles === "reject") {
        fileSupport.onUnsupportedFiles(files.genericFiles);
      }
    }
    return true;
  };

  const resetComposerDragState = () => {
    writeDragDepth(dragDepthRef, 0);
    setIsDragOverComposer(false);
  };

  const onComposerPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = collectComposerClipboardFiles(event.clipboardData);
    if (disabled) {
      if (files.length > 0) event.preventDefault();
      return;
    }
    const handled = handleSplitFiles(splitComposerDropzoneFiles(files));
    if (handled) event.preventDefault();
  };

  const onComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (shouldBlockDisabledComposerDropzoneTransfer(disabled, event.dataTransfer.types)) {
      event.preventDefault();
      resetComposerDragState();
      return;
    }
    if (!isComposerHandledDragForMode(event.dataTransfer, fileSupport.genericFiles)) return;
    event.preventDefault();
    if (isComposerDropzoneInternalDragTransition(event.currentTarget, event.relatedTarget)) {
      return;
    }
    writeDragDepth(dragDepthRef, 1);
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (shouldBlockDisabledComposerDropzoneTransfer(disabled, event.dataTransfer.types)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "none";
      resetComposerDragState();
      return;
    }
    if (!isComposerHandledDragForMode(event.dataTransfer, fileSupport.genericFiles)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (shouldBlockDisabledComposerDropzoneTransfer(disabled, event.dataTransfer.types)) {
      event.preventDefault();
      resetComposerDragState();
      return;
    }
    if (!isComposerHandledDragForMode(event.dataTransfer, fileSupport.genericFiles)) return;
    event.preventDefault();
    if (isComposerDropzoneInternalDragTransition(event.currentTarget, event.relatedTarget)) {
      return;
    }
    resetComposerDragState();
  };

  const onComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    if (shouldBlockDisabledComposerDropzoneTransfer(disabled, event.dataTransfer.types)) {
      event.preventDefault();
      resetComposerDragState();
      return;
    }
    const referenceText = event.dataTransfer.getData(CHAT_FILE_REFERENCE_DRAG_TYPE);
    if (referenceText) {
      event.preventDefault();
      resetComposerDragState();
      appendReferenceText?.(referenceText);
      return;
    }
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    // Desktop OS drops: resolve absolute paths so folders become @mentions
    // instead of unreadable attachment blobs (#351).
    const dropped = splitDroppedComposerFiles({
      files: event.dataTransfer.files,
      items: event.dataTransfer.items,
    });
    const splitFiles = {
      imageFiles: dropped.imageFiles,
      genericFiles: dropped.genericFiles,
    };
    const hasPathMentions = dropped.pathMentions.length > 0;
    if (
      !hasPathMentions &&
      shouldResetComposerDropzoneAfterUnhandledFileDrop(splitFiles, fileSupport.genericFiles)
    ) {
      if (shouldPreventDefaultForUnhandledFileDrop(splitFiles, fileSupport.genericFiles)) {
        event.preventDefault();
      }
      resetComposerDragState();
      return;
    }
    event.preventDefault();
    resetComposerDragState();
    if (hasPathMentions) {
      appendPathMentions?.(dropped.pathMentions);
    }
    handleSplitFiles(splitFiles);
    focusComposer?.();
  };

  useEffect(() => {
    if (!disabled) return;
    writeDragDepth(dragDepthRef, 0);
    setIsDragOverComposer(false);
  }, [disabled, dragDepthRef, setIsDragOverComposer]);

  return {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    resetComposerDragState,
  };
}

// The drag-depth cell is a caller-shared mutable counter (a ref in spirit,
// but typed as a plain object across component boundaries). Writing it via a
// module helper states that contract explicitly and keeps the mutation out of
// the compiled hook body, which React Compiler would otherwise reject as an
// argument mutation.
function writeDragDepth(depth: { current: number }, value: number): void {
  depth.current = value;
}
