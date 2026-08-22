import { readFileSync } from "node:fs";
import { MessageId, ThreadMarkerId, type ThreadMarker } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: (fileName: string) => (fileName.endsWith(".ts") ? "ts" : "text"),
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml(code: string) {
        return `<pre class="shiki"><code>${code}</code></pre>`;
      },
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

async function renderMarkdown(
  text: string,
  cwd = "C:\\Users\\LENOVO\\synara",
  markers?: readonly ThreadMarker[],
) {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");

  return renderToStaticMarkup(
    <ChatMarkdown text={text} cwd={cwd} isStreaming={false} markers={markers} />,
  );
}

async function renderUserMarkdown(text: string) {
  const { default: ChatMarkdown } = await import("./ChatMarkdown");

  return renderToStaticMarkup(
    <ChatMarkdown text={text} cwd={undefined} isStreaming={false} variant="user" />,
  );
}

describe("streamingCodeHighlightIntervalMs", () => {
  it("keeps the base cadence for small blocks and stretches it with block size", async () => {
    const { streamingCodeHighlightIntervalMs } = await import("./ChatMarkdown");
    expect(streamingCodeHighlightIntervalMs(0)).toBe(160);
    expect(streamingCodeHighlightIntervalMs(8_000)).toBe(160);
    expect(streamingCodeHighlightIntervalMs(44_000)).toBe(580);
    expect(streamingCodeHighlightIntervalMs(80_000)).toBe(1_000);
    expect(streamingCodeHighlightIntervalMs(500_000)).toBe(1_000);
  });
});

