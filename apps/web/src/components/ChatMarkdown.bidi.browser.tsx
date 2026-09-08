// FILE: ChatMarkdown.bidi.browser.tsx
// Purpose: Browser regressions for native RTL/LTR ownership in transcript markdown.
// Layer: Web component browser tests

import { render } from "vitest-browser-react";
import { describe, expect, it } from "vitest";

import "../index.css";
import ChatMarkdown from "./ChatMarkdown";

function markdownRoot(): HTMLElement {
  const root = document.querySelector<HTMLElement>(
    '.chat-markdown[data-direction-mode="auto-blocks"]',
  );
  if (!root) {
    throw new Error("automatic-direction markdown root was not rendered");
  }
  return root;
}

describe("ChatMarkdown automatic block direction", () => {
  it("uses each top-level prose block's first strong character", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          "مرحبا بالعالم\n\nEnglish paragraph\n\n1234 بدون حرف لاتيني\n\n1234 — !!!\n\nAPI هذا شرح"
        }
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );

    const root = markdownRoot();
    const paragraphs = Array.from(root.querySelectorAll("p"));
    expect(root.getAttribute("dir")).toBeNull();
    expect(paragraphs.map((paragraph) => paragraph.getAttribute("dir"))).toEqual([
      "auto",
      "auto",
      "auto",
      "auto",
      "auto",
    ]);
    expect(paragraphs.map((paragraph) => getComputedStyle(paragraph).direction)).toEqual([
      "rtl",
      "ltr",
      "rtl",
      "ltr",
      "ltr",
    ]);

    await screen.unmount();
  });

  it("keeps nested owners independent and preserves table column order", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "> اقتباس عربي",
          "",
          "- عنصر عربي",
          "- English item",
          "",
          "| العربية | English |",
          "| --- | --- |",
          "| قيمة | value |",
        ].join("\n")}
        cwd={undefined}
        directionMode="auto-blocks"
      />,
    );

    const root = markdownRoot();
    const quote = root.querySelector<HTMLElement>("blockquote");
    const items = Array.from(root.querySelectorAll<HTMLElement>("li"));
    const table = root.querySelector<HTMLTableElement>("table");
    const firstRowCells = Array.from(root.querySelectorAll<HTMLTableCellElement>("thead th"));

    expect(quote?.getAttribute("dir")).toBe("auto");
    expect(getComputedStyle(quote!).direction).toBe("rtl");
    expect(items.map((item) => getComputedStyle(item).direction)).toEqual(["rtl", "ltr"]);
    expect(table?.getAttribute("dir")).toBeNull();
    expect(firstRowCells.map((cell) => cell.getAttribute("dir"))).toEqual(["auto", "auto"]);
    expect(firstRowCells[0]!.getBoundingClientRect().left).toBeLessThan(
      firstRowCells[1]!.getBoundingClientRect().left,
    );

    await screen.unmount();
  });

  it("keeps technical content LTR and retains direction ownership while streaming", async () => {
    const initialText =
      "راجع [التوثيق](https://example.com/docs) واستخدم `npm run test`\n\n```sh\nnpm run test\n```";
    const screen = await render(
      <ChatMarkdown text={initialText} cwd={undefined} directionMode="auto-blocks" isStreaming />,
    );

    const root = markdownRoot();
    const paragraph = root.querySelector("p");
    const link = root.querySelector<HTMLAnchorElement>("p a");
    const inlineCode = root.querySelector<HTMLElement>("p code");
    const codeBlock = root.querySelector<HTMLElement>(".chat-markdown-codeblock");
    expect(getComputedStyle(paragraph!).direction).toBe("rtl");
    expect(link?.getAttribute("dir")).toBe("auto");
    expect(link?.href).toBe("https://example.com/docs");
    expect(link?.textContent).toContain("التوثيق");
    expect(getComputedStyle(link!).direction).toBe("rtl");
    expect(inlineCode?.getAttribute("dir")).toBe("ltr");
    expect(getComputedStyle(inlineCode!).direction).toBe("ltr");
    expect(codeBlock?.getAttribute("dir")).toBe("ltr");

    await screen.rerender(
      <ChatMarkdown
        text={`${initialText}\n\nEnglish follows.`}
        cwd={undefined}
        directionMode="auto-blocks"
        isStreaming
      />,
    );
    expect(markdownRoot()).toBe(root);
    expect(root.querySelector("p")?.getAttribute("dir")).toBe("auto");
    expect(getComputedStyle(root.querySelector("p")!).direction).toBe("rtl");

    await screen.unmount();
  });
});
