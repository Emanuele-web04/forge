// FILE: authSignedOut.ts
// Purpose: Replaces authenticated application state after the current browser session logs out.

export const AUTH_SIGNED_OUT_PATH = "/signed-out";

function renderSignedOutScreen(): void {
  const root = document.getElementById("root");
  if (!root) return;

  document.title = "Signed out · Synara";
  root.innerHTML = `
    <main aria-labelledby="signed-out-title" style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;padding:32px;background:#10110f;color:#f3f0e8;font-family:'DM Sans',sans-serif">
      <section style="position:relative;width:min(100%,560px);overflow:hidden;border:1px solid #373a34;background:#171915;padding:clamp(30px,6vw,56px);box-shadow:12px 12px 0 #080907">
        <div aria-hidden="true" style="position:absolute;inset:0 0 auto auto;width:128px;height:8px;background:#d6ff55"></div>
        <p style="margin:0 0 22px;color:#d6ff55;font:600 12px/1.2 'JetBrains Mono',monospace;letter-spacing:.16em;text-transform:uppercase">Session closed</p>
        <h1 id="signed-out-title" tabindex="-1" style="max-width:470px;margin:0;color:#fffdf7;font-size:clamp(36px,7vw,58px);font-weight:600;line-height:.96;letter-spacing:-.05em">This browser no longer controls Synara.</h1>
        <p style="max-width:440px;margin:26px 0 0;color:#b8bbb2;font-size:16px;line-height:1.65">The session and its live connections were revoked. To reconnect, generate a fresh pairing link from an active owner session and open it in this browser.</p>
      </section>
    </main>`;
  root.querySelector<HTMLElement>("h1")?.focus();
}

export function bootstrapSignedOutScreen(
  input: {
    readonly pathname: string;
    readonly render: () => void;
  } = {
    pathname: window.location.pathname,
    render: renderSignedOutScreen,
  },
): boolean {
  if (input.pathname !== AUTH_SIGNED_OUT_PATH) return false;
  input.render();
  return true;
}
