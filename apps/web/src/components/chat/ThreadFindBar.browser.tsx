// FILE: ThreadFindBar.browser.tsx
// Purpose: Browser regressions for deferred matching and imperative active stepping.
// Layer: Vitest browser tests

import { MessageId } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadFindBar } from "./ThreadFindBar";
import type { TimelineEntry } from "../../session-logic";

const TIMELINE_ENTRIES: TimelineEntry[] = [
  {
    id: "assistant-1",
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id: MessageId.makeUnsafe("assistant-1"),
      role: "assistant",
      text: "Error one. Error two.",
      createdAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
    },
  },
];

describe("ThreadFindBar interactions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("echoes input before deferred matching publishes the final query", async () => {
    const onHighlightChange = vi.fn();
    await render(
      <ThreadFindBar
        open
        focusNonce={1}
        timelineEntries={TIMELINE_ENTRIES}
        onClose={() => {}}
        onJump={() => {}}
        onHighlightChange={onHighlightChange}
        onActiveMatchChange={() => {}}
      />,
    );
    onHighlightChange.mockClear();
    const input = page.getByRole("textbox", { name: "Find in thread" });

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
    expect(onHighlightChange.mock.calls.at(-1)?.[0]?.query).not.toBe("err");
    await expect.poll(() => onHighlightChange.mock.calls.at(-1)?.[0]?.query).toBe("err");
  });

  it("steps through the imperative active path without republishing the query", async () => {
    const onHighlightChange = vi.fn();
    const onActiveMatchChange = vi.fn();
    const onJump = vi.fn();
    await render(
      <ThreadFindBar
        open
        focusNonce={1}
        timelineEntries={TIMELINE_ENTRIES}
        onClose={() => {}}
        onJump={onJump}
        onHighlightChange={onHighlightChange}
        onActiveMatchChange={onActiveMatchChange}
      />,
    );
    const input = page.getByRole("textbox", { name: "Find in thread" });
    await input.fill("error");
    await expect.poll(() => onHighlightChange.mock.calls.at(-1)?.[0]?.query).toBe("error");
    onHighlightChange.mockClear();
    onActiveMatchChange.mockClear();
    onJump.mockClear();

    await userEvent.keyboard("{Enter}");

    expect(onHighlightChange).not.toHaveBeenCalled();
    expect(onActiveMatchChange).toHaveBeenCalledWith({
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset: 11,
      endOffset: 16,
    });
    expect(onJump).toHaveBeenCalledWith({
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset: 11,
      endOffset: 16,
    });
  });
});
