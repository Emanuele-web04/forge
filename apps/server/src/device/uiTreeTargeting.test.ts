import { describe, expect, it } from "vitest";

import type { DeviceUiNode } from "@synara/contracts";

import {
  DeviceUiTargetError,
  findTarget,
  planScrollStep,
  readTapRequest,
  resolveTapTarget,
  tapPointForNode,
} from "./uiTreeTargeting.ts";

function node(partial: Partial<DeviceUiNode> & { readonly role: string }): DeviceUiNode {
  return {
    role: partial.role,
    subrole: partial.subrole ?? null,
    label: partial.label ?? null,
    value: partial.value ?? null,
    frame: partial.frame ?? { x: 0, y: 0, width: 402, height: 874 },
    activationPoint: partial.activationPoint ?? null,
    children: partial.children ?? [],
  };
}

/** The real Settings > Developer screen, measured on an iPhone 17 Pro. */
const DARK_APPEARANCE = node({
  role: "CheckBox",
  subrole: "Switch",
  label: "Dark Appearance",
  value: "0",
  frame: { x: 36, y: 184, width: 330, height: 28 },
  activationPoint: { x: 336.5, y: 198 },
});

const SCREEN = node({
  role: "Application",
  label: "Settings",
  children: [
    DARK_APPEARANCE,
    node({ role: "Button", label: "L4S", frame: { x: 20, y: 692, width: 362, height: 53 } }),
  ],
});

describe("tap point resolution", () => {
  it("prefers a control's own activation point over its row centre", () => {
    // The row spans x 36..366, so its centre is x=201: dead space that
    // swallowed a real agent's tap. Only x=336.5 hits the switch.
    expect(tapPointForNode(DARK_APPEARANCE)).toEqual({ x: 336.5, y: 198 });
  });

  it("falls back to the frame centre when a node has no activation point", () => {
    const plain = node({ role: "Button", frame: { x: 10, y: 20, width: 100, height: 40 } });
    expect(tapPointForNode(plain)).toEqual({ x: 60, y: 40 });
  });
});

describe("resolving a label to an element", () => {
  it("finds a switch by label and returns its own tap point and state", () => {
    const match = resolveTapTarget(SCREEN, { label: "Dark Appearance" });
    expect(match.point).toEqual({ x: 336.5, y: 198 });
    expect(match.node.value).toBe("0");
    expect(match.node.subrole).toBe("Switch");
  });

  it("matches case-insensitively and ignores surrounding space", () => {
    expect(resolveTapTarget(SCREEN, { label: "  dark appearance " }).point).toEqual({
      x: 336.5,
      y: 198,
    });
  });

  it("prefers an exact label over a longer one that merely contains it", () => {
    // "Developer" must not be ambiguous just because "Developer Mode" exists.
    const screen = node({
      role: "Application",
      children: [
        node({
          role: "Button",
          label: "Developer",
          frame: { x: 0, y: 100, width: 402, height: 50 },
        }),
        node({
          role: "Button",
          label: "Developer Mode",
          frame: { x: 0, y: 200, width: 402, height: 50 },
        }),
      ],
    });
    expect(resolveTapTarget(screen, { label: "Developer" }).point).toEqual({ x: 201, y: 125 });
  });

  it("uses role to disambiguate a label that appears twice", () => {
    const screen = node({
      role: "Application",
      children: [
        node({ role: "Heading", label: "Wi-Fi", frame: { x: 0, y: 100, width: 402, height: 40 } }),
        node({
          role: "CheckBox",
          subrole: "Switch",
          label: "Wi-Fi",
          value: "1",
          frame: { x: 0, y: 200, width: 402, height: 44 },
          activationPoint: { x: 336, y: 222 },
        }),
      ],
    });
    expect(() => resolveTapTarget(screen, { label: "Wi-Fi" })).toThrow(/2 elements match/);
    expect(resolveTapTarget(screen, { label: "Wi-Fi", role: "Switch" }).point).toEqual({
      x: 336,
      y: 222,
    });
    expect(resolveTapTarget(screen, { label: "Wi-Fi", role: "Heading" }).point).toEqual({
      x: 201,
      y: 120,
    });
  });

  it("names the elements on screen when the label matches nothing", () => {
    const error = (() => {
      try {
        resolveTapTarget(SCREEN, { label: "Airplane Mode" });
        return null;
      } catch (cause) {
        return cause as DeviceUiTargetError;
      }
    })();
    expect(error).toBeInstanceOf(DeviceUiTargetError);
    // The list has to reach the agent through the message: every transport
    // between here and the model carries only that.
    expect(error?.message).toMatch(/Dark Appearance/);
    expect(error?.candidates.length).toBeGreaterThan(0);
  });

  it("refuses an off-screen match instead of tapping through to something else", () => {
    // A scrolled-away row keeps a real frame with off-screen coordinates;
    // tapping it would hit whatever now occupies that position.
    const screen = node({
      role: "Application",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        node({
          role: "Button",
          label: "Far Below",
          frame: { x: 0, y: 1800, width: 402, height: 50 },
        }),
      ],
    });
    expect(() => resolveTapTarget(screen, { label: "Far Below" })).toThrow(/scrolled off screen/);
  });

  it("rejects an empty label rather than matching everything", () => {
    expect(() => resolveTapTarget(SCREEN, { label: "   " })).toThrow(/non-empty label/);
  });
});

