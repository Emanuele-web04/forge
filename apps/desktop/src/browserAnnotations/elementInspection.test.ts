import { describe, expect, it } from "vitest";

import {
  formatCssBorderRadius,
  formatCssBox,
  formatCssColor,
  formatCssFont,
  formatElementSize,
  inspectorCardFor,
  type ElementStyleSnapshot,
} from "./elementInspection";

const BASE_STYLE: ElementStyleSnapshot = {
  color: "rgb(20, 20, 19)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  fontWeight: "400",
  fontSize: "32px",
  lineHeight: "normal",
  fontFamily: 'Geist, "Geist Fallback", sans-serif',
  padding: ["0px", "0px", "0px", "0px"],
  margin: ["0px", "0px", "0px", "0px"],
  radius: ["0px", "0px", "0px", "0px"],
};

describe("formatCssColor", () => {
  it("renders opaque colors as hex", () => {
    expect(formatCssColor("rgb(20, 20, 19)")).toBe("#141413");
  });

  it("keeps alpha as an explicit percentage", () => {
    expect(formatCssColor("rgba(255, 0, 0, 0.5)")).toBe("#ff0000 50%");
  });

  it("scales percentage channels to 255 while alpha stays a fraction", () => {
    expect(formatCssColor("rgb(100% 0% 0%)")).toBe("#ff0000");
    expect(formatCssColor("rgb(100% 0% 0% / 50%)")).toBe("#ff0000 50%");
  });

  it("collapses fully transparent colors", () => {
    expect(formatCssColor("rgba(0, 0, 0, 0)")).toBe("transparent");
  });

  it("passes through values it cannot parse", () => {
    expect(formatCssColor("color(srgb 0.1 0.2 0.3)")).toBe("color(srgb 0.1 0.2 0.3)");
    expect(formatCssColor("   ")).toBeNull();
  });
});

describe("formatCssBox", () => {
  it("returns null for an empty box", () => {
    expect(formatCssBox(["0px", "0px", "0px", "0px"])).toBeNull();
  });

  it("collapses to CSS shorthand", () => {
    expect(formatCssBox(["8px", "8px", "8px", "8px"])).toBe("8px");
    expect(formatCssBox(["8px", "16px", "8px", "16px"])).toBe("8px 16px");
    expect(formatCssBox(["8px", "16px", "4px", "16px"])).toBe("8px 16px 4px");
    expect(formatCssBox(["8px", "16px", "4px", "2px"])).toBe("8px 16px 4px 2px");
  });

  it("rounds sub-pixel lengths and shortens zeros", () => {
    expect(formatCssBox(["12.3456px", "0px", "0px", "0px"])).toBe("12.35px 0 0");
  });
});

describe("formatCssBorderRadius", () => {
  it("collapses circular corners to ordinary shorthand", () => {
    expect(formatCssBorderRadius(["8px", "16px", "8px", "16px"])).toBe("8px 16px");
    expect(formatCssBorderRadius(["0px", "0px", "0px", "0px"])).toBe("0");
  });

  it("keeps the slash required by elliptical corners", () => {
    expect(formatCssBorderRadius(["10px 20px", "10px 20px", "10px 20px", "10px 20px"])).toBe(
      "10px / 20px",
    );
    expect(formatCssBorderRadius(["8px 12px", "16px", "8px 12px", "16px"])).toBe(
      "8px 16px / 12px 16px",
    );
    expect(formatCssBorderRadius(["calc(10px + 2%) calc(20px + 3%)", "0px", "0px", "0px"])).toBe(
      "calc(10px + 2%) 0 0 / calc(20px + 3%) 0 0",
    );
  });
});

describe("formatCssFont", () => {
  it("omits the default weight and normal line height", () => {
    expect(formatCssFont(BASE_STYLE)).toBe('32px Geist, "Geist Fallback", sans-serif');
  });

  it("includes weight and resolved line height", () => {
    expect(formatCssFont({ ...BASE_STYLE, fontWeight: "600", lineHeight: "40px" })).toBe(
      '600 32px/40px Geist, "Geist Fallback", sans-serif',
    );
  });
});

describe("formatElementSize", () => {
  it("rounds to whole pixels", () => {
    expect(formatElementSize(643.4, 68.6)).toBe("643×69");
  });
});

describe("inspectorCardFor", () => {
  it("keeps only rows that carry information", () => {
    const card = inspectorCardFor({
      tagName: "H1",
      width: 643,
      height: 69,
      style: BASE_STYLE,
    });
    expect(card.tag).toBe("h1");
    expect(card.size).toBe("643×69");
    expect(card.rows.map((row) => row.label)).toEqual(["color", "font"]);
  });

  it("reports spacing, background and radius when present", () => {
    const card = inspectorCardFor({
      tagName: "BUTTON",
      width: 120,
      height: 40,
      style: {
        ...BASE_STYLE,
        backgroundColor: "rgb(82, 111, 255)",
        padding: ["8px", "16px", "8px", "16px"],
        margin: ["0px", "0px", "12px", "0px"],
        radius: ["999px", "999px", "999px", "999px"],
      },
    });
    expect(card.rows).toEqual([
      { label: "color", value: "#141413" },
      { label: "bg", value: "#526fff" },
      { label: "font", value: '32px Geist, "Geist Fallback", sans-serif' },
      { label: "padding", value: "8px 16px" },
      { label: "margin", value: "0 0 12px" },
      { label: "radius", value: "999px" },
    ]);
  });

  it("reports elliptical radii with valid slash-separated shorthand", () => {
    const card = inspectorCardFor({
      tagName: "DIV",
      width: 120,
      height: 40,
      style: {
        ...BASE_STYLE,
        radius: ["10px 20px", "10px 20px", "10px 20px", "10px 20px"],
      },
    });
    expect(card.rows.at(-1)).toEqual({ label: "radius", value: "10px / 20px" });
  });
});
