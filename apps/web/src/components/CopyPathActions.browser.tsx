// FILE: CopyPathActions.browser.tsx
// Purpose: Verifies copy-path menus preserve path semantics and clipboard fallbacks.
// Layer: Browser UI test

import "../index.css";

import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { PropsWithChildren, ReactNode } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  toastAdd: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

vi.mock("./chat/OpenInPicker", () => ({
  OpenInPicker: ({ openInTarget }: { openInTarget: string | null }) => (
    <output data-testid="open-in-target">{openInTarget}</output>
  ),
}));

vi.mock("./chat/FileDiffView", () => ({
  FileDiffSurface: ({ children }: PropsWithChildren) => <div>{children}</div>,
  FileDiffCard: ({ renderHeaderTrailing }: { renderHeaderTrailing?: () => ReactNode }) => (
    <div data-diff-file-header>{renderHeaderTrailing?.()}</div>
  ),
}));

vi.mock("./LocalImagePreview", () => ({
  LocalImagePreview: () => null,
}));

import { DiffPanelFileList } from "./DiffPanelFileList";
import { WorkspaceFilePreviewHeader } from "./chat/WorkspaceFilePreviewHeader";

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

function setClipboard(clipboard: Pick<Clipboard, "writeText"> | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
}

function installSuccessfulFallbackCopy(): ReturnType<typeof vi.fn> {
  const execCommand = vi.fn().mockReturnValue(true);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

function restoreProperty(
  target: object,
  property: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

function fileDiff(path: string): FileDiffMetadata {
  return {
    cacheKey: `diff:${path}`,
    name: `b/${path}`,
    prevName: `a/${path}`,
  } as FileDiffMetadata;
}

function workspaceFilePreviewHeader(filePath: string, workspaceRoot: string) {
  return (
    <WorkspaceFilePreviewHeader
      workspaceRoot={workspaceRoot}
      filePath={filePath}
      isMarkdown={false}
      markdownPreviewEnabled={false}
      onMarkdownPreviewChange={vi.fn()}
    />
  );
}

async function expectPathCopied(path: string): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.toastAdd).toHaveBeenCalledWith({
      type: "success",
      title: "Path copied",
      description: path,
    });
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  harness.toastAdd.mockReset();
  restoreProperty(navigator, "clipboard", originalClipboardDescriptor);
  restoreProperty(document, "execCommand", originalExecCommandDescriptor);
  vi.restoreAllMocks();
});

describe("copy-path actions", () => {
  it("preserves a diff-relative path when the Clipboard API is unavailable", async () => {
    setClipboard(undefined);
    const execCommand = installSuccessfulFallbackCopy();
    const path = "apps/web/src/example.ts";

    await render(
      <DiffPanelFileList
        renderableFiles={[fileDiff(path)]}
        resolvedTheme="light"
        diffRenderMode="stacked"
        diffWordWrap={false}
        workspaceRoot="/workspace"
        collapsedFiles={new Set()}
        onToggleFileCollapsed={vi.fn()}
        chatActions={{ onReferenceInChat: vi.fn(), onAskWhyChanged: vi.fn() }}
      />,
    );

    await page.getByLabelText("File actions").click();
    await page.getByText("Copy path").click();

    await expectPathCopied(path);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("copies the resolved absolute workspace path after Clipboard API rejection", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("Document is not focused", "NotAllowedError"));
    setClipboard({ writeText });
    const execCommand = installSuccessfulFallbackCopy();
    const expectedPath = "/workspace/apps/web/src/example.ts";

    await render(workspaceFilePreviewHeader("apps/web/src/example.ts", "/workspace"));

    expect(page.getByTestId("open-in-target").element().textContent).toBe(expectedPath);
    await page.getByLabelText("More actions").click();
    await page.getByText("Copy path").click();

    await expectPathCopied(expectedPath);
    expect(writeText).toHaveBeenCalledWith(expectedPath);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("keeps the menu available when an outside-workspace path is its only action", async () => {
    setClipboard(undefined);
    const execCommand = installSuccessfulFallbackCopy();
    const path = "/tmp/synara scratch/example.ts";

    await render(workspaceFilePreviewHeader(path, "/workspace"));

    expect(page.getByTestId("open-in-target").element().textContent).toBe(path);
    await page.getByLabelText("More actions").click();
    await page.getByText("Copy path").click();

    await expectPathCopied(path);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
