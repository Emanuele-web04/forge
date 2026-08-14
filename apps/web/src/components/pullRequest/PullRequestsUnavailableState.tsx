// FILE: PullRequestsUnavailableState.tsx
// Purpose: Actionable empty state for the pull requests surface when the GitHub CLI is missing,
//          unauthenticated, or a request otherwise failed — each case gets a short explanation
//          and a copyable terminal command instead of a dead end.
// Layer: Pull request presentation
// Exports: PullRequestsUnavailableState, isPullRequestsUnavailableError

import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon, GitPullRequestIcon, TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { PR_FINE_TEXT_CLASS_NAME, PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

export function isPullRequestsUnavailableError(
  error: unknown,
): error is { _tag: "PullRequestsUnavailableError"; reason: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PullRequestsUnavailableError"
  );
}

function githubCliInstallCommand(platform: string): string | null {
  if (/mac/i.test(platform)) return "brew install gh";
  if (/win/i.test(platform)) return "winget install --id GitHub.cli";
  return null;
}

/** A single copyable terminal command — the `brew install gh` / `gh auth login` affordances. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        void copyTextToClipboard(command).then(
          () => {
            if (!mountedRef.current) return;
            setCopied(true);
            if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
            resetTimerRef.current = window.setTimeout(() => {
              resetTimerRef.current = null;
              setCopied(false);
            }, 1500);
          },
          (error) => {
            if (!mountedRef.current) return;
            toastManager.add({
              type: "error",
              title: "Could not copy command",
              description: error instanceof Error ? error.message : "Clipboard access failed.",
            });
          },
        );
      }}
      title="Copy to clipboard"
      className="group flex w-full items-center gap-2 rounded-lg border border-border/60 bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-left transition-colors hover:border-border"
    >
      <code
        className={cn(PR_META_TEXT_CLASS_NAME, "min-w-0 flex-1 truncate font-mono text-foreground")}
      >
        {command}
      </code>
      <span
        className={cn(
          PR_FINE_TEXT_CLASS_NAME,
          "flex shrink-0 items-center gap-1 text-muted-foreground transition-colors group-hover:text-foreground",
          copied && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {copied ? (
          <>
            <CheckIcon className="size-3" /> Copied
          </>
        ) : (
          <>
            <CopyIcon className="size-3" /> Copy
          </>
        )}
      </span>
    </button>
  );
}

export function PullRequestsUnavailableState({
  error,
  onRetry,
}: {
  error: unknown;
  /** Optional refetch hook so "Retry" re-runs the failed query instead of reloading the app. */
  onRetry?: () => void;
}) {
  const unavailable = isPullRequestsUnavailableError(error) ? error : null;
  const notInstalled = unavailable?.reason === "gh-not-installed";
  const notAuthenticated = unavailable?.reason === "gh-not-authenticated";
  const installCommand =
    notInstalled && typeof navigator !== "undefined"
      ? githubCliInstallCommand(navigator.platform)
      : null;

  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GitPullRequestIcon />
        </EmptyMedia>
        <EmptyTitle>
          {notInstalled
            ? "GitHub CLI is required"
            : notAuthenticated
              ? "Sign in to GitHub CLI"
              : "Pull requests are unavailable"}
        </EmptyTitle>
        <EmptyDescription>
          {notInstalled
            ? "Synara reads GitHub data only through the gh CLI. Install it, then reopen this view."
            : notAuthenticated
              ? "Authenticate the GitHub CLI in a terminal, then retry."
              : error instanceof Error
                ? error.message
                : "The pull request request failed."}
        </EmptyDescription>
      </EmptyHeader>
      {notInstalled || notAuthenticated ? (
        <EmptyContent>
          {notAuthenticated ? <CommandLine command="gh auth login" /> : null}
          {installCommand ? <CommandLine command={installCommand} /> : null}
          <div className="flex w-full items-center gap-2">
            {notInstalled ? (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => void ensureNativeApi().shell.openExternal("https://cli.github.com/")}
              >
                Install instructions
              </Button>
            ) : null}
            {onRetry ? (
              <Button
                variant={notInstalled ? "ghost" : "outline"}
                size="sm"
                className="flex-1"
                onClick={onRetry}
              >
                Retry
              </Button>
            ) : null}
          </div>
        </EmptyContent>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            className={cn(
              PR_META_TEXT_CLASS_NAME,
              "flex items-center gap-1.5 text-muted-foreground",
            )}
          >
            <TriangleAlertIcon className="size-3.5" />
            <span>Check your connection and try again.</span>
          </div>
          {onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </Empty>
  );
}
