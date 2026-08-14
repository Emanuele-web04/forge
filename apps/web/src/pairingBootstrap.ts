// FILE: pairingBootstrap.ts
// Purpose: Exchanges one-time remote pairing links before the application opens a WebSocket.

const PAIRING_PATH = "/pair";

interface PairingLocation {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  replace(url: string): void;
}

interface PairingHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

interface PairingBootstrapDependencies {
  readonly location: PairingLocation;
  readonly history: PairingHistory;
  readonly fetch: typeof globalThis.fetch;
  readonly renderFailure: () => void;
}

export type PairingBootstrapResult = "not-pairing" | "redirecting" | "failed";

function renderPairingFailure(): void {
  const root = document.getElementById("root");
  if (!root) return;

  document.title = "Pairing failed · Synara";
  root.innerHTML = `
    <main role="alert" aria-live="assertive" style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px;background:#10110f;color:#f3f0e8;font-family:'DM Sans',sans-serif">
      <section style="width:min(100%,520px);border:1px solid #373a34;background:#171915;padding:clamp(28px,6vw,52px);box-shadow:12px 12px 0 #080907">
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'Geist Mono',monospace;letter-spacing:.16em;text-transform:uppercase">Secure pairing interrupted</p>
        <h1 tabindex="-1" style="margin:0;color:#fffdf7;font-size:clamp(32px,7vw,52px);font-weight:600;line-height:.98;letter-spacing:-.045em">This pairing link could not be used.</h1>
        <p style="margin:24px 0 0;color:#b8bbb2;font-size:16px;line-height:1.6">The link may be incomplete, expired, or already used. Generate a new pairing link from the Synara server and try again.</p>
      </section>
    </main>`;
  root.querySelector<HTMLElement>("h1")?.focus();
}

export async function bootstrapPairingSession(
  dependencies: PairingBootstrapDependencies = {
    location: window.location,
    history: window.history,
    fetch: globalThis.fetch,
    renderFailure: renderPairingFailure,
  },
): Promise<PairingBootstrapResult> {
  if (dependencies.location.pathname !== PAIRING_PATH) {
    return "not-pairing";
  }

  const credential = new URLSearchParams(dependencies.location.hash.slice(1)).get("token");
  dependencies.history.replaceState(
    null,
    "",
    `${dependencies.location.pathname}${dependencies.location.search}`,
  );

  if (!credential) {
    dependencies.renderFailure();
    return "failed";
  }

  try {
    const response = await dependencies.fetch("/api/auth/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (!response.ok) {
      dependencies.renderFailure();
      return "failed";
    }
  } catch {
    dependencies.renderFailure();
    return "failed";
  }

  dependencies.location.replace("/");
  return "redirecting";
}
