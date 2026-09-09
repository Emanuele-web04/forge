import { describe, expect, it } from "vitest";

import {
  DEFAULT_THREAD_TITLE_REFRESH_MODE,
  isThreadTitleRefreshEnabled,
  normalizeThreadTitleRefreshMode,
  resolveThreadTitleRefreshMode,
} from "./threadTitleRefreshPolicy";

describe("threadTitleRefreshPolicy", () => {
  it("defaults to off", () => {
    expect(DEFAULT_THREAD_TITLE_REFRESH_MODE).toBe("off");
    expect(resolveThreadTitleRefreshMode({})).toBe("off");
  });

  it("resolves thread > project > global", () => {
    expect(resolveThreadTitleRefreshMode({ global: "automatic" })).toBe("automatic");
    expect(
      resolveThreadTitleRefreshMode({ global: "automatic", project: "suggested" }),
    ).toBe("suggested");
    expect(
      resolveThreadTitleRefreshMode({
        global: "automatic",
        project: "suggested",
        thread: "off",
      }),
    ).toBe("off");
  });

  it("treats unknown values as off", () => {
    expect(normalizeThreadTitleRefreshMode("every-minute")).toBe("off");
    expect(normalizeThreadTitleRefreshMode(undefined)).toBe("off");
    expect(resolveThreadTitleRefreshMode({ global: "bogus" as never })).toBe("off");
  });

  it("reports enabled only for suggested/automatic", () => {
    expect(isThreadTitleRefreshEnabled("off")).toBe(false);
    expect(isThreadTitleRefreshEnabled("suggested")).toBe(true);
    expect(isThreadTitleRefreshEnabled("automatic")).toBe(true);
  });
});
