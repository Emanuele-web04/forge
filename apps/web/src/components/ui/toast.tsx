"use client";

import { Toast, type ToastObject } from "@base-ui/react/toast";
import { useMemo, useEffect, useState, type CSSProperties } from "react";
import { useParams } from "@tanstack/react-router";
import { ThreadId } from "@synara/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "~/lib/icons";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { APP_TOOLTIP_SURFACE_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { buildVisibleToastLayout, shouldHideCollapsedToastContent } from "./toast.logic";
import {
  COMPACT_NOTIFICATION_SURFACE_CLASS_NAME,
  EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
  NOTIFICATION_ICON_CLASS_NAME,
} from "./notificationSurface";
import { useDiffRouteSearch } from "../../hooks/useDiffRouteSearch";
import { selectSplitView, useSplitViewStore } from "../../splitViewStore";
import {
  resolveVisibleToastThreadIds,
  shouldRenderToastForVisibleThreads,
} from "./toastRouteVisibility";

type ThreadToastData = {
  allowCrossThreadVisibility?: boolean;
  compactContextual?: boolean;
  copyText?: string;
  onClose?: () => void;
  secondaryActionProps?: React.ComponentProps<typeof Button>;
  threadId?: ThreadId | null;
  tooltipStyle?: boolean;
  dismissAfterVisibleMs?: number;
  archiveUndo?: {
    onUndo: () => boolean | Promise<boolean>;
    onViewArchived: () => void | Promise<void>;
  };
};

const toastManager = Toast.createToastManager<ThreadToastData>();
const anchoredToastManager = Toast.createToastManager<ThreadToastData>();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

function shouldUseCompactToast(toast: ToastObject<ThreadToastData>): boolean {
  if (toast.data?.compactContextual) {
    return true;
  }
  return !toast.data?.copyText && !toast.actionProps && !toast.data?.secondaryActionProps;
}

function isArchiveUndoToast(toast: ToastObject<ThreadToastData>): boolean {
  return Boolean(toast.data?.archiveUndo);
}

// Archive undo uses the tooltip chrome from the original design, but keeps the
// toast root no-drag so Electron titlebar hit testing cannot swallow clicks.
const ARCHIVE_UNDO_TOAST_SURFACE_CLASS_NAME = cn(
  APP_TOOLTIP_SURFACE_CLASS_NAME,
  "absolute w-max max-w-[min(calc(100vw-2rem),28rem)] rounded-2xl [--notification-fg:var(--popover-foreground)] [-webkit-app-region:no-drag]",
);

const ARCHIVE_UNDO_TOAST_LINK_CLASS_NAME =
  "rounded-sm font-medium text-[var(--info-foreground)] underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--info-foreground)]/35 disabled:pointer-events-none disabled:opacity-55";

function toastRootClassName(position: ToastPosition, compact: boolean): string {
  return cn(
    compact ? COMPACT_NOTIFICATION_SURFACE_CLASS_NAME : EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
    position.includes("center") ? "mx-auto" : compact ? "" : "w-full",
  );
}

function toastIconClassName(type: ToastObject<ThreadToastData>["type"]): string {
  return cn(NOTIFICATION_ICON_CLASS_NAME, type === "loading" && "animate-spin opacity-90");
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function shouldRenderForActiveThread(
  data: ThreadToastData | undefined,
  visibleThreadIds: ReadonlySet<ThreadId>,
): boolean {
  return shouldRenderToastForVisibleThreads({
    allowCrossThreadVisibility: data?.allowCrossThreadVisibility,
    toastThreadId: data?.threadId,
    visibleThreadIds,
  });
}

function useVisibleThreadIdsFromRoute(): ReadonlySet<ThreadId> {
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const routeSearch = useDiffRouteSearch();
  const splitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );

  return resolveVisibleToastThreadIds({ activeThreadId, splitView });
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
  paused: pausedProp,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
  // While paused (e.g. an Undo is in flight) the visible timer holds so the
  // toast can't auto-dismiss out from under an action the user just triggered.
  paused?: boolean;
}) {
  const paused = pausedProp ?? false;
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = !paused && document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId, paused]);

  return null;
}

