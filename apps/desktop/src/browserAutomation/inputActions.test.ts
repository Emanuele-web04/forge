import type { BrowserCssSelector } from "@synara/contracts";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callFunctionOn: vi.fn(),
  evaluateInContext: vi.fn(),
  dispatchTrustedDrag: vi.fn(async () => undefined),
  dispatchTrustedKeySequence: vi.fn(async () => undefined),
  dispatchTrustedText: vi.fn(async () => undefined),
  releaseBrowserTarget: vi.fn(async () => undefined),
  resolveBrowserTarget: vi.fn(async () => ({
    objectId: "editable-1",
    point: { x: 20, y: 10 },
    info: { role: "textbox", name: "Editor" },
    attached: true,
    visible: true,
    enabled: true,
    editable: true,
  })),
  waitForActionableTarget: vi.fn(
    async (_runtime: unknown, _objectId: string, _options: { readonly scroll?: string }) => ({
      ok: true as const,
      target: {
        point: { x: 20, y: 10 },
        rect: { x: 0, y: 0, width: 40, height: 20 },
      },
    }),
  ),
}));

vi.mock("./actionability", () => ({
  waitForActionableTarget: mocks.waitForActionableTarget,
}));

vi.mock("./cdpRuntime", () => ({
  callFunctionOn: mocks.callFunctionOn,
  evaluateInContext: mocks.evaluateInContext,
  loadStateForReadyState: vi.fn(),
  observePage: vi.fn(),
  throwIfAborted: vi.fn(),
}));

vi.mock("./targets", () => ({
  resolveBrowserTarget: mocks.resolveBrowserTarget,
  releaseBrowserTarget: mocks.releaseBrowserTarget,
}));

vi.mock("./trustedInput", () => ({
  dispatchTrustedClick: vi.fn(),
  dispatchTrustedDrag: mocks.dispatchTrustedDrag,
  dispatchTrustedHover: vi.fn(),
  dispatchTrustedKeySequence: mocks.dispatchTrustedKeySequence,
  dispatchTrustedScroll: vi.fn(),
  dispatchTrustedText: mocks.dispatchTrustedText,
  withTrustedGuestFocus: vi.fn(async (_runtime, operation: () => Promise<unknown>) => operation()),
}));

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { dragBrowserTarget, pressBrowserKeys, typeIntoBrowserTarget } from "./inputActions";

const runtime = {
  threadId: "thread-input" as BrowserAutomationVisibleRuntime["threadId"],
  tabId: "551c4630-5817-4db1-ab9e-58e65cdd1d55",
  webContents: { isDestroyed: () => false } as unknown as WebContents,
} satisfies BrowserAutomationVisibleRuntime;

describe("browser text input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { append: false, expectedCollapse: [] },
    { append: true, expectedCollapse: [false] },
  ])(
    "selects contenteditable correctly when append=$append",
    async ({ append, expectedCollapse }) => {
      const collapse = vi.fn();
      const range = {
        selectNodeContents: vi.fn(),
        collapse,
      };
      const selection = {
        removeAllRanges: vi.fn(),
        addRange: vi.fn(),
      };
      const element = {
        nodeType: 1,
        isConnected: true,
        isContentEditable: true,
        localName: "div",
        getAttribute: () => null,
        focus: vi.fn(),
      };
      vi.stubGlobal("document", {
        activeElement: element,
        createRange: () => range,
      });
      vi.stubGlobal("getSelection", () => selection);

      mocks.evaluateInContext.mockResolvedValue({ value: false });
      mocks.callFunctionOn.mockImplementation(
        async (
          _runtime: unknown,
          _objectId: string,
          declaration: string,
          options: { readonly arguments?: readonly unknown[] },
        ) => {
          // The prepare step embeds the classifier too, so match it before the
          // bare classification probe.
          if (declaration.includes("this.focus({ preventScroll: true })")) {
            const prepare = Function(`return (${declaration})`)() as (
              this: unknown,
              value: boolean,
            ) => { readonly ok?: boolean };
            return { value: prepare.call(element, options.arguments?.[0] === true) };
          }
          if (declaration.includes("classifyCredentialInput")) {
            return { value: false };
          }
          return { value: { kind: "text", length: 5, value: "hello" } };
        },
      );

      await expect(
        typeIntoBrowserTarget(
          runtime,
          {
            target: { selector: "#editor" as BrowserCssSelector },
            text: "hello",
            append,
          },
          undefined,
        ),
      ).resolves.toMatchObject({
        resultingValue: { kind: "text", length: 5, value: "hello" },
      });

      expect(range.selectNodeContents).toHaveBeenCalledWith(element);
      expect(collapse.mock.calls.map(([atStart]) => atStart)).toEqual(expectedCollapse);
      expect(mocks.dispatchTrustedText).toHaveBeenCalledWith(runtime, "hello", undefined);
      expect(mocks.releaseBrowserTarget).toHaveBeenCalledOnce();
    },
  );

  it("requires human entry for password and verification fields", async () => {
    mocks.callFunctionOn.mockResolvedValueOnce({
      value: { reason: "password-type", field: "current-password" },
    });

    await expect(
      typeIntoBrowserTarget(
        runtime,
        {
          target: { selector: "#password" as BrowserCssSelector },
          text: "not-a-password",
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "password-type", field: "current-password" },
    });

    expect(mocks.dispatchTrustedText).not.toHaveBeenCalled();
    expect(mocks.releaseBrowserTarget).toHaveBeenCalledOnce();
  });

  it("fails closed when the credential classification is missing", async () => {
    mocks.callFunctionOn.mockResolvedValueOnce({ value: undefined });

    await expect(
      typeIntoBrowserTarget(
        runtime,
        {
          target: { selector: "#editor" as BrowserCssSelector },
          text: "hello",
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "detection-error" },
    });

    expect(mocks.dispatchTrustedText).not.toHaveBeenCalled();
  });

  it("blocks typing when a focus handler morphs the field into a credential input", async () => {
    mocks.callFunctionOn.mockResolvedValueOnce({ value: false }).mockResolvedValueOnce({
      value: { ok: false, credential: { reason: "password-type", field: "morphed" } },
    });

    await expect(
      typeIntoBrowserTarget(
        runtime,
        {
          target: { selector: "#editor" as BrowserCssSelector },
          text: "hello",
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "password-type", field: "morphed" },
    });

    expect(mocks.dispatchTrustedText).not.toHaveBeenCalled();
  });

  it("re-checks the focused element after prepare before dispatching text", async () => {
    mocks.callFunctionOn
      .mockResolvedValueOnce({ value: false })
      .mockResolvedValueOnce({ value: { ok: true } });
    mocks.evaluateInContext.mockResolvedValueOnce({
      value: { reason: "credential-keyword", field: "otp" },
    });

    await expect(
      typeIntoBrowserTarget(
        runtime,
        {
          target: { selector: "#editor" as BrowserCssSelector },
          text: "hello",
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "credential-keyword", field: "otp" },
    });

    expect(mocks.dispatchTrustedText).not.toHaveBeenCalled();
  });
});

