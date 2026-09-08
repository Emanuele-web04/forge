import { createServer, type Server } from "node:http";

export interface VisibleBrowserFixtureSite {
  readonly initialUrl: string;
  readonly appUrl: string;
  readonly nextUrl: string;
  readonly redirectUrl: string;
  readonly close: () => Promise<void>;
}

const INITIAL_HTML = `<!doctype html><html><head><title>Initial fixture</title></head><body><h1>Initial page</h1></body></html>`;

const APP_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Visible browser fixture</title>
    <script>
      window.__annotationHostileCapture = [];
      window.__annotationUnexpectedKeyups = [];
      window.addEventListener("keyup", (event) => {
        window.__annotationUnexpectedKeyups.push(event.key);
      }, true);
      for (const type of ["pointerdown", "pointerup", "pointercancel", "pointerrawupdate", "mousedown", "mousemove", "mouseup", "auxclick", "contextmenu", "click", "keydown", "keypress", "keyup", "beforeinput", "input", "paste", "compositionupdate"]) {
        window.addEventListener(type, (event) => {
          const picker = document.querySelector("[data-synara-browser-annotations][data-interactive]");
          if (!picker) return;
          window.__annotationHostileCapture.push({
            type,
            key: typeof event.key === "string" ? event.key : "",
            data: typeof event.data === "string" ? event.data : "",
          });
        }, true);
      }
    </script>
    <style>
      body { margin: 0; min-height: 2600px; font: 16px system-ui, sans-serif; }
      main { padding: 20px; }
      label, button { display: block; margin: 0 0 18px; }
      input { width: 280px; height: 28px; }
      #manual { width: 180px; height: 42px; }
      #private-editor-wrap { width: 320px; padding: 18px; border: 1px solid #444; }
      #private-editor { width: 240px; padding: 8px; }
      #hover-result { visibility: hidden; }
      #hover-target:hover + #hover-result { visibility: visible; }
      #drag-source, #drop-target { width: 180px; min-height: 36px; padding: 8px; border: 1px solid #444; }
      #covered-wrap { position: relative; width: 180px; }
      #covered-overlay { position: absolute; inset: 0; z-index: 2; background: rgba(255, 255, 255, .01); }
      #bottom { position: absolute; top: 2450px; }
    </style>
  </head>
  <body data-agent-clicks="0" data-agent-click-trusted="false" data-point-clicks="0" data-manual-clicks="0" data-presses="0" data-key-trusted="false" data-input-trusted="false" data-drag-mousedown="0" data-drag-mousemove="0" data-dragstart="0" data-dragend="0" data-drop="0">
    <main>
      <label>Shared input <input aria-label="Shared input" /></label>
      <button id="agent" type="button">Commit agent action</button>
      <button id="point" type="button">Commit point action</button>
      <input id="manual" type="button" value="Manual Playwright action" />
      <section id="private-editor-wrap">
        <div id="private-editor" contenteditable="true">Private draft must not be captured</div>
      </section>
      <button id="hover-target" type="button">Reveal hover state</button>
      <span id="hover-result">Trusted hover revealed</span>
      <label>Fixture choice
        <select id="fixture-select" aria-label="Fixture choice">
          <option value="alpha">Alpha</option>
          <option value="beta">Beta</option>
          <option value="gamma">Gamma</option>
        </select>
      </label>
      <p id="select-state">Selected: alpha</p>
      <label>Fixture upload <input id="fixture-upload" aria-label="Fixture upload" type="file" multiple /></label>
      <p id="upload-state">Uploaded: none</p>
      <div id="drag-source" role="button" tabindex="0" draggable="true">Drag source</div>
      <div id="drop-target" role="button" tabindex="0">Drop target</div>
      <p id="drag-state">Dragged: no</p>
      <button id="alert-dialog" type="button">Open alert dialog</button>
      <button id="confirm-dialog" type="button">Open confirm dialog</button>
      <button id="prompt-dialog" type="button">Open prompt dialog</button>
      <p id="dialog-state">Dialog result: none</p>
      <button id="emit-logs" type="button">Emit fixture logs</button>
      <a id="next-page" href="/next">Go to next fixture page</a>
      <a id="download" href="/download">Download fixture</a>
      <button id="oauth-popup" type="button">Open OAuth popup</button>
      <a id="new-tab" href="/popup" target="_blank">Open fixture tab</a>
      <button id="disabled-action" type="button" disabled>Disabled action</button>
      <div id="covered-wrap">
        <button id="covered-action" type="button">Covered action</button>
        <span id="covered-overlay" aria-hidden="true"></span>
      </div>
      <p id="state">Agent clicks: 0; Point clicks: 0; Manual clicks: 0; Presses: 0</p>
      <p id="delayed" hidden>Delayed fixture ready</p>
      <p id="bottom">Bottom marker</p>
    </main>
    <script>
      const state = document.querySelector("#state");
      const agent = document.querySelector("#agent");
      const point = document.querySelector("#point");
      const manual = document.querySelector("#manual");
      const hoverTarget = document.querySelector("#hover-target");
      const hoverResult = document.querySelector("#hover-result");
      const fixtureSelect = document.querySelector("#fixture-select");
      const selectState = document.querySelector("#select-state");
      const fixtureUpload = document.querySelector("#fixture-upload");
      const uploadState = document.querySelector("#upload-state");
      const dragSource = document.querySelector("#drag-source");
      const dropTarget = document.querySelector("#drop-target");
      const dragState = document.querySelector("#drag-state");
      const alertDialog = document.querySelector("#alert-dialog");
      const confirmDialog = document.querySelector("#confirm-dialog");
      const promptDialog = document.querySelector("#prompt-dialog");
      const dialogState = document.querySelector("#dialog-state");
      const emitLogs = document.querySelector("#emit-logs");
      const oauthPopup = document.querySelector("#oauth-popup");
      const delayed = document.querySelector("#delayed");
      const sharedInput = document.querySelector('input[aria-label="Shared input"]');
      const render = () => {
        state.textContent = \`Agent clicks: \${document.body.dataset.agentClicks}; Point clicks: \${document.body.dataset.pointClicks}; Manual clicks: \${document.body.dataset.manualClicks}; Presses: \${document.body.dataset.presses}\`;
      };
      agent.addEventListener("click", (event) => {
        document.body.dataset.agentClicks = String(Number(document.body.dataset.agentClicks) + 1);
        document.body.dataset.agentClickTrusted = String(event.isTrusted);
        document.cookie = "shared_cookie=agent; SameSite=Lax";
        render();
      });
      point.addEventListener("click", (event) => {
        const rect = point.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (inside) document.body.dataset.pointClicks = String(Number(document.body.dataset.pointClicks) + 1);
        render();
      });
      manual.addEventListener("click", () => {
        document.body.dataset.manualClicks = String(Number(document.body.dataset.manualClicks) + 1);
        document.cookie = "manual_cookie=playwright; SameSite=Lax";
        render();
      });
      hoverTarget.addEventListener("mouseenter", (event) => {
        hoverResult.dataset.trusted = String(event.isTrusted);
      });
      sharedInput.addEventListener("input", (event) => {
        document.body.dataset.inputTrusted = String(event.isTrusted);
      });
      fixtureSelect.addEventListener("change", () => {
        selectState.textContent = "Selected: " + fixtureSelect.value;
      });
      fixtureUpload.addEventListener("change", () => {
        uploadState.textContent = "Uploaded: " + Array.from(fixtureUpload.files || [])
          .map((file) => file.name + ":" + file.size).join(",");
      });
      dragSource.addEventListener("dragstart", (event) => {
        document.body.dataset.dragstart = String(Number(document.body.dataset.dragstart) + 1);
        event.dataTransfer?.setData("text/plain", "synara-drag");
      });
      dragSource.addEventListener("mousedown", (event) => {
        document.body.dataset.dragButtons = String(event.buttons);
        document.body.dataset.dragMousedown = String(Number(document.body.dataset.dragMousedown) + 1);
      });
      dragSource.addEventListener("mousemove", () => {
        document.body.dataset.dragMousemove = String(Number(document.body.dataset.dragMousemove) + 1);
      });
      dragSource.addEventListener("dragend", () => {
        document.body.dataset.dragend = String(Number(document.body.dataset.dragend) + 1);
      });
      dropTarget.addEventListener("dragover", (event) => event.preventDefault());
      dropTarget.addEventListener("drop", (event) => {
        event.preventDefault();
        document.body.dataset.drop = String(Number(document.body.dataset.drop) + 1);
        dragState.textContent = "Dragged: " +
          (event.dataTransfer?.getData("text/plain") === "synara-drag" ? "yes" : "event");
      });
      alertDialog.addEventListener("click", () => {
        alert("Fixture alert");
        dialogState.textContent = "Dialog result: alert-continued";
      });
      confirmDialog.addEventListener("click", () => {
        dialogState.textContent = "Dialog result: confirm-" + String(confirm("Fixture confirm"));
      });
      promptDialog.addEventListener("click", () => {
        dialogState.textContent = "Dialog result: prompt-" + String(prompt("Fixture prompt", "default"));
      });
      emitLogs.addEventListener("click", async () => {
        console.warn("Fixture console warning");
        await fetch("/api/fixture", {
          method: "POST",
          headers: { "x-fixture-secret": "SECRET_HEADER_MUST_NOT_LEAK" },
          body: "SECRET_BODY_MUST_NOT_LEAK",
        });
        document.body.dataset.logsEmitted = "true";
      });
      oauthPopup.addEventListener("click", () => {
        window.open("/oauth", "oauthWindow", "width=480,height=640");
      });
      document.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          document.body.dataset.presses = String(Number(document.body.dataset.presses) + 1);
          document.body.dataset.keyTrusted = String(event.isTrusted);
          render();
        }
      });
      setTimeout(() => { delayed.hidden = false; }, 75);
    </script>
  </body>
</html>`;

const NEXT_HTML = `<!doctype html><html><head><title>Next fixture</title></head><body>
  <h1>Next fixture page</h1><a href="/app">Return to app fixture</a>
</body></html>`;

const POPUP_HTML = `<!doctype html><html><head><title>Popup fixture</title></head><body>
  <h1>Agent-created fixture tab</h1><button type="button">Popup action</button>
</body></html>`;

const OAUTH_HTML = `<!doctype html><html><head><title>OAuth fixture</title></head><body>
  <h1>Complete fixture sign-in</h1><button type="button">Continue manually</button>
</body></html>`;

const SIGNIN_HTML = `<!doctype html><html><head><title>Sign-in fixture</title></head><body>
  <label>Email <input type="email" /></label>
  <label>Password <input type="password" /></label>
  <button type="button" onclick="document.querySelector('#mode').textContent='Log In selected'">Log In</button>
  <button type="button" onclick="document.querySelector('#mode').textContent='Google selected'">Continue with Google</button>
  <p id="mode">Sign Up selected</p>
</body></html>`;

const HTML_BY_PATH: Readonly<Record<string, string>> = {
  "/app": APP_HTML,
  "/next": NEXT_HTML,
  "/oauth": OAUTH_HTML,
  "/popup": POPUP_HTML,
  "/signin": SIGNIN_HTML,
};

export async function startVisibleBrowserFixtureSite(): Promise<VisibleBrowserFixtureSite> {
  const server: Server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://fixture.test").pathname;
    if (requestPath === "/redirect") {
      response.statusCode = 302;
      response.setHeader("Location", "/next");
      response.end();
      return;
    }
    if (requestPath === "/api/fixture") {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath === "/download") {
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", 'attachment; filename="fixture-download.txt"');
      response.setHeader("Cache-Control", "no-store");
      response.end("agent-download-must-not-be-written\n");
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(HTML_BY_PATH[requestPath] ?? INITIAL_HTML);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture site did not bind TCP.");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    initialUrl: `${origin}/initial`,
    appUrl: `${origin}/app`,
    nextUrl: `${origin}/next`,
    redirectUrl: `${origin}/redirect`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
