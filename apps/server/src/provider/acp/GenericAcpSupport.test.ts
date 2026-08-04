import type * as Acp from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { buildGenericAcpSpawnInput, resolveGenericAcpAuthMethodId } from "./GenericAcpSupport.ts";

function initializeResponse(authMethodIds: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: authMethodIds.map((id) => ({ id, name: id })),
  };
}

describe("GenericAcpSupport", () => {
  it("builds the default Cline ACP command without invoking a shell", () => {
    expect(
      buildGenericAcpSpawnInput({ binaryPath: "cline", args: ["--acp"] }, "C:\\workspace"),
    ).toMatchObject({
      command: "cline",
      args: ["--acp"],
      cwd: "C:\\workspace",
    });
  });

  it("preserves configurable argument boundaries", () => {
    expect(
      buildGenericAcpSpawnInput(
        { binaryPath: "custom-agent", args: ["serve", "--name", "My Agent"] },
        "/workspace",
      ).args,
    ).toEqual(["serve", "--name", "My Agent"]);
  });

  it("uses the first authentication method advertised by the agent", async () => {
    await expect(
      Effect.runPromise(resolveGenericAcpAuthMethodId(initializeResponse(["cline", "api-key"]))),
    ).resolves.toBe("cline");
  });

  it("allows an ACP agent that does not require client-driven authentication", async () => {
    await expect(
      Effect.runPromise(resolveGenericAcpAuthMethodId(initializeResponse([]))),
    ).resolves.toBeUndefined();
  });
});
