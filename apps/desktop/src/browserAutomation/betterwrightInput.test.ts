import { describe, expect, it } from "vitest";
import { betterwrightExpectedInputs } from "./betterwrightInput";

describe("Betterwright input provenance", () => {
  it("registers only the exact pressed key and modifier combination", () => {
    expect(
      betterwrightExpectedInputs("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        modifiers: 10,
      }),
    ).toEqual([{ kind: "key", key: "enter", alt: false, control: true, meta: false, shift: true }]);
    expect(
      betterwrightExpectedInputs("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter" }),
    ).toEqual([]);
    expect(betterwrightExpectedInputs("Input.insertText", { text: "synthetic" })).toEqual([]);
  });

  it("registers the takeover signal for every accepted key representation", () => {
    // Multi-character keys must be lower-cased so the browser manager's
    // normalizeAutomationKey matches the expected signal.
    expect(
      betterwrightExpectedInputs("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "ArrowLeft",
        modifiers: 0,
      }),
    ).toEqual([
      { kind: "key", key: "arrowleft", alt: false, control: false, meta: false, shift: false },
    ]);
    expect(
      betterwrightExpectedInputs("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        key: "Enter",
        modifiers: 0,
      }),
    ).toEqual([
      { kind: "key", key: "enter", alt: false, control: false, meta: false, shift: false },
    ]);
    expect(
      betterwrightExpectedInputs("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        code: "Enter",
        modifiers: 0,
      }),
    ).toEqual([
      { kind: "key", key: "enter", alt: false, control: false, meta: false, shift: false },
    ]);
    expect(
      betterwrightExpectedInputs("Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: 13,
      }),
    ).toEqual([
      { kind: "key", key: "enter", alt: false, control: false, meta: false, shift: false },
    ]);
    expect(betterwrightExpectedInputs("Input.dispatchKeyEvent", { type: "rawKeyDown" })).toEqual(
      [],
    );
  });

  it("matches click, context-menu and wheel events without suppressing unrelated pointer input", () => {
    expect(
      betterwrightExpectedInputs("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "right",
        x: 12,
        y: 34,
      }),
    ).toEqual([
      { kind: "mouse", type: "mouseDown", button: "right", x: 12, y: 34 },
      { kind: "mouse", type: "contextMenu", button: "right", x: 12, y: 34 },
    ]);
    expect(
      betterwrightExpectedInputs("Input.dispatchMouseEvent", { type: "mouseWheel", x: 12, y: 34 }),
    ).toEqual([{ kind: "mouse", type: "mouseWheel", x: 12, y: 34 }]);
    expect(
      betterwrightExpectedInputs("Input.dispatchMouseEvent", { type: "mouseMoved", x: 12, y: 34 }),
    ).toEqual([]);
  });
});
