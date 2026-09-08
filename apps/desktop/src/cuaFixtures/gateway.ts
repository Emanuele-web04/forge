import { BrowserWindow } from "electron";
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { ComputerManager } from "../../../server/src/computer/ComputerManager";
import type { CuaComputerBackend } from "../../../server/src/computer/CuaComputerBackend";
import { makeAgentGatewayComputerTools } from "../../../server/src/agentGateway/computerTools";
import { GatewayToolError, type ToolContext } from "../../../server/src/agentGateway/toolRuntime";
import type { McpToolCallResult } from "../../../server/src/agentGateway/protocol";

/** Real handlers, frame ownership, manager and native host. The caller is a
 * controlled provider context, not a paid model turn. Foreground is denied. */
export async function runGatewayFixture(
  backend: CuaComputerBackend,
  directory: string,
  actionCount: () => number,
  approveCapture: (windowId: string) => void,
) {
  const title = `Synara Cua Fixture ${process.pid}`;
  const first = new BrowserWindow({ title: `${title} A`, width: 640, height: 420, x: 80, y: 80 });
  const sibling = new BrowserWindow({
    title: `${title} B`,
    width: 320,
    height: 220,
    x: 760,
    y: 100,
    show: false,
  });
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const cases: Array<Record<string, unknown>> = [];
  const approvals: Array<{ name: string; turnId: string | null; allowed: false }> = [];
  let active = true;
  const thread = `fixture-gateway-${process.pid}`;
  const turn = `${thread}-turn`;
  const context: ToolContext = {
    principal: {
      kind: "provider-session",
      sessionKey: thread,
      threadId: thread,
      turnId: turn,
      provider: "codex",
    },
    callerSessionKey: thread,
    callerThreadId: thread,
    callerTurnId: turn,
    callerThreadLabel: "Owned fixture",
    callerProvider: "codex",
    callerCapabilities: new Set(["computer:control"]),
    jsonRpcRequestId: 1,
    assertCallerTurnActive: () =>
      active
        ? Effect.void
        : Effect.fail(
            new GatewayToolError("fixture_turn_ended", "The controlled fixture turn ended."),
          ),
  };
  const entries = makeAgentGatewayComputerTools({
    manager,
    authorizeAction: async (name, _args, caller) => {
      approvals.push({ name, turnId: caller.callerTurnId, allowed: false });
      return false;
    },
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const entry = entries.find((tool) => tool.definition.name === name);
    if (!entry) throw new Error(`Missing fixture tool ${name}`);
    return Effect.runPromise(entry.handler(args, context));
  };
  const payload = (result: McpToolCallResult) => {
    const block = result.content.find((part) => part.type === "text");
    if (block?.type !== "text") return {};
    try {
      return JSON.parse(block.text);
    } catch {
      return { error: block.text };
    }
  };
  const saveImage = async (result: McpToolCallResult, name: string) => {
    const block = result.content.find((part) => part.type === "image");
    if (block?.type === "image")
      await writeFile(join(directory, name), Buffer.from(block.data, "base64"));
  };
  try {
    await first.loadURL(
      `data:text/html,${encodeURIComponent(`<title>${title} A</title><style>body{font:20px system-ui;padding:32px}button{font:24px system-ui;padding:18px}</style><h1>Synara gateway fixture</h1><button id="counter">Counter: 0</button><script>window.clicks=0;counter.onclick=()=>{counter.textContent='Counter: '+(++window.clicks)}</script>`)}`,
    );
    await sibling.loadURL(
      `data:text/html,${encodeURIComponent(`<title>${title} B</title><h1>Owned sibling</h1>`)}`,
    );
    sibling.showInactive();
    await pause(300);
    const windows = await backend.listWindows();
    const owned = (label: string) =>
      windows.filter(
        (window) => window.pid === process.pid && window.title === `${title} ${label}`,
      );
    if (owned("A").length !== 1 || owned("B").length !== 1)
      throw new Error("Gateway fixture identity is ambiguous; no input sent.");
    const target = owned("A")[0]!;
    const other = owned("B")[0]!;
    approveCapture(target.id);
    await manager.setControlEnabled(thread, true);
    const observation = await call("computer_get_state", {
      window_id: target.id,
      include_screenshot: true,
    });
    const frame = payload(observation).screenshot;
    if (
      observation.isError ||
      frame?.windowId !== target.id ||
      !frame?.screenshotId ||
      !(frame.scale > 0)
    )
      throw new Error("Gateway observation lost its exact-window frame; no input sent.");
    await saveImage(observation, "gateway-before.png");
    const button = await first.webContents.executeJavaScript(
      "(()=>{const r=document.querySelector('#counter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    );
    const content = first.getContentBounds();
    const point = {
      x: (content.x + button.x - frame.region.x) * frame.scale,
      y: (content.y + button.y - frame.region.y) * frame.scale,
      screenshot_id: frame.screenshotId,
    };
    let before = actionCount();
    const mismatch = await call("computer_click", {
      ...point,
      window_id: other.id,
      include_screenshot: false,
    });
    cases.push({
      name: "different-window-frame",
      status: mismatch.isError && actionCount() === before ? "passed" : "failed",
      error: payload(mismatch).error,
    });

    before = actionCount();
    const clicked = await call("computer_click", { ...point, window_id: target.id });
    const clicks = await first.webContents.executeJavaScript("window.clicks");
    const clickedPayload = payload(clicked);
    cases.push({
      name: "gateway-native-click",
      status:
        !clicked.isError &&
        clicks === 1 &&
        actionCount() === before + 1 &&
        clickedPayload.screenshot?.windowId === target.id
          ? "passed"
          : "failed",
      clicks,
      nativeSubmissions: actionCount() - before,
      delivery: clickedPayload.delivery,
      screenshotWindowId: clickedPayload.screenshot?.windowId,
      error: clickedPayload.error,
    });
    await saveImage(clicked, "gateway-after.png");

    before = actionCount();
    const denied = await call("computer_type_text", {
      window_id: target.id,
      text: "must not arrive",
      delivery_mode: "foreground",
      include_screenshot: false,
    });
    cases.push({
      name: "foreground-denial-before-native",
      status:
        denied.isError &&
        actionCount() === before &&
        approvals.length === 1 &&
        approvals[0]?.turnId === turn
          ? "passed"
          : "failed",
      nativeSubmissions: actionCount() - before,
    });

    await manager.setControlEnabled(thread, false);
    before = actionCount();
    const disabled = await call("computer_click", {
      ...point,
      window_id: target.id,
      include_screenshot: false,
    });
    const unchanged = await first.webContents.executeJavaScript("window.clicks");
    cases.push({
      name: "off-refuses-native-input",
      status:
        disabled.isError && actionCount() === before && unchanged === clicks ? "passed" : "failed",
      nativeSubmissions: actionCount() - before,
      error: payload(disabled).error,
    });

    await manager.setControlEnabled(thread, true);
    active = false;
    before = actionCount();
    const ended = await call("computer_click", {
      ...point,
      window_id: target.id,
      include_screenshot: false,
    });
    cases.push({
      name: "ended-turn-refuses-native-input",
      status: ended.isError && actionCount() === before ? "passed" : "failed",
      nativeSubmissions: actionCount() - before,
      error: payload(ended).error,
    });
    return {
      caller: "controlled-provider-context",
      target: { pid: target.pid, id: target.id, title: target.title },
      approvals,
      cases,
    };
  } catch (error) {
    return { error: String(error), approvals, cases };
  } finally {
    await manager.dispose();
    first.destroy();
    sibling.destroy();
  }
}
