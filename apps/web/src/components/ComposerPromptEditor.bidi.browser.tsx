import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import { ComposerPromptEditor } from "./ComposerPromptEditor";

function ComposerHarness({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);

  return (
    <ComposerPromptEditor
      value={value}
      cursor={cursor}
      terminalContexts={[]}
      disabled={false}
      placeholder="Type a message"
      onRemoveTerminalContext={vi.fn()}
      onPaste={vi.fn()}
      onChange={(nextValue, nextCursor) => {
        setValue(nextValue);
        setCursor(nextCursor);
      }}
    />
  );
}

function composerDirectionSnapshot() {
  const root = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
  const blocks = Array.from(root?.children ?? []).map((element) => ({
    tagName: element.tagName,
    dir: element.getAttribute("dir"),
    computedDirection: getComputedStyle(element).direction,
    text: element.textContent,
  }));
  return {
    root,
    rootDir: root?.getAttribute("dir") ?? null,
    rootComputedDirection: root ? getComputedStyle(root).direction : null,
    blocks,
  };
}

describe("ComposerPromptEditor bidi ownership", () => {
  it("keeps the ContentEditable root neutral and lets Lexical own block direction", async () => {
    const screen = await render(<ComposerHarness initialValue="مرحبا بالعالم" />);

    await expect.poll(() => composerDirectionSnapshot().blocks[0]?.dir).toBe("auto");
    let snapshot = composerDirectionSnapshot();
    expect(snapshot.rootDir).toBeNull();
    expect(snapshot.rootComputedDirection).toBe("ltr");
    expect(snapshot.blocks).toEqual([
      {
        tagName: "P",
        dir: "auto",
        computedDirection: "rtl",
        text: "مرحبا بالعالم",
      },
    ]);

    const editor = page.getByTestId("composer-editor");
    await editor.fill("English text");
    await expect.poll(() => composerDirectionSnapshot().blocks[0]?.dir).toBe("auto");
    snapshot = composerDirectionSnapshot();
    expect(snapshot.rootDir).toBeNull();
    expect(snapshot.blocks[0]?.computedDirection).toBe("ltr");
    expect(snapshot.blocks[0]?.text).toBe("English text");

    await editor.fill("");
    await expect.poll(() => composerDirectionSnapshot().blocks[0]?.text).toBe("");
    snapshot = composerDirectionSnapshot();
    expect(snapshot.rootDir).toBeNull();
    expect(snapshot.blocks[0]?.dir).toBe("auto");
    expect(snapshot.blocks[0]?.computedDirection).toBe("ltr");

    await editor.fill("سطر عربي\nEnglish line");
    await expect.poll(() => composerDirectionSnapshot().blocks.length).toBe(1);
    snapshot = composerDirectionSnapshot();
    expect(snapshot.blocks[0]?.dir).toBe("auto");
    expect(snapshot.blocks[0]?.computedDirection).toBe("rtl");
    expect(snapshot.blocks[0]?.text).toBe("سطر عربي\nEnglish line");

    await userEvent.keyboard("{Control>}z{/Control}");
    await expect
      .poll(() => composerDirectionSnapshot().blocks[0]?.text)
      .not.toBe("سطر عربي\nEnglish line");
    expect(composerDirectionSnapshot().rootDir).toBeNull();

    await screen.unmount();
  });
});
