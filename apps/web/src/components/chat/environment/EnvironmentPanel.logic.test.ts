import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  getRepositoryLabel,
  UPSTREAM_AMNESIA_HINT,
  UPSTREAM_AMNESIA_LABEL,
} from "./EnvironmentPanel";
import { shouldShowStudioFolderRow } from "./EnvironmentPanel.logic";

describe("shouldShowStudioFolderRow", () => {
  it("shows a picked Studio reference folder only when the native shell can open it", () => {
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: false,
      }),
    ).toBe(false);
  });

  it("hides the row outside Studio and when no folder was picked", () => {
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: false,
        studioFolderPath: "/Users/tester/Projects/demo",
        nativeShellAvailable: true,
      }),
    ).toBe(false);
    expect(
      shouldShowStudioFolderRow({
        isStudioChat: true,
        studioFolderPath: null,
        nativeShellAvailable: true,
      }),
    ).toBe(false);
  });
});

describe("getRepositoryLabel", () => {
  it("shows the upstream repository when amnesia is disabled", () => {
    const markup = renderToStaticMarkup(
      getRepositoryLabel({
        githubRepository: { nameWithOwner: "openai/codex", url: "https://github.com/openai/codex" },
        hideUpstreamRepositoryInfo: false,
      }),
    );

    expect(markup).toContain("openai/codex");
    expect(markup).not.toContain(UPSTREAM_AMNESIA_LABEL);
  });

  it("hides upstream identity with amnesia messaging when enabled", () => {
    const markup = renderToStaticMarkup(
      getRepositoryLabel({
        githubRepository: { nameWithOwner: "openai/codex", url: "https://github.com/openai/codex" },
        hideUpstreamRepositoryInfo: true,
      }),
    );

    expect(markup).toContain(UPSTREAM_AMNESIA_LABEL);
    expect(markup).toContain(UPSTREAM_AMNESIA_HINT);
    expect(markup).not.toContain("openai/codex");
  });
});
