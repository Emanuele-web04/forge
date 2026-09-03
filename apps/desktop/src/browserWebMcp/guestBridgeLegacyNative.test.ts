import { expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ executeInMainWorld: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: electron }));

import { installWebMcpBridgeInMainWorld } from "./guestBridge";

it("uses stringified arguments with the legacy navigator WebMCP API", async () => {
  const tool = {
    name: "legacy_search",
    description: "Search with the legacy WebMCP preview.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    origin: "https://legacy.example",
    window: globalThis,
  };
  const executeTool = vi.fn(async (_tool: typeof tool, input: string) =>
    JSON.stringify({ received: input }),
  );
  const modelContext = {
    getTools: async () => [tool],
    executeTool,
  };
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      permissionsPolicy: { allowsFeature: () => true },
      querySelectorAll: () => [],
    }),
  );
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { modelContext });
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://legacy.example" });

  installWebMcpBridgeInMainWorld();

  const bridge = (
    globalThis as typeof globalThis & {
      readonly __synaraWebMcpBridgeV1: {
        readonly list: () => Promise<{
          readonly implementation: string;
          readonly tools: ReadonlyArray<{ readonly index: number; readonly signature: string }>;
        }>;
        readonly invoke: (
          index: number,
          signature: string,
          inputJson: string,
          invocationId: string,
        ) => Promise<unknown>;
      };
    }
  ).__synaraWebMcpBridgeV1;
  const listed = await bridge.list();

  expect(listed.implementation).toBe("native");
  await expect(
    bridge.invoke(
      listed.tools[0]!.index,
      listed.tools[0]!.signature,
      JSON.stringify({ query: "WebMCP" }),
      "legacy-1",
    ),
  ).resolves.toEqual({
    status: "completed",
    result: { received: JSON.stringify({ query: "WebMCP" }) },
  });
  expect(executeTool).toHaveBeenCalledWith(
    tool,
    JSON.stringify({ query: "WebMCP" }),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
