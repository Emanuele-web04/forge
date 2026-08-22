// FILE: initialBackendWindowOpen.ts
// Purpose: Coordinates first packaged-window reveal without waiting on backend readiness.
// Layer: Desktop startup utility
// Exports: openInitialBackendWindow

export type BackendWindowReadySource = "listening" | "http";

export interface InitialBackendWindowOpenOptions {
  readonly isDevelopment: boolean;
  readonly baseUrl: string;
  readonly hasExistingWindow: () => boolean;
  readonly createWindow: () => void;
  readonly getReadinessInFlight: () => Promise<void> | null;
  readonly setReadinessInFlight: (promise: Promise<void> | null) => void;
  readonly waitForBackendWindowReady: (baseUrl: string) => Promise<BackendWindowReadySource>;
  readonly writeLog: (message: string) => void;
  readonly isReadinessAborted: (error: unknown) => boolean;
  readonly formatErrorMessage: (error: unknown) => string;
  readonly warn: (message: string, error: unknown) => void;
}

export function openInitialBackendWindow(options: InitialBackendWindowOpenOptions): void {
  if (options.isDevelopment || options.baseUrl.length === 0) {
    return;
  }

  if (!options.hasExistingWindow()) {
    // The packaged renderer is served from local files, so surface the window
    // while the backend finishes startup instead of leaving macOS menu-bar-only.
    options.createWindow();
    options.writeLog("bootstrap main window created");
  }

  if (options.getReadinessInFlight() !== null) {
    return;
  }

  const nextOpen = options
    .waitForBackendWindowReady(options.baseUrl)
    .then((source) => {
      options.writeLog(`bootstrap backend ready source=${source}`);
    })
    .catch((error) => {
      if (options.isReadinessAborted(error)) {
        return;
      }
      options.writeLog(
        `bootstrap backend readiness warning message=${options.formatErrorMessage(error)}`,
      );
      options.warn("[desktop] backend readiness observation ended before startup completed", error);
    })
    .finally(() => {
      if (options.getReadinessInFlight() === nextOpen) {
        options.setReadinessInFlight(null);
      }
    });

  options.setReadinessInFlight(nextOpen);
}
