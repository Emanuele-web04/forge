import { describe, expect, it } from "vitest";

import { CloudAuthRequestError } from "./cloudAuthApi";

describe("CloudAuthRequestError", () => {
  it("is distinguishable from an unexpected browser failure", () => {
    expect(new CloudAuthRequestError("Invalid credentials")).toMatchObject({
      message: "Invalid credentials",
      name: "CloudAuthRequestError",
    });
  });
});
