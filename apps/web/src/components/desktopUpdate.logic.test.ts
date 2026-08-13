import { describe, expect, it } from "vitest";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@synara/contracts";

import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateAlreadyCurrentNotice,
  getDesktopUpdateButtonLabel,
  getDesktopUpdateButtonVariant,
  getDesktopUpdateButtonPresentation,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateDownloadPercent,
  getDesktopUpdateErrorSignature,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldHighlightDesktopUpdateError,
  shouldRecommendManualDesktopDownload,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  installFailureCount: 0,
  releaseUrl: null,
};

describe("desktop update button state", () => {
  it("hides the button when idle (no update available)", () => {
    expect(shouldShowDesktopUpdateButton(baseState)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(baseState)).toBe("check");
    expect(getDesktopUpdateButtonTooltip(baseState)).toBe("Check for updates");
  });

  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(false);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("rebuilds updater state after a failed install restart", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      downloadedVersion: null,
      message: "Synara restarted before the update was installed.",
      errorContext: "install",
      canRetry: true,
      installFailureCount: 1,
    };

    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(false);
    expect(getDesktopUpdateButtonLabel(state)).toBe("Retry");
    expect(getDesktopUpdateButtonTooltip(state)).toBe(
      "Synara restarted, but update 1.1.0 was not installed. Click to try again.",
    );
  });

  it("keeps update errors with known versions actionable even when context is missing", () => {
    expect(
      resolveDesktopUpdateButtonAction({
        ...baseState,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "native updater failed",
        errorContext: null,
        canRetry: true,
      }),
    ).toBe("install");

    expect(
      resolveDesktopUpdateButtonAction({
        ...baseState,
        status: "error",
        availableVersion: "1.1.0",
        message: "native updater failed",
        errorContext: null,
        canRetry: true,
      }),
    ).toBe("download");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("check");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to check again");
  });

  it("hides non-actionable update errors without a known version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "native updater failed",
      errorContext: "install",
      canRetry: false,
    };

    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
    expect(getDesktopUpdateButtonLabel(state)).toBe("Preparing");
    expect(getDesktopUpdateButtonPresentation(state)).toEqual({
      label: "Preparing",
      secondaryLabel: null,
    });
    expect(getDesktopUpdateDownloadPercent(state)).toBe(42);
  });

  it("surfaces a clamped integer download percentage only while downloading", () => {
    expect(getDesktopUpdateDownloadPercent(null)).toBeNull();
    expect(
      getDesktopUpdateDownloadPercent({
        ...baseState,
        status: "downloading",
        downloadPercent: null,
      }),
    ).toBeNull();
    expect(
      getDesktopUpdateDownloadPercent({
        ...baseState,
        status: "downloading",
        downloadPercent: 37.9,
      }),
    ).toBe(37);
    expect(
      getDesktopUpdateDownloadPercent({
        ...baseState,
        status: "downloading",
        downloadPercent: 126.9,
      }),
    ).toBe(100);
    expect(
      getDesktopUpdateDownloadPercent({ ...baseState, status: "downloading", downloadPercent: -8 }),
    ).toBe(0);
    // Percentage stays hidden outside the active download (e.g. ready to install).
    expect(
      getDesktopUpdateDownloadPercent({ ...baseState, status: "downloaded", downloadPercent: 100 }),
    ).toBeNull();
  });

  it("keeps update checks hidden while a check is in flight", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
    };

    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("check");
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Checking for updates");
    expect(getDesktopUpdateButtonLabel(state)).toBe("Checking...");
  });

  it("shows retry labels for actionable update errors", () => {
    expect(
      getDesktopUpdateButtonLabel({
        ...baseState,
        status: "error",
        availableVersion: "1.1.0",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe("Retry");

    expect(
      getDesktopUpdateButtonLabel({
        ...baseState,
        status: "error",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        errorContext: "install",
        canRetry: true,
      }),
    ).toBe("Retry");
  });

  it("shows failure labels while keeping retryable updater states actionable", () => {
    const downloadFailure: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "checksum mismatch",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(downloadFailure)).toBe("download");
    expect(getDesktopUpdateButtonLabel(downloadFailure)).toBe("Retry");
    expect(getDesktopUpdateButtonTooltip(downloadFailure)).toContain("Click to retry");

    const installFailure: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(installFailure)).toBe("install");
    expect(getDesktopUpdateButtonLabel(installFailure)).toBe("Retry");
    expect(getDesktopUpdateButtonTooltip(installFailure)).toContain("Click to retry");
  });

  it("shows explicit updating state when install is in progress", () => {
    const installingState: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
    };
    const presentation = getDesktopUpdateButtonPresentation(installingState, { installing: true });
    expect(presentation.label).toBe("Updating...");
    expect(getDesktopUpdateButtonTooltip(installingState, { installing: true })).toBe(
      "Applying update...",
    );
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("getDesktopUpdateAlreadyCurrentNotice", () => {
  it("returns an info notice when a download/install resolves to up-to-date", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "up-to-date",
        currentVersion: "1.0.0",
      },
    };
    expect(getDesktopUpdateAlreadyCurrentNotice(result)).toBe(
      "You're already on the latest version (1.0.0).",
    );
  });

  it("returns null when the action completed", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: { ...baseState, status: "up-to-date" },
    };
    expect(getDesktopUpdateAlreadyCurrentNotice(result)).toBeNull();
  });

  it("returns null when the version was genuinely actionable", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
      },
    };
    expect(getDesktopUpdateAlreadyCurrentNotice(result)).toBeNull();
  });
});

