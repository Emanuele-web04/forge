import {
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationThread,
  type ServerConfig,
  type ServerProviderStatus,
  type WsCompatibilityError,
} from "@synara/contracts";
import { defaultTerminalTitleForCliKind } from "@synara/shared/terminalThreads";
import { isThreadDetailEventFor } from "@synara/shared/threadDetailEvents";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { DesktopWindowControls } from "../components/DesktopWindowControls";
import { AppSnapCoordinator } from "../components/AppSnapCoordinator";
import { AppSnapWelcomeDialog } from "../components/AppSnapWelcomeDialog";
import { FeedbackDialog } from "../components/FeedbackDialog";
import { SETTINGS_TARGETS } from "../settingsNavigation";
import ShortcutsDialog from "../components/ShortcutsDialog";
import WhatsNewDialog from "../components/WhatsNewDialog";
import { useWhatsNew } from "../whatsNew/useWhatsNew";
import { WhatsNewPopoutCard } from "../whatsNew/WhatsNewPopoutCard";
import { shouldRenderTerminalWorkspace } from "../components/ChatView.logic";
import { Button, dialogActionButtonClassName } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { useGitProgressToastPreview } from "../components/useGitProgressToastPreview";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { useFeatureFlags } from "../featureFlags";
import { useFocusedChatContext } from "../focusedChatContext";
import { useFeedbackDialogStore } from "../feedbackDialogStore";
import type { FeedbackThreadContext } from "../feedback";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  reconcileServerProviderStatuses,
  refreshServerConfigAfterTransportOpen,
  serverConfigQueryOptions,
  serverQueryKeys,
  serverSettingsQueryOptions,
} from "../lib/serverReactQuery";
import { ensureNativeApi, readNativeApi } from "../nativeApi";
import {
  finalizePromotedDraftThreads,
  markPromotedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { useStore } from "../store";
import { EMPTY_THREAD_IDS } from "../storeState";
import { createAllThreadsSelector } from "../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { terminalActivityFromEvent } from "../terminalActivity";
import {
  onServerConfigUpdated,
  onServerProviderStatusesUpdated,
  onServerSettingsUpdated,
  onServerWelcome,
  onThreadStreamFailure,
} from "../wsNativeApi";
import {
  addWsCompatibilityIssueListener,
  addWsTransportStateListener,
  readLatestWsCompatibilityIssue,
} from "../wsTransportEvents";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { invalidateProjectFileQueriesForCwds, projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { useProjectRunStore } from "../projectRunStore";
import { dockTerminalThreadId } from "../lib/dockTerminalScope";
import { TaskCompletionNotifications } from "../notifications/taskCompletion";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import {
  isThreadDetailRetained,
  resolveThreadDetailSubscriptionLeaseIds,
  setVisibleThreadDetailIds,
  subscribeThreadDetailEvictions,
  useRetainedThreadDetailIds,
} from "../threadDetailSubscriptionRetention";
import {
  advanceThreadDetailResumeCursor,
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
  getThreadDetailResumeCursor,
  setThreadDetailResumeCursor,
} from "../threadDetailResumeCursors";
import { hasPendingTurnDispatch } from "../pendingTurnDispatch";
import { canApplyThreadSnapshot, selectOrphanedThreadDetailIds } from "./-threadDetailOwnership";
import { getThreadFromState, getThreadsFromState } from "../threadDerivation";
import { useAppDensity } from "../hooks/useAppDensity";
import { useChatWidth } from "../hooks/useChatWidth";
import { useDesktopAppIcon } from "../hooks/useDesktopAppIcon";
import { useAppTypography } from "../hooks/useAppTypography";
import { usePreloadRouteChunks } from "../hooks/usePreloadRouteChunks";
import { useSyncDesktopTopBarTrafficLightGutterZoom } from "../hooks/useDesktopTopBarGutter";
import { useTheme } from "../hooks/useTheme";
import { useNativeFontSmoothing } from "../hooks/useNativeFontSmoothing";
import { invalidateGitQueries, invalidateGitQueriesForCwds } from "../lib/gitReactQuery";
import { shouldRepairDesktopProjectSnapshot } from "../lib/desktopProjectRecovery";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import {
  PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS,
  useProviderAuthRefreshOnFocus,
} from "../hooks/useProviderAuthRefreshOnFocus";
import { useProviderStatusRefresh } from "../hooks/useProviderStatusRefresh";
import { resolveSplitViewThreadIds, selectSplitView, useSplitViewStore } from "../splitViewStore";
import { useRightDockStore } from "../rightDockStore";
import { resolveVisibleDockSidechatThreadIds } from "../rightDockStore.logic";
import { arraysShallowEqual } from "../storeNormalization";
import { providerModelDiscoveryInvalidationFingerprint } from "../lib/providerDiscoveryInvalidation";
import { providerDiscoveryQueryKeys } from "../lib/providerDiscoveryReactQuery";
import { useAppSettings } from "../appSettings";
import { getNavigatorPlatform } from "../lib/utils";
import {
  getNotifiableProviderUpdateStatuses,
  isProviderUpdateActive,
  providerUpdateNotificationKey,
  PROVIDER_UPDATE_INITIAL_REFRESH_DELAY_MS,
  PROVIDER_UPDATE_REFRESH_INTERVAL_MS,
  withProviderUpdateTimeout,
} from "../providerUpdates";
import {
  getGitInvalidationThreadIdForEvent,
  getProjectFileInvalidationThreadIdForEvent,
  getStudioOutputInvalidationThreadIdForEvent,
  resolveGitInvalidationCwdForThreadId,
  shouldInvalidateGitQueriesForEvent,
  shouldInvalidateProviderQueriesForEvent,
} from "./-rootEventInvalidation";
import { createDesktopProjectRecoveryAttemptGate } from "./-desktopProjectRecoveryAttempt";

const SHELL_SNAPSHOT_BOOTSTRAP_FALLBACK_DELAY_MS = 1_500;
const THREAD_DETAIL_CATCHUP_INTERVAL_MS = 1_500;
const THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS = 4_500;
const THREAD_DETAIL_PROJECTION_RECONCILE_MAX_CONCURRENCY = 2;
// Bounded backoff for the periodic catch-up polls while a healthy live stream
// keeps delivering everything: consecutive empty replays stretch the 1.5s poll
// toward 6s, and consecutive no-op projection reconciles stretch the 4.5s
// reconcile toward 18s. Both reset on a new turn, any applied event, or any
// repair signal (missing snapshot, pending dispatch, terminal fence, draft
// promotion), so recovery paths always run at base cadence.
const THREAD_DETAIL_REPLAY_MAX_NOOP_STREAK = 2;
const THREAD_DETAIL_PROJECTION_RECONCILE_MAX_NOOP_STREAK = 2;
const PENDING_SHELL_EVENT_BUFFER_LIMIT = 1_024;
const PENDING_THREAD_EVENT_BUFFER_LIMIT = 512;
const IMMEDIATE_ASSISTANT_FLUSH_ID_LIMIT = 512;
const seenProviderUpdateNotificationKeys = new Set<string>();

type ProviderUpdateToastId = ReturnType<typeof toastManager.add>;
type ActiveProviderUpdateToast =
  | {
      readonly kind: "prompt";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
    }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly toastId: ProviderUpdateToastId;
    };

function shellThreadHasStarted(thread: OrchestrationShellSnapshot["threads"][number]): boolean {
  return thread.latestTurn !== null || thread.session !== null;
}

function detailThreadHasStarted(thread: OrchestrationThread): boolean {
  return shellThreadHasStarted(thread) || thread.messages.length > 0;
}

function reconcilePromotedDraftsFromShellThreads(
  threads: ReadonlyArray<OrchestrationShellSnapshot["threads"][number]>,
): void {
  markPromotedDraftThreads(new Set(threads.map((thread) => thread.id)));
  finalizePromotedDraftThreads(
    new Set(threads.filter((thread) => shellThreadHasStarted(thread)).map((thread) => thread.id)),
  );
}

function reconcilePromotedDraftFromThreadDetail(thread: OrchestrationThread): void {
  markPromotedDraftThreads(new Set([thread.id]));
  if (detailThreadHasStarted(thread)) {
    finalizePromotedDraftThreads(new Set([thread.id]));
  }
}

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  useAppTypography();
  useAppDensity();
  useChatWidth();
  useDesktopAppIcon();
  usePreloadRouteChunks();
  useNativeFontSmoothing();
  useSyncDesktopTopBarTrafficLightGutterZoom();
  useTheme();
  const [compatibilityIssue, setCompatibilityIssue] = useState<WsCompatibilityError | null>(() =>
    readLatestWsCompatibilityIssue(),
  );
  useEffect(
    () =>
      addWsCompatibilityIssueListener(setCompatibilityIssue, {
        replayCurrent: true,
      }),
    [],
  );

  // Single mount point for the Windows caption buttons. The cluster is pinned to the
  // window's top-right corner (frameless Windows shell) and renders nothing on macOS,
  // Linux, or the web build, so it is safe to mount unconditionally here — including on
  // the pre-backend "connecting" screen, so the window stays closable before the
  // renderer connects. Top bars reserve space for it via
  // useDesktopTopBarWindowControlsGutterClassName().
  //
  // MUST render LAST: Electron builds the OS drag region by walking elements with
  // `-webkit-app-region` in DOM order, unioning `drag` rects and subtracting `no-drag`
  // rects in sequence. The route headers are full-width `drag-region`s that extend under
  // this cluster, so the cluster's `no-drag` rect has to be subtracted AFTER those drag
  // rects are added — otherwise the OS reclaims the corner as title-bar caption and
  // swallows the click as a window drag (the buttons render but do nothing). Rendering
  // it last in document order guarantees that subtraction wins. (z above dialogs/toasts
  // so it also stays clickable while a modal is open.)
  const desktopWindowControls = <DesktopWindowControls className="fixed top-0 right-0 z-[250]" />;

  if (compatibilityIssue) {
    return (
      <>
        <TransportCompatibilityView issue={compatibilityIssue} />
        {desktopWindowControls}
      </>
    );
  }

  if (!readNativeApi()) {
    return (
      <>
        <div className="flex h-screen flex-col bg-background text-foreground">
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Connecting to {APP_DISPLAY_NAME} server...
            </p>
          </div>
        </div>
        {desktopWindowControls}
      </>
    );
  }

  return (
    <>
      <ToastProvider position="top-center">
        <AnchoredToastProvider>
          <GitProgressToastPreviewDev />
          <EventRouter />
          <ProviderStatusRefreshCoordinator />
          <GlobalShortcutsDialog />
          <GlobalFeedbackDialog />
          <GlobalWhatsNewSurface />
          <TaskCompletionNotifications />
          <AppSnapWelcomeDialog />
          <AppSnapCoordinator />
          <DesktopProjectBootstrap />
          <Outlet />
        </AnchoredToastProvider>
      </ToastProvider>
      {desktopWindowControls}
    </>
  );
}

