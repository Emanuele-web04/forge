import { describe, expect, it } from "vitest";

import { LinearClientError, linearIssueBodyPreview } from "./linearClient";

describe("linearClient helpers", () => {
  it("formats body previews", () => {
    expect(
      linearIssueBodyPreview({
        id: "1",
        identifier: "ENG-1",
        title: "Title",
        description: "Hello   world\n\nmore",
        url: "https://linear.app/x/issue/ENG-1",
      }),
    ).toBe("Hello world more");
  });

  it("exposes typed LinearClientError reasons", () => {
    const error = new LinearClientError("missing-key", "missing");
    expect(error.reason).toBe("missing-key");
    expect(error.message).toBe("missing");
  });
});
