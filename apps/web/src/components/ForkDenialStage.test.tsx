import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getForkDenialStages } from "../lib/forkDenial";
import { ForkDenialStageList } from "./ForkDenialStage";

describe("ForkDenialStage", () => {
  it("renders every stage label in provided order", () => {
    const stages = getForkDenialStages({ includeFinalForkState: true });
    const markup = renderToStaticMarkup(<ForkDenialStageList stages={stages} />);
    const indexes = stages.map((stage) => markup.indexOf(stage.label));

    for (const index of indexes) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });
});