function TransportCompatibilityView({ issue }: { issue: WsCompatibilityError }) {
  const title =
    issue.action === "update-client"
      ? "This Synara client needs an update."
      : issue.action === "update-server"
        ? "The Synara server needs an update."
        : "Synara needs to reconnect with a matching build.";
  const guidance =
    issue.action === "update-client"
      ? "Update or reload this client, then reconnect."
      : issue.action === "update-server"
        ? "Update or restart the server, then reload this client."
        : "Reload the app. If this repeats, restart Synara so the client and server use matching builds.";

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-amber-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold text-muted-foreground">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{issue.message}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{guidance}</p>
        <p className="mt-4 text-xs text-muted-foreground/80">
          Client {APP_VERSION} · Server {issue.serverBuild}
        </p>
        <div className="mt-5">
          <Button
            size="sm"
            className={dialogActionButtonClassName}
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>
      </section>
    </div>
  );
}

function GitProgressToastPreviewDev() {
  const featureFlags = useFeatureFlags();
  const enabled = import.meta.env.DEV && featureFlags["pin-git-progress-toast-preview"];
  useGitProgressToastPreview(enabled);
  return null;
}

function ProviderStatusRefreshCoordinator() {
  const { settings } = useAppSettings();
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const [transportOpen, setTransportOpen] = useState(false);
  const [liveVersionCheckCompleted, setLiveVersionCheckCompleted] = useState(false);
  const providerUpdateChecksEnabled =
    serverSettingsQuery.data !== undefined && settings.enableProviderUpdateChecks;
  const providerUpdateRefreshEnabled = providerUpdateChecksEnabled && transportOpen;
  const markLiveVersionCheckCompleted = useCallback(() => {
    setLiveVersionCheckCompleted(true);
  }, []);

  // The update coordinator includes the same focus/visibility refresh. Keep the
  // auth-only loop for the setting-off case so enabling update checks never
  // launches duplicate provider probes on focus.
  useProviderAuthRefreshOnFocus({ enabled: !providerUpdateChecksEnabled });
  useEffect(
    () =>
      addWsTransportStateListener(
        (state) => {
          const open = state === "open";
          setTransportOpen(open);
          if (!open) {
            setLiveVersionCheckCompleted(false);
          }
        },
        { replayCurrent: true },
      ),
    [],
  );

  useEffect(() => {
    if (!providerUpdateChecksEnabled) {
      setLiveVersionCheckCompleted(false);
    }
  }, [providerUpdateChecksEnabled]);

  // Provider latest-version checks are slow/network-backed, so keep this cadence
  // coarse while still honoring the automatic update-check setting.
  useProviderStatusRefresh({
    enabled: providerUpdateRefreshEnabled,
    initialDelayMs: PROVIDER_UPDATE_INITIAL_REFRESH_DELAY_MS,
    intervalMs: PROVIDER_UPDATE_REFRESH_INTERVAL_MS,
    minIntervalMs: PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS,
    refreshOnFocus: true,
    onRefreshSuccess: markLiveVersionCheckCompleted,
  });

  // Keep the notifier mounted while the transport is interrupted. Dropping the
  // gate makes it close any active prompt before a reconnect can reuse cached data.
  return (
    <ProviderUpdateNotifications
      liveVersionCheckCompleted={providerUpdateRefreshEnabled && liveVersionCheckCompleted}
    />
  );
}

// Extracted to module scope so its run-always cleanup can stay a try/finally: the
// React Compiler does not compile module functions, so the finally block is fine
// here even though it would bail out the component body.
async function runProviderUpdateAll(params: {
  providers: ReadonlyArray<ServerProviderStatus>;
  queryClient: QueryClient;
  activeToastRef: { current: ActiveProviderUpdateToast | null };
  isUpdatingAllRef: { current: boolean };
  progressToastDismissedRef: { current: boolean };
  setIsUpdatingAll: (value: boolean) => void;
}): Promise<void> {
  const {
    providers,
    queryClient,
    activeToastRef,
    isUpdatingAllRef,
    progressToastDismissedRef,
    setIsUpdatingAll,
  } = params;
  const activeNotificationKey = providerUpdateNotificationKey(providers);
  if (isUpdatingAllRef.current || providers.length === 0 || !activeNotificationKey) {
    return;
  }

  isUpdatingAllRef.current = true;
  progressToastDismissedRef.current = false;
  setIsUpdatingAll(true);
  const trackedToast = activeToastRef.current;
  const toastId =
    trackedToast?.toastId ??
    toastManager.add({
      type: "loading",
      title: "Updating providers...",
      description:
        providers.length === 1
          ? `Updating ${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]}.`
          : `Updating ${providers.length} providers.`,
      timeout: 0,
    });
  activeToastRef.current = { kind: "update", key: activeNotificationKey, toastId };
  const dismissProgressToast = () => {
    progressToastDismissedRef.current = true;
    if (activeToastRef.current?.toastId === toastId) {
      activeToastRef.current = null;
    }
    toastManager.close(toastId);
  };

  toastManager.update(toastId, {
    type: "loading",
    title: "Updating providers...",
    description:
      providers.length === 1
        ? `Updating ${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]}.`
        : `Updating ${providers.length} providers.`,
    actionProps: undefined,
    data: { onClose: dismissProgressToast },
    timeout: 0,
  });

  const failures: Array<{ provider: ServerProviderStatus; reason: string }> = [];

  try {
    const api = ensureNativeApi();
    for (const provider of providers) {
      try {
        const result = await withProviderUpdateTimeout({
          provider: provider.provider,
          request: api.server.updateProvider({ provider: provider.provider }),
        });
        const refreshed = result.providers.find((entry) => entry.provider === provider.provider);
        const updateState = refreshed?.updateState;
        if (updateState?.status === "failed" || updateState?.status === "unchanged") {
          failures.push({
            provider,
            reason: updateState.message ?? "The update command did not complete successfully.",
          });
        } else if (refreshed?.versionAdvisory?.status === "behind_latest") {
          failures.push({
            provider,
            reason: "The provider still appears outdated after updating.",
          });
        }
      } catch (error) {
        failures.push({
          provider,
          reason: error instanceof Error ? error.message : "The update request failed.",
        });
      }
    }
  } catch (error) {
    for (const provider of providers) {
      failures.push({
        provider,
        reason:
          error instanceof Error ? error.message : "The provider update request could not start.",
      });
    }
  } finally {
    // Refresh is best-effort UI sync; it must not keep the progress toast alive.
    await queryClient
      .invalidateQueries({ queryKey: serverQueryKeys.config() })
      .catch(() => undefined);
    isUpdatingAllRef.current = false;
    setIsUpdatingAll(false);
  }

  if (progressToastDismissedRef.current || activeToastRef.current?.toastId !== toastId) {
    return;
  }

  if (failures.length > 0) {
    activeToastRef.current = null;
    // Surface the exact manual commands so a user whose one-click update
    // failed (EACCES on global npm, PATH/package-manager mismatch, etc.) can
    // copy and run them in a terminal instead of being stuck.
    const manualCommands = Array.from(
      new Set(
        failures
          .map(({ provider }) => provider.versionAdvisory?.updateCommand)
          .filter(
            (command): command is string =>
              typeof command === "string" && command.trim().length > 0,
          ),
      ),
    );
    const failureLines = failures
      .map(({ provider, reason }) => `${PROVIDER_DISPLAY_NAMES[provider.provider]}: ${reason}`)
      .join("\n");
    toastManager.update(toastId, {
      type: "error",
      title:
        failures.length === providers.length
          ? "Provider updates failed"
          : "Some provider updates failed",
      description:
        manualCommands.length > 0
          ? `${failureLines}\n\nCopy the command${manualCommands.length === 1 ? "" : "s"} below to update manually in a terminal.`
          : failureLines,
      data: {
        onClose: dismissProgressToast,
        ...(manualCommands.length > 0 ? { copyText: manualCommands.join("\n") } : {}),
      },
      timeout: 0,
    });
    return;
  }

  activeToastRef.current = null;
  toastManager.update(toastId, {
    type: "success",
    title:
      providers.length === 1
        ? `${PROVIDER_DISPLAY_NAMES[providers[0]!.provider]} updated`
        : `${providers.length} providers updated`,
    description: "New sessions will use the refreshed provider tools.",
    data: { onClose: dismissProgressToast },
    timeout: 6000,
  });
}

