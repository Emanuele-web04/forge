// FILE: ThreadFindBar.test.tsx
// Purpose: The in-thread find surface is a compact floating top-right panel.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatThreadFindHost, ThreadFindBar } from "./ThreadFindBar";

describe("ThreadFindBar", () => {
  it("renders a compact find panel with field, navigation, and close chrome", () => {
    const markup = renderToStaticMarkup(
      createElement(ThreadFindBar, {
        open: true,
        focusNonce: 1,
        timelineEntries: [],
        onClose: () => {},
        onJump: () => {},
        onHighlightChange: () => {},
        onActiveMatchChange: () => {},
      }),
    );

    expect(markup).toContain('data-testid="thread-find-bar"');
    expect(markup).toContain('data-thread-find-layout="panel"');
    expect(markup).toContain("Find in thread");
    expect(markup).toContain("Search chat...");
    expect(markup).toContain("Previous match (Shift+Enter)");
    expect(markup).toContain("Next match (Enter)");
    expect(markup).toContain("Close find (Esc)");
    expect(markup).toContain("w-80");
    // The results row is a collapsed disclosure until a query is typed.
    expect(markup).toContain("grid-rows-[0fr]");
  });
});

describe("ChatThreadFindHost", () => {
  it("floats the find panel at the top-right without displacing the transcript", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatThreadFindHost, {
        open: true,
        focusNonce: 1,
        timelineEntries: [],
        threadId: "thread-1",
        className: "pr-[138px]!",
        onClose: () => {},
        onJump: () => {},
        onHighlightChange: () => {},
        onActiveMatchChange: () => {},
      }),
    );

    expect(markup).toContain('data-testid="thread-find-bar"');
    expect(markup).toContain('data-thread-find-layout="panel"');
    expect(markup).toContain('data-thread-find-host="true"');
    expect(markup).toContain("Find in thread");
    expect(markup).toContain("absolute right-0 top-0");
    expect(markup).toContain("pr-[138px]!");
    // Above the header and the docked Environment overlay (z-20) so find never
    // slides with either.
    expect(markup).toContain("z-40");
    expect(markup).toContain("grid-rows-[1fr]");
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
        onActiveMatchChange: () => {},
      }),
    );

    expect(markup).toContain('data-testid="thread-find-bar"');
    expect(markup).toContain("grid-rows-[0fr]");
  });
});
