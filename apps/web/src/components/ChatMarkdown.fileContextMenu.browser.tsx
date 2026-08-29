// FILE: ChatMarkdown.fileContextMenu.browser.tsx
// Purpose: Verifies assistant file links replace the browser menu with Synara's file actions.
// Layer: Web chat browser tests

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: api,
  });
  return () => {
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

let restoreNativeApi: (() => void) | undefined;

beforeEach(() => {
  harness.showFileReferenceContextMenu.mockReset();
  harness.showFileReferenceContextMenu.mockResolvedValue(undefined);
});

afterEach(() => {
  restoreNativeApi?.();
  restoreNativeApi = undefined;
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

  it("opens a relative inline-code file that exists in the chat workspace", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    restoreNativeApi = installNativeApi({
      projects: {
        resolveWorkspaceFileReferences: vi.fn().mockResolvedValue({
          relativePaths: ["src/index.ts"],
        }),
      },
    } as unknown as NativeApi);
    const screen = await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
          <ChatMarkdown
            text="See `src/index.ts`."
            cwd="/Users/tester/project"
            isStreaming={false}
          />
        </WorkspaceFileOpenerContext.Provider>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      screen.getByRole("link", { name: "index.ts" }).element();
    });
    screen
      .getByRole("link", { name: "index.ts" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("does not chip a relative file that cannot be found", async () => {
    restoreNativeApi = installNativeApi({
      projects: {
        resolveWorkspaceFileReferences: vi.fn().mockResolvedValue({ relativePaths: [null] }),
      },
    } as unknown as NativeApi);
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <ChatMarkdown
          text="See `scripts/upsert_pr_proof.py`."
          cwd="/Users/tester/Documents/Synara/thread"
          isStreaming={false}
        />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(document.querySelector("code")?.textContent).toBe("scripts/upsert_pr_proof.py");
    });
    expect(document.querySelector('a[href*="upsert_pr_proof.py"]')).toBeNull();
  });

  it("batches transcript file chips without using ancestor relocation scans", async () => {
    const resolveWorkspaceFileReferences = vi.fn(
      async (input: { relativePaths: ReadonlyArray<string> }) => ({
        relativePaths: [...input.relativePaths],
      }),
    );
    const resolveOutOfRootFileReference = vi.fn();
    restoreNativeApi = installNativeApi({
      projects: {
        resolveWorkspaceFileReferences,
        resolveOutOfRootFileReference,
      },
    } as unknown as NativeApi);

    const screen = await render(
      <QueryClientProvider client={makeQueryClient()}>
        <ChatMarkdown
          text="See `src/index.ts`, `docs/readme.md`, and `src/index.ts` again."
          cwd="/Users/tester/project"
          isStreaming={false}
        />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      screen.getByRole("link", { name: "readme.md" }).element();
      expect(document.querySelectorAll('a[title="src/index.ts"]')).toHaveLength(2);
    });
    expect(resolveWorkspaceFileReferences).toHaveBeenCalledOnce();
    const request = resolveWorkspaceFileReferences.mock.calls[0]?.[0];
    expect(request?.relativePaths).toHaveLength(2);
    expect(request?.relativePaths).toEqual(
      expect.arrayContaining(["src/index.ts", "docs/readme.md"]),
    );
    expect(resolveOutOfRootFileReference).not.toHaveBeenCalled();
  });

  it("opens an absolute directory path from inline code", async () => {
    const openFile = vi.fn().mockReturnValue(true);
    const absoluteDir = "/Users/tester/.agents/skills/annotate-pr";
    const screen = await render(
      <WorkspaceFileOpenerContext.Provider value={{ openFile }}>
        <ChatMarkdown
          text={`Dir: \`${absoluteDir}\``}
          cwd="/Users/tester/chat-workspace"
          isStreaming={false}
        />
      </WorkspaceFileOpenerContext.Provider>,
    );

    screen
      .getByRole("link", { name: "annotate-pr" })
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith(absoluteDir);
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
