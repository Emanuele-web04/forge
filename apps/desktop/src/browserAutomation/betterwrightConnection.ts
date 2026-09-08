import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { WebContents } from "electron";
import { WebSocketServer } from "ws";
import { BetterwrightCdpTarget } from "./betterwrightCdp";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";

/** Private loopback transport. The capability is passed only to the trusted worker. */
export async function openBetterwrightConnection(
  contents: WebContents,
  diagnostic?: (method: string, outcome: string) => void,
  uploadFiles: readonly string[] = [],
  cookieImport = false,
  expectAgentInput?: BrowserAutomationVisibleRuntime["expectAgentInput"],
) {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  const { targetInfo } = (await contents.debugger.sendCommand("Target.getTargetInfo")) as {
    targetInfo: { targetId: string };
  };
  const { sessionId: backendSessionId } = (await contents.debugger.sendCommand(
    "Target.attachToTarget",
    { targetId: targetInfo.targetId, flatten: true },
  )) as { sessionId: string };
  const capability = randomBytes(32).toString("hex");
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
  let target: BetterwrightCdpTarget | undefined;
  let connected = false;
  let closing: Promise<void> | undefined;
  server.on("upgrade", (request, socket, head) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${capability}`);
    if (
      closing ||
      connected ||
      request.headers.origin ||
      request.url !== "/browser" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      socket.destroy();
      return;
    }
    connected = true;
    sockets.handleUpgrade(request, socket, head, (client) => {
      try {
        target = new BetterwrightCdpTarget(
          contents,
          (message) => {
            if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
          },
          diagnostic,
          targetInfo.targetId,
          new Set(uploadFiles),
          backendSessionId,
          cookieImport,
          expectAgentInput,
        );
      } catch {
        client.close();
        return;
      }
      client.on("message", (data) => {
        try {
          const message: unknown = JSON.parse(data.toString());
          if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
          void target?.receive(message).catch(() => client.close());
        } catch {
          client.close();
        }
      });
      client.on("error", () => {
        void close();
      });
      client.on("close", () => {
        void close();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch(async (error) => {
    await contents.debugger
      .sendCommand("Target.detachFromTarget", { sessionId: backendSessionId })
      .catch(() => {});
    throw error;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser transport unavailable.");
  function close(cancel = true): Promise<void> {
    closing ??= (async () => {
      const draining = target
        ? target.dispose(cancel)
        : contents.debugger
            .sendCommand("Target.detachFromTarget", { sessionId: backendSessionId })
            .then(
              () => undefined,
              () => undefined,
            );
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await draining;
    })();
    return closing;
  }
  return {
    provider: {
      cdpUrl: `ws://127.0.0.1:${address.port}/browser`,
      headers: { authorization: `Bearer ${capability}` },
    },
    close,
  };
}
