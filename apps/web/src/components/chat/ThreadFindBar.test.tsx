// FILE: ThreadFindBar.test.tsx
// Purpose: The in-thread find surface is a dedicated bar, not a corner overlay.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatThreadFindHost, ThreadFindBar } from "./ThreadFindBar";

describe("ThreadFindBar", () => {
  it("renders a dedicated full-width find bar with count and navigation chrome", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadFindBar, {
        open: true,
        focusNonce: 1,
        timelineEntries: [],
        onClose: () => {},
        onJump: () => {},
        onHighlightChange: () => {},
      }),
    );

    expect(markup).toContain('data-testid="thread-find-bar"');
    expect(markup).toContain('data-thread-find-layout="bar"');
    expect(markup).toContain("Find in thread");
    expect(markup).toContain("Previous match (Shift+Enter)");
    expect(markup).toContain("Next match (Enter)");
    expect(markup).toContain("Close find (Esc)");
    expect(markup).toContain("flex-1");
    expect(markup).not.toContain("w-36");
  });
});

describe("ChatThreadFindHost", () => {
  it("opens a dedicated find bar on an empty thread (centered landing)", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatThreadFindHost, {
        open: true,
        focusNonce: 1,
        timelineEntries: [],
        threadId: "thread-1",
        onClose: () => {},
        onJump: () => {},
        onHighlightChange: () => {},
      }),
    );

    expect(markup).toContain('data-testid="thread-find-bar"');
    expect(markup).toContain('data-thread-find-layout="bar"');
    expect(markup).toContain('data-thread-find-host="true"');
    expect(markup).toContain("Find in thread");
    expect(markup).toContain("grid-rows-[1fr]");
    expect(markup).toContain("w-full");
    expect(markup).not.toContain("absolute right-2 top-2");
    expect(markup).not.toContain("w-36");
  });

  it("collapses with shared disclosure motion when closed", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatThreadFindHost, {
        open: false,
        focusNonce: 0,
        timelineEntries: [],
        threadId: "thread-1",
        onClose: () => {},
        onJump: () => {},
        onHighlightChange: () => {},
      }),
    );

    expect(markup).toContain('data-testid="thread-find-bar"');
    expect(markup).toContain("grid-rows-[0fr]");
    expect(markup).not.toContain("absolute right-2 top-2");
  });
});