function ProviderUpdateNotifications({
  liveVersionCheckCompleted,
}: {
  readonly liveVersionCheckCompleted: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const providerUpdateServerSettings = serverSettingsQuery.data
    ? {
        ...serverSettingsQuery.data,
        enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
      }
    : null;
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const activeToastRef = useRef<ActiveProviderUpdateToast | null>(null);
  const isUpdatingAllRef = useRef(false);
  const progressToastDismissedRef = useRef(false);
  const outdatedProviders = getNotifiableProviderUpdateStatuses({
    providers: serverConfigQuery.data?.providers ?? [],
    hiddenProviders: settings.hiddenProviders,
    serverSettings: providerUpdateServerSettings,
    liveVersionCheckCompleted,
  });
  const oneClickProviders = outdatedProviders.filter(
    (provider) => !isProviderUpdateActive(provider),
  );
  const notificationKey = providerUpdateNotificationKey(outdatedProviders);

  const updateAll = (providers: ReadonlyArray<ServerProviderStatus>) =>
    runProviderUpdateAll({
      providers,
      queryClient,
      activeToastRef,
      isUpdatingAllRef,
      progressToastDismissedRef,
      setIsUpdatingAll,
    });

  useEffect(() => {
    const activeToast = activeToastRef.current;
    if (activeToast?.kind === "prompt" && activeToast.key !== notificationKey) {
      toastManager.close(activeToast.toastId);
      activeToastRef.current = null;
    }

    if (
      outdatedProviders.length === 0 ||
      oneClickProviders.length === 0 ||
      !notificationKey ||
      isUpdatingAll ||
      activeToastRef.current ||
      seenProviderUpdateNotificationKeys.has(notificationKey)
    ) {
      return;
    }

    // Key the prompt by the complete provider/version set so a partial refresh
    // cannot stack a second "Update all" prompt on top of the first one.
    seenProviderUpdateNotificationKeys.add(notificationKey);

    const firstProvider = outdatedProviders[0]!;
    const additionalCount = outdatedProviders.length - 1;
    const providerName = PROVIDER_DISPLAY_NAMES[firstProvider.provider];
    const title =
      outdatedProviders.length === 1
        ? `${providerName} update available`
        : `${outdatedProviders.length} provider updates available`;
    const description =
      outdatedProviders.length === 1
        ? `${providerName} has a newer version available.`
        : `${providerName} and ${additionalCount} more provider${additionalCount === 1 ? "" : "s"} have newer versions available.`;

    let toastId!: ProviderUpdateToastId;
    const closeTrackedPrompt = () => {
      if (activeToastRef.current?.toastId === toastId) {
        activeToastRef.current = null;
      }
      toastManager.close(toastId);
    };
    toastId = toastManager.add({
      type: "warning",
      title,
      description,
      timeout: 0,
      actionProps: {
        children: "Review updates",
        onClick: () => {
          if (activeToastRef.current?.toastId === toastId) {
            toastManager.close(toastId);
            activeToastRef.current = null;
          }
          void navigate({
            to: "/settings",
            search: { section: "providers", target: SETTINGS_TARGETS.providerUpdates },
          });
        },
      },
      data: {
        onClose: closeTrackedPrompt,
        secondaryActionProps: {
          children: "Update all",
          onClick: () => {
            void updateAll(oneClickProviders);
          },
        },
      },
    });
    activeToastRef.current = { kind: "prompt", key: notificationKey, toastId };
  }, [isUpdatingAll, navigate, notificationKey, oneClickProviders, outdatedProviders, updateAll]);

  return null;
}

function GlobalShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const { focusedThreadId, activeProject } = useFocusedChatContext();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const keybindings = serverConfigQuery.data?.keybindings ?? [];
  const platform = getNavigatorPlatform();
  const activeThreadTerminalState = useTerminalStateStore((state) =>
    focusedThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, focusedThreadId)
      : null,
  );
  const terminalOpen = activeThreadTerminalState?.terminalOpen ?? false;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: activeThreadTerminalState?.presentationMode ?? "drawer",
    terminalOpen,
  });

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "show-shortcuts") {
        setOpen(true);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  return (
    <ShortcutsDialog
      open={open}
      onOpenChange={setOpen}
      keybindings={keybindings}
      projectScripts={activeProject?.kind === "project" ? activeProject.scripts : []}
      platform={platform}
      context={{
        terminalFocus: isTerminalFocused(),
        terminalOpen,
        terminalWorkspaceOpen,
      }}
    />
  );
}

function GlobalFeedbackDialog() {
  const { activeProject, activeThread } = useFocusedChatContext();
  const isOpen = useFeedbackDialogStore((state) => state.isOpen);
  const requestedContext = useFeedbackDialogStore((state) => state.context);
  const setOpen = useFeedbackDialogStore((state) => state.setOpen);
  const context: FeedbackThreadContext = requestedContext ?? {
    provider: activeThread?.modelSelection.provider ?? null,
    model: activeThread?.modelSelection.model ?? null,
    projectKind: activeProject?.kind ?? null,
    environmentMode: activeThread?.envMode ?? null,
    runtimeMode: activeThread?.runtimeMode ?? null,
    interactionMode: activeThread?.interactionMode ?? null,
    sessionStatus: activeThread?.session?.status ?? null,
    latestTurnState: activeThread?.latestTurn?.state ?? null,
    messageCount: activeThread?.messages.length ?? 0,
    activityCount: activeThread?.activities.length ?? 0,
    hasPendingApproval: activeThread?.hasPendingApprovals === true,
    hasPendingUserInput: activeThread?.hasPendingUserInput === true,
    hasThreadError: Boolean(activeThread?.error),
  };

  return <FeedbackDialog open={isOpen} context={context} onOpenChange={setOpen} />;
}

