import http, { type RequestListener } from "node:http";

export interface EphemeralHttpServer {
  readonly server: http.Server;
  readonly origin: string;
  setRequestListener(listener: RequestListener): void;
  close(): Promise<void>;
}

export async function bindEphemeralHttpServer(): Promise<EphemeralHttpServer> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ephemeral HTTP server did not bind a TCP port");
  }
  let requestListener: RequestListener | undefined;
  let closed = false;
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    setRequestListener(listener) {
      if (requestListener) server.off("request", requestListener);
      requestListener = listener;
      server.on("request", listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (requestListener) server.off("request", requestListener);
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
