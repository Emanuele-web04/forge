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
  it("opens a collapsed relative chip from the file the agent actually edited", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown
          text="See `.../scripts/delete_uploadthing.py`."
          cwd="/Users/tester/synara-issue-793"
          isStreaming={false}
          knownAbsoluteFilePaths={[
            "/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py",
          ]}
        />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "delete_uploadthing.py" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith(
      "/Users/tester/.agents/skills/annotate-pr/scripts/delete_uploadthing.py",
    );
  });

  it("opens a relative chip from a unique same-turn absolute tool path", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown
          text="See `references/uploadthing.md`."
          cwd="/Users/tester/chat-workspace"
          isStreaming={false}
          knownAbsoluteFilePaths={[
            "/Users/tester/.agents/skills/annotate-pr/references/uploadthing.md",
          ]}
        />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "uploadthing.md" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith(
      "/Users/tester/.agents/skills/annotate-pr/references/uploadthing.md",
    );
  });

  it("opens a relative inline-code file against the chat workspace", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown text="See `src/index.ts`." cwd="/Users/tester/project" isStreaming={false} />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "index.ts" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith("/Users/tester/project/src/index.ts");
  });

  it("opens an authored absolute file URL", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown
          text="[docs/example.md](file:///Users/tester/external-tool/docs/example.md)"
          cwd="/Users/tester/chat-workspace"
          isStreaming={false}
        />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "docs/example.md" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith("/Users/tester/external-tool/docs/example.md");
  });

  it("opens an absolute inline-code path", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown
          text="See `/Users/tester/external-tool/docs/example.md`."
          cwd="/Users/tester/chat-workspace"
          isStreaming={false}
        />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "example.md" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith("/Users/tester/external-tool/docs/example.md");
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
