// FILE: desktopUpdate.logic.ts
// Purpose: Maps desktop updater state into sidebar button actions, copy, and variants.
// Layer: Web UI state helper
// Depends on: Desktop update IPC contracts.

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@synara/contracts";

export type DesktopUpdateButtonAction = "check" | "download" | "install" | "none";

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.status === "idle" ||
    state.status === "checking" ||
    state.status === "up-to-date" ||
    (state.status === "error" && state.errorContext === "check")
  ) {
    return "check";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && !state.downloadedVersion && state.availableVersion) {
      return "download";
    }
    if (
      state.downloadedVersion &&
      (state.errorContext === "install" || state.errorContext === null)
    ) {
      return "install";
    }
    if (
      state.availableVersion &&
      (state.errorContext === "download" || state.errorContext === null)
    ) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state?.enabled) return false;
  // Only show the button when there's actually something to do:
  // a version being prepared, a downloaded update to install, or a retryable error.
  // Update checks stay background-only so periodic polling never flashes sidebar UI.
  const action = resolveDesktopUpdateButtonAction(state);
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded" ||
    (state.status === "error" && state.errorContext !== "check" && action !== "none")
  );
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return (
    state?.status === "downloading" ||
    state?.status === "checking" ||
    (state?.status === "available" && state.errorContext !== "download")
  );
}

export interface DesktopUpdateButtonPresentation {
  label: string;
  secondaryLabel: string | null;
}

export function getDesktopUpdateButtonPresentation(
  state: DesktopUpdateState | null,
  options?: { installing?: boolean },
): DesktopUpdateButtonPresentation {
  if (options?.installing) {
    return {
      label: "Updating...",
      secondaryLabel: null,
    };
  }

  if (!state) {
    return {
      label: "Update",
      secondaryLabel: null,
    };
  }

  if (state.status === "checking") {
    return {
      label: "Checking...",
      secondaryLabel: null,
    };
  }

  if (state.status === "downloading") {
    return {
      label: "Preparing",
      secondaryLabel: null,
    };
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    if (state.errorContext === "download" || state.errorContext === "install") {
      return {
        label: "Retry",
        secondaryLabel: null,
      };
    }
    return {
      label: "Preparing",
      secondaryLabel: null,
    };
  }
  if (action === "install") {
    if (state.errorContext === "install") {
      return {
        label: "Retry",
        secondaryLabel: null,
      };
    }
    return {
      label: "Update",
      secondaryLabel: null,
    };
  }
  if (action === "check") {
    return {
      label: "Check updates",
      secondaryLabel: null,
    };
  }
  return {
    label: "Update",
    secondaryLabel: null,
  };
}

export function getDesktopUpdateButtonLabel(state: DesktopUpdateState | null): string {
  return getDesktopUpdateButtonPresentation(state).label;
}

/**
 * Clamped, integer download percentage to surface on the update button while a
 * download is in flight. Returns null outside the downloading state or when the
 * updater has not reported a finite percentage yet.
 */
export function getDesktopUpdateDownloadPercent(state: DesktopUpdateState | null): number | null {
  if (!state || state.status !== "downloading") return null;
  const percent = state.downloadPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but Synara is still running the Intel build under Rosetta. Synara is preparing the native Apple Silicon update.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but Synara is still running the Intel build under Rosetta. Click Update to restart into the native Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but Synara is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  options?: { installing?: boolean },
): string {
  if (options?.installing) {
    return "Applying update...";
  }
  if (state.status === "idle") {
    return "Check for updates";
  }
  if (state.status === "checking") {
    return "Checking for updates...";
  }
  if (state.status === "up-to-date") {
    return `You're up to date on ${state.currentVersion}. Click to check again.`;
  }
  if (state.errorContext === "install" && !state.downloadedVersion && state.availableVersion) {
    return `Synara restarted, but update ${state.availableVersion} was not installed. Click to try again.`;
  }
  if (state.errorContext === "download" && state.availableVersion) {
    return `Could not prepare update ${state.availableVersion}. Click to retry.`;
  }
  if (state.errorContext === "install" && (state.downloadedVersion || state.availableVersion)) {
    return `Could not install update ${state.downloadedVersion ?? state.availableVersion}. Click to retry.`;
  }
  if (state.status === "available") {
    return `Preparing update ${state.availableVersion ?? ""}`.trim();
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Preparing update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} is ready. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "check") {
      return state.message
        ? `${state.message}. Click to check again.`
        : "Update check failed. Click to try again.";
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return `Could not prepare update ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Could not install update ${state.downloadedVersion}. Click to retry.`;
    }
    return state.message ?? "Update failed";
  }
  return "Update available";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

// A download/install request can resolve to "up-to-date" when the offered version
// turned out not to be newer (stale updater state). That is not an error, so the UI
// should show an informational notice instead of silently resetting the button.
export function getDesktopUpdateAlreadyCurrentNotice(
  result: DesktopUpdateActionResult,
): string | null {
  if (result.completed || result.state.status !== "up-to-date") {
    return null;
  }
  return `You're already on the latest version (${result.state.currentVersion}).`;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state) return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function shouldRecommendManualDesktopDownload(state: DesktopUpdateState | null): boolean {
  return Boolean(state && state.installFailureCount >= 2 && state.releaseUrl);
}

// Stable identity for an in-app update failure, used to avoid toasting the same
// download/install error twice (e.g. once from the click handler and again when
// the install watchdog pushes the recovered state). Returns null for states that
// have no actionable manual-download fallback (checks, successes, in-progress).
export function getDesktopUpdateErrorSignature(state: DesktopUpdateState | null): string | null {
  if (!state || (state.errorContext !== "download" && state.errorContext !== "install")) {
    return null;
  }
  const version = state.downloadedVersion ?? state.availableVersion ?? "";
  return `${state.errorContext}:${version}:${state.installFailureCount}:${state.message ?? ""}`;
}

export type DesktopUpdateButtonVariant = "installing" | "ready" | "progress" | "error" | "info";

/**
 * Resolve the severity/color variant for the update button.
 *
 * A failed install keeps `status === "downloaded"` (with `errorContext === "install"`),
 * so the error state must be evaluated before the happy "downloaded"/"downloading"
 * states — otherwise a failed install would render with the green "ready" color while
 * its label says "Retry".
 */
export function getDesktopUpdateButtonVariant(
  state: DesktopUpdateState | null,
  options?: { installing?: boolean },
): DesktopUpdateButtonVariant {
  if (options?.installing) return "installing";
  if (shouldHighlightDesktopUpdateError(state)) return "error";
  if (state?.status === "downloaded") return "ready";
  if (state?.status === "downloading") return "progress";
  return "info";
}
