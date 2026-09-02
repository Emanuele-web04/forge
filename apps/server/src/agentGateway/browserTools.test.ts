import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import type { BrowserAutomationHostShape } from "../browserAutomation/Services/BrowserAutomationHost.ts";
import { makeAgentGatewayBrowserTools, normalizeGatewayBrowserArguments } from "./browserTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:test",
    threadId: "thread-a",
    provider: "claudeAgent",
    turnId: "turn-a",
  },
  callerThreadId: "thread-a",
  callerSessionKey: "gateway-session:test",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["browser:control"]),
  callerTurnId: "turn-a",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

const TAB_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_ID = "22222222-2222-4222-8222-222222222222";
const NEXT_SNAPSHOT_ID = "33333333-3333-4333-8333-333333333333";

const snapshotHostOutput = (snapshotId = SNAPSHOT_ID) => ({
  structuredContent: {
    snapshotId,
    tabId: TAB_ID,
    url: "https://www.youtube.com/",
    title: "YouTube",
    capturedAt: "2026-07-22T10:00:00.000Z",
    viewport: { width: 1_024, height: 768, deviceScaleFactor: 1 },
    semanticSource: "bounded-wai-aria" as const,
    semanticCoverage: {
      openShadow: "observed" as const,
      interceptedClosedShadow: "unobservable" as const,
      declarativeClosedShadow: "unobservable" as const,
    },
    elements: [
      {
        ref: "e3",
        role: "textbox",
        name: "Search",
        context: [
          { role: "main", name: "YouTube" },
          { role: "search", name: "Site search" },
        ],
        bounds: { x: 10, y: 10, width: 200, height: 32 },
        states: ["editable"],
      },
    ],
    visibleText: "Search",
    diagnostics: [],
    truncationReasons: [],
  },
});

const typeOutput = () => ({
  tabId: TAB_ID,
  target: { ref: "e3", role: "textbox", name: "Search" },
  resultingValue: { kind: "text" as const, length: 6, value: "Amixem" },
});

