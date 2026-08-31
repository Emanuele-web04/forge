import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Http from "node:http";

const [mode, shutdownToken, readyPath, signalPath] = process.argv.slice(2);

if (!mode || !shutdownToken || !readyPath || !signalPath) {
  throw new Error("Expected mode, shutdown token, ready path, and signal path.");
}

const writeSignal = (signal) => {
  Fs.appendFileSync(signalPath, `${signal}\n`, "utf8");
};

if (mode === "stubborn") {
  process.on("SIGTERM", () => writeSignal("SIGTERM"));
}

let provider = null;

const spawnProvider = () =>
  ChildProcess.spawn(
    process.execPath,
    [
      "-e",
      [
        'const Fs = require("node:fs");',
        `const signalPath = ${JSON.stringify(signalPath)};`,
        'process.once("SIGTERM", () => {',
        '  Fs.appendFileSync(signalPath, "PROVIDER_SIGTERM\\n", "utf8");',
        "  process.exit(0);",
        "});",
        'process.send?.("ready");',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );

async function stopProvider() {
  if (!provider || provider.exitCode !== null || provider.signalCode !== null) return;
  const exited = new Promise((resolve) => provider.once("exit", () => resolve()));
  provider.kill("SIGTERM");
  await exited;
}

let shutdownStarted = false;
const server = Http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/api/desktop/shutdown") {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${shutdownToken}`) {
    response.writeHead(401).end();
    return;
  }

  response.writeHead(202, { "Content-Type": "application/json" });
  response.end('{"accepted":true}');
  if (mode === "stubborn" || shutdownStarted) return;
  shutdownStarted = true;
  void stopProvider().then(() => server.close(() => process.exit(0)));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture did not receive a loopback port.");
  }
  const publishReady = () => {
    try {
      Fs.writeFileSync(
        readyPath,
        JSON.stringify({ port: address.port, providerPid: provider?.pid ?? null }),
        "utf8",
      );
    } catch (error) {
      provider?.kill("SIGKILL");
      throw error;
    }
  };

  if (mode !== "graceful") {
    publishReady();
    return;
  }

  provider = spawnProvider();
  let providerReady = false;
  const failBeforeReady = () => {
    if (providerReady) return;
    server.close(() => process.exit(1));
  };
  provider.once("error", failBeforeReady);
  provider.once("exit", failBeforeReady);
  provider.once("message", (message) => {
    if (message !== "ready") return;
    providerReady = true;
    publishReady();
  });
});