describe("reading a tap request", () => {
  it("accepts a label, with or without a role", () => {
    expect(readTapRequest({ label: "Dark Appearance" })).toEqual({
      kind: "element",
      target: { label: "Dark Appearance", role: undefined },
    });
    expect(readTapRequest({ label: "Wi-Fi", role: "Switch" })).toMatchObject({
      kind: "element",
      target: { role: "Switch" },
    });
  });

  it("accepts an explicit point", () => {
    expect(readTapRequest({ x: 10, y: 20 })).toEqual({ kind: "point", x: 10, y: 20 });
  });

  it("refuses shapes that are neither, and says which to use", () => {
    expect(() => readTapRequest({})).toThrow(/either label .* or both x and y/);
    expect(() => readTapRequest({ x: 10 })).toThrow(/both x and y/);
    // Both forms at once is ambiguous: silently preferring one would make the
    // other's presence a lie about what got tapped.
    expect(() => readTapRequest({ label: "A", x: 1, y: 2 })).toThrow(/not both/);
  });
});

describe("planning a scroll step", () => {
  const screen = node({ role: "Application", frame: { x: 0, y: 0, width: 402, height: 874 } });

  it("asks for no swipe when the target is already in the band", () => {
    const middle = node({ role: "Button", frame: { x: 0, y: 400, width: 402, height: 44 } });
    expect(planScrollStep(middle, screen)).toBeNull();
  });

  it("treats a row under the status bar as needing a scroll, not as visible", () => {
    // On screen by coordinates, untappable in practice: the band exists so a
    // target does not end up beneath the status bar or home indicator.
    const underStatusBar = node({ role: "Button", frame: { x: 0, y: 10, width: 402, height: 30 } });
    expect(planScrollStep(underStatusBar, screen)).not.toBeNull();
  });

  it("swipes upward to pull a target below the fold into view", () => {
    const below = node({ role: "Button", frame: { x: 0, y: 1_500, width: 402, height: 44 } });
    const step = planScrollStep(below, screen);
    // Content follows the finger, so reaching downward means dragging up.
    expect(step).not.toBeNull();
    expect((step as NonNullable<typeof step>).toY).toBeLessThan(
      (step as NonNullable<typeof step>).fromY,
    );
  });

  it("swipes downward to pull a target above the fold into view", () => {
    const above = node({ role: "Button", frame: { x: 0, y: -600, width: 402, height: 44 } });
    const step = planScrollStep(above, screen);
    expect(step).not.toBeNull();
    expect((step as NonNullable<typeof step>).toY).toBeGreaterThan(
      (step as NonNullable<typeof step>).fromY,
    );
  });

  it("never swipes further than the gap, so a near target is not flung past", () => {
    const justBelow = node({ role: "Button", frame: { x: 0, y: 800, width: 402, height: 44 } });
    const step = planScrollStep(justBelow, screen);
    expect(step).not.toBeNull();
    const travelled = Math.abs(
      (step as NonNullable<typeof step>).toY - (step as NonNullable<typeof step>).fromY,
    );
    const gap = Math.abs(822 - 437);
    expect(travelled).toBeLessThanOrEqual(gap + 1);
  });

  it("keeps the swipe inside the screen so the gesture is deliverable", () => {
    const farBelow = node({ role: "Button", frame: { x: 0, y: 5_000, width: 402, height: 44 } });
    const step = planScrollStep(farBelow, screen);
    expect(step).not.toBeNull();
    for (const y of [
      (step as NonNullable<typeof step>).fromY,
      (step as NonNullable<typeof step>).toY,
    ]) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(874);
    }
  });
});

describe("finding a target that is off screen", () => {
  it("reports an off-screen match rather than refusing it outright", () => {
    // findTarget locates it for the scroll loop; resolveTapTarget is the one
    // that insists on visibility, for callers that will not scroll.
    const screen = node({
      role: "Application",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        node({
          role: "Button",
          label: "Far Below",
          frame: { x: 0, y: 1_800, width: 402, height: 50 },
        }),
      ],
    });
    const match = findTarget(screen, { label: "Far Below" });
    expect(match.onScreen).toBe(false);
    expect(() => resolveTapTarget(screen, { label: "Far Below" })).toThrow(/scrolled off screen/);
  });

  it("prefers the visible match when a label repeats down a long list", () => {
    const screen = node({
      role: "Application",
      frame: { x: 0, y: 0, width: 402, height: 874 },
      children: [
        node({ role: "Button", label: "Row", frame: { x: 0, y: 400, width: 402, height: 44 } }),
        node({ role: "Button", label: "Row", frame: { x: 0, y: 2_000, width: 402, height: 44 } }),
      ],
    });
    expect(findTarget(screen, { label: "Row" }).node.frame.y).toBe(400);
  });
});