function ToastActions({
  actionProps,
  copyText,
  secondaryActionProps,
}: {
  actionProps: ToastObject<ThreadToastData>["actionProps"];
  copyText: string | undefined;
  secondaryActionProps: ThreadToastData["secondaryActionProps"];
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  if (!actionProps && !copyText && !secondaryActionProps) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {copyText && (
        <Button
          aria-label={isCopied ? "Copied error message" : "Copy error message"}
          className="self-start rounded-md border-[var(--notification-fg)]/20 bg-[var(--notification-fg)]/10 text-[var(--notification-fg)] hover:bg-[var(--notification-fg)]/20"
          onClick={() => {
            copyToClipboard(copyText, undefined);
          }}
          size="xs"
          title={isCopied ? "Copied error message" : "Copy error message"}
          variant="outline"
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          <span>{isCopied ? "Copied" : "Copy"}</span>
        </Button>
      )}
      {actionProps && (
        <Toast.Action
          {...actionProps}
          className={cn(
            buttonVariants({ size: "xs", variant: "outline" }),
            "self-start rounded-md border-[var(--notification-fg)]/20 bg-[var(--notification-fg)]/10 text-[var(--notification-fg)] hover:bg-[var(--notification-fg)]/20",
            actionProps.className,
          )}
          data-slot="toast-action"
        >
          {actionProps.children}
        </Toast.Action>
      )}
      {secondaryActionProps && (
        <Button
          {...secondaryActionProps}
          className={cn(
            "self-start rounded-md border-[var(--notification-fg)]/20 bg-[var(--notification-fg)]/10 text-[var(--notification-fg)] hover:bg-[var(--notification-fg)]/20",
            secondaryActionProps.className,
          )}
          size={secondaryActionProps.size ?? "xs"}
          variant={secondaryActionProps.variant ?? "outline"}
        />
      )}
    </div>
  );
}

function ToastCloseButton({
  compact: compactProp,
  onDismiss,
  onClose,
}: {
  compact?: boolean;
  onDismiss: () => void;
  onClose?: (() => void) | undefined;
}) {
  const compact = compactProp ?? false;
  return (
    <button
      type="button"
      aria-label="Dismiss toast"
      className={cn(
        // pointer-events-auto keeps the X clickable even when a stacked/collapsed
        // toast still gates its content with pointer-events-none.
        "pointer-events-auto z-10 inline-flex shrink-0 items-center justify-center rounded-full text-[var(--notification-fg)]/65 transition-colors hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--notification-fg)]/35",
        compact ? "size-5" : "absolute top-2 right-2 size-6",
      )}
      data-slot="toast-close"
      onClick={() => {
        onClose?.();
        onDismiss();
      }}
      title="Dismiss toast"
    >
      <XIcon className={compact ? "size-3" : "size-3.5"} />
    </button>
  );
}

