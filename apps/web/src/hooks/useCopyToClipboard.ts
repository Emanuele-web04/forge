import * as React from "react";

import { toastManager } from "../components/ui/toast";
import { buildThreadLinkUrl } from "../lib/threadLink";

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

/**
 * Copy a filesystem path and surface the shared success/error toast. Single source
 * of truth for the "Path copied" affordance used by the sidebar and the kanban board.
 */
export function useCopyPathToClipboard(): (path: string) => void {
  const { copyToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });
  return (path: string) => copyToClipboard(path, { path });
}

/** Copy a thread id and surface the shared "Thread ID copied" toast. */
export function useCopyThreadIdToClipboard(): (threadId: string) => void {
  const { copyToClipboard } = useCopyToClipboard<{ threadId: string }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Thread ID copied", description: ctx.threadId }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });
  return (threadId: string) => copyToClipboard(threadId, { threadId });
}

/** Copy a browser-openable thread URL (Codex-style "Copy link"). */
export function useCopyThreadLinkToClipboard(): (threadId: string) => void {
  const { copyToClipboard } = useCopyToClipboard<{ url: string }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Link copied", description: ctx.url }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Failed to copy link",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });
  return (threadId: string) => {
    try {
      const url = buildThreadLinkUrl(threadId);
      copyToClipboard(url, { url });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to copy link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  };
}