describe("browser key presses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits trusted keys when no credential input is focused", async () => {
    mocks.evaluateInContext.mockResolvedValueOnce({ value: false });

    await expect(pressBrowserKeys(runtime, { keys: ["Enter"] }, undefined)).resolves.toMatchObject({
      emitted: ["Enter"],
      modifiersReleased: true,
    });

    expect(mocks.dispatchTrustedKeySequence).toHaveBeenCalledWith(runtime, ["Enter"], undefined);
  });

  it("requires human entry when a credential input is focused", async () => {
    mocks.evaluateInContext.mockResolvedValueOnce({
      value: { reason: "credential-keyword", field: "otp" },
    });

    await expect(pressBrowserKeys(runtime, { keys: ["Enter"] }, undefined)).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "credential-keyword", field: "otp" },
    });

    expect(mocks.dispatchTrustedKeySequence).not.toHaveBeenCalled();
  });

  it("fails closed when the focused-element classification is missing", async () => {
    mocks.evaluateInContext.mockResolvedValueOnce({ value: undefined });

    await expect(pressBrowserKeys(runtime, { keys: ["Enter"] }, undefined)).rejects.toMatchObject({
      browserError: { code: "BrowserCredentialInputRequired" },
      credentialContext: { reason: "detection-error" },
    });

    expect(mocks.dispatchTrustedKeySequence).not.toHaveBeenCalled();
  });
});

describe("browser drag input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recomputes the source point after bringing both endpoints into one viewport", async () => {
    mocks.resolveBrowserTarget
      .mockResolvedValueOnce({
        objectId: "source-1",
        point: { x: 119, y: 260 },
        info: { role: "button", name: "Drag source" },
        attached: true,
        visible: true,
        enabled: true,
        editable: false,
      })
      .mockResolvedValueOnce({
        objectId: "target-1",
        point: { x: 119, y: 260 },
        info: { role: "button", name: "Drop target" },
        attached: true,
        visible: true,
        enabled: true,
        editable: false,
      });
    mocks.waitForActionableTarget
      .mockResolvedValueOnce({
        ok: true,
        target: { point: { x: 119, y: 260 }, rect: { x: 20, y: 233, width: 198, height: 54 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        target: { point: { x: 119, y: 260 }, rect: { x: 20, y: 233, width: 198, height: 54 } },
      })
      .mockResolvedValueOnce({
        ok: true,
        target: { point: { x: 119, y: 206 }, rect: { x: 20, y: 179, width: 198, height: 54 } },
      });

    await dragBrowserTarget(
      runtime,
      {
        source: { selector: "#drag-source" as BrowserCssSelector },
        target: { selector: "#drop-target" as BrowserCssSelector },
        steps: 8,
      },
      undefined,
    );

    expect(mocks.waitForActionableTarget.mock.calls.map(([, , options]) => options.scroll)).toEqual(
      ["nearest", "nearest", "none"],
    );
    expect(mocks.dispatchTrustedDrag).toHaveBeenCalledWith(
      runtime,
      { x: 119, y: 206 },
      { x: 119, y: 260 },
      { steps: 8 },
      undefined,
    );
  });
});