function ArchiveUndoToastSurface({
  archiveUndo,
  toastId,
  dismissAfterVisibleMs,
  hideCollapsedContent,
  onDismiss,
}: {
  archiveUndo: NonNullable<ThreadToastData["archiveUndo"]>;
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
  hideCollapsedContent: boolean;
  onDismiss: () => void;
}) {
  const [undoPending, setUndoPending] = useState(false);
  // A pending Undo owns the next navigation; keep the Settings path idle until it settles.
  const actionsDisabled = undoPending;

  const handleUndoClick = () => {
    if (actionsDisabled) return;
    setUndoPending(true);
    void (async () => {
      try {
        const restored = await archiveUndo.onUndo();
        if (restored) {
          onDismiss();
          return;
        }
        setUndoPending(false);
      } catch {
        setUndoPending(false);
      }
    })();
  };

  const handleViewArchivedClick = () => {
    if (actionsDisabled) return;
    void archiveUndo.onViewArchived();
    onDismiss();
  };

  return (
    <>
      <ThreadToastVisibleAutoDismiss
        toastId={toastId}
        dismissAfterVisibleMs={dismissAfterVisibleMs}
        paused={undoPending}
      />
      <Toast.Content
        className={cn(
          "pointer-events-auto relative flex items-center gap-2 overflow-hidden px-3.5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] leading-normal transition-opacity duration-250 data-expanded:opacity-100",
          hideCollapsedContent &&
            "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
        )}
        data-slot="toast-archive-undo"
      >
        <Toast.Title
          className="min-w-0 flex-1 font-normal whitespace-nowrap"
          data-slot="toast-title"
          render={<div />}
        >
          <button
            type="button"
            className={ARCHIVE_UNDO_TOAST_LINK_CLASS_NAME}
            data-base-ui-swipe-ignore
            disabled={actionsDisabled}
            onClick={handleUndoClick}
          >
            Undo
          </button>{" "}
          or view archived chats in{" "}
          <button
            type="button"
            className={ARCHIVE_UNDO_TOAST_LINK_CLASS_NAME}
            data-base-ui-swipe-ignore
            disabled={actionsDisabled}
            onClick={handleViewArchivedClick}
          >
            Settings
          </button>
        </Toast.Title>
        <ToastCloseButton compact onDismiss={onDismiss} />
      </Toast.Content>
    </>
  );
}

function ToastSurface({
  toast,
  compact,
  hideCollapsedContent,
  onDismiss,
}: {
  toast: ToastObject<ThreadToastData>;
  compact: boolean;
  hideCollapsedContent: boolean;
  onDismiss: () => void;
}) {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
  const compactContextual = compact && toast.data?.compactContextual === true;

  return (
    <Toast.Content
      className={cn(
        "pointer-events-auto relative flex overflow-hidden transition-opacity duration-250 data-expanded:opacity-100",
        compact
          ? cn(
              "gap-2 px-3 py-1.5 pr-1.5 text-[length:var(--app-font-size-ui-sm,11px)] leading-normal",
              compactContextual ? "items-start py-2" : "items-center",
            )
          : "items-start gap-2 px-3.5 py-3 pr-10 text-sm",
        hideCollapsedContent && "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "shrink-0 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            compact
              ? cn("[&>svg]:size-3.5", compactContextual && "pt-0.5")
              : "[&>svg]:h-lh [&>svg]:w-4",
          )}
          data-slot="toast-icon"
        >
          <Icon className={toastIconClassName(toast.type)} />
        </div>
      ) : null}

      <div
        className={cn(
          "min-w-0 flex-1",
          compact && !compactContextual ? "flex items-center" : "flex flex-col gap-0.5",
        )}
      >
        <Toast.Title
          className={cn(
            "min-w-0 font-normal",
            compact && !compactContextual
              ? "truncate whitespace-nowrap"
              : compactContextual
                ? "truncate whitespace-nowrap font-medium"
                : "break-words",
          )}
          data-slot="toast-title"
        />
        {!compact || compactContextual ? (
          <Toast.Description
            className={cn(
              "min-w-0 text-[var(--notification-fg)]/72",
              compactContextual ? "line-clamp-2 max-w-80 break-words leading-snug" : "break-words",
            )}
            data-slot="toast-description"
          />
        ) : null}
        {!compact ? (
          <ToastActions
            actionProps={toast.actionProps}
            copyText={toast.data?.copyText}
            secondaryActionProps={toast.data?.secondaryActionProps}
          />
        ) : null}
      </div>

      {compactContextual && toast.actionProps ? (
        <Toast.Action
          {...toast.actionProps}
          className={cn(
            "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 font-medium text-[var(--notification-fg)]/76 transition-colors hover:bg-[var(--notification-fg)]/10 hover:text-[var(--notification-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--notification-fg)]/35",
            toast.actionProps.className,
          )}
          data-slot="toast-action"
        >
          {toast.actionProps.children}
        </Toast.Action>
      ) : null}
      <ToastCloseButton compact={compact} onClose={toast.data?.onClose} onDismiss={onDismiss} />
    </Toast.Content>
  );
}

