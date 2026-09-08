import { runInNewContext } from "node:vm";
import { BrowserUploadTarget } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { betterwrightLocator } from "./betterwrightLocator";

describe("host-authored Betterwright locators", () => {
  it.each([
    [{ selector: "input[type=file]" }, "locator", ["input[type=file]"]],
    [
      { locator: { kind: "role", role: "button", name: "Upload" } },
      "getByRole",
      ["button", { name: "Upload", exact: true }],
    ],
    [{ locator: { kind: "testId", value: "upload" } }, "getByTestId", ["upload"]],
    [
      { locator: { kind: "text", text: "Upload", exact: false } },
      "getByText",
      ["Upload", { exact: false }],
    ],
    [
      { locator: { kind: "label", text: "Attachment" } },
      "getByLabel",
      ["Attachment", { exact: true }],
    ],
    [
      { locator: { kind: "placeholder", text: "File" } },
      "getByPlaceholder",
      ["File", { exact: true }],
    ],
  ] as const)("preserves locator semantics for %j", (target, method, args) => {
    const call = vi.fn(() => "locator-result");
    expect(
      runInNewContext(betterwrightLocator(Schema.decodeUnknownSync(BrowserUploadTarget)(target)), {
        page: { [method]: call },
      }),
    ).toBe("locator-result");
    expect(call).toHaveBeenCalledExactlyOnceWith(...args);
  });

  it("treats quotes, escapes and JavaScript-looking selectors as data", () => {
    const selector = '\"); globalThis.injected = true; //\\\n';
    const call = vi.fn();
    const context = { page: { locator: call }, injected: false };
    // Bypass input validation deliberately to exercise the code-generation boundary.
    runInNewContext(betterwrightLocator({ selector } as BrowserUploadTarget), context);
    expect(context.injected).toBe(false);
    expect(call).toHaveBeenCalledExactlyOnceWith(selector);
  });
});
