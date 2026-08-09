import * as React from "react";

import { toastManager } from "../components/ui/toast";

function fallbackCopyTextToClipboard(value: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const activeElement =
    typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const selection = document.getSelection();
  const savedRanges =
    selection == null
      ? []
      : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));
  const textarea = document.createElement("textarea");

  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } finally {
    textarea.remove();

    if (selection) {
      selection.removeAllRanges();
      for (const range of savedRanges) {
        selection.addRange(range);
      }
    }

    activeElement?.focus();
  }
}

export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("Clipboard API unavailable.");
  }

  if (!value) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      if (fallbackCopyTextToClipboard(value)) {
        return;
      }
      throw error;
    }
  }

  if (fallbackCopyTextToClipboard(value)) {
    return;
  }

  throw new Error("Clipboard API unavailable.");
}

export function useCopyToClipboard<TContext = void>({
  timeout: timeoutProp,
  onCopy,
  onError,
}: {
  timeout?: number;
  onCopy?: (ctx: TContext) => void;
  onError?: (error: Error, ctx: TContext) => void;
} = {}): { copyToClipboard: (value: string, ctx: TContext) => void; isCopied: boolean } {
  const timeout = timeoutProp ?? 2000;
  const [isCopied, setIsCopied] = React.useState(false);
  const timeoutIdRef = React.useRef<NodeJS.Timeout | null>(null);
  const onCopyRef = React.useRef(onCopy);
  const onErrorRef = React.useRef(onError);
  const timeoutRef = React.useRef(timeout);

  // Mirrored in an effect (not during render) so the hook stays eligible for
  // React Compiler; copyToClipboard only runs from post-commit user events.
  React.useEffect(() => {
    onCopyRef.current = onCopy;
    onErrorRef.current = onError;
    timeoutRef.current = timeout;
  }, [onCopy, onError, timeout]);

  const copyToClipboard = React.useCallback((value: string, ctx: TContext): void => {
    void copyTextToClipboard(value).then(
      () => {
        if (timeoutIdRef.current) {
          clearTimeout(timeoutIdRef.current);
        }
        setIsCopied(true);

        onCopyRef.current?.(ctx);

        if (timeoutRef.current !== 0) {
          timeoutIdRef.current = setTimeout(() => {
            setIsCopied(false);
            timeoutIdRef.current = null;
          }, timeoutRef.current);
        }
      },
      (error) => {
        if (onErrorRef.current) {
          onErrorRef.current(error, ctx);
        } else {
          console.error(error);
        }
      },
    );
  }, []);

  // Cleanup timeout on unmount
  React.useEffect(() => {
    return (): void => {
      if (timeoutIdRef.current) {
        clearTimeout(timeoutIdRef.current);
      }
    };
  }, []);

  return { copyToClipboard, isCopied };
}

interface CopyToastLabels {
  successTitle: string;
  /** Shown under the success title — usually the thing that was copied. */
  successDescription: string;
  errorTitle: string;
}

/**
 * Shared "copy + toast" plumbing behind every copy-X convenience hook below:
 * one success/error toast shape, one place to change it.
 */
function useCopyWithToasts(): (value: string, labels: CopyToastLabels) => void {
  const { copyToClipboard } = useCopyToClipboard<CopyToastLabels>({
    onCopy: (labels) =>
      toastManager.add({
        type: "success",
        title: labels.successTitle,
        description: labels.successDescription,
      }),
    onError: (error, labels) =>
      toastManager.add({
        type: "error",
        title: labels.errorTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });
  return copyToClipboard;
}

/**
 * Copy a filesystem path and surface the shared success/error toast. Single source
 * of truth for the "Path copied" affordance used by the sidebar and the kanban board.
 */
export function useCopyPathToClipboard(): (path: string) => void {
  const copy = useCopyWithToasts();
  return (path: string) =>
    copy(path, {
      successTitle: "Path copied",
      successDescription: path,
      errorTitle: "Failed to copy path",
    });
}

/**
 * Copy a previewed file's text contents and surface the shared success/error
 * toast. Single source of truth for the "Copy contents" affordance in the
 * file-preview header's overflow menu. Empty files get an informational toast
 * instead of a copy (the clipboard helper never writes empty strings), and
 * `partial: true` (large files whose preview holds a truncated read) is called
 * out so the success toast never claims more than what was copied.
 */
export function useCopyFileContentsToClipboard(): (
  contents: string,
  fileName: string,
  options?: { partial?: boolean },
) => void {
  const copy = useCopyWithToasts();
  return (contents: string, fileName: string, options?: { partial?: boolean }) => {
    if (contents.length === 0) {
      toastManager.add({ type: "info", title: "Nothing to copy", description: "File is empty" });
      return;
    }
    copy(
      contents,
      options?.partial
        ? {
            successTitle: "Partial contents copied",
            successDescription: "Large file — only the loaded part was copied",
            errorTitle: "Failed to copy contents",
          }
        : {
            successTitle: "Contents copied",
            successDescription: fileName,
            errorTitle: "Failed to copy contents",
          },
    );
  };
}

/** Copy a thread id and surface the shared "Thread ID copied" toast. */
export function useCopyThreadIdToClipboard(): (threadId: string) => void {
  const copy = useCopyWithToasts();
  return (threadId: string) =>
    copy(threadId, {
      successTitle: "Thread ID copied",
      successDescription: threadId,
      errorTitle: "Failed to copy thread ID",
    });
}
