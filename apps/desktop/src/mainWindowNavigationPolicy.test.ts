import { describe, expect, it } from "vitest";

import { isAllowedMainWindowNavigation } from "./mainWindowNavigationPolicy";

describe("main window navigation policy", () => {
  it("allows paths within the configured packaged app authority", () => {
    expect(
      isAllowedMainWindowNavigation(
        "synara://app/settings?section=security#sessions",
        "synara://app/index.html",
      ),
    ).toBe(true);
  });

  it("allows paths within the exact configured development origin", () => {
    expect(
      isAllowedMainWindowNavigation(
        "http://localhost:5173/project/one",
        "http://localhost:5173/index.html",
      ),
    ).toBe(true);
  });

  it.each([
    "https://example.com/",
    "synara://app.attacker.test/",
    "synara-canary://app/index.html",
    "synara://user@app/index.html",
    "not a url",
  ])("rejects navigation outside the packaged app authority: %s", (targetUrl) => {
    expect(isAllowedMainWindowNavigation(targetUrl, "synara://app/index.html")).toBe(false);
  });

  it.each(["http://127.0.0.1:5173/", "http://localhost:4173/", "https://localhost:5173/"])(
    "rejects navigation outside the exact development origin: %s",
    (targetUrl) => {
      expect(isAllowedMainWindowNavigation(targetUrl, "http://localhost:5173/")).toBe(false);
    },
  );
});
