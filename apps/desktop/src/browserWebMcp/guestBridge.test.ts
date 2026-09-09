import { expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({ executeInMainWorld: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: electron }));

import { installWebMcpBridgeInMainWorld } from "./guestBridge";

it("provides a document.modelContext compatibility bridge before native WebMCP exists", async () => {
  const declarativeForms: unknown[] = [];
  const observedTargets: unknown[] = [];
  let mutationCallback: MutationCallback | undefined;
  const fakeDocument = Object.assign(new EventTarget(), {
    documentElement: new EventTarget(),
    permissionsPolicy: { features: () => ["tools"], allowsFeature: () => true },
    querySelectorAll: () => declarativeForms,
  });
  class FakeMutationObserver {
    constructor(callback: MutationCallback) {
      mutationCallback = callback;
    }

    observe(target: unknown): void {
      observedTargets.push(target);
    }
  }
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("location", { origin: "https://app.example" });
  vi.stubGlobal("MutationObserver", FakeMutationObserver);

  installWebMcpBridgeInMainWorld();

  const modelContext = (
    fakeDocument as typeof fakeDocument & {
      readonly modelContext: {
        ontoolchange: EventListener | null;
        readonly addEventListener: (type: string, listener: EventListener) => void;
        readonly registerTool: (tool: Record<string, unknown>) => Promise<void>;
        readonly getTools: () => Promise<ReadonlyArray<Record<string, unknown>>>;
        readonly executeTool: (
          tool: Record<string, unknown>,
          input: Record<string, unknown>,
        ) => Promise<string>;
      };
    }
  ).modelContext;
  const standardToolChange = vi.fn();
  modelContext.addEventListener("toolchange", standardToolChange);
  expect(observedTargets).toEqual([fakeDocument.documentElement]);
  await modelContext.registerTool({
    name: "addTodo",
    description: "Add one todo item.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: false },
    execute: async (input: { readonly text: string }) => ({ created: input.text }),
  });
  await modelContext.registerTool({
    name: "hostileError",
    description: "Reject with an error value that cannot be coerced safely.",
    execute: async () => {
      throw {
        toString() {
          throw new Error("hostile coercion");
        },
      };
    },
  });
  const registeredTools = await modelContext.getTools();
  await expect(
    modelContext.executeTool(registeredTools[0]!, { text: "Spec-compatible" }),
  ).resolves.toBe(JSON.stringify({ created: "Spec-compatible" }));
  await expect(
    modelContext.registerTool({
      name: "addTodo",
      description: "Duplicate tool.",
      execute: async () => null,
    }),
  ).rejects.toMatchObject({ name: "InvalidStateError" });

  const bridge = (
    globalThis as typeof globalThis & {
      readonly __synaraWebMcpBridgeV1: {
        readonly list: () => Promise<{
          readonly implementation: string;
          readonly tools: ReadonlyArray<{
            readonly index: number;
            readonly signature: string;
            readonly name: string;
            readonly annotations: { readonly untrustedContentHint: boolean };
          }>;
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

  expect(listed.implementation).toBe("compatibility");
  expect(observedTargets).toEqual([fakeDocument.documentElement]);
  expect(listed.tools[0]).toMatchObject({
    index: 0,
    name: "addTodo",
    annotations: { untrustedContentHint: true },
  });
  expect(listed.tools[0]!.signature).toMatch(/^[0-9a-f]{64}$/u);
  await expect(
    bridge.invoke(0, listed.tools[0]!.signature, JSON.stringify({ text: "Ship WebMCP" }), "i1"),
  ).resolves.toEqual({ status: "completed", result: { created: "Ship WebMCP" } });
  const hostileTool = listed.tools.find((tool) => tool.name === "hostileError")!;
  await expect(
    bridge.invoke(hostileTool.index, hostileTool.signature, JSON.stringify({}), "i2"),
  ).resolves.toEqual({
    status: "failed",
    error: {
      name: "WebMcpToolError",
      message: "The page-declared WebMCP tool failed.",
    },
  });

  for (let index = 0; index < 4; index += 1) {
    await modelContext.registerTool({
      name: `large_${index}`,
      description: `Large schema ${index}.`,
      inputSchema: {
        type: "object",
        properties: {
          value: { type: "string", description: "x".repeat(8_000) },
        },
      },
      execute: async () => null,
    });
  }
  const bounded = await bridge.list();
  const transferredToolBytes = bounded.tools.reduce(
    (total, tool) => total + new TextEncoder().encode(JSON.stringify(tool)).byteLength,
    0,
  );
  expect(transferredToolBytes).toBeLessThanOrEqual(24 * 1_024);
  expect(bounded.tools.length).toBeLessThan(6);

  const declarativeAttributes = new Map([
    ["toolname", "searchPage"],
    ["tooldescription", "Search this page."],
  ]);
  declarativeForms.push({
    elements: [],
    getAttribute: (name: string) => declarativeAttributes.get(name) ?? null,
  });
  const toolChange = vi.fn();
  modelContext.ontoolchange = toolChange;
  standardToolChange.mockClear();
  const withDeclarative = await bridge.list();

  expect(withDeclarative.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "searchPage", description: "Search this page." }),
    ]),
  );
  expect(observedTargets).toEqual([fakeDocument.documentElement]);

  const unrelatedTarget = {
    matches: () => false,
    closest: () => null,
  };
  mutationCallback?.(
    [
      {
        type: "childList",
        target: unrelatedTarget,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ],
    {} as MutationObserver,
  );
  await Promise.resolve();
  expect(toolChange).not.toHaveBeenCalled();

  const toolForm = {
    matches: (selector: string) => selector.startsWith("form"),
    closest: () => null,
  };
  mutationCallback?.(
    [
      {
        type: "childList",
        target: unrelatedTarget,
        addedNodes: [toolForm] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ],
    {} as MutationObserver,
  );
  await Promise.resolve();
  expect(toolChange).toHaveBeenCalledOnce();
});
