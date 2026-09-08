import { app, BrowserWindow, ipcMain } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { cuaRequest, CUA_HOST_SOCKET_ENV, type CuaReply } from "@synara/shared/cuaDriverProtocol";
import { CuaDriverHost } from "../cuaDriverHost";
import { pngDimensions } from "../../../server/src/pngHeader";

/** Runs the real server/provider/web client with the real GUI-owned Cua host.
 * The fixture-only socket restricts the native surface; it never manufactures
 * action success, a screenshot, a provider callback or an approval response. */
export async function runLiveFixture(directory: string, binaryPath: string) {
  const serverEntry = process.env.SYNARA_CUA_FIXTURE_SERVER;
  if (!serverEntry?.endsWith("/apps/server/dist/index.mjs"))
    throw new Error("An explicit built Synara server is required.");
  await readFile(serverEntry);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "README.md"),
    "Owned Synara Computer integration fixture. No repository changes are needed.\n",
  );
  const calls: Array<Record<string, unknown>> = [];
  const report: Record<string, unknown> = {
    mode: "live-provider",
    pid: process.pid,
    nativeBuild: JSON.parse(
      await readFile(join(process.resourcesPath, "fixture-native.json"), "utf8"),
    ),
    calls,
    nativeSubmissions: 0,
    clicks: 0,
  };
  let persistence = Promise.resolve();
  const persist = () => {
    const content = JSON.stringify(report, null, 2);
    persistence = persistence.then(() =>
      writeFile(join(directory, "live-report.json"), content, { mode: 0o600 }),
    );
    return persistence;
  };
  await app.whenReady();
  const title = `Synara Cua Live Fixture ${process.pid}`;
  const target = new BrowserWindow({
    title,
    width: 600,
    height: 340,
    x: 100,
    y: 120,
    resizable: false,
    movable: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  const channel = `live-fixture-${process.pid}`;
  const receive = (_event: unknown, clicks: number) => {
    report.clicks = clicks;
    void persist();
  };
  ipcMain.on(channel, receive);
  await target.loadURL(
    `data:text/html,${encodeURIComponent(`<!doctype html><title>${title}</title><style>body{font:20px system-ui;padding:24px}button{font:24px system-ui;padding:25px;background:#def;border:2px solid #345;border-radius:12px}</style><h1>Owned live-provider target</h1><button id="counter">Click counter: 0</button><p>One background click is permitted.</p><script>const {ipcRenderer}=require('electron');let clicks=0;const b=document.querySelector('#counter');b.onclick=()=>{b.textContent='Click counter: '+(++clicks);ipcRenderer.send(${JSON.stringify(channel)},clicks)};</script>`)}`,
  );
  target.webContents.on("will-navigate", (event) => event.preventDefault());
  target.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const capability = randomBytes(32).toString("base64url");
  const host = new CuaDriverHost({
    binaryPath,
    capability,
    bundleId: "com.synara.cua-fixture",
    setup: async () => {
      throw new Error("Fixture never requests new macOS permissions.");
    },
  });
  const nativeEndpoint = await host.listen();
  const nativeCall = (name: string, args: Record<string, unknown> = {}) =>
    cuaRequest<CuaReply>(nativeEndpoint, { method: "call", name, args, capability });
  const permissions = await nativeCall("check_permissions", { prompt: false });
  report.permissions = permissions.result?.structuredContent;
  if (
    permissions.result?.structuredContent?.accessibility !== true ||
    permissions.result?.structuredContent?.screen_recording !== true
  ) {
    await host.dispose();
    target.destroy();
    ipcMain.removeListener(channel, receive);
    report.error = "Fixture grants are missing; no server/provider/input started.";
    await persist();
    return report;
  }
  await pause(300);
  const inventory = await nativeCall("list_windows", { pid: process.pid });
  const rows = inventory.result?.structuredContent?.windows as
    | Array<Record<string, unknown>>
    | undefined;
  const matches = rows?.filter((row) => row.pid === process.pid && row.title === title) ?? [];
  if (matches.length !== 1 || !Number.isInteger(matches[0]?.window_id)) {
    await host.dispose();
    target.destroy();
    ipcMain.removeListener(channel, receive);
    throw new Error("Exact owned target identity was not established; no input permitted.");
  }
  const windowId = matches[0]!.window_id;
  report.target = { pid: process.pid, windowId, id: `cua:${process.pid}:${windowId}`, title };
  let frame: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  const owned = (args: Record<string, unknown>) =>
    args.pid === process.pid && args.window_id === windowId && !target.isDestroyed();
  const clients = new Set<Socket>();
  const endpoint = join(directory, "fixture-host.sock");
  const proxy = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => undefined);
    socket.setTimeout(40_000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      socket.removeAllListeners("data");
      const controller = new AbortController();
      let inputSubmitted = false;
      const abort = () => controller.abort();
      socket.once("close", abort);
      void (async () => {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        if (request.capability !== capability)
          throw new Error("Fixture host authority is required.");
        const args = (request.args ?? {}) as Record<string, unknown>;
        const name = request.name;
        if (request.method !== "probe" && request.method !== "stop") {
          if (request.method !== "call")
            throw new Error("Fixture setup is not an admitted action.");
          if (name === "get_window_state") {
            if (!owned(args))
              throw new Error("Capture is restricted to the exact owned fixture window.");
          } else if (name === "list_windows") {
            request.args = { ...args, pid: process.pid };
          } else if (name === "check_permissions") {
            request.args = { prompt: false };
          } else if (name === "click") {
            if (
              !owned(args) ||
              args.delivery_mode !== "background" ||
              args.count !== 1 ||
              args.button ||
              args.modifier ||
              report.nativeSubmissions !== 0 ||
              !frame
            )
              throw new Error(
                "Only one unmodified background click on the owned counter is admitted.",
              );
            const bounds = target.getBounds();
            if (
              ["x", "y", "width", "height"].some(
                (key) =>
                  bounds[key as keyof typeof bounds] !==
                  frame![key as "x" | "y" | "width" | "height"],
              )
            )
              throw new Error("Owned target geometry changed.");
            const button = await target.webContents.executeJavaScript(
              "(()=>{const r=document.querySelector('#counter').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()",
            );
            const content = target.getContentBounds();
            const x = Number(args.x) / frame.scale + frame.x - content.x;
            const y = Number(args.y) / frame.scale + frame.y - content.y;
            if (
              !Number.isFinite(x) ||
              !Number.isFinite(y) ||
              x < button.x ||
              x >= button.x + button.width ||
              y < button.y ||
              y >= button.y + button.height
            )
              throw new Error("Click is outside the owned counter.");
            report.nativeSubmissions = 1;
          } else if (name !== "get_screen_size" && name !== "get_agent_cursor_state") {
            throw new Error("Fixture refuses desktop overview, clipboard and all other input.");
          }
        }
        inputSubmitted = name === "click";
        const reply = await cuaRequest<CuaReply>(nativeEndpoint, request, {
          signal: controller.signal,
          timeoutMs: 35_000,
          mutation: inputSubmitted,
        });
        if (name === "list_windows" && Array.isArray(reply.result?.structuredContent?.windows)) {
          reply.result.structuredContent.windows = reply.result.structuredContent.windows.filter(
            (row: Record<string, unknown>) =>
              row.pid === process.pid && row.window_id === windowId && row.title === title,
          );
          reply.result.content = [
            { type: "text", text: JSON.stringify(reply.result.structuredContent) },
          ];
        }
        if (name === "get_window_state" && reply.result?.structuredContent) {
          const data = reply.result.structuredContent;
          const image = reply.result.content?.find((part) => part.type === "image" && part.data);
          if (image?.data) {
            const png = Buffer.from(image.data, "base64"),
              size = pngDimensions(png);
            const bounds = data.window_bounds as {
              x: number;
              y: number;
              width: number;
              height: number;
            };
            if (data.pid !== process.pid || data.window_id !== windowId || !size || !bounds?.width)
              throw new Error("Native screenshot identity or geometry mismatch.");
            frame = { ...bounds, scale: size.width / bounds.width };
            await writeFile(
              join(directory, Number(report.clicks) > 0 ? "live-after.png" : "live-before.png"),
              png,
            );
          }
        }
        calls.push({
          at: new Date().toISOString(),
          method: request.method,
          name,
          args: request.args,
          ok: reply.ok,
          ...(name === "click" ? { result: reply.result?.structuredContent } : {}),
        });
        await persist();
        return reply;
      })()
        .catch(async (error) => {
          const effect = inputSubmitted ? "dispatched-unknown" : "not-dispatched";
          calls.push({ at: new Date().toISOString(), error: String(error), effect });
          await persist();
          return { ok: false, effect, error: String(error) };
        })
        .then((reply) => {
          socket.removeListener("close", abort);
          if (!socket.destroyed) socket.end(JSON.stringify(reply) + "\n");
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(endpoint, resolve);
  });
  await chmod(endpoint, 0o600);
  const preflight: Array<Record<string, unknown>> = [];
  for (const [name, request] of [
    ["authority", { method: "probe", capability: "invalid" }],
    ["desktop-capture", { method: "call", name: "get_desktop_state", capability }],
    [
      "foreign-window",
      {
        method: "call",
        name: "get_window_state",
        args: { pid: 1, window_id: windowId },
        capability,
      },
    ],
    [
      "foreground-input",
      {
        method: "call",
        name: "click",
        args: {
          pid: process.pid,
          window_id: windowId,
          delivery_mode: "foreground",
          count: 1,
          x: 0,
          y: 0,
        },
        capability,
      },
    ],
    ["clipboard", { method: "call", name: "clipboard_read", capability }],
  ] as const) {
    const reply = await cuaRequest<CuaReply>(endpoint, request);
    const passed =
      reply.ok === false && reply.effect === "not-dispatched" && report.nativeSubmissions === 0;
    preflight.push({ name, passed });
    if (!passed) throw new Error(`Fixture scope guard failed: ${name}; provider launch refused.`);
  }
  report.scopePreflight = preflight;
  const portReservation = createServer();
  await new Promise<void>((resolve) => portReservation.listen(0, "127.0.0.1", resolve));
  const port = (portReservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => portReservation.close(() => resolve()));
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    SYNARA_HOME: join(directory, "server-home"),
    SYNARA_MODE: "web",
    SYNARA_PORT: String(port),
    SYNARA_HOST: "127.0.0.1",
    SYNARA_NO_BROWSER: "1",
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
    SYNARA_BROWSER_HOST_CAPABILITY_FD: "3",
    [CUA_HOST_SOCKET_ENV]: endpoint,
  };
  for (const name of [
    "SYNARA_AUTH_TOKEN",
    "VITE_DEV_SERVER_URL",
    "SYNARA_BROWSER_HOST_CAPABILITY",
    "SYNARA_BROWSER_HOST_PIPE_PATH",
    "SYNARA_COMPUTER_BACKEND",
  ])
    delete env[name as keyof typeof env];
  const server: ChildProcess = spawn(process.execPath, [serverEntry], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  (server.stdio[3] as import("node:stream").Writable).end(capability);
  let output = "",
    exited = false;
  const recordOutput = (chunk: Buffer) => {
    output += chunk.toString();
  };
  server.stdout?.on("data", recordOutput);
  server.stderr?.on("data", recordOutput);
  const serverExit = new Promise<void>((resolve) => {
    server.once("exit", (code, signal) => {
      exited = true;
      report.serverExit = { code, signal };
      resolve();
    });
    server.once("error", (error) => {
      exited = true;
      report.serverError = String(error);
      resolve();
    });
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const timeout = setTimeout(finish, 20 * 60_000);
  const closing = () => finish();
  target.on("closed", closing);
  process.on("SIGTERM", closing);
  try {
    for (let attempt = 0; attempt < 300 && !exited && !output.includes("Synara running"); attempt++)
      await pause(100);
    if (!output.includes("Synara running"))
      throw new Error("Live fixture server failed to become ready.");
    report.server = {
      pid: server.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      workspace,
      ready: true,
    };
    await persist();
    await Promise.race([finished, serverExit]);
  } catch (error) {
    report.error = String(error);
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGTERM", closing);
    if (!exited) server.kill("SIGTERM");
    // Stop native admission before retiring the GUI-owned host. Never replace
    // or force-kill an input generation whose cooperative cleanup is unknown.
    await host.stop();
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await Promise.race([serverExit, pause(5_000)]);
    if (!exited) {
      report.serverForcedExit = true;
      server.kill("SIGKILL");
      await serverExit;
    }
    await host.dispose();
    if (!target.isDestroyed()) target.destroy();
    ipcMain.removeListener(channel, receive);
    await writeFile(join(directory, "live-server.log"), output, { mode: 0o600 });
    await persist();
  }
  return report;
}
