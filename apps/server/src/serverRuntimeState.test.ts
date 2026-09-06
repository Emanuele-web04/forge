import * as NodeServices from "@effect/platform-node/NodeServices";
import fs from "node:fs";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  PersistedServerRuntimeState,
} from "./serverRuntimeState";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-runtime-state-",
}).pipe(Layer.provide(NodeServices.layer));
const testLayer = Layer.merge(NodeServices.layer, serverConfigLayer);

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("serverRuntimeState", () => {
  it("persists and clears runtime state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const state = makePersistedServerRuntimeState({ config, port: 4123 });
        yield* persistServerRuntimeState({ path: config.serverRuntimeStatePath, state });
        const mode = fs.statSync(config.serverRuntimeStatePath).mode & 0o777;
        const persisted = fs.readFileSync(config.serverRuntimeStatePath, "utf8");
        yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
        const cleared = !fs.existsSync(config.serverRuntimeStatePath);
        return { persisted, cleared, mode };
      }),
    );

    const persisted = Schema.decodeUnknownSync(Schema.fromJsonString(PersistedServerRuntimeState))(
      result.persisted,
    );
    expect(persisted.origin).toBe("http://127.0.0.1:4123");
    expect(result.cleared).toBe(true);
    if (process.platform !== "win32") expect(result.mode).toBe(0o600);
  });
});
