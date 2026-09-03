import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpiredSidechatNotice } from "./ExpiredSidechatNotice";

describe("ExpiredSidechatNotice", () => {
  it("explains expiry and offers a replacement side chat", () => {
    const markup = renderToStaticMarkup(<ExpiredSidechatNotice onStartNew={() => undefined} />);

    expect(markup).toContain("expired after 1 hour of inactivity");
    expect(markup).toContain("Start new");
  });
});