describe("getDesktopUpdateButtonVariant", () => {
  it("uses the installing variant while an install is in progress", () => {
    expect(
      getDesktopUpdateButtonVariant(
        { ...baseState, status: "downloaded", downloadedVersion: "1.1.0" },
        { installing: true },
      ),
    ).toBe("installing");
  });

  it("renders a failed install as error even though status stays downloaded", () => {
    expect(
      getDesktopUpdateButtonVariant({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: "shutdown timeout",
        errorContext: "install",
        canRetry: true,
      }),
    ).toBe("error");
  });

  it("renders a failed download as error", () => {
    expect(
      getDesktopUpdateButtonVariant({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe("error");
  });

  it("maps healthy updater states to their own variants", () => {
    expect(
      getDesktopUpdateButtonVariant({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
      }),
    ).toBe("ready");
    expect(
      getDesktopUpdateButtonVariant({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 40,
      }),
    ).toBe("progress");
    expect(
      getDesktopUpdateButtonVariant({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
      }),
    ).toBe("info");
    expect(getDesktopUpdateButtonVariant(null)).toBe("info");
  });
});

describe("desktop update UI helpers", () => {
  it("toasts only for accepted incomplete actions", () => {
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: false,
        state: baseState,
      }),
    ).toBe(true);
    expect(
      shouldToastDesktopUpdateActionResult({
        accepted: true,
        completed: true,
        state: baseState,
      }),
    ).toBe(false);
  });

  it("highlights only actionable updater errors", () => {
    expect(
      shouldHighlightDesktopUpdateError({
        ...baseState,
        status: "available",
        errorContext: "download",
        canRetry: true,
      }),
    ).toBe(true);
    expect(
      shouldHighlightDesktopUpdateError({
        ...baseState,
        status: "error",
        errorContext: "check",
        canRetry: true,
      }),
    ).toBe(false);
  });

  it("recommends a manual download after repeated install failures", () => {
    expect(
      shouldRecommendManualDesktopDownload({
        ...baseState,
        installFailureCount: 2,
        releaseUrl: "https://example.com/releases",
      }),
    ).toBe(true);
    expect(
      shouldRecommendManualDesktopDownload({
        ...baseState,
        installFailureCount: 1,
        releaseUrl: "https://example.com/releases",
      }),
    ).toBe(false);
    expect(
      shouldRecommendManualDesktopDownload({
        ...baseState,
        installFailureCount: 3,
        releaseUrl: null,
      }),
    ).toBe(false);
  });

  it("includes the install failure count in error signatures", () => {
    const failedState = {
      ...baseState,
      status: "error" as const,
      availableVersion: "1.1.0",
      errorContext: "install" as const,
      message: "Install failed",
    };

    expect(getDesktopUpdateErrorSignature({ ...failedState, installFailureCount: 1 })).not.toBe(
      getDesktopUpdateErrorSignature({ ...failedState, installFailureCount: 2 }),
    );
  });

  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is being prepared", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("preparing");
  });
});
