import type { BrowserAutomationExpectedInput } from "../browserManager";
import { normalizedKeyEventKey } from "./betterwrightKeyboardPolicy";

export function betterwrightExpectedInputs(
  method: string,
  params: Record<string, unknown>,
): BrowserAutomationExpectedInput[] {
  if (
    method === "Input.dispatchKeyEvent" &&
    ["keyDown", "rawKeyDown"].includes(String(params.type))
  ) {
    // The keyboard policy accepts key, code, text and virtual-key forms; the
    // takeover signal must register for every one of them or a valid dispatch
    // reads as an unexpected synthetic key. Normalize the supplied key so it
    // matches the lower-cased form the browser manager expects.
    const key = normalizedKeyEventKey(params);
    if (!key) return [];
    const modifiers = typeof params.modifiers === "number" ? params.modifiers : 0;
    return [
      {
        kind: "key",
        key,
        alt: Boolean(modifiers & 1),
        control: Boolean(modifiers & 2),
        meta: Boolean(modifiers & 4),
        shift: Boolean(modifiers & 8),
      },
    ];
  }
  if (
    method !== "Input.dispatchMouseEvent" ||
    typeof params.x !== "number" ||
    typeof params.y !== "number"
  )
    return [];
  if (params.type !== "mousePressed" && params.type !== "mouseWheel") return [];
  const button =
    params.button === "left" || params.button === "right" || params.button === "middle"
      ? params.button
      : undefined;
  const point: { x: number; y: number; button?: "left" | "right" | "middle" } = {
    x: params.x,
    y: params.y,
    ...(button ? { button } : {}),
  };
  return [
    { kind: "mouse", type: params.type === "mouseWheel" ? "mouseWheel" : "mouseDown", ...point },
    ...(button === "right" && params.type === "mousePressed"
      ? [{ kind: "mouse" as const, type: "contextMenu" as const, ...point }]
      : []),
  ];
}
