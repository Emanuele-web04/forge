import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getForkDenialStages } from "../lib/forkDenial";
import { ForkDenialStageList } from "./ForkDenialStage";

describe("ForkDenialStage", () => {
  it("renders every stage label in provided order", () => {
    const stages = getForkDenialStages({ includeFinalForkState: true });
    const markup = renderToStaticMarkup(<ForkDenialStageList stages={stages} />);
    const normalizedMarkup = markup
      .replace(/&#39;|&#x27;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    const indexes = stages.map((stage) => normalizedMarkup.indexOf(stage.label));

    for (const index of indexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});
