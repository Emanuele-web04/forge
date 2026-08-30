import { describe, expect, it } from "vitest";

import type { ComputerUiNode, ComputerWindowId } from "@synara/contracts";

import {
  ComputerTargetError,
  activationPointForNode,
  actionableElements,
  computerTargetCandidates,
  resolveComputerPoint,
  resolveComputerSemanticTarget,
} from "./uiTreeTargeting.ts";

const windowId = (value: string): ComputerWindowId => value as ComputerWindowId;

function node(partial: Partial<ComputerUiNode> & { readonly role: string }): ComputerUiNode {
  return {
    role: partial.role,
    label: partial.label ?? null,
    value: partial.value ?? null,
    description: partial.description ?? null,
    frame: partial.frame ?? { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: partial.activationPoint ?? null,
    onScreen: partial.onScreen ?? true,
    windowId: partial.windowId ?? null,
    children: partial.children ?? [],
  };
}

const DESKTOP = node({
  role: "desktop",
  description: "AT-SPI desktop",
  children: [
    node({
      role: "push button",
      label: "Save",
      windowId: windowId("editor"),
      frame: { x: 100, y: 200, width: 80, height: 30 },
      activationPoint: { x: 140, y: 215 },
    }),
    node({
      role: "push button",
      label: "Save As",
      windowId: windowId("editor"),
      frame: { x: 200, y: 200, width: 80, height: 30 },
    }),
    node({
      role: "menu item",
      label: "Save",
      windowId: windowId("browser"),
      frame: { x: 900, y: 200, width: 80, height: 30 },
    }),
  ],
});

function thrown(run: () => unknown): ComputerTargetError {
  try {
    run();
  } catch (cause) {
    return cause as ComputerTargetError;
  }
  throw new Error("expected a ComputerTargetError");
}

describe("resolving a coordinate target", () => {
  const screen = { width: 1_920, height: 1_080, scale: 1 };

  it("takes a point that is on the screen", () => {
    expect(resolveComputerPoint({ x: 10, y: 20 }, screen)).toEqual({ x: 10, y: 20 });
  });

  it("refuses half a coordinate and a coordinate past the edge", () => {
    const half = thrown(() => resolveComputerPoint({ x: 10 }, screen));
    expect(half.code).toBe("computer_target_invalid");
    const past = thrown(() => resolveComputerPoint({ x: 1_920, y: 10 }, screen));
    expect(past.code).toBe("computer_target_offscreen");
  });
});

describe("resolving a labelled desktop target", () => {
  it("returns the control's own activation point when it has one", () => {
    const match = resolveComputerSemanticTarget(DESKTOP, { label: "Save", role: "push button" });
    expect(match.point).toEqual({ x: 140, y: 215 });
    expect(match.node.windowId).toBe("editor");
  });

  it("falls back to the frame centre for a control with no activation point", () => {
    const plain = node({ role: "x", frame: { x: 10, y: 20, width: 100, height: 40 } });
    expect(activationPointForNode(plain)).toEqual({ x: 60, y: 40 });
  });

  it("prefers an exact label over a longer one that contains it", () => {
    const target = { label: "Save", windowId: windowId("editor") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.frame.x).toBe(100);
  });

  it("scopes matching to the named window", () => {
    const target = { label: "Save", windowId: windowId("browser") };
    expect(resolveComputerSemanticTarget(DESKTOP, target).node.role).toBe("menu item");
  });

  it("falls back to substring when no label matches exactly", () => {
    expect(resolveComputerSemanticTarget(DESKTOP, { label: "ave As" }).node.label).toBe("Save As");
  });

  it("compares a role verbatim rather than loosely", () => {
    // AT-SPI role names are a fixed vocabulary, so a near miss is a wrong role
    // and not a spelling to be forgiven.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { role: "Push Button" }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("matches a label without trimming the query", () => {
    // Nothing trims a label arriving over MCP, and quietly acting on a control
    // the caller did not name is worse than a refusal they can correct.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: " Save " }));
    expect(error.code).toBe("computer_target_not_found");
  });

  it("refuses a label that names a control in two windows", () => {
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Save" }));
    expect(error.code).toBe("computer_target_ambiguous");
    expect(error.candidates).toHaveLength(2);
  });

  it("trusts the perception source's own on-screen flag", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Hidden",
          onScreen: false,
          // On screen by coordinates; the source knows better, and is believed.
          frame: { x: 10, y: 10, width: 80, height: 30 },
        }),
      ],
    });
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Hidden" }));
    expect(error.code).toBe("computer_target_offscreen");
    expect(error.candidates).toHaveLength(1);
  });
});

