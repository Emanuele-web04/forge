import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type ServerConfig,
  type ServerSettingsView,
} from "@synara/contracts";

export function createBrowserTestServerConfig(checkedAt: string): ServerConfig {
  return {
    cwd: "/repo/project",
    worktreesDir: "/repo/.codex/worktrees",
    keybindingsConfigPath: "/repo/project/.synara-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        supportsAutoRuntimeMode: true,
        checkedAt,
      },
    ],
    availableEditors: [],
  };
}

/**
 * Server settings for full-app browser fixtures. The onboarding marker is set so the
 * first-run welcome tour (which gates on "no projects and never completed") does not open
 * over the surface under test; the tour has its own coverage.
 */
export function createBrowserTestServerSettings(completedAt: string): ServerSettingsView {
  return { ...DEFAULT_SERVER_SETTINGS_VIEW, onboardingCompletedAt: completedAt };
}

export function createFullscreenTestHost(): HTMLDivElement {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    display: "grid",
    overflow: "hidden",
  });
  document.body.append(host);
  return host;
}
