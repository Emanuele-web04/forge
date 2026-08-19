// FILE: CopilotAcpSupport.test.ts
// Purpose: Verifies GitHub Copilot CLI ACP launch, auth, model selection, and discovery.
// Layer: Provider ACP support tests

import type * as Acp from "@agentclientprotocol/sdk";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import * as AcpErrors from "./AcpErrors.ts";
import {
  applyCopilotAcpModelSelection,
  buildCopilotAcpSpawnInput,
  discoverCopilotAcpModels,
  resolveCopilotAcpAuthMethodId,
} from "./CopilotAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildCopilotAcpSpawnInput", () => {
  it("launches the native Copilot ACP server explicitly over stdio", () => {
    const spawn = buildCopilotAcpSpawnInput(undefined, "/tmp/project");

    expect(spawn.command).toBe("copilot");
    expect(spawn.args).toEqual(["--acp", "--stdio"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.env).toBeDefined();
  });

  it("honors a configured Copilot binary without routing through a shell", () => {
    const spawn = buildCopilotAcpSpawnInput(
      { binaryPath: "/opt/copilot/bin/copilot" },
      "/tmp/project with spaces",
    );

    expect(spawn.command).toBe("/opt/copilot/bin/copilot");
    expect(spawn.args).toEqual(["--acp", "--stdio"]);
    expect(spawn.cwd).toBe("/tmp/project with spaces");
  });
});

describe("resolveCopilotAcpAuthMethodId", () => {
  it("uses the first authentication method advertised by Copilot", async () => {
    const methodId = await Effect.runPromise(
      resolveCopilotAcpAuthMethodId(initializeWithAuthMethods(["github-login", "token"])),
    );
    expect(methodId).toBe("github-login");
  });

  it("allows BYOK sessions when Copilot advertises no client-driven auth method", async () => {
    const methodId = await Effect.runPromise(
      resolveCopilotAcpAuthMethodId(initializeWithAuthMethods([])),
    );
    expect(methodId).toBeUndefined();
  });
});

describe("applyCopilotAcpModelSelection", () => {
  it("sets the selected model through the ACP model-config seam", async () => {
    const models: string[] = [];
    await Effect.runPromise(
      applyCopilotAcpModelSelection({
        runtime: {
          setModel: (model) => {
            models.push(model);
            return Effect.void;
          },
        },
        model: "gpt-5.5",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(models).toEqual(["gpt-5.5"]);
  });

  it("does not send an empty model selection", async () => {
    const models: string[] = [];
    await Effect.runPromise(
      applyCopilotAcpModelSelection({
        runtime: {
          setModel: (model) => {
            models.push(model);
            return Effect.void;
          },
        },
        model: "   ",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(models).toEqual([]);
  });
});

describe("discoverCopilotAcpModels", () => {
  it("derives the model catalog from Copilot's ACP session configuration", async () => {
    const configOptions: ReadonlyArray<Acp.SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.5",
        options: [
          {
            value: "gpt-5.5",
            name: "GPT-5.5",
            description: "Default coding model",
          },
          {
            value: "claude-sonnet-5",
            name: "Claude Sonnet 5",
          },
        ],
      },
    ];

    const result = await Effect.runPromise(
      discoverCopilotAcpModels({ getConfigOptions: Effect.succeed(configOptions) }),
    );

    expect(result).toEqual({
      models: [
        {
          slug: "gpt-5.5",
          name: "GPT-5.5",
          description: "Default coding model",
        },
        {
          slug: "claude-sonnet-5",
          name: "Claude Sonnet 5",
        },
      ],
      source: "copilot-acp",
      cached: false,
    });
  });

  it("fails closed when Copilot does not advertise model configuration", async () => {
    const error = await Effect.runPromise(
      discoverCopilotAcpModels({ getConfigOptions: Effect.succeed([]) }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    if (error._tag !== "AcpRequestError") {
      throw error;
    }
    expect(error.errorMessage).toContain("did not advertise a model configuration option");
  });
});
