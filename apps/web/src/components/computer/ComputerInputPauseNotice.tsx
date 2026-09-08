import type { ComputerInputPause, ComputerWindow } from "@synara/contracts";
import { useState } from "react";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";

/** Readiness is an observation. It never raises a window or replays an action. */
export function ComputerInputPauseNotice({
  pause,
  windows,
}: {
  pause: ComputerInputPause;
  windows: readonly ComputerWindow[];
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const window = windows.find((item) => item.id === pause.windowId);
  const target = window?.appName ?? window?.title ?? "the target window";
  const check = async () => {
    if (!pause.windowId || checking) return;
    setChecking(true);
    setError(null);
    try {
      const state = await ensureNativeApi().computer.getState({
        windowId: pause.windowId,
        includeScreenshot: false,
      });
      if (state.inputPause)
        setError(
          "The window is still unavailable for input. Restore it on this desktop, then check again.",
        );
    } catch {
      setError("Could not check the window. Try again after returning to it.");
    } finally {
      setChecking(false);
    }
  };
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-3 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">Input paused — return to {target}</p>
        <p className="text-muted-foreground">
          {error ??
            "Bring the window onto this desktop, or exit the full-screen app, then check again. Continue from the current page once input is available."}
        </p>
      </div>
      {pause.windowId ? (
        <Button variant="outline" size="xs" disabled={checking} onClick={check}>
          {checking ? "Checking…" : "Check again"}
        </Button>
      ) : null}
    </div>
  );
}
