import { serve } from "@hono/node-server";

import { createRelayApp } from "./app";
import { loadRelayConfig } from "./config";

async function main(): Promise<void> {
  const config = loadRelayConfig(process.env);
  const relay = await createRelayApp(config);
  const server = serve({ fetch: relay.app.fetch, port: config.port }, (info) => {
    console.log(`[relay] listening on port ${info.port}`);
  });
  server.on("upgrade", relay.handleUpgrade);

  let shuttingDown = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[relay] received ${signal}, shutting down`);
    server.off("upgrade", relay.handleUpgrade);
    relay.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    process.exit(0);
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  console.error("[relay] fatal startup error", error);
  process.exit(1);
});