function ToastProvider({ children, position: positionProp, ...props }: ToastProviderProps) {
  const position = positionProp ?? "top-center";
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position: positionProp }: { position: ToastPosition }) {
  const position = positionProp ?? "top-center";
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const visibleThreadIds = useVisibleThreadIdsFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts
    .filter((toast) => shouldRenderForActiveThread(toast.data, visibleThreadIds))
    .toSorted((left, right) => {
      const leftEnding = left.transitionStatus === "ending";
      const rightEnding = right.transitionStatus === "ending";
      if (leftEnding === rightEnding) return 0;
      return leftEnding ? 1 : -1;
    });
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-[200] mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-sm [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          // Vertical positioning
          "data-[position=top-center]:top-4",
          "data-[position=top-left]:top-[calc(var(--toast-inset)+46px)]",
          "data-[position=top-right]:top-[calc(var(--toast-inset)+46px)]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          // Horizontal positioning
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const compact = shouldUseCompactToast(toast);
          const archiveUndoToast = isArchiveUndoToast(toast);

          return (
            <Toast.Root
              className={cn(
                "absolute z-[calc(9999-var(--toast-index))] h-(--toast-calc-height) select-none [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                archiveUndoToast
                  ? cn(
                      ARCHIVE_UNDO_TOAST_SURFACE_CLASS_NAME,
                      position.includes("center") ? "mx-auto" : "",
                    )
                  : toastRootClassName(position, compact),
                // Base positioning using data-position
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Define some variables
                // Base UI exposes a shared front-most height for the collapsed stack.
                // If that shared measurement is briefly stale, long content can render
                // outside the card until hover expands the toast and swaps to its own height.
                "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))] [--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Top-center uses a flat banner stack without peek/shrink offsets.
                "data-[position=top-center]:[--toast-peek:0px] data-[position=top-center]:[--toast-scale:1] data-[position=top-center]:[--toast-shrink:0]",
                "data-[position=top-center]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-swipe-movement-y))]",
                "data-[position=top-center]:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-offset-y)+var(--toast-swipe-movement-y)))]",
                // Define offset-y variable
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                // Default state transform
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                // Limited state
                "data-limited:opacity-0",
                // Expanded state
                "data-expanded:h-(--toast-height)",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                // Starting and ending animations
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position=top-center]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                // Ending animations (direction-aware)
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Ending animations (expanded)
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                // Closed/limited toasts stay mounted briefly for animation; they must
                // never sit as invisible hit targets above a fresh interactive toast.
                "data-ending-style:pointer-events-none data-limited:pointer-events-none",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              {archiveUndoToast && toast.data?.archiveUndo ? (
                <ArchiveUndoToastSurface
                  archiveUndo={toast.data.archiveUndo}
                  toastId={toast.id}
                  dismissAfterVisibleMs={toast.data.dismissAfterVisibleMs}
                  hideCollapsedContent={hideCollapsedContent}
                  onDismiss={() => toastManager.close(toast.id)}
                />
              ) : (
                <>
                  <ThreadToastVisibleAutoDismiss
                    dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                    toastId={toast.id}
                  />
                  <ToastSurface
                    compact={compact}
                    hideCollapsedContent={hideCollapsedContent}
                    onDismiss={() => toastManager.close(toast.id)}
                    toast={toast}
                  />
                </>
              )}
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const visibleThreadIds = useVisibleThreadIdsFromRoute();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {toasts
          .filter((toast) => shouldRenderForActiveThread(toast.data, visibleThreadIds))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;
            const compact = !tooltipStyle && shouldUseCompactToast(toast);

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-50 max-w-[min(--spacing(64),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "relative text-balance transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                    tooltipStyle
                      ? "rounded-lg border bg-popover text-popover-foreground text-xs shadow-md/5 [-webkit-app-region:no-drag] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]"
                      : compact
                        ? COMPACT_NOTIFICATION_SURFACE_CLASS_NAME
                        : EXPANDED_NOTIFICATION_SURFACE_CLASS_NAME,
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <ToastSurface
                      compact={compact}
                      hideCollapsedContent={false}
                      onDismiss={() => anchoredToastManager.close(toast.id)}
                      toast={toast}
                    />
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
