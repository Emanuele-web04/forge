// Dispatches a computer-use E2E turn to the DEV server over its feature socket,
// so computer-use changes can be exercised end to end without driving the UI.
// Must live under apps/web: bun resolves the effect/unstable subpath imports
// from the script's own directory. The project id is this machine's dev
// project; the token is the dev server's SYNARA_AUTH_TOKEN (read it from
// /proc/<dev server pid>/environ — untruncated).
//
// Usage:
//   cd apps/web && SYNARA_DEV_TOKEN=<token> bun scripts/cu-e2e-dispatch.mjs "<prompt>" [title]
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { WsFeatureRpcGroup } from "@synara/contracts";

const runtime = JSON.parse(
  readFileSync(
    "/home/RobertFedora/Projects/synara/.synara/electron-dev/dev/server-runtime.json",
    "utf8",
  ),
);
const token = process.env.SYNARA_DEV_TOKEN;
if (!token) throw new Error("SYNARA_DEV_TOKEN not set");
const base = `http://${runtime.host}:${runtime.port}`;

const negotiate = await fetch(
  `${base}/ws/negotiate?token=${token}&x-synara-client-build=${encodeURIComponent("0.7.2")}&x-synara-protocol-epoch=1&x-synara-protocol-min-revision=1&x-synara-protocol-max-revision=1`,
  { cache: "no-store" },
).then((r) => r.json());
if (!negotiate.serverInstanceId) throw new Error(`negotiate failed: ${JSON.stringify(negotiate)}`);

const wsUrl =
  `ws://${runtime.host}:${runtime.port}/ws?token=${token}` +
  `&x-synara-client-build=${encodeURIComponent("0.7.2")}` +
  `&x-synara-protocol-epoch=1` +
  `&x-synara-protocol-revision=${negotiate.negotiatedRevision}` +
  `&x-synara-server-instance=${negotiate.serverInstanceId}`;

const PROJECT_ID = "4730861f-bba6-4e35-98df-0289fed1d308";
const prompt = process.argv[2] ?? "Say READY and stop.";
const title = process.argv[3] ?? "CU E2E";
const threadId = randomUUID();
const now = () => new Date().toISOString();
const modelSelection = { provider: "claudeAgent", model: "claude-opus-5", supportsAutoMode: true };

const protocolLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(
    Socket.layerWebSocket(wsUrl).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
  ),
  Layer.provide(RpcSerialization.layerJson),
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsFeatureRpcGroup);
  yield* client["orchestration.dispatchCommand"]({
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId: PROJECT_ID,
    title,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now(),
  });
  yield* client["orchestration.dispatchCommand"]({
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: prompt,
      attachments: [],
    },
    modelSelection,
    enableComputerControl: true,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now(),
  });
  return threadId;
});

const result = await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(protocolLayer)));
console.log(JSON.stringify({ dispatched: true, threadId: result }));
process.exit(0);
