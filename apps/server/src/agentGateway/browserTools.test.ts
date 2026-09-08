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
describe("agent gateway browser tools", () => {
  it("loads the delegated E2E playbook on demand without touching the browser", async () => {
    const execute = vi.fn();
    const tool = makeAgentGatewayBrowserTools({ available: true, execute: execute as never }).find(
      (tool) => tool.definition.name === "synara_e2e_review",
    )!;
    const result = await Effect.runPromise(tool.handler({}, context));
    const text = JSON.stringify(result);
    for (const requirement of [
      "explicitly requests an E2E",
      "provider-native subagent/Task",
      "One agent owns the shared embedded browser",
      "Wait for the child",
      "If native delegation is unavailable",
      "Do not capture exposed secrets",
      "untested flows",
    ]) {
      expect(text).toContain(requirement);
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([45000, 60000])(
    "reports actionable timeout bounds before dispatch (%s)",
    async (timeoutMs) => {
      const execute = vi.fn();
      const run = makeAgentGatewayBrowserTools({ available: true, execute: execute as never }).find(
        (tool) => tool.definition.name === "browser_run",
      )!;
      const result = await Effect.runPromise(
        run.handler({ timeoutMs, code: "private-code" }, context),
      );
      expect(result.isError).toBe(true);
      const content = result.content[0];
      expect(JSON.parse(content?.type === "text" ? content.text : "null")).toMatchObject({
        error: {
          code: "BrowserInvalidTimeout",
          phase: "input",
          effectMayHaveCommitted: false,
          message: expect.stringContaining("100 to 30000"),
        },
      });
      expect(JSON.stringify(result)).not.toContain("private-code");
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it("forwards a bounded Betterwright operation and preserves legacy text output", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({ tabId: TAB_ID, value: { visible: "Signed in" }, serializedByteCount: 23 }),
    );
    const tools = makeAgentGatewayBrowserTools({ available: true, execute });
    const run = tools.find((tool) => tool.definition.name === "browser_run")!;
    const result = await Effect.runPromise(
      run.handler({ code: "return await snapshot()" }, context),
    );
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "browser_run",
        threadId: "thread-a",
        sessionKey: context.callerSessionKey,
      }),
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Untrusted browser data"),
    });
    expect(result.structuredContent).toMatchObject({ value: { visible: "Signed in" } });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Signed in") });
    expect(tools.some((tool) => tool.definition.name === "browser_click")).toBe(false);
  });

  it.each(["short-visible-result", "synthetic-page-content ".repeat(500)])(
    "returns browser data once for Codex even when the entire envelope is printed",
    async (visible) => {
      const output = {
        tabId: TAB_ID,
        value: { visible },
        serializedByteCount: Buffer.byteLength(JSON.stringify({ visible })),
      };
      const execute = vi.fn(() => Effect.succeed(output));
      const run = makeAgentGatewayBrowserTools({ available: true, execute }).find(
        (tool) => tool.definition.name === "browser_run",
      )!;
      const result = await Effect.runPromise(
        run.handler(
          { code: "return await snapshot()" },
          {
            ...context,
            callerProvider: "codex",
          },
        ),
      );
      expect(result.structuredContent).toEqual(output);
      expect(result.content).toEqual([
        { type: "text", text: expect.stringContaining("Untrusted browser data") },
      ]);
      expect(JSON.stringify(result).split(visible)).toHaveLength(2);
      expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(output).length + 180);
    },
  );

  it("keeps error details visible to Codex result-selection fallback", async () => {
    const execute = vi.fn();
    const run = makeAgentGatewayBrowserTools({ available: true, execute: execute as never }).find(
      (tool) => tool.definition.name === "browser_run",
    )!;
    const result = await Effect.runPromise(
      run.handler(
        { code: "return true", timeoutMs: 60000 },
        {
          ...context,
          callerProvider: "codex",
        },
      ),
    );
    const selected = result.structuredContent ?? result;
    expect(selected).toMatchObject({ isError: true });
    expect(JSON.stringify(selected)).toContain("BrowserInvalidTimeout");
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves native screenshot blocks without duplicating metadata or base64", async () => {
    const image = { mimeType: "image/png" as const, width: 1, height: 1, byteLength: 3 };
    const metadata = {
      tabId: TAB_ID,
      url: "https://example.test/",
      capturedAt: "2026-09-07T00:00:00.000Z",
      mode: "viewport",
      clipped: false,
      image,
    };
    const execute = vi.fn(() =>
      Effect.succeed({ structuredContent: metadata, image: { ...image, data: "YWJj" } }),
    );
    const screenshot = makeAgentGatewayBrowserTools({ available: true, execute }).find(
      (tool) => tool.definition.name === "browser_screenshot",
    )!;
    const result = await Effect.runPromise(
      screenshot.handler({}, { ...context, callerProvider: "codex" }),
    );
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(JSON.stringify(result.structuredContent))).toEqual(metadata);
    expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "YWJj" });
    expect(JSON.stringify(result).split("YWJj")).toHaveLength(2);
    expect(JSON.stringify(result).split(TAB_ID)).toHaveLength(2);
  });

  it("keeps unavailable status structured for Codex without contacting the host", async () => {
    const execute = vi.fn();
    const status = makeAgentGatewayBrowserTools({
      available: false,
      execute: execute as never,
    }).find((tool) => tool.definition.name === "browser_status")!;
    const result = await Effect.runPromise(
      status.handler({}, { ...context, callerProvider: "codex" }),
    );
    expect(result.structuredContent).toMatchObject({ available: false, assignedTabId: null });
    expect(JSON.stringify(result).split("visible-shared-electron-webview")).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["saved", "failed", "debug"])(
    "exposes completion proof truthfully when persistence is %s",
    async (mode) => {
      const image = { mimeType: "image/png" as const, width: 1, height: 1, byteLength: 3 };
      const execute = vi.fn(() =>
        Effect.succeed({
          structuredContent: {
            tabId: TAB_ID,
            url: "https://example.test/",
            capturedAt: "2026-09-07T00:00:00Z",
            mode: "viewport",
            clipped: false,
            image,
          },
          image: { ...image, data: "YWJj" },
        }),
      );
      const saveProof = vi.fn(async () => {
        if (mode === "failed") throw new Error("private-storage-error");
        return "/private/generated_images/proof.png";
      });
      const tool = makeAgentGatewayBrowserTools({ available: true, execute }, { saveProof }).find(
        (tool) => tool.definition.name === "browser_screenshot",
      )!;
      const result = await Effect.runPromise(
        tool.handler(
          { kind: mode === "debug" ? "debug" : "proof" },
          { ...context, callerProvider: "codex" },
        ),
      );
      expect(result.isError).not.toBe(true);
      expect(result.content[1]).toMatchObject({ type: "image", data: "YWJj" });
      expect(JSON.stringify(result)).not.toContain("private-storage-error");
      if (mode === "saved")
        expect(result.structuredContent).toHaveProperty(
          "artifactPath",
          "/private/generated_images/proof.png",
        );
      else expect(result.structuredContent).not.toHaveProperty("artifactPath");
      if (mode === "failed") expect(result.structuredContent).toHaveProperty("artifactError");
      if (mode === "debug") expect(saveProof).not.toHaveBeenCalled();
      else expect(saveProof).toHaveBeenCalledWith(context.callerThreadId, "YWJj");
    },
  );

  it("rejects oversized batches and cross-call upload refs before dispatch", async () => {
    const execute = vi.fn();
    const tools = makeAgentGatewayBrowserTools({ available: true, execute: execute as never });
    const run = tools.find((tool) => tool.definition.name === "browser_run")!;
    const upload = tools.find((tool) => tool.definition.name === "browser_upload")!;
    expect(
      (await Effect.runPromise(run.handler({ code: "x".repeat(16385) }, context))).isError,
    ).toBe(true);
    expect(
      (
        await Effect.runPromise(
          upload.handler(
            { target: { ref: "e1", snapshotId: TAB_ID }, paths: ["file.txt"] },
            context,
          ),
        )
      ).isError,
    ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(
      normalizeGatewayBrowserArguments("browser_upload", {
        selector: "input[type=file]",
        files: ["file.txt"],
      }),
    ).toEqual({ target: { selector: "input[type=file]" }, paths: ["file.txt"] });
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
      "browser_screenshot",
      "browser_logs",
      "browser_upload",
      "browser_run",
      "browser_close",
      "synara_e2e_review",
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
      error: { code: "BrowserInvalidArguments", phase: "input" },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
