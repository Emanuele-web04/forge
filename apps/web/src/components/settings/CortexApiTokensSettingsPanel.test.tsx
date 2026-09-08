import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CortexApiTokensSettingsPanel } from "./CortexApiTokensSettingsPanel";

describe("CortexApiTokensSettingsPanel", () => {
  it("does not pretend that a local token manager is available", () => {
    const markup = renderToStaticMarkup(<CortexApiTokensSettingsPanel active />);
    expect(markup).toContain("Private preview");
    expect(markup).toContain("No token is created, stored, or displayed");
    expect(markup).toContain("Create token");
    expect(markup).toContain("disabled");
  });
});
