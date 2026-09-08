import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { CuaDriverHost } from "../cuaDriverHost";
import type { CuaComputerBackend } from "../../../server/src/computer/CuaComputerBackend";
import { withDesktopDeliveryMode } from "../../../server/src/computer/DesktopOperationQueue";

/** Application-owned event counts establish release; a transport reply alone
 * cannot prove that the target consumed the matching mouse/key up. */
export async function runCancellationFixture(
  backend: CuaComputerBackend,
  host: CuaDriverHost,
  approveCapture: (windowId: string) => void,
) {
  const title = `Synara Cua Fixture ${process.pid} C`;
  const channel = `fixture-cancel-${randomUUID()}`;
  const window = new BrowserWindow({
    title,
    width: 640,
    height: 420,
    x: 80,
    y: 80,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  let state = { mouseDown: 0, mouseUp: 0, dragged: 0, keyDown: 0, keyUp: 0, text: "", buttons: 0 };
  const update = (_event: unknown, value: typeof state) => {
    state = value;
  };
  ipcMain.on(channel, update);
  const cases: Array<Record<string, unknown>> = [];
  try {
    const html = `<!doctype html><title>${title}</title><style>body{font:18px system-ui;padding:20px}#drag{height:100px;background:#dce9ff}input{font:20px system-ui;width:95%;margin-top:24px}</style><h1>Cancellation fixture</h1><div id="drag">Owned drag target</div><input id="text" aria-label="Cancellation text"><script>
      const {ipcRenderer}=require('electron'), field=document.querySelector('#text');
      const state={mouseDown:0,mouseUp:0,dragged:0,keyDown:0,keyUp:0,text:'',buttons:0};
      function emit(){state.text=field.value;ipcRenderer.send(${JSON.stringify(channel)}, {...state})}
      document.addEventListener('mousedown',e=>{state.mouseDown++;state.buttons=e.buttons;emit()});
      document.addEventListener('mouseup',e=>{state.mouseUp++;state.buttons=e.buttons;emit()});
      document.addEventListener('mousemove',e=>{if(e.buttons){state.dragged++;emit()}});
      document.addEventListener('keydown',()=>{state.keyDown++;emit()});
      document.addEventListener('keyup',()=>{state.keyUp++;emit()});
      field.addEventListener('input',emit); emit();
    </script>`;
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // WindowServer publishes intermediate bounds during the macOS opening
    // animation. Wait for the fixture's declared frame before observing input.
    let matches: Awaited<ReturnType<CuaComputerBackend["listWindows"]>> = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      matches = (await backend.listWindows()).filter(
        (candidate) => candidate.pid === process.pid && candidate.title === title,
      );
      const declared = window.getBounds();
      const actual = matches[0]?.bounds;
      if (
        matches.length === 1 &&
        actual &&
        actual.x === declared.x &&
        actual.y === declared.y &&
        actual.width === declared.width &&
        actual.height === declared.height
      )
        break;
      await pause(50);
    }
    if (matches.length !== 1)
      throw new Error("Cancellation fixture identity is ambiguous; no input sent.");
    const target = matches[0]!;
    approveCapture(target.id);
    const observe = () => backend.getState({ windowId: target.id, includeScreenshot: true });
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!condition() && Date.now() < deadline) await pause(2);
      return condition();
    };
    await observe();
    const rect = await window.webContents.executeJavaScript(
      "(()=>{const r=document.querySelector('#drag').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()",
    );
    const content = window.getContentBounds();
    const start = { x: content.x + rect.x + 40, y: content.y + rect.y + rect.height / 2 };
    const click = backend.click(start, target.id).then(
      (result) => ({ result }),
      (error) => ({ error: String(error) }),
    );
    const sawDown = await waitFor(() => state.mouseDown > 0);
    const before = { ...state };
    const stoppedAt = performance.now();
    await host.stop();
    const stopMilliseconds = performance.now() - stoppedAt;
    const outcome = await click;
    await pause(200);
    const after = { ...state };
    await pause(350);
    cases.push({
      name: "cancel-held-click",
      status:
        sawDown &&
        before.mouseUp === 0 &&
        after.mouseDown === 1 &&
        after.mouseUp === 1 &&
        after.buttons === 0 &&
        after.mouseDown === state.mouseDown &&
        stopMilliseconds < 4_000
          ? "passed"
          : "failed",
      before,
      after,
      settled: { ...state },
      stopMilliseconds,
      outcome,
    });

    await observe();
    await window.webContents.executeJavaScript(
      "document.querySelector('#text').focus();document.querySelector('#text').select()",
    );
    const keyBaseline = { down: state.keyDown, up: state.keyUp };
    const text = "cancel-fixture-".repeat(60);
    const typing = backend.typeText(text, target.id).then(
      (result) => ({ result }),
      (error) => ({ error: String(error) }),
    );
    const sawKey = await waitFor(() => state.keyDown > keyBaseline.down);
    const keyBefore = { ...state };
    const keyStoppedAt = performance.now();
    await host.stop();
    const keyStopMilliseconds = performance.now() - keyStoppedAt;
    const keyOutcome = await typing;
    await pause(200);
    const keyAfter = { ...state };
    await pause(350);
    const down = keyAfter.keyDown - keyBaseline.down;
    const up = keyAfter.keyUp - keyBaseline.up;
    cases.push({
      name: "cancel-typing",
      status:
        sawKey &&
        down > 0 &&
        down === up &&
        keyAfter.text.length < text.length &&
        keyAfter.text === state.text &&
        keyAfter.keyDown === state.keyDown &&
        keyStopMilliseconds < 4_000
          ? "passed"
          : "failed",
      before: keyBefore,
      after: keyAfter,
      settled: { ...state },
      stopMilliseconds: keyStopMilliseconds,
      outcome: keyOutcome,
    });
    if (process.env.SYNARA_CUA_FIXTURE_FOREGROUND_CANCEL === "approved-once") {
      for (const mode of ["drag", "modified-click"] as const) {
        await observe();
        const baseline = { ...state };
        const operation = withDesktopDeliveryMode("foreground", () =>
          mode === "drag"
            ? backend.drag(start, { x: start.x + rect.width - 80, y: start.y }, 10_000, target.id)
            : backend.click(start, target.id, ["shift"]),
        ).then(
          (result) => ({ result }),
          (error) => ({ error: String(error) }),
        );
        const held = await waitFor(
          () =>
            state.mouseDown > baseline.mouseDown &&
            (mode !== "drag" || state.dragged > baseline.dragged),
        );
        const before = { ...state };
        const stopStarted = performance.now();
        await host.stop();
        const stopMilliseconds = performance.now() - stopStarted;
        const outcome = await operation;
        await pause(200);
        const after = { ...state };
        await pause(350);
        const matchingMouse =
          after.mouseDown - baseline.mouseDown === 1 && after.mouseUp - baseline.mouseUp === 1;
        const keyDownCount = after.keyDown - baseline.keyDown;
        const matchingKeys =
          keyDownCount === after.keyUp - baseline.keyUp &&
          (mode !== "modified-click" || keyDownCount > 0);
        const heldBefore =
          before.mouseDown > before.mouseUp &&
          (mode !== "drag" || before.dragged > baseline.dragged);
        cases.push({
          name: `foreground-cancel-${mode}`,
          status:
            held &&
            heldBefore &&
            matchingMouse &&
            matchingKeys &&
            after.buttons === 0 &&
            after.mouseDown === state.mouseDown &&
            after.dragged === state.dragged &&
            stopMilliseconds < 4_000
              ? "passed"
              : "failed",
          before,
          after,
          settled: { ...state },
          stopMilliseconds,
          outcome,
        });
      }
    } else {
      cases.push({
        name: "foreground-cancel-drag-and-modified-click",
        status: "not-run",
        reason: "Requires explicit authorization for these two foreground actions.",
      });
    }
    return { target: { id: target.id, pid: target.pid, title }, cases };
  } catch (error) {
    return { cases, error: String(error) };
  } finally {
    window.close();
    ipcMain.removeListener(channel, update);
  }
}
