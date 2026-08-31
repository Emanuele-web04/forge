import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  BROWSER_TOOL_NAMES,
  BrowserClickInput,
  BrowserClickOutput,
  BrowserDragInput,
  BrowserEvaluateInput,
  BrowserLogsInput,
  BrowserLogsOutput,
  BrowserPressOutput,
  BrowserScreenshotInput,
  BrowserSelectInput,
  BrowserSnapshotInput,
  BrowserSnapshotOutput,
  BrowserStatusInput,
  BrowserTabsInput,
  BrowserToolNavigateInput,
  BrowserToolOpenInput,
  BrowserTypeInput,
  BrowserUploadInput,
  BrowserWaitInput,
  BrowserWebMcpCallInput,
  BrowserWebMcpCallOutput,
  BrowserWebMcpToolsInput,
  BrowserWebMcpToolsOutput,
} from "./index";

const KEY = "01J00000000000000000000000";
const TAB_ID = "00000000-0000-4000-8000-000000000001";
const SNAPSHOT_ID = "00000000-0000-4000-8000-000000000002";

describe("browser automation tool schemas", () => {
  it("publishes the complete canonical visible-browser tool names in stable order", () => {
    expect(BROWSER_TOOL_NAMES).toEqual([
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
    expect(new Set(BROWSER_TOOL_NAMES).size).toBe(BROWSER_TOOL_NAMES.length);
  });

  it("keeps screenshots and diagnostics bounded and closed", () => {
    expect(Schema.decodeUnknownSync(BrowserScreenshotInput)({})).toMatchObject({
      fullPage: false,
    });
    expect(Schema.is(BrowserScreenshotInput)({ fullPage: true, extra: true })).toBe(false);
    expect(Schema.decodeUnknownSync(BrowserLogsInput)({})).toMatchObject({
      includeConsole: true,
      includeNetwork: true,
      limit: 100,
    });
    expect(Schema.is(BrowserLogsInput)({ includeConsole: false, includeNetwork: false })).toBe(
      false,
    );
    expect(Schema.is(BrowserLogsInput)({ limit: 201 })).toBe(false);
    expect(() =>
      Schema.decodeUnknownSync(BrowserLogsOutput)({
        tabId: TAB_ID,
        startedAt: "2026-07-22T00:00:00.000Z",
        capturedAt: "2026-07-22T00:00:01.000Z",
        entries: [],
        droppedCount: 0,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserLogsOutput)({
        tabId: TAB_ID,
        startedAt: "2026-07-22T00:00:00.000Z",
        capturedAt: "2026-07-22T00:00:01.000Z",
        entries: [],
        droppedCount: 0,
        truncated: false,
      }),
    ).not.toThrow();
  });

  it("navigates by exactly one public URL or private annotation reference", () => {
    expect(Schema.is(BrowserToolNavigateInput)({ url: "https://example.test/page" })).toBe(true);
    expect(Schema.is(BrowserToolNavigateInput)({ annotationId: "annotation-1" })).toBe(true);
    expect(Schema.is(BrowserToolNavigateInput)({})).toBe(false);
    expect(
      Schema.is(BrowserToolNavigateInput)({
        url: "https://example.test/page",
        annotationId: "annotation-1",
      }),
    ).toBe(false);
  });

  it("bounds advanced element actions and only accepts workspace-relative uploads", () => {
    expect(
      Schema.is(BrowserDragInput)({
        source: { selector: "#source" },
        target: { selector: "#target" },
      }),
    ).toBe(true);
    expect(
      Schema.is(BrowserDragInput)({
        source: { selector: "#source" },
        target: { selector: "#target" },
        steps: 101,
      }),
    ).toBe(false);

    expect(
      Schema.is(BrowserSelectInput)({
        target: { selector: "select" },
        values: ["one", "two"],
      }),
    ).toBe(true);
    expect(
      Schema.is(BrowserSelectInput)({
        target: { selector: "select" },
        values: [],
      }),
    ).toBe(false);

    expect(
      Schema.is(BrowserUploadInput)({
        target: { selector: 'input[type="file"]' },
        paths: ["fixtures/avatar.png"],
      }),
    ).toBe(true);
    for (const path of [
      "/tmp/secret",
      "../secret",
      "fixtures/../secret",
      "C:\\secret.txt",
      "\\\\host\\share\\secret.txt",
    ]) {
      expect(
        Schema.is(BrowserUploadInput)({
          target: { selector: 'input[type="file"]' },
          paths: [path],
        }),
        path,
      ).toBe(false);
    }
  });

  it("requires exactly one click target while keeping retry keys optional", () => {
    expect(
      Schema.is(BrowserClickInput)({ idempotencyKey: KEY, target: { selector: "#save" } }),
    ).toBe(true);
    expect(Schema.is(BrowserClickInput)({ target: { selector: "#save" } })).toBe(true);
    expect(Schema.is(BrowserClickInput)({ target: { ref: "e1" } })).toBe(false);
    expect(
      Schema.is(BrowserClickInput)({
        target: { ref: "e1", snapshotId: SNAPSHOT_ID },
      }),
    ).toBe(true);
    expect(
      Schema.is(BrowserClickInput)({
        idempotencyKey: KEY,
        target: { selector: "#save", point: { x: 1, y: 1 } },
      }),
    ).toBe(false);
    expect(
      Schema.is(BrowserTypeInput)({
        idempotencyKey: KEY,
        target: { point: { x: 1, y: 1 } },
        text: "x",
      }),
    ).toBe(false);
  });

  it("reports popup correlation and explicit human handoff for click and press", () => {
    const clickOutput = {
      tabId: TAB_ID,
      finalUrl: "https://example.test/login",
      redirects: [],
      loadState: "commit",
      target: { role: "button", name: "Sign in" },
      point: { x: 100, y: 80 },
      humanActionRequired: {
        kind: "oauth_popup",
        instruction: "Complete sign-in in the visible popup before continuing.",
      },
    };
    const pressOutput = {
      tabId: TAB_ID,
      emitted: ["Enter"],
      modifiersReleased: true,
      openedTabId: "00000000-0000-4000-8000-000000000003",
      humanActionRequired: clickOutput.humanActionRequired,
    };

    expect(() => Schema.decodeUnknownSync(BrowserClickOutput)(clickOutput)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(BrowserPressOutput)(pressOutput)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserClickOutput)({
        ...clickOutput,
        humanActionRequired: { kind: "oauth_popup", instruction: "keep automating" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserPressOutput)({
        ...pressOutput,
        openedTabId: "not-a-tab-id",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserPressOutput)({
        ...pressOutput,
        humanActionRequired: { kind: "oauth_popup", instruction: "keep automating" },
      }),
    ).toThrow();
  });

  it("bounds evaluate and wait inputs", () => {
    expect(
      Schema.is(BrowserEvaluateInput)({ idempotencyKey: KEY, expression: "x".repeat(16_385) }),
    ).toBe(false);
    expect(
      Schema.is(BrowserWaitInput)({
        conditions: Array.from({ length: 9 }, () => ({
          kind: "text",
          text: "x",
          state: "present",
        })),
      }),
    ).toBe(false);
    expect(
      Schema.is(BrowserWaitInput)({
        conditions: [{ kind: "delay", timeMs: 500 }],
      }),
    ).toBe(true);
    expect(
      Schema.is(BrowserWaitInput)({
        conditions: [{ kind: "delay", timeMs: 0 }],
      }),
    ).toBe(false);
    expect(
      Schema.is(BrowserWaitInput)({
        conditions: [{ kind: "delay", timeMs: 29_001 }],
      }),
    ).toBe(false);
  });

  it("keeps semantic snapshots lightweight unless an image is explicitly requested", () => {
    expect(Schema.decodeUnknownSync(BrowserSnapshotInput)({})).toMatchObject({
      includeImage: false,
      includeDiagnostics: true,
    });

    const snapshot = {
      snapshotId: "00000000-0000-4000-8000-000000000002",
      tabId: TAB_ID,
      url: "https://example.test/users",
      title: "Users",
      capturedAt: "2026-07-22T10:00:00.000Z",
      viewport: { width: 1_024, height: 768, deviceScaleFactor: 1 },
      semanticSource: "bounded-wai-aria",
      semanticCoverage: {
        openShadow: "observed",
        interceptedClosedShadow: "unobservable",
        declarativeClosedShadow: "unobservable",
      },
      elements: [
        {
          ref: "e1",
          role: "button",
          name: "Delete",
          context: [{ role: "listitem", name: "Alice Delete" }],
          bounds: { x: 10, y: 10, width: 80, height: 32 },
          states: [],
        },
      ],
      visibleText: "Alice Delete",
      diagnostics: [],
      truncationReasons: [],
    };
    expect(() => Schema.decodeUnknownSync(BrowserSnapshotOutput)(snapshot)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserSnapshotOutput)({
        ...snapshot,
        elements: [
          {
            ...snapshot.elements[0],
            context: Array.from({ length: 5 }, () => ({ role: "listitem", name: "User" })),
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserSnapshotOutput)({
        ...snapshot,
        elements: [
          {
            ...snapshot.elements[0],
            context: [{ role: "listitem", name: "x".repeat(513) }],
          },
        ],
      }),
    ).toThrow();
  });

  it("keeps WebMCP discovery compact and binds calls to opaque ids", () => {
    expect(Schema.decodeUnknownSync(BrowserWebMcpToolsInput)({})).toMatchObject({ limit: 8 });
    expect(Schema.is(BrowserWebMcpToolsInput)({ query: "checkout", limit: 32 })).toBe(true);
    expect(Schema.is(BrowserWebMcpToolsInput)({ limit: 33 })).toBe(false);
    expect(
      Schema.decodeUnknownSync(BrowserWebMcpCallInput)({
        discoveryId: SNAPSHOT_ID,
        toolId: "w1",
      }),
    ).toMatchObject({ arguments: {} });
    expect(
      Schema.is(BrowserWebMcpCallInput)({ discoveryId: SNAPSHOT_ID, toolId: "checkout" }),
    ).toBe(false);

    const discovery = {
      tabId: TAB_ID,
      url: "https://example.test/checkout",
      contentTrust: "untrusted-web-page",
      available: true,
      implementation: "compatibility",
      discoveryId: SNAPSHOT_ID,
      tools: [
        {
          toolId: "w1",
          name: "checkout",
          description: "Submit the current cart.",
          inputSchema: { type: "object", properties: {} },
          origin: "https://example.test",
          annotations: { readOnlyHint: false, untrustedContentHint: true },
        },
      ],
      totalToolCount: 1,
      skippedToolCount: 0,
      truncated: false,
    };
    expect(() => Schema.decodeUnknownSync(BrowserWebMcpToolsOutput)(discovery)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(BrowserWebMcpCallOutput)({
        tabId: TAB_ID,
        discoveryId: SNAPSHOT_ID,
        toolId: "w1",
        toolName: "checkout",
        contentTrust: "untrusted-web-page",
        status: "completed",
        result: { orderId: "123" },
        finalUrl: "https://example.test/complete",
        navigated: true,
        redirects: [],
        loadState: "commit",
      }),
    ).not.toThrow();
  });

  it("forbids tabId on workspace/open tools", () => {
    for (const schema of [BrowserStatusInput, BrowserTabsInput, BrowserToolOpenInput]) {
      expect(Schema.is(schema)({ tabId: TAB_ID })).toBe(false);
    }
    expect(
      Schema.is(BrowserToolOpenInput)({ idempotencyKey: KEY, tabId: TAB_ID, reuse: false }),
    ).toBe(false);
  });
});
