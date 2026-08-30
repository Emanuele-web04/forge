import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SidechatMinimalHeader } from "./ChatHeader";

describe("SidechatMinimalHeader", () => {
  it("renders only side chat identity and its close affordance", () => {
    const markup = renderToStaticMarkup(
      <SidechatMinimalHeader title="Investigate cache" onClose={() => undefined} />,
    );

    expect(markup).toContain("Investigate cache");
    expect(markup).toContain("Close side chat");
    expect(markup).not.toContain("Environment");
    expect(markup).not.toContain("Hand off");
  });
});