describe("agent gateway browser tools", () => {
  it("normalizes provider-friendly browser aliases before validation", () => {
    expect(
      normalizeGatewayBrowserArguments("browser_type", {
        ref: "e3",
        snapshotId: SNAPSHOT_ID,
        text: "Amixem",
      }),
    ).toEqual({ target: { ref: "e3", snapshotId: SNAPSHOT_ID }, text: "Amixem" });
    expect(
      normalizeGatewayBrowserArguments("browser_click", {
        ref: "e4",
        snapshotId: SNAPSHOT_ID,
      }),
    ).toEqual({ target: { ref: "e4", snapshotId: SNAPSHOT_ID } });
    expect(normalizeGatewayBrowserArguments("browser_press", { key: "ENTER" })).toEqual({
      keys: ["Enter"],
    });
    expect(
      normalizeGatewayBrowserArguments("browser_press", {
        keys: ["ctrl+a", "BACKSPACE"],
      }),
    ).toEqual({ keys: ["Control+A", "Backspace"] });
    expect(normalizeGatewayBrowserArguments("browser_scroll", { direction: "down" })).toEqual({
      direction: "down",
      mode: "direction",
    });
    expect(normalizeGatewayBrowserArguments("browser_screenshot", { full_page: true })).toEqual({
      fullPage: true,
    });
    expect(
      normalizeGatewayBrowserArguments("browser_select", {
        elementId: "e4",
        snapshotId: SNAPSHOT_ID,
        value: "one",
      }),
    ).toEqual({
      target: { ref: "e4", snapshotId: SNAPSHOT_ID },
      values: ["one"],
    });
    expect(
      normalizeGatewayBrowserArguments("browser_upload", {
        selector: 'input[type="file"]',
        files: ["fixtures/avatar.png"],
      }),
    ).toEqual({
      target: { selector: 'input[type="file"]' },
      paths: ["fixtures/avatar.png"],
    });
    expect(normalizeGatewayBrowserArguments("browser_wait", { timeMs: 1_500 })).toEqual({
      conditions: [{ kind: "delay", timeMs: 1_500 }],
      timeoutMs: 2_500,
    });
    expect(normalizeGatewayBrowserArguments("browser_wait", { timeoutMs: 2_000 })).toEqual({
      conditions: [{ kind: "delay", timeMs: 2_000 }],
      timeoutMs: 3_000,
    });
  });

  it("keeps bare ref aliases unbound while preserving explicit snapshot ids", () => {
    expect(normalizeGatewayBrowserArguments("browser_type", { ref: "e3", text: "Amixem" })).toEqual(
      { target: { ref: "e3" }, text: "Amixem" },
    );
    expect(
      normalizeGatewayBrowserArguments("browser_type", {
        elementId: "e3",
        snapshotId: SNAPSHOT_ID,
        text: "Amixem",
      }),
    ).toEqual({
      target: { ref: "e3", snapshotId: SNAPSHOT_ID },
      text: "Amixem",
    });
    expect(
      normalizeGatewayBrowserArguments("browser_drag", {
        from: { elementId: "e3", snapshotId: SNAPSHOT_ID },
        to: { ref: "e4", snapshotId: SNAPSHOT_ID },
      }),
    ).toEqual({
      source: { ref: "e3", snapshotId: SNAPSHOT_ID },
      target: { ref: "e4", snapshotId: SNAPSHOT_ID },
    });
  });

  it("rejects a bare old ref after a new snapshot and accepts the explicit current ref", async () => {
    let snapshotCount = 0;
    const execute = vi.fn((request: { name: string }) =>
      Effect.succeed(
        request.name === "browser_snapshot"
          ? snapshotHostOutput(snapshotCount++ === 0 ? SNAPSHOT_ID : NEXT_SNAPSHOT_ID)
          : typeOutput(),
      ),
    );
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const snapshot = tools.find((tool) => tool.definition.name === "browser_snapshot")!;
    const type = tools.find((tool) => tool.definition.name === "browser_type")!;

    await Effect.runPromise(snapshot.handler({}, context));
    const currentSnapshot = await Effect.runPromise(
      snapshot.handler({}, { ...context, jsonRpcRequestId: 2 }),
    );
    const bareOldRef = await Effect.runPromise(
      type.handler({ ref: "e3", text: "Amixem" }, { ...context, jsonRpcRequestId: 3 }),
    );
    const explicitCurrentRef = await Effect.runPromise(
      type.handler(
        { ref: "e3", snapshotId: NEXT_SNAPSHOT_ID, text: "Amixem" },
        { ...context, jsonRpcRequestId: 4 },
      ),
    );

    expect(currentSnapshot.isError).not.toBe(true);
    expect(bareOldRef.isError).toBe(true);
    expect(explicitCurrentRef.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        name: "browser_type",
        arguments: expect.objectContaining({
          target: { ref: "e3", snapshotId: NEXT_SNAPSHOT_ID },
          text: "Amixem",
          idempotencyKey: expect.any(String),
        }),
      }),
    );
  });

  it("renders bounded semantic ancestry in snapshot MCP text", async () => {
    const execute = vi.fn(() => Effect.succeed(snapshotHostOutput()));
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const snapshot = tools.find((tool) => tool.definition.name === "browser_snapshot")!;
    const result = await Effect.runPromise(snapshot.handler({}, context));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(result.isError).not.toBe(true);
    expect(text).toContain('[e3] textbox "Search" context=main "YouTube" > search "Site search"');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the snapshot MCP text projection compact with adversarial semantic context", async () => {
    const hostOutput = snapshotHostOutput();
    hostOutput.structuredContent.elements = Array.from({ length: 120 }, (_, index) => ({
      ref: `e${index + 1}`,
      role: "button",
      name: `Action ${index} ${"n".repeat(256)}`,
      context: Array.from({ length: 4 }, (__, contextIndex) => ({
        role: "listitem",
        name: `Context ${contextIndex} ${"c".repeat(480)}`,
      })),
      bounds: { x: 10, y: 10, width: 200, height: 32 },
      states: [],
    }));
    hostOutput.structuredContent.visibleText = "é".repeat(4_000);
    const execute = vi.fn(() => Effect.succeed(hostOutput));
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const snapshot = tools.find((tool) => tool.definition.name === "browser_snapshot")!;

    const result = await Effect.runPromise(snapshot.handler({}, context));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(16_000);
    expect(text).toContain("mcpTextTruncated=elements,visibleText");
    expect(text).not.toContain("�");
  });

  it("keeps untrusted WebMCP results from flooding model context", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({
        tabId: TAB_ID,
        discoveryId: SNAPSHOT_ID,
        toolId: "w1",
        toolName: "search",
        contentTrust: "untrusted-web-page",
        status: "completed",
        result: { content: "é".repeat(30_000) },
        finalUrl: "https://example.test/results",
        navigated: false,
        redirects: Array.from(
          { length: 20 },
          (_, index) => `https://redirect.example/${"r".repeat(7_900)}?step=${index}`,
        ),
        dialogs: Array.from({ length: 20 }, (_, index) => ({
          kind: "alert",
          message: `Dialog ${index} ${"d".repeat(4_000)}`,
          action: "accepted",
          openedAt: "2026-08-26T10:00:00.000Z",
        })),
      }),
    );
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const call = tools.find((tool) => tool.definition.name === "browser_webmcp_call")!;

    const result = await Effect.runPromise(
      call.handler({ discoveryId: SNAPSHOT_ID, toolId: "w1" }, context),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(text).toContain("contentTrust=untrusted-web-page");
    expect(text).toContain("resultPreview=");
    expect(text).toContain("webMcpResultTruncated=true");
    expect(text).toContain('"redirectCount":20');
    expect(text).toContain('"dialogCount":20');
    expect(text).not.toContain('"result":{"content"');
    expect(text).not.toContain("�");
  });

  it("keeps oversized failed WebMCP calls parseable in model context", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({
        tabId: TAB_ID,
        discoveryId: SNAPSHOT_ID,
        toolId: "w1",
        toolName: "search",
        contentTrust: "untrusted-web-page",
        status: "failed",
        error: { name: "SearchError", message: "Search failed." },
        finalUrl: "https://example.test/results",
        navigated: true,
        redirects: Array.from(
          { length: 20 },
          (_, index) => `https://redirect.example/${"r".repeat(7_900)}?step=${index}`,
        ),
        dialogs: Array.from({ length: 20 }, (_, index) => ({
          kind: "alert",
          message: `Dialog ${index} ${"d".repeat(4_000)}`,
          action: "accepted",
          openedAt: "2026-08-26T10:00:00.000Z",
        })),
      }),
    );
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const call = tools.find((tool) => tool.definition.name === "browser_webmcp_call")!;

    const result = await Effect.runPromise(
      call.handler({ discoveryId: SNAPSHOT_ID, toolId: "w1" }, context),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    const metadata = JSON.parse(text.split("\n")[2] ?? "null") as Record<string, unknown>;

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(metadata).toMatchObject({
      status: "failed",
      error: { name: "SearchError", message: "Search failed." },
      redirectCount: 20,
      redirectsTruncated: true,
      dialogCount: 20,
      dialogsTruncated: true,
    });
    expect(text).toContain("webMcpCallProjectionCompacted=true");
    expect(text).not.toContain("webMcpTextTruncated=true");
    expect(text).not.toContain("�");
  });

  it("keeps a full bounded WebMCP discovery intact in model context", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({
        tabId: TAB_ID,
        url: `https://example.test/${"u".repeat(7_000)}`,
        contentTrust: "untrusted-web-page",
        available: true,
        implementation: "compatibility",
        discoveryId: SNAPSHOT_ID,
        tools: [
          {
            toolId: "w1",
            name: "search",
            description: "Search the catalogue.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "s".repeat(15_000) },
              },
            },
            origin: "https://example.test",
            annotations: { readOnlyHint: true, untrustedContentHint: true },
          },
        ],
        totalToolCount: 1,
        skippedToolCount: 0,
        truncated: false,
      }),
    );
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const discovery = tools.find((tool) => tool.definition.name === "browser_webmcp_tools")!;

    const result = await Effect.runPromise(discovery.handler({}, context));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(text).not.toContain("webMcpTextTruncated=true");
    expect(() => JSON.parse(text.split("\n").slice(2).join("\n"))).not.toThrow();
  });

  it("leaves ambiguous aliases invalid instead of guessing", async () => {
    const execute = vi.fn();
    const tools = makeAgentGatewayBrowserTools({ available: true, execute: execute as never });
    const type = tools.find((tool) => tool.definition.name === "browser_type")!;
    const press = tools.find((tool) => tool.definition.name === "browser_press")!;

    const bareRef = await Effect.runPromise(type.handler({ ref: "e3", text: "Amixem" }, context));
    const conflictingKeys = await Effect.runPromise(
      press.handler({ key: "ENTER", keys: ["Tab"] }, context),
    );

    expect(bareRef.isError).toBe(true);
    expect(conflictingKeys.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("publishes the complete canonical visible-browser catalogue", () => {
    const host: BrowserAutomationHostShape = {
      available: false,
      execute: () => Effect.die("not called"),
    };
    const tools = makeAgentGatewayBrowserTools(host);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "browser_status",
      "browser_tabs",
      "browser_open",
      "browser_navigate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_resize",
      "browser_snapshot",
      "browser_webmcp_tools",
      "browser_webmcp_call",
      "browser_screenshot",
      "browser_logs",
      "browser_click",
      "browser_hover",
      "browser_drag",
      "browser_type",
      "browser_select",
      "browser_upload",
      "browser_press",
      "browser_scroll",
      "browser_wait",
      "browser_evaluate",
      "browser_close",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "browser:control")).toBe(true);
    expect(tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(tools.every((tool) => tool.definition.outputSchema === undefined)).toBe(true);

    const openSchema = tools.find((tool) => tool.definition.name === "browser_open")!.definition
      .inputSchema as { readonly required?: readonly string[] };
    const navigateSchema = tools.find((tool) => tool.definition.name === "browser_navigate")!
      .definition.inputSchema as {
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(openSchema.required ?? []).not.toContain("idempotencyKey");
    expect(navigateSchema.required ?? []).not.toContain("url");
    expect(navigateSchema.required ?? []).not.toContain("annotationId");
    expect(navigateSchema.properties).toHaveProperty("url");
    expect(navigateSchema.properties).toHaveProperty("annotationId");
    expect(navigateSchema.required ?? []).not.toContain("idempotencyKey");
  });

  it("reports desktop browser unavailability without dispatching", async () => {
    const execute = vi.fn();
    const tools = makeAgentGatewayBrowserTools({
      available: false,
      execute: execute as never,
    });
    const status = tools.find((tool) => tool.definition.name === "browser_status")!;
    const result = await Effect.runPromise(status.handler({}, context));
    expect(execute).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      available: false,
      physicalScope: "visible-shared-electron-webview",
    });
  });

  it("routes identity and thread scope to the desktop host", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({
        tabs: [],
        activeTabId: null,
        assignedTabId: null,
      }),
    );
    const tools = makeAgentGatewayBrowserTools({
      available: true,
      execute,
    });
    const tabs = tools.find((tool) => tool.definition.name === "browser_tabs")!;
    const result = await Effect.runPromise(tabs.handler({}, context));
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "gateway-session:test",
        provider: "claudeAgent",
        threadId: "thread-a",
        name: "browser_tabs",
      }),
    );
  });

  it("resolves upload workspace server-side and never places it in public arguments", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({
        tabId: TAB_ID,
        target: { role: "textbox", name: "Upload" },
        files: [{ name: "avatar.png", byteLength: 42 }],
      }),
    );
    const resolveWorkspaceRoot = vi.fn(() => Effect.succeed("/workspace/project"));
    const tools = makeAgentGatewayBrowserTools(
      { available: true, execute },
      { resolveWorkspaceRoot },
    );
    const upload = tools.find((tool) => tool.definition.name === "browser_upload")!;

    const result = await Effect.runPromise(
      upload.handler(
        {
          target: { selector: 'input[type="file"]' },
          paths: ["fixtures/avatar.png"],
        },
        context,
      ),
    );

    expect(result.isError).not.toBe(true);
    expect(resolveWorkspaceRoot).toHaveBeenCalledWith(context);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/workspace/project",
        arguments: expect.not.objectContaining({ workspaceRoot: expect.anything() }),
      }),
    );
  });

  it("refuses upload when the authenticated thread has no canonical workspace", async () => {
    const execute = vi.fn();
    const tools = makeAgentGatewayBrowserTools({ available: true, execute: execute as never });
    const upload = tools.find((tool) => tool.definition.name === "browser_upload")!;

    const result = await Effect.runPromise(
      upload.handler(
        {
          target: { selector: 'input[type="file"]' },
          paths: ["fixtures/avatar.png"],
        },
        context,
      ),
    );

    expect(result.isError).toBe(true);
    expect(
      JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null"),
    ).toMatchObject({
      error: { code: "BrowserUploadWorkspaceUnavailable" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("supplies stable request-scoped idempotency keys for natural open and navigate calls", async () => {
    const execute = vi.fn((request: { name: string; arguments: Record<string, unknown> }) =>
      Effect.succeed({
        tabId: "11111111-1111-4111-8111-111111111111",
        finalUrl: String(request.arguments.url),
        redirects: [],
        loadState: "domcontentloaded" as const,
        ...(request.name === "browser_open" ? { disposition: "created" as const } : {}),
      }),
    );
    const tools = makeAgentGatewayBrowserTools({
      available: true,
      execute,
    });
    const open = tools.find((tool) => tool.definition.name === "browser_open")!;
    const navigate = tools.find((tool) => tool.definition.name === "browser_navigate")!;

    const firstOpen = await Effect.runPromise(
      open.handler({ url: "https://www.youtube.com" }, context),
    );
    const repeatedOpen = await Effect.runPromise(
      open.handler({ url: "https://www.youtube.com" }, context),
    );
    const nextRequestOpen = await Effect.runPromise(
      open.handler({ url: "https://www.youtube.com" }, { ...context, jsonRpcRequestId: 2 }),
    );
    const naturalNavigate = await Effect.runPromise(
      navigate.handler({ url: "https://www.youtube.com/@Amixem" }, context),
    );

    expect(firstOpen.isError).not.toBe(true);
    expect(repeatedOpen.isError).not.toBe(true);
    expect(nextRequestOpen.isError).not.toBe(true);
    expect(naturalNavigate.isError).not.toBe(true);

    const requests = execute.mock.calls.map(([request]) => request);
    const keys = requests.map((request) => request.arguments.idempotencyKey);
    expect(keys[0]).toMatch(/^synara-mcp-[a-f0-9]{40}$/u);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "browser_navigate",
        arguments: expect.objectContaining({
          url: "https://www.youtube.com/@Amixem",
          idempotencyKey: expect.any(String),
        }),
      }),
    );
  });

  it("rejects an explicit invalid retry key instead of silently replacing it", async () => {
    const execute = vi.fn();
    const tools = makeAgentGatewayBrowserTools({
      available: true,
      execute: execute as never,
    });
    const open = tools.find((tool) => tool.definition.name === "browser_open")!;

    const result = await Effect.runPromise(
      open.handler({ url: "https://www.youtube.com", idempotencyKey: "" }, context),
    );

    expect(result.isError).toBe(true);
    const content = result.content[0];
    expect(JSON.parse(content?.type === "text" ? content.text : "null")).toMatchObject({
      error: { code: "BrowserInputUnsupported", phase: "input" },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
