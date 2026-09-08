import { describe, expect, it } from "vitest";

import { parseMacUiForest } from "./macUiTree.ts";

describe("parseMacUiForest", () => {
  const screenSize = { width: 1440, height: 900, scale: 1 };

  it("shifts global frames into agent space and preserves the node path", () => {
    const payload = {
      root: {
        role: "desktop",
        frame: { x: -100, y: -50, width: 1440, height: 900 },
        children: [
          {
            role: "AXTextField",
            label: "Amount",
            value: "12",
            windowId: "5",
            frame: { x: 200, y: 150, width: 120, height: 24 },
            activationPoint: { x: 260, y: 162 },
            nodePath: [0, 3],
            editable: true,
            children: [],
          },
        ],
      },
    };
    const root = parseMacUiForest(payload, screenSize, { x: -100, y: -50 });
    expect(root?.frame).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    const field = root?.children[0];
    expect(field?.frame).toEqual({ x: 300, y: 200, width: 120, height: 24 });
    expect(field?.activationPoint).toEqual({ x: 360, y: 212 });
    expect(field?.nodePath).toEqual([0, 3]);
    expect(field?.editable).toBe(true);
    expect(field?.windowId).toBe("5");
  });

  it("drops a node with no usable frame rather than inventing coordinates", () => {
    const payload = { root: { role: "desktop", frame: { x: 0, y: 0, width: 100, height: 100 } } };
    const root = parseMacUiForest(payload, screenSize, { x: 0, y: 0 });
    expect(root?.children).toEqual([]);
  });

  it("returns undefined when the payload carries no root frame at all", () => {
    expect(parseMacUiForest({}, screenSize, { x: 0, y: 0 })).toBeUndefined();
  });

  it("carries the helper's truncation marker through to the agent", () => {
    const payload = {
      root: {
        role: "desktop",
        frame: { x: 0, y: 0, width: 100, height: 100 },
        children: [
          {
            role: "AXWindow",
            truncated: true,
            frame: { x: 0, y: 0, width: 50, height: 50 },
            children: [],
          },
        ],
      },
    };
    const root = parseMacUiForest(payload, screenSize, { x: 0, y: 0 });
    // Dropping this left a budget-truncated subtree indistinguishable from a
    // complete one, so an agent reads "no such control" instead of "not walked".
    expect(root?.children[0]?.truncated).toBe(true);
    expect(root?.truncated).toBeUndefined();
  });

  it("clamps an oversized label so the schema encode cannot fail", () => {
    const huge = "x".repeat(5_000);
    const payload = {
      root: {
        role: "desktop",
        frame: { x: 0, y: 0, width: 100, height: 100 },
        children: [
          {
            role: "AXStaticText",
            label: huge,
            frame: { x: 0, y: 0, width: 10, height: 10 },
            children: [],
          },
        ],
      },
    };
    const root = parseMacUiForest(payload, screenSize, { x: 0, y: 0 });
    expect(root?.children[0]?.label?.length ?? 0).toBeLessThanOrEqual(1_024);
  });
});
