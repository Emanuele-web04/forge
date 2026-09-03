import type { ResolvedThreadWorkspaceState } from "@synara/shared/threadEnvironment";
import type { ProviderInteractionMode } from "@synara/contracts";
import type { DraftThreadEnvMode } from "../../composerDraftStore";
import {
  type ContextWindowSnapshot,
  formatContextWindowTokens,
  formatCostUsd,
} from "../../lib/contextWindow";
import type { RateLimitStatus } from "./RateLimitBanner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ContextWindowMeter } from "./ContextWindowMeter";

function formatRateLimitMessage(rateLimitStatus: RateLimitStatus): string {
  const resetSuffix = rateLimitStatus.resetsAt
    ? ` Resets at ${new Date(rateLimitStatus.resetsAt).toLocaleTimeString()}.`
    : "";
  if (rateLimitStatus.status === "rejected") {
    return `Rate limit reached.${resetSuffix}`;
  }
  const utilizationSuffix =
    typeof rateLimitStatus.utilization === "number"
      ? ` (${Math.round(rateLimitStatus.utilization * 100)}% used)`
      : "";
  return `Approaching rate limit${utilizationSuffix}.${resetSuffix}`;
}

function formatEnvironmentLabel(
  envMode: DraftThreadEnvMode,
  envState: ResolvedThreadWorkspaceState,
): string {
  if (envMode === "local") {
    return "Local";
  }
  return envState === "worktree-pending" ? "New worktree (pending)" : "Worktree";
}

export function ComposerSlashStatusDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedModel: string | null | undefined;
  fastModeEnabled: boolean;
  selectedPromptEffort: string | null;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  envState: ResolvedThreadWorkspaceState;
  branch: string | null;
  contextWindow: ContextWindowSnapshot | null;
  cumulativeCostUsd: number | null;
  rateLimitStatus: RateLimitStatus | null;
  activeContextWindowLabel?: string | null;
  pendingContextWindowLabel?: string | null;
}) {
  const {
    open,
    onOpenChange,
    selectedModel,
    fastModeEnabled,
    selectedPromptEffort,
    interactionMode,
    envMode,
    envState,
    branch,
    contextWindow,
    cumulativeCostUsd,
    rateLimitStatus,
    activeContextWindowLabel,
    pendingContextWindowLabel,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Session Status</DialogTitle>
          <DialogDescription>
            Runtime controls and local thread state for the active composer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-4 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Model</p>
              <p className="font-medium text-foreground">{selectedModel}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Fast Mode</p>
              <p className="font-medium text-foreground">{fastModeEnabled ? "On" : "Off"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Reasoning</p>
              <p className="font-medium text-foreground">{selectedPromptEffort ?? "Default"}</p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Mode</p>
              <p className="font-medium text-foreground">
                {interactionMode === "plan"
                  ? "Plan"
                  : interactionMode === "debug"
                    ? "Debug"
                    : "Default"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Environment</p>
              <p className="font-medium text-foreground">
                {formatEnvironmentLabel(envMode, envState)}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Branch</p>
              <p className="font-medium text-foreground">{branch ?? "Unknown"}</p>
            </div>
          </div>

          <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Context Window</p>
                <p className="text-sm text-muted-foreground">
                  Latest usage reported by the active thread.
                </p>
                {pendingContextWindowLabel ? (
                  <p className="text-sm text-muted-foreground">
                    Current session: {activeContextWindowLabel ?? "Unknown"}. Next turn:{" "}
                    {pendingContextWindowLabel}.
                  </p>
                ) : null}
              </div>
              {contextWindow ? (
                <ContextWindowMeter
                  usage={contextWindow}
                  cumulativeCostUsd={cumulativeCostUsd}
                  activeWindowLabel={activeContextWindowLabel}
                  pendingWindowLabel={pendingContextWindowLabel}
                />
              ) : null}
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              {contextWindow ? (
                <>
                  <div>
                    <p className="text-muted-foreground">Used</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.usedTokens)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Remaining</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.remainingTokens)}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Window</p>
                    <p className="font-medium text-foreground">
                      {formatContextWindowTokens(contextWindow.maxTokens)}
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <p className="text-muted-foreground">Context usage</p>
                  <p className="font-medium text-foreground">Not reported yet</p>
                </div>
              )}
              <div>
                <p className="text-muted-foreground">Cost</p>
                <p className="font-medium text-foreground">
                  {cumulativeCostUsd !== null ? formatCostUsd(cumulativeCostUsd) : "Not available"}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border/60 bg-card p-4">
            <p className="text-xs text-muted-foreground">Rate Limits</p>
            {rateLimitStatus ? (
              <p className="text-sm text-foreground">{formatRateLimitMessage(rateLimitStatus)}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No active rate-limit warning for this thread.
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
