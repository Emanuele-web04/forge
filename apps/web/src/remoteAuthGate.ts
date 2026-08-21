// FILE: remoteAuthGate.ts
// Purpose: Stops the remote WebUI from hanging unsigned-in on "Loading activity...".

import { isElectron } from "./env";

export const REMOTE_PAIRING_REQUIRED_PATH = "/pair";

interface AuthSessionResponse {
  readonly authenticated: boolean;
  readonly auth?: {
    readonly policy?: string;
  };
}

interface RemoteAuthGateDependencies {
  readonly isElectron: boolean;
  readonly pathname: string;
  readonly fetch: typeof globalThis.fetch;
  readonly render: () => void;
}

function renderRemotePairingRequired(): void {
  const root = document.getElementById("root");
  if (!root) return;

  document.title = "Pairing required · Synara";
  root.innerHTML = `
    <main role="alert" aria-live="assertive" style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px;background:#10110f;color:#f3f0e8;font-family:'DM Sans',sans-serif">
      <section style="width:min(100%,520px);border:1px solid #373a34;background:#171915;padding:clamp(28px,6vw,52px);box-shadow:12px 12px 0 #080907">
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'Geist Mono',monospace;letter-spacing:.16em;text-transform:uppercase">Remote access</p>
        <h1 tabindex="-1" style="margin:0;color:#fffdf7;font-size:clamp(32px,7vw,52px);font-weight:600;line-height:.98;letter-spacing:-.045em">This browser is not paired yet.</h1>
        <p style="margin:24px 0 0;color:#b8bbb2;font-size:16px;line-height:1.6">Open the full one-time pairing link from the Synara server in Chrome. Brave shields can block the session cookie and leave this empty loading screen.</p>
      </section>
    </main>`;
  root.querySelector<HTMLElement>("h1")?.focus();
}

export function shouldRequireRemotePairing(input: {
  readonly isElectron: boolean;
  readonly pathname: string;
  readonly authenticated: boolean;
  readonly policy: string | undefined;
}): boolean {
  if (input.isElectron) return false;
  if (input.pathname === REMOTE_PAIRING_REQUIRED_PATH) return false;
  if (input.authenticated) return false;
  return input.policy === "remote-reachable";
}

export async function bootstrapRemoteAuthGate(
  dependencies: RemoteAuthGateDependencies = {
    isElectron,
    pathname: window.location.pathname,
    fetch: globalThis.fetch,
    render: renderRemotePairingRequired,
  },
): Promise<"ok" | "blocked"> {
  if (dependencies.isElectron || dependencies.pathname === REMOTE_PAIRING_REQUIRED_PATH) {
    return "ok";
  }

  try {
    const response = await dependencies.fetch("/api/auth/session", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      dependencies.render();
      return "blocked";
    }
    const session = (await response.json()) as AuthSessionResponse;
    if (
      shouldRequireRemotePairing({
        isElectron: dependencies.isElectron,
        pathname: dependencies.pathname,
        authenticated: session.authenticated,
        policy: session.auth?.policy,
      })
    ) {
      dependencies.render();
      return "blocked";
    }
  } catch {
    dependencies.render();
    return "blocked";
  }

  return "ok";
}
