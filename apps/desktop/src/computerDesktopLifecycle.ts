/** Translate OS desktop availability into independent, composable input gates. */
export interface ComputerDesktopLifecycleHost {
  pauseDesktop(reason: string): Promise<void>;
  resumeDesktop(reason: string): void;
}

interface DesktopPowerMonitor {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
  getSystemIdleState(seconds: number): string;
}

export function registerComputerDesktopLifecycle(
  monitor: DesktopPowerMonitor,
  host: ComputerDesktopLifecycleHost,
  onError: (error: unknown) => void,
): () => void {
  const registrations: Array<readonly [string, () => void]> = [];
  const register = (event: string, listener: () => void) => {
    monitor.on(event, listener);
    registrations.push([event, listener]);
  };
  const pause = (reason: string) => {
    void host.pauseDesktop(reason).catch(onError);
  };
  for (const [pauseEvent, resumeEvent, reason] of [
    ["lock-screen", "unlock-screen", "screen-lock"],
    ["suspend", "resume", "system-sleep"],
    ["user-did-resign-active", "user-did-become-active", "user-session"],
  ] as const) {
    register(pauseEvent, () => pause(reason));
    register(resumeEvent, () => host.resumeDesktop(reason));
  }
  // Events alone miss an app launched while the screen is already locked.
  if (monitor.getSystemIdleState(1) === "locked") pause("screen-lock");
  return () => {
    for (const [event, listener] of registrations) monitor.removeListener(event, listener);
  };
}
