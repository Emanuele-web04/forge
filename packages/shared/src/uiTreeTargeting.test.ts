import { describe, expect, it } from "vitest";

import {
  flattenUiTree,
  resolveUiTreeTarget,
  uiTreeActivationPoint,
  type UiTreeTargetSpec,
} from "./uiTreeTargeting";

interface TestNode {
  readonly label: string;
  readonly role: string;
  readonly onScreen?: boolean;
  readonly children?: readonly TestNode[];
}

const node = (partial: Partial<TestNode> & { readonly label: string }): TestNode => ({
  role: partial.role ?? "button",
  onScreen: partial.onScreen ?? true,
  children: partial.children ?? [],
  label: partial.label,
});

class NoMatch extends Error {
  constructor(readonly pool: readonly TestNode[]) {
    super(`nothing matched; pool: ${pool.map((entry) => entry.label).join(",")}`);
    this.name = "NoMatch";
  }
}

class Ambiguous extends Error {
  constructor(readonly matches: readonly TestNode[]) {
    super(`${matches.length} matched: ${matches.map((entry) => entry.label).join(",")}`);
    this.name = "Ambiguous";
  }
}

const childrenOf = (entry: TestNode): readonly TestNode[] => entry.children ?? [];

function spec(overrides: Partial<UiTreeTargetSpec<TestNode>> = {}): UiTreeTargetSpec<TestNode> {
  return {
    labelOf: (entry) => entry.label,
    matchesRole: (entry, role) => entry.role === role,
    matchKey: (label) => label.trim().toLocaleLowerCase(),
    exactKey: (label) => label.trim().toLocaleLowerCase(),
    isOnScreen: (entry) => entry.onScreen !== false,
    preferOnScreen: true,
    noMatch: (pool) => new NoMatch(pool),
    ambiguous: (matches) => new Ambiguous(matches),
    ...overrides,
  };
}

const resolve = (
  pool: readonly TestNode[],
  query: { label?: string | undefined; role?: string | undefined },
  overrides?: Partial<UiTreeTargetSpec<TestNode>>,
) => resolveUiTreeTarget({ pool, query, spec: spec(overrides) });

function thrown<TError>(run: () => unknown): TError {
  try {
    run();
  } catch (cause) {
    return cause as TError;
  }
  throw new Error("expected a refusal");
}

describe("flattening a tree", () => {
  it("visits parents before their children, depth first", () => {
    const root = node({
      label: "root",
      children: [
        node({ label: "a", children: [node({ label: "a1" }), node({ label: "a2" })] }),
        node({ label: "b" }),
      ],
    });
    const labels = flattenUiTree(root, childrenOf).map((entry) => entry.label);
    expect(labels).toEqual(["root", "a", "a1", "a2", "b"]);
  });
});

describe("the activation point", () => {
  it("prefers a node's own control point over the centre of its frame", () => {
    const point = uiTreeActivationPoint({
      frame: { x: 36, y: 184, width: 330, height: 28 },
      activationPoint: { x: 336.5, y: 198 },
    });
    expect(point).toEqual({ x: 336.5, y: 198 });
  });

  it("falls back to the frame centre for a null or absent control point", () => {
    const frame = { x: 10, y: 20, width: 100, height: 40 };
    expect(uiTreeActivationPoint({ frame, activationPoint: null })).toEqual({ x: 60, y: 40 });
    expect(uiTreeActivationPoint({ frame })).toEqual({ x: 60, y: 40 });
  });
});

describe("resolving a label", () => {
  it("prefers an exact label over a longer one that merely contains it", () => {
    const pool = [node({ label: "Developer" }), node({ label: "Developer Mode" })];
    expect(resolve(pool, { label: "Developer" }).node.label).toBe("Developer");
  });

  it("falls back to substring only when nothing matches exactly", () => {
    const pool = [node({ label: "Developer Mode" })];
    expect(resolve(pool, { label: "Developer" }).node.label).toBe("Developer Mode");
  });

  it("refuses several matches rather than taking the first", () => {
    const pool = [node({ label: "Row A" }), node({ label: "Row B" })];
    const error = thrown<Ambiguous>(() => resolve(pool, { label: "Row" }));
    expect(error).toBeInstanceOf(Ambiguous);
    expect(error.matches).toHaveLength(2);
  });

  it("hands the whole pool, not the near misses, to the no-match refusal", () => {
    const pool = [node({ label: "Wi-Fi" }), node({ label: "Bluetooth" })];
    const error = thrown<NoMatch>(() => resolve(pool, { label: "Airplane Mode" }));
    expect(error).toBeInstanceOf(NoMatch);
    expect(error.pool).toBe(pool);
  });

  it("narrows by role before matching the label", () => {
    const pool = [
      node({ label: "Wi-Fi", role: "heading" }),
      node({ label: "Wi-Fi", role: "switch" }),
    ];
    expect(() => resolve(pool, { label: "Wi-Fi" })).toThrow(Ambiguous);
    expect(resolve(pool, { label: "Wi-Fi", role: "switch" }).node.role).toBe("switch");
  });

  it("matches on role alone when the query names no label", () => {
    const pool = [node({ label: "Wi-Fi", role: "heading" }), node({ label: "Save", role: "menu" })];
    expect(resolve(pool, { role: "menu" }).node.label).toBe("Save");
  });

  it("compares both sides through the family's own keys", () => {
    const pool = [node({ label: "Dark Appearance" })];
    // The default spec trims and lowercases; a family that does neither sees
    // these as different strings, which is exactly why the keys are a slot.
    expect(resolve(pool, { label: "  dark appearance " }).node.label).toBe("Dark Appearance");
    const verbatim = { matchKey: (label: string) => label, exactKey: (label: string) => label };
    expect(() => resolve(pool, { label: "  dark appearance " }, verbatim)).toThrow(NoMatch);
  });

  it("promotes an exact match by exactKey even when matchKey is looser", () => {
    // The desktop family's shape: substring is case-insensitive, exactness is
    // not, so a differently-cased query stays ambiguous.
    const pool = [node({ label: "Save" }), node({ label: "Save As" })];
    const strictExact = { exactKey: (label: string) => label };
    expect(resolve(pool, { label: "Save" }, strictExact).node.label).toBe("Save");
    expect(() => resolve(pool, { label: "save" }, strictExact)).toThrow(Ambiguous);
  });
});

describe("on-screen handling", () => {
  it("narrows an ambiguity to the visible matches when the family asks it to", () => {
    const pool = [node({ label: "Row", onScreen: true }), node({ label: "Row", onScreen: false })];
    const match = resolve(pool, { label: "Row" });
    expect(match.onScreen).toBe(true);
    expect(match.node.onScreen).toBe(true);
  });

  it("reports an off-screen sole match rather than refusing it here", () => {
    const pool = [node({ label: "Far Below", onScreen: false })];
    expect(resolve(pool, { label: "Far Below" })).toMatchObject({ onScreen: false });
  });

  it("leaves an ambiguity ambiguous when the family does not prefer visible ones", () => {
    // Without the narrowing a repeated label stays a refusal, which is what a
    // family whose refusal is meant to name every match wants.
    const pool = [node({ label: "Row", onScreen: true }), node({ label: "Row", onScreen: false })];
    expect(() => resolve(pool, { label: "Row" }, { preferOnScreen: false })).toThrow(Ambiguous);
  });
});
