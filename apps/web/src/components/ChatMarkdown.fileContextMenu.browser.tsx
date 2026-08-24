// FILE: ChatMarkdown.fileContextMenu.browser.tsx
// Purpose: Verifies assistant file links replace the browser menu with Synara's file actions.
// Layer: Web chat browser tests

import { render } from "vitest-browser-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  showFileReferenceContextMenu: vi.fn(),
}));

vi.mock("../lib/fileReferenceContextMenu", () => ({
  showFileReferenceContextMenu: harness.showFileReferenceContextMenu,
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

import ChatMarkdown from "./ChatMarkdown";
import { WorkspaceFileOpenerContext } from "../lib/workspaceFileOpener";

beforeEach(() => {
  harness.showFileReferenceContextMenu.mockReset();
  harness.showFileReferenceContextMenu.mockResolvedValue(undefined);
});

describe("ChatMarkdown file context menu", () => {
  it("carries same-message absolute provenance when opening a relative file", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown
          text={[
            "Dir: `/Users/tester/.cache/ember-204`",
            "- `artifacts/quartz-731.md`",
            "Also exists at `/Users/tester/.local/share/onyx-918`.",
          ].join("\n")}
          cwd="/Users/tester/chat-workspace"
          isStreaming={false}
        />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "quartz-731.md" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledWith("/Users/tester/chat-workspace/artifacts/quartz-731.md", {
      externalFileCandidates: ["/Users/tester/.cache/ember-204/artifacts/quartz-731.md"],
    });
  });

  it("opens the shared file menu with a position-free absolute path", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[Download video](/repo/output/video.mp4:42)"
        cwd="/repo"
        isStreaming={false}
      />,
    );
    const link = screen.getByRole("link", { name: "Download video" }).element();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 15,
      clientY: 28,
    });

    link.dispatchEvent(event);

    await vi.waitFor(() => expect(harness.showFileReferenceContextMenu).toHaveBeenCalledOnce());
    expect(event.defaultPrevented).toBe(true);
    expect(harness.showFileReferenceContextMenu).toHaveBeenCalledWith({
      path: "/repo/output/video.mp4",
      revealPath: "/repo/output/video.mp4",
      position: { x: 15, y: 28 },
      onReferenceInChat: undefined,
    });
  });
});