function GlobalWhatsNewSurface() {
  // Single mount point per app session. The hook owns the "popout visible" and
  // "dialog open" booleans and the seen-marker persistence; this component is
  // just the plumbing that renders them together so they share one entry.
  const {
    currentEntry,
    allEntries,
    currentVersion,
    isPopoutVisible,
    isDialogOpen,
    openDialog,
    dismissPopout,
    onDialogOpenChange,
  } = useWhatsNew();

  if (!currentEntry) {
    // Silent-bootstrap or noop — nothing to render on either surface.
    return null;
  }

  return (
    <>
      {isPopoutVisible && (
        <WhatsNewPopoutCard
          entry={currentEntry}
          currentVersion={currentVersion}
          onOpen={openDialog}
          onDismiss={dismissPopout}
        />
      )}
      <WhatsNewDialog
        open={isDialogOpen}
        onOpenChange={onDialogOpenChange}
        currentEntry={currentEntry}
        allEntries={allEntries}
        currentVersion={currentVersion}
      />
    </>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold text-muted-foreground">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">Something went wrong.</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" className={dialogActionButtonClassName} onClick={() => reset()}>
            Try again
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={dialogActionButtonClassName}
            onClick={() => window.location.reload()}
          >
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function appendBounded<T>(items: T[], item: T, limit: number): void {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (items.length >= normalizedLimit) {
    items.splice(0, items.length - normalizedLimit + 1);
  }
  items.push(item);
}

function addBoundedSetValue<T>(set: Set<T>, value: T, limit: number): void {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (set.has(value)) {
    set.delete(value);
  }
  while (set.size >= normalizedLimit) {
    const oldestValue = set.values().next().value as T | undefined;
    if (oldestValue === undefined) {
      break;
    }
    set.delete(oldestValue);
  }
  set.add(value);
}

function shouldFlushDomainEventImmediately(
  event: OrchestrationEvent,
  immediatelyFlushedAssistantMessageIds: Set<string>,
): boolean {
  if (event.type !== "thread.message-sent" || event.payload.role !== "assistant") {
    return false;
  }

  if (!event.payload.streaming) {
    immediatelyFlushedAssistantMessageIds.delete(event.payload.messageId);
    return false;
  }

  if (immediatelyFlushedAssistantMessageIds.has(event.payload.messageId)) {
    return false;
  }

  addBoundedSetValue(
    immediatelyFlushedAssistantMessageIds,
    event.payload.messageId,
    IMMEDIATE_ASSISTANT_FLUSH_ID_LIMIT,
  );
  return true;
}

function isThreadDetailEventForThread(event: OrchestrationEvent, threadId: ThreadId): boolean {
  return isThreadDetailEventFor(event, threadId);
}

// Both catch-up predicates also honor the composer's pending-dispatch signal:
// the store-derived checks describe what the client already believes, and the
// exact failure being repaired is a lost `thread.session-set(running)` event
// that leaves that belief stale. A turn dispatched with no observed echo must
// force re-sync regardless of what the store says.
//
// A store-derived busy state may belong to an earlier queued turn, so it cannot
// safely retire the marker for the new dispatch. The marker therefore remains
// independent until its age cap expires or the dispatch site proves that no
// server turn remains.
function shouldPollThreadDetailCatchup(threadId: ThreadId): boolean {
  const thread = getThreadFromState(useStore.getState(), threadId);
  return (
    thread?.session?.orchestrationStatus === "running" ||
    thread?.latestTurn?.state === "running" ||
    hasPendingTurnDispatch(threadId)
  );
}

function shouldReconcileThreadProjection(threadId: ThreadId): boolean {
  const thread = getThreadFromState(useStore.getState(), threadId);
  return (
    thread?.session?.orchestrationStatus === "starting" ||
    thread?.session?.orchestrationStatus === "running" ||
    thread?.latestTurn?.state === "running" ||
    thread?.messages.some((message) => message.role === "assistant" && message.streaming) ===
      true ||
    hasPendingTurnDispatch(threadId)
  );
}

function isTerminalThreadSessionStatus(status: string): boolean {
  return (
    status === "ready" || status === "interrupted" || status === "stopped" || status === "error"
  );
}

/**
 * Frees the detail of threads whose stream lease just dropped and that nothing
 * else owns. Batched into one store write because every write re-runs the
 * retention reconcile.
 */
function releaseOrphanedThreadDetail(input: {
  readonly releasedThreadIds: readonly ThreadId[];
  readonly keptThreadIds?: ReadonlySet<ThreadId> | undefined;
}): void {
  const orphanedThreadIds = selectOrphanedThreadDetailIds({
    releasedThreadIds: input.releasedThreadIds,
    isRetained: isThreadDetailRetained,
    keptThreadIds: input.keptThreadIds,
  });
  if (orphanedThreadIds.length === 0) {
    return;
  }
  // The store's detail-wipe transition also drops each thread's resume cursor,
  // so a resubscribe after this release fetches a fresh snapshot.
  useStore.getState().evictThreadDetails(orphanedThreadIds);
}

function EventRouter() {
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const syncServerThreadDetailHotPath = useStore((store) => store.syncServerThreadDetailHotPath);
  const applyShellEvent = useStore((store) => store.applyShellEvent);
  const applyOrchestrationEventsHotPath = useStore(
    (store) => store.applyOrchestrationEventsHotPath,
  );
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const setServerWorkspacePaths = useWorkspacePathsStore((store) => store.setServerWorkspacePaths);
  const serverThreadIds = useStore((store) => store.threadIds ?? EMPTY_THREAD_IDS);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const hostThreadIds = useMemo(
    () =>
      activeSplitView
        ? resolveSplitViewThreadIds(activeSplitView)
        : routeThreadId
          ? [routeThreadId]
          : [],
    [activeSplitView, routeThreadId],
  );
  // Right-dock sidechat panes render a full ChatView for their embedded thread,
  // so they need a detail lease exactly like split-view panes: without one the
  // sidechat's snapshot never syncs and its transcript stays on the loading state.
  const dockStateByThreadId = useRightDockStore((store) => store.dockStateByThreadId);
  const visibleThreadIds = useMemo(
    () => [
      ...hostThreadIds,
      ...resolveVisibleDockSidechatThreadIds({
        dockRendered: routeSearch.view !== "editor",
        dockStateByThreadId,
        hostThreadIds,
      }),
    ],
    [dockStateByThreadId, hostThreadIds, routeSearch.view],
  );
  const retainedThreadIds = useRetainedThreadDetailIds();
  const serverThreadIdSet = useMemo(() => new Set(serverThreadIds), [serverThreadIds]);
  // Stabilize the lease array by content: `serverThreads` re-emits on every
  // streaming update, and an identity-changing lease list would enqueue a no-op
  // subscription reconcile per render onto the serialized subscribe chain.
  const nextSubscribedThreadIds = resolveThreadDetailSubscriptionLeaseIds({
    visibleThreadIds,
    retainedThreadIds,
    serverThreadIds: serverThreadIdSet,
  });
  const subscribedThreadIdsRef = useRef(nextSubscribedThreadIds);
  const subscribedThreadIds = arraysShallowEqual(
    subscribedThreadIdsRef.current,
    nextSubscribedThreadIds,
  )
    ? subscribedThreadIdsRef.current
    : nextSubscribedThreadIds;
  const pathnameRef = useRef(pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const visibleThreadIdsRef = useRef(subscribedThreadIds);
  const reconcileThreadSubscriptionsRef = useRef<
    ((threadIds: readonly ThreadId[]) => Promise<void>) | null
  >(null);

  // Latest-value mirrors read by the subscription effect's post-commit async
  // callbacks (welcome handler, scoped-subscription reconcile, terminal cleanup).
  // The refs are seeded via useRef init, so mount reads stay correct before this
  // runs; subsequent renders refresh them here instead of during render.
  useEffect(() => {
    pathnameRef.current = pathname;
    visibleThreadIdsRef.current = subscribedThreadIds;
    subscribedThreadIdsRef.current = subscribedThreadIds;
    // Retention must know what is on screen: an evicted visible thread keeps its
    // shell row and renders as an empty conversation until a snapshot lands.
    setVisibleThreadDetailIds(visibleThreadIds);
  }, [pathname, subscribedThreadIds, visibleThreadIds]);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let needsProviderInvalidation = false;
    let needsBroadGitInvalidation = false;
    let pendingGitInvalidationThreadIds = new Set<ThreadId>();
    let pendingProjectFileInvalidationThreadIds = new Set<ThreadId>();
    let pendingStudioOutputInvalidationThreadIds = new Set<ThreadId>();
    let pendingDomainEvents: OrchestrationEvent[] = [];
    const immediatelyFlushedAssistantMessageIds = new Set<string>();
    let providerDiscoveryInvalidationFingerprint: string | null = null;
    let shellSnapshotSequence = -1;
    let pendingShellEvents: OrchestrationShellStreamEvent[] = [];
    const subscribedThreadIds = new Set<ThreadId>();
    const threadSnapshotSequenceById = new Map<ThreadId, number>();
    const pendingThreadEventsById = new Map<ThreadId, OrchestrationEvent[]>();
    const threadSnapshotRequestInFlight = new Set<ThreadId>();
    const threadSnapshotRefreshPending = new Set<ThreadId>();
    const threadSnapshotNotFoundRetryAttempted = new Set<ThreadId>();
    const threadReplayRequestInFlight = new Set<ThreadId>();
    const threadProjectionReconcileInFlight = new Map<ThreadId, number>();
    const threadProjectionTerminalFencePending = new Set<ThreadId>();
    const threadSubscriptionGenerationById = new Map<ThreadId, number>();
    const nextThreadProjectionReconcileAtById = new Map<ThreadId, number>();
    let nextThreadSubscriptionGeneration = 0;
    let reconcileThreadSubscriptionsChain = Promise.resolve();

    const isDraftThreadAwaitingProjection = (threadId: ThreadId): boolean => {
      if (useComposerDraftStore.getState().draftThreadsByThreadId[threadId] === undefined) {
        return false;
      }
      return (
        !threadSnapshotSequenceById.has(threadId) ||
        getThreadFromState(useStore.getState(), threadId) === undefined
      );
    };

    // Catch-up poll backoff, keyed by (threadId, turnId): a new turn resets the
    // cadence so fresh activity repairs fast, while consecutive no-op polls
    // during a healthy stream stretch toward their bounded caps.
    interface ThreadCatchupBackoff {
      turnId: string | null;
      replayNoopStreak: number;
      nextReplayAt: number;
      reconcileNoopStreak: number;
    }
    const threadCatchupBackoffById = new Map<ThreadId, ThreadCatchupBackoff>();
    const resolveThreadCatchupBackoff = (threadId: ThreadId): ThreadCatchupBackoff => {
      const turnId = getThreadFromState(useStore.getState(), threadId)?.latestTurn?.turnId ?? null;
      let entry = threadCatchupBackoffById.get(threadId);
      if (entry === undefined || entry.turnId !== turnId) {
        entry = { turnId, replayNoopStreak: 0, nextReplayAt: 0, reconcileNoopStreak: 0 };
        threadCatchupBackoffById.set(threadId, entry);
      }
      return entry;
    };
    const noteThreadReplayResult = (threadId: ThreadId, appliedEventCount: number): void => {
      const entry = resolveThreadCatchupBackoff(threadId);
      if (appliedEventCount > 0) {
        entry.replayNoopStreak = 0;
        entry.nextReplayAt = 0;
        return;
      }
      entry.replayNoopStreak = Math.min(
        entry.replayNoopStreak + 1,
        THREAD_DETAIL_REPLAY_MAX_NOOP_STREAK,
      );
      entry.nextReplayAt =
        Date.now() + THREAD_DETAIL_CATCHUP_INTERVAL_MS * 2 ** entry.replayNoopStreak;
    };
    const noteThreadReconcileResult = (threadId: ThreadId, wasNoop: boolean): void => {
      const entry = resolveThreadCatchupBackoff(threadId);
      entry.reconcileNoopStreak = wasNoop
        ? Math.min(
            entry.reconcileNoopStreak + 1,
            THREAD_DETAIL_PROJECTION_RECONCILE_MAX_NOOP_STREAK,
          )
        : 0;
    };
    const nextThreadProjectionReconcileDelayMs = (threadId: ThreadId): number => {
      // Repair paths never back off: they exist to fix a client that is known
      // (or suspected) to be out of sync, and delaying them delays recovery.
      if (
        threadProjectionTerminalFencePending.has(threadId) ||
        isDraftThreadAwaitingProjection(threadId) ||
        hasPendingTurnDispatch(threadId)
      ) {
        const entry = resolveThreadCatchupBackoff(threadId);
        entry.reconcileNoopStreak = 0;
        return THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS;
      }
      const entry = resolveThreadCatchupBackoff(threadId);
      return THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS * 2 ** entry.reconcileNoopStreak;
    };

    const beginThreadSubscription = (threadId: ThreadId) => {
      // Cursor resume delivers no snapshot: the stream replays only the gap on
      // top of the cached detail. Seed the live cursor so gap/live events apply
      // immediately instead of buffering while waiting for a snapshot — which
      // is also what previously triggered the unsubscribe-resubscribe race that
      // re-shipped full history.
      const resumeCursor = getThreadDetailResumeCursor(threadId);
      if (resumeCursor === undefined) {
        threadSnapshotSequenceById.delete(threadId);
      } else {
        threadSnapshotSequenceById.set(threadId, resumeCursor);
      }
      pendingThreadEventsById.set(threadId, []);
      threadSnapshotRequestInFlight.delete(threadId);
      threadSnapshotRefreshPending.delete(threadId);
      threadSnapshotNotFoundRetryAttempted.delete(threadId);
      threadProjectionReconcileInFlight.delete(threadId);
      threadProjectionTerminalFencePending.delete(threadId);
      threadCatchupBackoffById.delete(threadId);
      nextThreadSubscriptionGeneration += 1;
      threadSubscriptionGenerationById.set(threadId, nextThreadSubscriptionGeneration);
      nextThreadProjectionReconcileAtById.set(
        threadId,
        Date.now() + THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS,
      );
    };

    // Single choke point for handing a thread detail event to the reducer.
    // The reducer silently ignores detail events for a thread the store no
    // longer holds (pruned by a shell full sync, evicted, deleted), and domain
    // events never create thread records, so advancing the fence and resume
    // cursor first would vouch for events that never landed — a later cursor
    // resume would then skip them forever. When the thread is missing, drop
    // the resume bookkeeping and re-snapshot through the projection instead.
    const applyFencedThreadEvent = (threadId: ThreadId, event: OrchestrationEvent): boolean => {
      if (!getThreadFromState(useStore.getState(), threadId)) {
        threadSnapshotSequenceById.delete(threadId);
        pendingThreadEventsById.delete(threadId);
        clearThreadDetailResumeCursor(threadId);
        if (subscribedThreadIds.has(threadId)) {
          void reconcileThreadProjection(threadId).catch(() => undefined);
        }
        return false;
      }
      threadSnapshotSequenceById.set(threadId, event.sequence);
      advanceThreadDetailResumeCursor(threadId, event.sequence);
      queueDomainEvent(event);
      // Any applied event — live or replayed — is fresh activity: drop the
      // replay backoff so a subsequently lost event repairs at base cadence.
      const backoff = threadCatchupBackoffById.get(threadId);
      if (backoff !== undefined) {
        backoff.replayNoopStreak = 0;
        backoff.nextReplayAt = 0;
      }
      return true;
    };

    const flushThreadBuffer = (threadId: ThreadId, snapshotSequence: number) => {
      const pendingEvents = pendingThreadEventsById.get(threadId) ?? [];
      pendingThreadEventsById.delete(threadId);
      let latestThreadSequence = threadSnapshotSequenceById.get(threadId) ?? snapshotSequence;
      for (const event of pendingEvents.toSorted((left, right) => left.sequence - right.sequence)) {
        if (event.sequence > latestThreadSequence) {
          latestThreadSequence = event.sequence;
          if (!applyFencedThreadEvent(threadId, event)) {
            return;
          }
        }
      }
    };

    const flushShellBuffer = (snapshotSequence: number) => {
      const nextPending = pendingShellEvents
        .filter((event) => event.sequence > snapshotSequence)
        .toSorted((left, right) => left.sequence - right.sequence);
      pendingShellEvents = [];
      for (const event of nextPending) {
        shellSnapshotSequence = Math.max(shellSnapshotSequence, event.sequence);
        applyShellEvent(event);
      }
    };

    const reconcileThreadSubscriptions = async (threadIds: readonly ThreadId[]) => {
      const nextThreadIds = new Set(threadIds);
      const removals = [...subscribedThreadIds].filter((threadId) => !nextThreadIds.has(threadId));
      const additions = [...nextThreadIds].filter((threadId) => !subscribedThreadIds.has(threadId));

      // Release dropped leases before subscribing additions: the server enforces a
      // per-client thread-stream budget, and subscribing while a stale lease still
      // holds its slot gets the new thread's stream rejected at admission.
      for (const threadId of removals) {
        threadSnapshotSequenceById.delete(threadId);
        pendingThreadEventsById.delete(threadId);
        threadSnapshotRequestInFlight.delete(threadId);
        threadSnapshotRefreshPending.delete(threadId);
        threadSnapshotNotFoundRetryAttempted.delete(threadId);
        threadReplayRequestInFlight.delete(threadId);
        threadProjectionReconcileInFlight.delete(threadId);
        threadProjectionTerminalFencePending.delete(threadId);
        threadSubscriptionGenerationById.delete(threadId);
        nextThreadProjectionReconcileAtById.delete(threadId);
        threadCatchupBackoffById.delete(threadId);
        subscribedThreadIds.delete(threadId);
      }
      // A retention eviction can refresh a thread whose lease is dropping in the
      // same tick, so the refreshed snapshot may already have landed. Retention
      // no longer owns the entry, and eviction only runs from retention entries,
      // so without this the restored slices stay in the store forever.
      releaseOrphanedThreadDetail({ releasedThreadIds: removals });
      await Promise.all(
        removals.map((threadId) =>
          api.orchestration.unsubscribeThread({ threadId }).catch(() => undefined),
        ),
      );

      for (const threadId of additions) {
        beginThreadSubscription(threadId);
        subscribedThreadIds.add(threadId);
      }
      await Promise.all(
        additions.map((threadId) =>
          api.orchestration
            .subscribeThread(buildThreadSubscribeInput(threadId))
            .catch(() => undefined),
        ),
      );
    };

    const enqueueThreadSubscriptionOperation = (operation: () => Promise<void>) => {
      reconcileThreadSubscriptionsChain = reconcileThreadSubscriptionsChain
        .catch(() => undefined)
        .then(operation);
      return reconcileThreadSubscriptionsChain;
    };

    const enqueueThreadSubscriptionReconcile = (threadIds: readonly ThreadId[]) => {
      const nextThreadIds = [...threadIds];
      return enqueueThreadSubscriptionOperation(() => reconcileThreadSubscriptions(nextThreadIds));
    };

    const refreshThreadSnapshot = (threadId: ThreadId): Promise<void> => {
      if (threadSnapshotRequestInFlight.has(threadId)) {
        // The in-flight snapshot predates whatever triggered this call (a
        // retention eviction wiped detail the running request cannot know about),
        // so re-arm instead of dropping it and leaving the thread blank.
        threadSnapshotRefreshPending.add(threadId);
        return Promise.resolve();
      }
      threadSnapshotRequestInFlight.add(threadId);
      return enqueueThreadSubscriptionOperation(async () => {
        if (disposed || !subscribedThreadIds.has(threadId)) {
          return;
        }
        await api.orchestration.unsubscribeThread({ threadId }).catch(() => undefined);
        if (disposed || !subscribedThreadIds.has(threadId)) {
          return;
        }
        // Every caller of this restart wants authoritative history (wiped or
        // never-synced detail), so a cursor resume would skip exactly the
        // snapshot being requested.
        clearThreadDetailResumeCursor(threadId);
        await api.orchestration.subscribeThread({ threadId }).catch(() => undefined);
      }).finally(() => {
        threadSnapshotRequestInFlight.delete(threadId);
        if (!threadSnapshotRefreshPending.delete(threadId)) {
          return;
        }
        if (disposed || !subscribedThreadIds.has(threadId)) {
          return;
        }
        void refreshThreadSnapshot(threadId);
      });
    };

    const shouldApplyBootstrapShellSnapshot = (snapshot: OrchestrationShellSnapshot) => {
      if (disposed) {
        return false;
      }
      const currentState = useStore.getState();
      if (!currentState.threadsHydrated) {
        return true;
      }
      // Desktop can briefly hydrate from an empty startup stream before the
      // projection reader is fully ready. Let the later non-empty shell query win.
      return (
        (currentState.spaces.length === 0 && snapshot.spaces.length > 0) ||
        (currentState.projects.length === 0 && snapshot.projects.length > 0) ||
        ((currentState.threadIds?.length ?? 0) === 0 && snapshot.threads.length > 0)
      );
    };

    function collectSubscribedDraftsInShell(
      threads: ReadonlyArray<OrchestrationShellSnapshot["threads"][number]>,
    ): ThreadId[] {
      const draftsByThreadId = useComposerDraftStore.getState().draftThreadsByThreadId;
      return threads
        .map((thread) => thread.id)
        .filter((threadId) => subscribedThreadIds.has(threadId) && threadId in draftsByThreadId);
    }

    function reconcileMissingSubscribedThreadProjections(threadIds: readonly ThreadId[]) {
      for (const threadId of threadIds) {
        if (!threadSnapshotSequenceById.has(threadId)) {
          void reconcileThreadProjection(threadId).catch(() => undefined);
        }
      }
    }

    const loadShellSnapshotOnce = async () => {
      if (disposed) return;
      const snapshot = await api.orchestration.getShellSnapshot();
      if (disposed) return;
      if (!shouldApplyBootstrapShellSnapshot(snapshot)) {
        return;
      }
      const promotedDraftThreadIds = collectSubscribedDraftsInShell(snapshot.threads);
      shellSnapshotSequence = snapshot.snapshotSequence;
      syncServerShellSnapshot(snapshot);
      reconcilePromotedDraftsFromShellThreads(snapshot.threads);
      removeOrphanedTerminalsForCurrentState();
      flushShellBuffer(snapshot.snapshotSequence);
      reconcileMissingSubscribedThreadProjections(promotedDraftThreadIds);
    };

    let scopedSubscriptionRefresh: Promise<void> | null = null;
    const ensureScopedSubscriptions = () => {
      if (scopedSubscriptionRefresh) {
        return scopedSubscriptionRefresh;
      }
      const refresh = (async () => {
        shellSnapshotSequence = -1;
        pendingShellEvents = [];
        await api.orchestration.subscribeShell().catch(() => loadShellSnapshotOnce());
        await enqueueThreadSubscriptionOperation(async () => {
          threadSnapshotSequenceById.clear();
          pendingThreadEventsById.clear();
          threadSnapshotRequestInFlight.clear();
          threadSnapshotRefreshPending.clear();
          threadReplayRequestInFlight.clear();
          threadProjectionReconcileInFlight.clear();
          threadProjectionTerminalFencePending.clear();
          threadSubscriptionGenerationById.clear();
          nextThreadProjectionReconcileAtById.clear();
          threadCatchupBackoffById.clear();
          const previousThreadIds = [...subscribedThreadIds];
          subscribedThreadIds.clear();
          // Reconnect drops every lease at once, so the reconcile below sees no
          // removals to clean up. Free detail for threads that retention does not
          // own and the reconcile will not re-lease, while leaving the threads it
          // does re-lease untouched so a reconnect never blanks the open chat.
          releaseOrphanedThreadDetail({
            releasedThreadIds: previousThreadIds,
            keptThreadIds: new Set(visibleThreadIdsRef.current),
          });
          await Promise.all(
            previousThreadIds.map((threadId) =>
              api.orchestration.unsubscribeThread({ threadId }).catch(() => undefined),
            ),
          );
          await reconcileThreadSubscriptions(visibleThreadIdsRef.current);
        });
      })().finally(() => {
        if (scopedSubscriptionRefresh === refresh) {
          scopedSubscriptionRefresh = null;
        }
      });
      scopedSubscriptionRefresh = refresh;
      return refresh;
    };

    const removeOrphanedTerminalsForCurrentState = () => {
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: getThreadsFromState(useStore.getState()).map((thread) => ({
          id: thread.id,
          deletedAt: null,
          archivedAt: thread.archivedAt ?? null,
        })),
        draftThreadIds,
      });
      // Right-dock terminals live under a synthetic scope derived from each active
      // thread; retain those scopes so docked terminals are not pruned mid-session.
      // Snapshot first: we mutate the set while iterating its prior membership.
      for (const activeThreadId of Array.from(activeThreadIds)) {
        activeThreadIds.add(dockTerminalThreadId(activeThreadId));
      }
      removeOrphanedTerminalStates(activeThreadIds);
    };

    const flushPendingDomainEvents = () => {
      if (pendingDomainEvents.length > 0) {
        applyOrchestrationEventsHotPath(coalesceOrchestrationUiEvents(pendingDomainEvents));
        pendingDomainEvents = [];
      }
      if (needsProviderInvalidation) {
        needsProviderInvalidation = false;
        pendingProjectFileInvalidationThreadIds = new Set();
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      } else if (pendingProjectFileInvalidationThreadIds.size > 0) {
        // Mid-turn file-change activities: refresh the editor file tree and
        // open file preview for just the affected workspaces.
        const currentState = useStore.getState();
        const fileChangeCwds = new Set<string>();
        for (const threadId of pendingProjectFileInvalidationThreadIds) {
          const cwd = resolveGitInvalidationCwdForThreadId(currentState, threadId);
          if (cwd) {
            fileChangeCwds.add(cwd);
          }
        }
        pendingProjectFileInvalidationThreadIds = new Set();
        if (fileChangeCwds.size > 0) {
          void invalidateProjectFileQueriesForCwds(queryClient, fileChangeCwds);
        } else {
          void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
        }
      }
      if (pendingStudioOutputInvalidationThreadIds.size > 0) {
        // File-change activities cover non-Git Studio chats; finalized checkpoints cover Git.
        for (const threadId of pendingStudioOutputInvalidationThreadIds) {
          void queryClient.invalidateQueries({
            queryKey: serverQueryKeys.studioThreadOutputs(threadId),
          });
        }
        pendingStudioOutputInvalidationThreadIds = new Set();
      }
      if (needsBroadGitInvalidation) {
        needsBroadGitInvalidation = false;
        pendingGitInvalidationThreadIds = new Set();
        void invalidateGitQueries(queryClient);
      } else if (pendingGitInvalidationThreadIds.size > 0) {
        const currentState = useStore.getState();
        const scopedCwds = new Set<string>();
        let hasUnresolvedThread = false;
        for (const threadId of pendingGitInvalidationThreadIds) {
          const cwd = resolveGitInvalidationCwdForThreadId(currentState, threadId);
          if (cwd) {
            scopedCwds.add(cwd);
          } else {
            hasUnresolvedThread = true;
          }
        }
        pendingGitInvalidationThreadIds = new Set();
        if (hasUnresolvedThread || scopedCwds.size === 0) {
          void invalidateGitQueries(queryClient);
        } else {
          void invalidateGitQueriesForCwds(queryClient, scopedCwds);
        }
      }
    };

    const queueDomainEvent = (event: OrchestrationEvent) => {
      pendingDomainEvents.push(event);
      if (shouldInvalidateProviderQueriesForEvent(event)) {
        needsProviderInvalidation = true;
      }
      const projectFileThreadId = getProjectFileInvalidationThreadIdForEvent(event);
      if (projectFileThreadId) {
        pendingProjectFileInvalidationThreadIds.add(projectFileThreadId);
      }
      const studioOutputThreadId = getStudioOutputInvalidationThreadIdForEvent(event);
      if (studioOutputThreadId) {
        pendingStudioOutputInvalidationThreadIds.add(studioOutputThreadId);
      }
      if (shouldInvalidateGitQueriesForEvent(event)) {
        const threadId = getGitInvalidationThreadIdForEvent(event);
        if (threadId) {
          pendingGitInvalidationThreadIds.add(threadId);
        } else {
          needsBroadGitInvalidation = true;
        }
      }
      if (shouldFlushDomainEventImmediately(event, immediatelyFlushedAssistantMessageIds)) {
        domainEventFlushThrottler.cancel();
        flushPendingDomainEvents();
        return;
      }
      domainEventFlushThrottler.maybeExecute();
    };

    // Resolves the number of events actually applied, or null when the replay
    // was skipped (already in flight, no cursor, or target already reached) —
    // callers driving the poll backoff must not count a skip as an empty poll.
    const replayThreadEvents = async (
      threadId: ThreadId,
      targetSequence?: number,
    ): Promise<number | null> => {
      if (disposed || threadReplayRequestInFlight.has(threadId)) {
        return null;
      }
      const fromSequence = threadSnapshotSequenceById.get(threadId);
      if (
        fromSequence === undefined ||
        (targetSequence !== undefined && fromSequence >= targetSequence)
      ) {
        return null;
      }
      threadReplayRequestInFlight.add(threadId);
      // Promise chain keeps the run-always cleanup (finally) and lets a replay
      // rejection propagate to callers exactly as the try/finally did.
      return await api.orchestration
        .replayEvents(fromSequence, threadId)
        .then((replayedEvents) => {
          let appliedEventCount = 0;
          for (const event of replayedEvents
            .filter((candidate) => isThreadDetailEventForThread(candidate, threadId))
            .filter(
              (candidate) => targetSequence === undefined || candidate.sequence <= targetSequence,
            )
            .toSorted((left, right) => left.sequence - right.sequence)) {
            const latestThreadSequence = threadSnapshotSequenceById.get(threadId) ?? fromSequence;
            if (event.sequence <= latestThreadSequence) {
              continue;
            }
            if (!applyFencedThreadEvent(threadId, event)) {
              break;
            }
            appliedEventCount += 1;
          }
          if (appliedEventCount === 0) {
            // An empty replay is evidence of a quiet stream only if nothing
            // else moved the cursor while it ran. A replay raced by live
            // events (they applied first, so every replayed event was skipped)
            // must not feed the no-op backoff.
            const cursorAdvancedDuringReplay =
              (threadSnapshotSequenceById.get(threadId) ?? fromSequence) > fromSequence;
            return cursorAdvancedDuringReplay ? null : 0;
          }
          return appliedEventCount;
        })
        .finally(() => {
          threadReplayRequestInFlight.delete(threadId);
        });
    };

    const reconcileThreadProjection = async (threadId: ThreadId): Promise<void> => {
      const subscriptionGeneration = threadSubscriptionGenerationById.get(threadId);
      if (
        disposed ||
        !subscribedThreadIds.has(threadId) ||
        subscriptionGeneration === undefined ||
        threadProjectionReconcileInFlight.has(threadId)
      ) {
        return;
      }
      threadProjectionReconcileInFlight.set(threadId, subscriptionGeneration);
      let projectionConfirmed = false;
      let projectionAttemptFailed = false;
      try {
        const snapshot = await api.orchestration.getThreadDetailSnapshot({ threadId });
        if (
          snapshot === null ||
          disposed ||
          threadSubscriptionGenerationById.get(threadId) !== subscriptionGeneration ||
          !canApplyThreadSnapshot({ threadId, leasedThreadIds: subscribedThreadIds })
        ) {
          return;
        }
        const currentSequence = threadSnapshotSequenceById.get(threadId) ?? -1;
        // The RPC response can race a newer stream event. An older projection is
        // authoritative only for its own fence; applying it after the live cursor
        // advances would roll the thread back and the already-consumed event is no
        // longer buffered to restore it.
        if (snapshot.snapshotSequence < currentSequence) {
          return;
        }
        const currentThread = getThreadFromState(useStore.getState(), threadId);
        const projectionRepairsTerminalFence = threadProjectionTerminalFencePending.has(threadId);
        const projectionSettlesCurrentTurn =
          currentThread?.latestTurn?.state === "running" &&
          snapshot.thread.latestTurn !== null &&
          snapshot.thread.latestTurn.turnId === currentThread.latestTurn.turnId &&
          snapshot.thread.latestTurn.state !== "running" &&
          snapshot.thread.latestTurn.completedAt !== null;
        threadSnapshotSequenceById.set(
          threadId,
          Math.max(currentSequence, snapshot.snapshotSequence),
        );
        advanceThreadDetailResumeCursor(threadId, snapshot.snapshotSequence);
        // Apply even when the cursor did not advance. The projection is
        // authoritative and can repair a client that advanced its cursor while
        // dropping or failing to reduce one of the corresponding live events.
        const stateBeforeProjectionApply = useStore.getState();
        syncServerThreadDetailHotPath(snapshot.thread);
        reconcilePromotedDraftFromThreadDetail(snapshot.thread);
        flushThreadBuffer(threadId, snapshot.snapshotSequence);
        projectionConfirmed = true;
        // No-op: the live stream had already delivered everything the snapshot
        // contains AND applying it changed nothing (no divergence repaired).
        // Any real work — cursor advance or a store change — resets the streak.
        noteThreadReconcileResult(
          threadId,
          snapshot.snapshotSequence <= currentSequence &&
            useStore.getState() === stateBeforeProjectionApply,
        );
        if (projectionSettlesCurrentTurn || projectionRepairsTerminalFence) {
          // Mirror terminal-event invalidation when recovery came from the
          // projection rather than the live stream.
          needsProviderInvalidation = true;
          pendingGitInvalidationThreadIds.add(threadId);
          pendingStudioOutputInvalidationThreadIds.add(threadId);
          domainEventFlushThrottler.maybeExecute();
        }
      } catch (error) {
        projectionAttemptFailed = true;
        throw error;
      } finally {
        if (threadProjectionReconcileInFlight.get(threadId) === subscriptionGeneration) {
          threadProjectionReconcileInFlight.delete(threadId);
        }
        if (threadSubscriptionGenerationById.get(threadId) === subscriptionGeneration) {
          if (projectionAttemptFailed) {
            // A failed reconcile is not evidence of a quiet healthy stream.
            // Retry it at the base cadence, while preserving backoff when the
            // snapshot was merely superseded by newer live events.
            resolveThreadCatchupBackoff(threadId).reconcileNoopStreak = 0;
          }
          if (projectionConfirmed) {
            threadProjectionTerminalFencePending.delete(threadId);
          }
          if (
            threadProjectionTerminalFencePending.has(threadId) ||
            shouldReconcileThreadProjection(threadId) ||
            isDraftThreadAwaitingProjection(threadId)
          ) {
            nextThreadProjectionReconcileAtById.set(
              threadId,
              Date.now() + nextThreadProjectionReconcileDelayMs(threadId),
            );
          } else {
            nextThreadProjectionReconcileAtById.delete(threadId);
          }
        }
      }
    };

    const domainEventFlushThrottler = new Throttler(
      () => {
        flushPendingDomainEvents();
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    reconcileThreadSubscriptionsRef.current = (threadIds) =>
      enqueueThreadSubscriptionReconcile(threadIds);

    const unsubShellEvent = api.orchestration.onShellEvent((item) => {
      if (item.kind === "snapshot") {
        const promotedDraftThreadIds = collectSubscribedDraftsInShell(item.snapshot.threads);
        shellSnapshotSequence = item.snapshot.snapshotSequence;
        syncServerShellSnapshot(item.snapshot);
        reconcilePromotedDraftsFromShellThreads(item.snapshot.threads);
        removeOrphanedTerminalsForCurrentState();
        flushShellBuffer(item.snapshot.snapshotSequence);
        reconcileMissingSubscribedThreadProjections(promotedDraftThreadIds);
        return;
      }

      if (shellSnapshotSequence < 0) {
        appendBounded(pendingShellEvents, item, PENDING_SHELL_EVENT_BUFFER_LIMIT);
        return;
      }
      if (item.sequence <= shellSnapshotSequence) {
        return;
      }
      shellSnapshotSequence = item.sequence;
      applyShellEvent(item);
      if (item.kind === "thread-upserted") {
        reconcilePromotedDraftsFromShellThreads([item.thread]);
      }
      if (
        item.kind === "thread-upserted" &&
        subscribedThreadIds.has(item.thread.id) &&
        item.thread.session !== null &&
        isTerminalThreadSessionStatus(item.thread.session.status)
      ) {
        threadProjectionTerminalFencePending.add(item.thread.id);
        nextThreadProjectionReconcileAtById.set(
          item.thread.id,
          Date.now() + THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS,
        );
      }
      if (
        item.kind === "thread-upserted" &&
        subscribedThreadIds.has(item.thread.id) &&
        !threadSnapshotSequenceById.has(item.thread.id)
      ) {
        // The draft's live stream may still be waiting on a snapshot request
        // that started before the thread projection existed. Read the now-real
        // projection directly instead of restarting that stream on every shell
        // update; repeated ready/running/meta updates can otherwise keep
        // cancelling hydration before a snapshot reaches the renderer.
        void reconcileThreadProjection(item.thread.id).catch(() => undefined);
      }
      if (item.kind === "thread-upserted" && subscribedThreadIds.has(item.thread.id)) {
        void replayThreadEvents(item.thread.id, item.sequence).catch(() => undefined);
      }
    });
    const unsubThreadEvent = api.orchestration.onThreadEvent((item) => {
      if (item.kind === "snapshot") {
        const threadId = item.snapshot.thread.id;
        threadSnapshotRequestInFlight.delete(threadId);
        // The lease can drop while its refreshed snapshot is in flight. Applying it
        // then would restore detail slices that no retention entry owns, and since
        // eviction only runs from retention entries nothing would ever free them.
        if (!canApplyThreadSnapshot({ threadId, leasedThreadIds: subscribedThreadIds })) {
          threadSnapshotSequenceById.delete(threadId);
          pendingThreadEventsById.delete(threadId);
          clearThreadDetailResumeCursor(threadId);
          return;
        }
        syncServerThreadDetailHotPath(item.snapshot.thread);
        // The projection can discard a tombstoned snapshot (deleted thread or
        // project) instead of applying it; committing the cursor or the stream
        // fence first would leave resume bookkeeping vouching for detail that
        // was never stored. `threadDetailSyncById` flips to "synced" only when
        // the detail was actually applied.
        if (useStore.getState().threadDetailSyncById?.[threadId] !== "synced") {
          threadSnapshotSequenceById.delete(threadId);
          pendingThreadEventsById.delete(threadId);
          clearThreadDetailResumeCursor(threadId);
          return;
        }
        threadSnapshotSequenceById.set(threadId, item.snapshot.snapshotSequence);
        threadSnapshotNotFoundRetryAttempted.delete(threadId);
        // Snapshots replace cached detail wholesale, so overwrite the cursor
        // even when it is lower than the previous one (server-side reset).
        setThreadDetailResumeCursor(threadId, item.snapshot.snapshotSequence);
        nextThreadProjectionReconcileAtById.set(
          threadId,
          Date.now() + THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS,
        );
        reconcilePromotedDraftFromThreadDetail(item.snapshot.thread);
        flushThreadBuffer(threadId, item.snapshot.snapshotSequence);
        return;
      }

      const threadId = ThreadId.makeUnsafe(String(item.event.aggregateId));
      if (
        item.event.type === "thread.session-set" &&
        isTerminalThreadSessionStatus(item.event.payload.session.status)
      ) {
        threadProjectionTerminalFencePending.add(threadId);
        nextThreadProjectionReconcileAtById.set(
          threadId,
          Date.now() + THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS,
        );
      }
      const latestThreadSequence = threadSnapshotSequenceById.get(threadId);
      if (latestThreadSequence === undefined) {
        const pendingThreadEvents = pendingThreadEventsById.get(threadId) ?? [];
        appendBounded(pendingThreadEvents, item.event, PENDING_THREAD_EVENT_BUFFER_LIMIT);
        pendingThreadEventsById.set(threadId, pendingThreadEvents);
        if (subscribedThreadIds.has(threadId)) {
          void reconcileThreadProjection(threadId).catch(() => undefined);
        }
        return;
      }
      if (item.event.sequence <= latestThreadSequence) {
        return;
      }
      if (!applyFencedThreadEvent(threadId, item.event)) {
        return;
      }
      nextThreadProjectionReconcileAtById.set(
        threadId,
        Date.now() + THREAD_DETAIL_PROJECTION_RECONCILE_INTERVAL_MS,
      );
    });
    const unsubThreadStreamFailure = onThreadStreamFailure((failure) => {
      const threadId = ThreadId.makeUnsafe(failure.threadId);
      if (disposed || !subscribedThreadIds.has(threadId)) {
        return;
      }
      // The stream is dead with retries and reconnects exhausted: forget its
      // cursor so a future resubscribe requests a fresh snapshot, and surface
      // the failure so the thread view stops posing as an empty conversation.
      clearThreadDetailResumeCursor(threadId);
      threadSnapshotSequenceById.delete(threadId);
      threadSnapshotRequestInFlight.delete(threadId);
      threadSnapshotRefreshPending.delete(threadId);
      useStore.getState().markThreadDetailSyncFailed(threadId);
      if (
        failure.code === "THREAD_SNAPSHOT_NOT_FOUND" &&
        !threadSnapshotNotFoundRetryAttempted.has(threadId) &&
        getThreadFromState(useStore.getState(), threadId)
      ) {
        threadSnapshotNotFoundRetryAttempted.add(threadId);
        useStore.getState().clearThreadDetailSyncFailure(threadId);
        void refreshThreadSnapshot(threadId);
      }
    });
    // Retention can evict a thread's detail slices while its stream lease stays
    // active. The wiped messages never refresh on their own, so drop the cursor
    // and restart the stream to fetch a fresh snapshot.
    const unsubThreadDetailEviction = subscribeThreadDetailEvictions((threadId) => {
      // Retention already dropped the resume cursor when it wiped the detail;
      // here only the live-stream bookkeeping for leased threads remains.
      if (disposed || !subscribedThreadIds.has(threadId)) {
        return;
      }
      threadSnapshotSequenceById.delete(threadId);
      pendingThreadEventsById.set(threadId, []);
      void refreshThreadSnapshot(threadId);
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const terminalThreadId = ThreadId.makeUnsafe(event.threadId);
      if (event.type === "activity") {
        const terminalStore = useTerminalStateStore.getState();
        const currentCliKind =
          selectThreadTerminalState(terminalStore.terminalStateByThreadId, terminalThreadId)
            .terminalCliKindsById[event.terminalId] ?? null;
        if (event.cliKind || currentCliKind !== null) {
          terminalStore.setTerminalMetadata(terminalThreadId, event.terminalId, {
            cliKind: event.cliKind,
            label: event.cliKind ? defaultTerminalTitleForCliKind(event.cliKind) : "Terminal",
          });
        }
      }
      const activity = terminalActivityFromEvent(event);
      if (activity === null) {
        return;
      }
      useTerminalStateStore.getState().setTerminalActivity(terminalThreadId, event.terminalId, {
        hasRunningSubprocess: activity.hasRunningSubprocess,
        agentState: activity.agentState,
      });
    });
    // Dev servers are first-class server processes; mirror their lifecycle into the
    // client store so the sidebar indicator survives reconnects and stays consistent
    // across tabs without owning any thread/terminal state.
    const invalidateLocalServers = () => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
    };
    const unsubDevServerEvent = api.projects.onDevServerEvent((event) => {
      const store = useProjectRunStore.getState();
      if (event.type === "snapshot") {
        store.replaceAll(event.servers);
      } else if (event.type === "upserted") {
        store.upsertRun(event.server);
      } else {
        store.removeRun(event.projectId);
      }
      invalidateLocalServers();
    });
    // The channel's initial snapshot may have arrived before this listener was
    // registered, so seed from the authoritative registry on mount.
    void api.projects
      .listDevServers()
      .then(({ servers }) => {
        if (disposed) {
          return;
        }
        useProjectRunStore.getState().replaceAll(servers);
        invalidateLocalServers();
      })
      .catch(() => undefined);
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        setServerWorkspacePaths({
          homeDir: payload.homeDir,
          chatWorkspaceRoot: payload.chatWorkspaceRoot,
          studioWorkspaceRoot: payload.studioWorkspaceRoot,
        });
        await ensureScopedSubscriptions();
        if (disposed) {
          return;
        }
        await loadShellSnapshotOnce();

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);

        if (pathnameRef.current !== "/") {
          return;
        }
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });
    // onServerConfigUpdated replays the latest cached value synchronously
    // during subscribe. Skip the toast for that replay so effect re-runs
    // don't produce duplicate toasts.
    let subscribed = false;
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
      if (!subscribed) return;
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    const unsubProviderStatusesUpdated = onServerProviderStatusesUpdated((payload) => {
      const nextProviderDiscoveryFingerprint = providerModelDiscoveryInvalidationFingerprint(
        payload.providers,
      );
      const currentConfig = queryClient.getQueryData<ServerConfig>(serverQueryKeys.config());
      const previousProviderDiscoveryFingerprint =
        providerDiscoveryInvalidationFingerprint ??
        (currentConfig
          ? providerModelDiscoveryInvalidationFingerprint(currentConfig.providers)
          : null);
      const shouldInvalidateProviderDiscovery =
        previousProviderDiscoveryFingerprint !== null &&
        previousProviderDiscoveryFingerprint !== nextProviderDiscoveryFingerprint;
      providerDiscoveryInvalidationFingerprint = nextProviderDiscoveryFingerprint;

      void reconcileServerProviderStatuses(queryClient, payload.providers).catch(() => undefined);
      if (shouldInvalidateProviderDiscovery) {
        // Model and agent discovery can depend on auth, availability, and installed versions,
        // but not on every provider-status timestamp replay.
        void queryClient.invalidateQueries({
          queryKey: ["provider-discovery", "models", "kilo"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["provider-discovery", "models", "opencode"],
        });
        void queryClient.invalidateQueries({
          queryKey: ["provider-discovery", "models", "cursor"],
        });
        void queryClient.invalidateQueries({
          queryKey: providerDiscoveryQueryKeys.agentsForProvider("kilo"),
        });
        void queryClient.invalidateQueries({
          queryKey: providerDiscoveryQueryKeys.agentsForProvider("opencode"),
        });
      }
    });
    const unsubWsTransportState = addWsTransportStateListener(
      (state) => {
        if (state !== "open") return;
        // Reopening the socket is a projection boundary. React Query otherwise
        // keeps the previous infinite-stale config and can strand "Checking".
        void refreshServerConfigAfterTransportOpen(queryClient).catch(() => undefined);
      },
      { replayCurrent: true },
    );
    const unsubServerSettingsUpdated = onServerSettingsUpdated((payload) => {
      queryClient.setQueryData(serverQueryKeys.settings(), payload.settings);
      void queryClient.invalidateQueries({
        queryKey: serverSettingsQueryOptions().queryKey,
      });
    });
    subscribed = true;
    void ensureScopedSubscriptions();
    // The shell stream normally delivers the sidebar snapshot. If it fails before
    // the first event, use the same lightweight query instead of the full history.
    const shellBootstrapFallbackTimer = window.setTimeout(() => {
      void loadShellSnapshotOnce().catch(() => undefined);
    }, SHELL_SNAPSHOT_BOOTSTRAP_FALLBACK_DELAY_MS);
    const threadDetailCatchupInterval = window.setInterval(() => {
      const now = Date.now();
      let availableProjectionReconcileSlots = Math.max(
        0,
        THREAD_DETAIL_PROJECTION_RECONCILE_MAX_CONCURRENCY - threadProjectionReconcileInFlight.size,
      );
      for (const threadId of subscribedThreadIds) {
        const draftThreadAwaitingProjection = isDraftThreadAwaitingProjection(threadId);
        if (shouldPollThreadDetailCatchup(threadId)) {
          if (!threadSnapshotSequenceById.has(threadId)) {
            // Missing snapshot is a repair path — never backed off.
            void reconcileThreadProjection(threadId).catch(() => undefined);
          } else if (
            // A pending dispatch is the exact lost-event failure this poll
            // repairs, so it always polls at base cadence; otherwise honor the
            // empty-replay backoff (reset on any applied event or a new turn).
            hasPendingTurnDispatch(threadId) ||
            now >= resolveThreadCatchupBackoff(threadId).nextReplayAt
          ) {
            // A late replay result must not recreate backoff state for a thread
            // whose lease was dropped (cleanup deleted it) or re-leased (a new
            // generation starts fresh) while the request was in flight.
            const replaySubscriptionGeneration = threadSubscriptionGenerationById.get(threadId);
            void replayThreadEvents(threadId)
              .then((appliedEventCount) => {
                if (
                  appliedEventCount !== null &&
                  threadSubscriptionGenerationById.get(threadId) === replaySubscriptionGeneration
                ) {
                  noteThreadReplayResult(threadId, appliedEventCount);
                }
              })
              .catch(() => undefined);
          }
        }
        if (
          !threadProjectionTerminalFencePending.has(threadId) &&
          !shouldReconcileThreadProjection(threadId) &&
          !draftThreadAwaitingProjection
        ) {
          nextThreadProjectionReconcileAtById.delete(threadId);
          continue;
        }
        const nextProjectionReconcileAt = nextThreadProjectionReconcileAtById.get(threadId) ?? now;
        if (
          availableProjectionReconcileSlots > 0 &&
          !threadProjectionReconcileInFlight.has(threadId) &&
          now >= nextProjectionReconcileAt
        ) {
          availableProjectionReconcileSlots -= 1;
          void reconcileThreadProjection(threadId).catch(() => undefined);
        }
      }
    }, THREAD_DETAIL_CATCHUP_INTERVAL_MS);

    return () => {
      flushPendingDomainEvents();
      disposed = true;
      window.clearTimeout(shellBootstrapFallbackTimer);
      window.clearInterval(threadDetailCatchupInterval);
      needsProviderInvalidation = false;
      needsBroadGitInvalidation = false;
      pendingGitInvalidationThreadIds = new Set();
      pendingStudioOutputInvalidationThreadIds = new Set();
      threadProjectionReconcileInFlight.clear();
      threadProjectionTerminalFencePending.clear();
      threadSubscriptionGenerationById.clear();
      nextThreadProjectionReconcileAtById.clear();
      threadCatchupBackoffById.clear();
      domainEventFlushThrottler.cancel();
      reconcileThreadSubscriptionsRef.current = null;
      void api.orchestration.unsubscribeShell().catch(() => undefined);
      // Same shape as reconnect: every lease drops at once, and a remount re-leases
      // only the visible threads. Keeping those avoids blanking the open chat, and
      // anything recently viewed is owned by retention, which evicts it on schedule.
      releaseOrphanedThreadDetail({
        releasedThreadIds: [...subscribedThreadIds],
        keptThreadIds: new Set(visibleThreadIdsRef.current),
      });
      void Promise.all(
        [...subscribedThreadIds].map((threadId) =>
          api.orchestration.unsubscribeThread({ threadId }).catch(() => undefined),
        ),
      );
      unsubShellEvent();
      unsubThreadEvent();
      unsubThreadStreamFailure();
      unsubThreadDetailEviction();
      unsubTerminalEvent();
      unsubDevServerEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
      unsubProviderStatusesUpdated();
      unsubWsTransportState();
      unsubServerSettingsUpdated();
    };
  }, [
    applyOrchestrationEventsHotPath,
    applyShellEvent,
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    setServerWorkspacePaths,
    syncServerShellSnapshot,
    syncServerThreadDetailHotPath,
  ]);

  useLayoutEffect(() => {
    const reconcile = reconcileThreadSubscriptionsRef.current;
    if (!reconcile) {
      return;
    }
    void reconcile(subscribedThreadIds);
  }, [subscribedThreadIds]);

  return null;
}

