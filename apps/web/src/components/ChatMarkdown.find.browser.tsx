// FILE: ChatMarkdown.find.browser.tsx
// Purpose: Browser regression for parse-free in-thread find decoration updates.
// Layer: Vitest browser tests

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const reactMarkdownRender = vi.hoisted(() => vi.fn());

vi.mock("react-markdown", () => {
  return {
    default: (props: { children?: string }) => {
      reactMarkdownRender();
      return <p>{props.children}</p>;
    },
    defaultUrlTransform: (value: string) => value,
  };
});

import ChatMarkdown from "./ChatMarkdown";

function FindQueryHarness() {
  const [query, setQuery] = useState("error");
  return (
    <div>
      <button type="button" onClick={() => setQuery("failed")}>
        Change query
      </button>
      <ChatMarkdown
        text="Error first, then failed."
        cwd={undefined}
        isStreaming={false}
        findQuery={query}
      />
    </div>
  );
}

describe("ChatMarkdown in-thread find", () => {
  afterEach(() => {
    reactMarkdownRender.mockClear();
  });

  it("updates find decoration without rendering the markdown parser again", async () => {
    await render(<FindQueryHarness />);
    expect(reactMarkdownRender).toHaveBeenCalledTimes(1);

    await page.getByRole("button", { name: "Change query" }).click();

    expect(reactMarkdownRender).toHaveBeenCalledTimes(1);
  });
});
