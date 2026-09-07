// FILE: FilePreviewFindBar.browser.tsx
// Purpose: Browser regressions for deferred matching and Enter/Shift+Enter stepping.
// Layer: Vitest browser tests

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { FilePreviewFindBar } from "./FilePreviewFindBar";

const CONTENTS = "Error one. Error two.";

describe("FilePreviewFindBar interactions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("echoes input before deferred matching publishes the final query", async () => {
    const onMatchesChange = vi.fn();
    await render(
      <FilePreviewFindBar
        open
        focusNonce={1}
        contents={CONTENTS}
        onClose={() => {}}
        onMatchesChange={onMatchesChange}
        onActiveMatchChange={() => {}}
      />,
    );
    onMatchesChange.mockClear();
    const input = page.getByRole("textbox", { name: "Find in file" });

    const inputElement = input.element() as HTMLInputElement;
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    nativeValueSetter?.call(inputElement, "err");
    inputElement.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: "err", inputType: "insertText" }),
    );

    expect(input.element()).toHaveValue("err");
    expect(onMatchesChange.mock.calls.at(-1)?.[1]).not.toBe("err");
    await expect.poll(() => onMatchesChange.mock.calls.at(-1)?.[1]).toBe("err");
  });

  it("steps through matches with Enter without republishing the query", async () => {
    const onMatchesChange = vi.fn();
    const onActiveMatchChange = vi.fn();
    await render(
      <FilePreviewFindBar
        open
        focusNonce={1}
        contents={CONTENTS}
        onClose={() => {}}
        onMatchesChange={onMatchesChange}
        onActiveMatchChange={onActiveMatchChange}
      />,
    );
    const input = page.getByRole("textbox", { name: "Find in file" });
    await input.fill("error");
    await expect.poll(() => onMatchesChange.mock.calls.at(-1)?.[1]).toBe("error");
    onMatchesChange.mockClear();
    onActiveMatchChange.mockClear();

    await userEvent.keyboard("{Enter}");

    expect(onMatchesChange).not.toHaveBeenCalled();
    expect(onActiveMatchChange).toHaveBeenCalledWith(
      { index: 1, startOffset: 11, endOffset: 16 },
      "error",
      1,
    );
  });
});