function DesktopProjectBootstrap() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const projects = useStore((store) => store.projects);
  const threads = useStore(selectAllThreads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const recoveryAttemptGateRef = useRef<ReturnType<
    typeof createDesktopProjectRecoveryAttemptGate
  > | null>(null);
  if (recoveryAttemptGateRef.current === null) {
    recoveryAttemptGateRef.current = createDesktopProjectRecoveryAttemptGate();
  }
  const recoveryAttemptGate = recoveryAttemptGateRef.current;

  useEffect(() => {
    let disposed = false;
    const api = readNativeApi();
    if (!api || !threadsHydrated) {
      return;
    }

    const projectIds = new Set(projects.map((project) => project.id));
    const hasThreadWithoutProject = threads.some((thread) => !projectIds.has(thread.projectId));
    if (projects.length > 0 && !hasThreadWithoutProject) {
      return;
    }

    const attempt = recoveryAttemptGate.begin();
    if (!attempt) return;
    const ownsAttempt = () => !disposed && attempt.isCurrent();

    // Shell subscriptions should normally hydrate the sidebar. If project rows
    // are missing while live threads exist, repair before accepting the snapshot.
    void api.orchestration
      .getShellSnapshot()
      .then((snapshot) => {
        if (!ownsAttempt()) return;
        const needsRepair = shouldRepairDesktopProjectSnapshot(snapshot);
        if (!needsRepair) {
          if (!ownsAttempt() || !attempt.complete()) return;
          useStore.getState().syncServerShellSnapshot(snapshot);
          return;
        }
        return api.orchestration.repairState().then((repairedSnapshot) => {
          if (!ownsAttempt() || !attempt.complete()) return;
          syncServerReadModel(repairedSnapshot);
        });
      })
      .catch(() => {
        attempt.release();
      });

    return () => {
      disposed = true;
      attempt.release();
    };
  }, [projects, recoveryAttemptGate, syncServerReadModel, threads, threadsHydrated]);

  // Desktop hydration normally runs through EventRouter project + orchestration sync.
  return null;
}
const selectAllThreads = createAllThreadsSelector();