describe("naming the candidates", () => {
  it("puts the candidates in the message, not only in the structured field", () => {
    // Every transport between here and the model — MCP tool errors, WsRpcError —
    // is only guaranteed to carry the message, and a "no such label" with no
    // list of the real ones is a dead end.
    const error = thrown(() => resolveComputerSemanticTarget(DESKTOP, { label: "Print" }));
    expect(error.code).toBe("computer_target_not_found");
    expect(error.candidates.length).toBeGreaterThan(0);
    expect(error.message).toContain("Save As");
    expect(error.message).toContain("push button");
    expect(error.message).toContain('in window "editor"');
  });

  it("leaves a message alone when there are no candidates to name", () => {
    const screen = { width: 100, height: 100 };
    const error = thrown(() => resolveComputerPoint({ x: 5_000, y: 10 }, screen));
    expect(error.message).toBe("Computer target (5000, 10) is outside the 100x100 screen.");
  });

  it("caps a candidate list at sixteen entries", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 40 }, (_unused, index) =>
        node({ role: "push button", label: `Button ${index}` }),
      ),
    });
    // The root counts too: the cap is on the flattened list, not on the children.
    expect(computerTargetCandidates(desktop)).toHaveLength(16);
    const error = thrown(() => resolveComputerSemanticTarget(desktop, { label: "Nope" }));
    expect(error.candidates).toHaveLength(16);
  });
});

/**
 * The digest is what makes labels discoverable to the model: without it the
 * only grounding is pixel estimation from a downscaled screenshot, which is
 * exactly the clunkiness this exists to remove.
 */
describe("actionableElements", () => {
  it("lists labeled on-screen actionable elements in tree order", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "push button",
          label: "Reload",
          windowId: windowId("browser"),
          children: [
            node({ role: "entry", label: "Email", value: "", windowId: windowId("browser") }),
          ],
        }),
        node({ role: "heading", label: "Settings", windowId: windowId("browser") }),
      ],
    });

    expect(actionableElements(desktop)).toEqual({
      complete: true,
      items: [
        { role: "push button", label: "Reload", windowId: windowId("browser") },
        { role: "entry", label: "Email", value: "", windowId: windowId("browser") },
      ],
    });
  });

  it("drops unlabeled controls, static text, and off-screen elements", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({ role: "push button", windowId: windowId("w") }),
        node({ role: "text", label: "A paragraph of static text", windowId: windowId("w") }),
        node({
          role: "check box",
          label: "Off screen",
          onScreen: false,
          windowId: windowId("w"),
        }),
        node({ role: "check box", label: "Subscribed", windowId: windowId("w") }),
      ],
    });

    expect(actionableElements(desktop).items).toEqual([
      { role: "check box", label: "Subscribed", windowId: windowId("w") },
    ]);
  });

  it("falls back to the description when there is no label, matching targeting", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "slider",
          description: "Volume",
          windowId: windowId("player"),
        }),
      ],
    });

    // Targeting matches on `label ?? description`, so the digest must name the
    // element by the same words or the model could not act on it by label.
    expect(actionableElements(desktop).items).toEqual([
      { role: "slider", label: "Volume", windowId: windowId("player") },
    ]);
  });

  it("keeps duplicate labels — real ambiguity — but separates windows", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({ role: "push button", label: "Save", windowId: windowId("editor") }),
        node({ role: "push button", label: "Save", windowId: windowId("editor") }),
        node({ role: "menu item", label: "Save", windowId: windowId("browser") }),
      ],
    });

    const elements = actionableElements(desktop);
    expect(elements.complete).toBe(true);
    expect(elements.items).toHaveLength(3);
    expect(elements.items[0]?.windowId).toBe(windowId("editor"));
    expect(elements.items.at(-1)?.windowId).toBe(windowId("browser"));
  });

  it("truncates long labels and values on whole characters", () => {
    const desktop = node({
      role: "desktop",
      children: [
        node({
          role: "entry",
          label: `x`.repeat(300),
          value: "v".repeat(200),
          windowId: windowId("editor"),
        }),
      ],
    });

    const [element] = actionableElements(desktop).items;
    expect(element?.label.length).toBeLessThanOrEqual(80);
    expect(element?.value?.length).toBeLessThanOrEqual(40);
  });

  it("caps the list and reports when it had to cut elements off", () => {
    const desktop = node({
      role: "desktop",
      children: Array.from({ length: 80 }, (_unused, index) =>
        node({
          role: "push button",
          label: `Button ${index}`,
          windowId: windowId("panel"),
          children: [node({ role: "link", label: "child link", windowId: windowId("panel") })],
        }),
      ),
    });

    const elements = actionableElements(desktop);
    expect(elements.items).toHaveLength(60);
    expect(elements.complete).toBe(false);
  });
});