describe("ChatMarkdown", () => {
  it("uses the theme foreground token for markdown text", async () => {
    const markup = await renderMarkdown("Theme-aware text");

    expect(markup).toContain("text-foreground");
    expect(markup).not.toContain("text-neutral-900");
  });

  it("renders inline math with KaTeX", async () => {
    const markup = await renderMarkdown("Euler wrote $e^{i\\\\pi} + 1 = 0$.");

    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("katex-display");
    expect(markup).not.toContain("$e^{i\\\\pi} + 1 = 0$");
  });

  it("renders display math with KaTeX block output", async () => {
    const markup = await renderMarkdown("$$\n\\\\int_0^1 x^2 \\, dx\n$$");

    expect(markup).toContain("katex-display");
    expect(markup).not.toContain("$$");
  });

  it("keeps links and code intact when math is present", async () => {
    const markup = await renderMarkdown(
      [
        "Read [local notes](./notes.md) and [external docs](https://example.com).",
        "",
        "Inline math $x^2 + y^2$ still renders.",
        "",
        "Inline code `$z$` stays literal.",
        "",
        "```ts",
        'const price = "$5";',
        "```",
      ].join("\n"),
    );

    expect(markup).toContain('href="./notes.md"');
    expect(markup).not.toContain('href="./notes.md" target="_blank"');
    expect(markup).toContain(
      'href="https://example.com" target="_blank" rel="noopener noreferrer"',
    );
    expect(markup).toContain("<code>$z$</code>");
    expect(markup).toContain("const price = &quot;$5&quot;;");
    expect(markup.match(/class="katex"/g) ?? []).toHaveLength(1);
  });

  it("renders external assistant links with the shared favicon icon slot", async () => {
    const markup = await renderMarkdown(
      "Closest source: [OpenAI benchmark](https://openai.com/research).",
    );

    expect(markup).toContain(
      'class="inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline"',
    );
    expect(markup).toContain("inline-block size-[1em] shrink-0 align-middle -translate-y-px mr-1");
    expect(markup).toContain("OpenAI benchmark");
  });

  it("keeps dollar signs in markdown file links from becoming math", async () => {
    const source =
      "Files touched:\n\n- [_chat.$threadId.tsx](/Users/julius/project/apps/web/src/routes/_chat.$threadId.tsx:1192)";
    const markup = await renderMarkdown(source, "/Users/julius/project");

    expect(markup).toContain(
      'href="/Users/julius/project/apps/web/src/routes/_chat.$threadId.tsx:1192"',
    );
    expect(markup).toContain("_chat.$threadId.tsx");
    expect(markup).not.toContain('class="katex"');
    expect(markup).not.toContain("CHATMARKDOWNLITERALDOLLARPLACEHOLDER");
  });

  it("does not turn ordinary dollar text or escaped dollars into math", async () => {
    const markup = await renderMarkdown(
      "It costs $5 to $10 per seat. Escape \\$E=mc^2\\$ when you want literal TeX.",
    );

    expect(markup).toContain("$5 to $10");
    expect(markup).toContain("$E=mc^2$");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps currency literal without swallowing later inline math", async () => {
    const markup = await renderMarkdown("Price $5. Formula $x$ still renders.");

    expect(markup).toContain("$5. Formula");
    expect(markup).toContain('class="katex"');
    expect(markup).not.toContain("$x$");
  });

  it("keeps all-caps dollar identifiers literal", async () => {
    const markup = await renderMarkdown("Use $USD$ for price and $PATH$ for shell lookup.");

    expect(markup).toContain("$USD$");
    expect(markup).toContain("$PATH$");
    expect(markup).not.toContain('class="katex"');
  });

  it("renders a table whose delimiter row is missing cells", async () => {
    // Models regularly emit a delimiter row with fewer cells than the header;
    // GFM rejects the whole block on the mismatch and the table degrades into
    // one run-on paragraph of pipes. The repair pass pads the delimiter row.
    const markup = await renderMarkdown(
      [
        "Studio vs. normal mode:",
        "",
        "| | Normal mode | Studio |",
        "|---|---|",
        "| Purpose | Focused, interactive work | Long-running, agent-led work |",
      ].join("\n"),
    );

    expect(markup).toContain("<table>");
    expect(markup).toContain("<th>Studio</th>");
    expect(markup).toContain("<td>Purpose</td>");
    expect(markup).not.toContain("|---|");
  });

  it("keeps pipe-and-dash lines inside code fences out of table repair", async () => {
    const markup = await renderMarkdown(["```", "| a | b |", "|---|", "```"].join("\n"));

    expect(markup).not.toContain("<table>");
    expect(markup).toContain("|---|");
  });

  it("renders exact thread marker ranges without changing markdown structure", async () => {
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-1"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset: 7,
      endOffset: 21,
      selectedText: "important text",
      style: "highlight",
      color: "yellow",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown("Read **important text** today.", undefined, [marker]);

    expect(markup).toContain('data-thread-marker-id="marker-1"');
    expect(markup).toContain("thread-marker-highlight");
    expect(markup).toContain("<strong>");
    expect(markup).toContain("important text");
  });

  it("renders marker ranges resolved from visual text across markdown delimiters", async () => {
    const text = "**Ho letto tutto il progetto.**\n\n**L'app è bella e curata:** UI dark coerente.";
    const startOffset = text.indexOf("Ho letto");
    const endOffset = text.indexOf(":** UI") + 1;
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-markdown-range"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset,
      endOffset,
      selectedText: text.slice(startOffset, endOffset),
      style: "highlight",
      color: "yellow",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown(text, undefined, [marker]);

    expect(markup.match(/data-thread-marker-id="marker-markdown-range"/g) ?? []).toHaveLength(2);
    expect(markup).toContain("thread-marker-continues-after");
    expect(markup).toContain("thread-marker-continues-before");
    expect(markup).toContain("Ho letto tutto il progetto.");
    expect(markup).toContain("L&#x27;app è bella e curata:");
  });

  it("keeps marker offsets stable after literal dollar protection", async () => {
    const text = "Price $5. Highlight this phrase.";
    const startOffset = text.indexOf("Highlight");
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-dollar"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset,
      endOffset: startOffset + "Highlight this phrase".length,
      selectedText: "Highlight this phrase",
      style: "underline",
      color: "blue",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown(text, undefined, [marker]);

    expect(markup).toContain('data-thread-marker-id="marker-dollar"');
    expect(markup).toContain("thread-marker-underline");
    expect(markup).toContain("Price $5.");
  });

  it("keeps marker offsets aligned when an escaped dollar precedes the marker", async () => {
    // `\$` is two raw characters that render as one `$`; the dollar-protection transform must stay
    // length-preserving or every offset after it shifts and the marker wraps the wrong substring.
    const text = "Cost is \\$5 here. Highlight this phrase.";
    const startOffset = text.indexOf("Highlight");
    const selectedText = "Highlight this phrase";
    const marker: ThreadMarker = {
      id: ThreadMarkerId.makeUnsafe("marker-escaped-dollar"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      startOffset,
      endOffset: startOffset + selectedText.length,
      selectedText,
      style: "underline",
      color: "blue",
      label: null,
      done: false,
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const markup = await renderMarkdown(text, undefined, [marker]);

    expect(markup).toContain('data-thread-marker-id="marker-escaped-dollar"');
    expect(markup).toContain(">Highlight this phrase</span>");
    expect(markup).toContain("Cost is $5 here.");
    expect(markup).not.toContain('class="katex"');
  });

  it("keeps plan, diff, and transcript surfaces routed through the shared renderer", () => {
    const planSidebarSource = readFileSync(new URL("./PlanSidebar.tsx", import.meta.url), "utf8");
    const proposedPlanCardSource = readFileSync(
      new URL("./chat/ProposedPlanCard.tsx", import.meta.url),
      "utf8",
    );
    const messagesTimelineSource = readFileSync(
      new URL("./chat/MessagesTimeline.tsx", import.meta.url),
      "utf8",
    );

    expect(planSidebarSource).toContain('import ChatMarkdown from "./ChatMarkdown"');
    expect(planSidebarSource).toContain("<ChatMarkdown");
    expect(proposedPlanCardSource).toContain('import ChatMarkdown from "../ChatMarkdown"');
    expect(proposedPlanCardSource).toContain("<ChatMarkdown");
    expect(messagesTimelineSource).toContain('import ChatMarkdown from "../ChatMarkdown"');
    expect(messagesTimelineSource).toContain("<ChatMarkdown");
  });
});

describe("ChatMarkdown user variant", () => {
  it("renders inline markdown formatting", async () => {
    const markup = await renderUserMarkdown("use `bun run test` and **bold** text");

    expect(markup).toContain("chat-markdown--user");
    expect(markup).toContain("<code>bun run test</code>");
    expect(markup).toContain("<strong>bold</strong>");
  });

  it("keeps single newlines as hard breaks", async () => {
    const markup = await renderUserMarkdown("first line\nsecond line");

    expect(markup).toContain("first line<br/>\nsecond line");
  });

  it("keeps dollars literal instead of parsing math", async () => {
    const markup = await renderUserMarkdown("It costs $5 and $x^2$ stays literal.");

    expect(markup).toContain("$5");
    expect(markup).toContain("$x^2$");
    expect(markup).not.toContain('class="katex"');
  });

  it("renders composer skill tokens as chips", async () => {
    const markup = await renderUserMarkdown("run $deep-research on this");

    expect(markup).toContain("Deep Research");
    expect(markup).not.toContain("$deep-research");
  });

  it("keeps composer tokens literal inside inline code", async () => {
    const markup = await renderUserMarkdown("literal `$deep-research` here");

    expect(markup).toContain("<code>$deep-research</code>");
    expect(markup).not.toContain("Deep Research");
  });

  it("keeps Object.prototype member names as literal inline code", async () => {
    // `inlineCodeFilePath` strips wrapping quotes, so the quoted forms reach the icon
    // tables as the bare keys `constructor` / `__proto__`.
    for (const token of ["constructor", "__proto__", '"constructor"', '"__proto__"']) {
      const markup = await renderUserMarkdown(`what if a key is \`${token}\``);

      expect(markup).toContain("<code>");
      expect(markup).not.toContain('data-slot="central-icon"');
    }
  });

  it("renders @-mention tokens as mention chips", async () => {
    const markup = await renderUserMarkdown("check @src/utils/model.ts please");

    expect(markup).toContain('title="src/utils/model.ts"');
    expect(markup).not.toContain("@src/utils/model.ts");
  });

  it("renders pasted URLs as interactive link chips", async () => {
    const markup = await renderUserMarkdown("see https://example.com/docs now");

    expect(markup).toContain('title="https://example.com/docs"');
    expect(markup).toContain("<button");
  });

  it("renders fenced code with the shared code block chrome", async () => {
    const markup = await renderUserMarkdown(
      ["look at this:", "", "```ts", "const value = 1;", "```"].join("\n"),
    );

    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).toContain("const value = 1;");
  });
});
