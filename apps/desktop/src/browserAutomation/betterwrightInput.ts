import type { BrowserAutomationExpectedInput } from "../browserManager";

export function betterwrightExpectedInputs(
  method: string,
  params: Record<string, unknown>,
): BrowserAutomationExpectedInput[] {
  if (
    method === "Input.dispatchKeyEvent" &&
    ["keyDown", "rawKeyDown"].includes(String(params.type)) &&
    typeof params.key === "string"
  ) {
    const modifiers = typeof params.modifiers === "number" ? params.modifiers : 0;
    return [
      {
        kind: "key",
        key: params.key,
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
