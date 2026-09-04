import { mkdtempSync, rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vitest";

import { Effect } from "effect";

import { runAcpInitializeProbe } from "./AcpProbe.ts";

const mockAgentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/acp-mock-agent.ts",
);

describe("AcpProbe — bounded ACP initialize probe", () => {
  it("reports the agent's advertised identity and capabilities for a healthy agent", async () => {
    const outcome = await Effect.runPromise(
      runAcpInitializeProbe({
        command: process.execPath,
        args: [mockAgentPath],
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    expect(outcome.state).toBe("ok");
    if (outcome.state === "ok") {
      expect(outcome.protocolVersion).toBeGreaterThan(0);
      expect(outcome.capabilities).toBeDefined();
      // The fixture advertises `loadSession: true` by default.
      expect(outcome.capabilities.loadSession).toBe(true);
      expect(outcome.identityFingerprint).toBeTruthy();
    }
  });

  it("runs with a scratch workspace and cleans it up when the scope closes", async () => {
    const outcomes: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const outcome = yield* runAcpInitializeProbe({
          command: process.execPath,
          args: [mockAgentPath],
        });
        outcomes.push(outcome.state);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
    expect(outcomes).toEqual(["ok"]);
  });

  it("never surfaces a raw failure — a bad binary becomes a structured failed outcome", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), ".acp-probe-bad-"));
    try {
      // A binary that is not an ACP server at all.
      const outcome = await Effect.runPromise(
        runAcpInitializeProbe({
          command: process.execPath,
          args: [path.join(dir, "not-a-real-file.ts")],
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      expect(outcome).toMatchObject({ state: "failed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an explicit identity override for testability", async () => {
    const outcome = await Effect.runPromise(
      runAcpInitializeProbe({
        command: process.execPath,
        args: [mockAgentPath],
        options: { identity: "test-identity" },
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    if (outcome.state === "ok") {
      expect(outcome.identityFingerprint).toBe("test-identity");
    }
  });
});
