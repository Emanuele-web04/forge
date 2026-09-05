// Preserve state and current callbacks while streaming markdown updates.
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import ChatMarkdown from "./ChatMarkdown";

const fenced = "```javascript\nconst answer = 42;\n```\n\nExplanation.";

describe("ChatMarkdown streaming identity", () => {
  it("keeps the code block and soft wrap while prose streams after it", async () => {
    const screen = await render(<ChatMarkdown text={fenced} cwd={undefined} isStreaming />);
    await screen.getByRole("button", { name: "Enable soft wrap" }).click();
    const block = document.querySelector(".chat-markdown-codeblock");
    expect(block?.getAttribute("data-wrap")).toBe("true");

    await screen.rerender(<ChatMarkdown text={fenced + " More detail."} cwd={undefined} isStreaming />);
    expect(document.querySelector(".chat-markdown-codeblock")).toBe(block);
    expect(block?.getAttribute("data-wrap")).toBe("true");
    await screen.unmount();
  });

  it("shows the complete growing code when the stream finishes", async () => {
    const screen = await render(<ChatMarkdown text={"```text\npartial"} cwd={undefined} isStreaming />);
    const finalCode = "partial\ncomplete final line";
    await screen.rerender(<ChatMarkdown text={`\`\`\`text\n${finalCode}\n\`\`\``} cwd={undefined} isStreaming={false} />);
    await expect.poll(() => document.querySelector(".chat-markdown-codeblock pre")?.textContent).toContain(finalCode);
    await screen.unmount();
  });

  it("uses the latest checkbox callback without changing markdown text", async () => {
    const previous = vi.fn();
    const current = vi.fn();
    const screen = await render(<ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={previous} />);
    await screen.rerender(<ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={current} />);
    await screen.getByRole("checkbox").click();
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith({ sourceLine: 1, checked: true });
    await screen.unmount();
  });
});
