// FILE: WorkspaceFilePreview.selection.browser.tsx
// Purpose: Browser regressions for the highlight -> "Add to chat" flow in the
//          rendered-markdown preview (snippet references) and source view.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ChatFileReference } from "../lib/chatReferences";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const MARKDOWN_PATH = "docs/handoff.md";
const MARKDOWN_CONTENTS = "# Handoff\n\n- Ship the **selection** toolbar\n- Then celebrate\n";

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
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function loadedMarkdown(): ProjectReadFileResult {
  return {
    relativePath: MARKDOWN_PATH,
    contents: MARKDOWN_CONTENTS,
    truncated: false,
    version: `sha256:${"1".repeat(64)}`,
    encoding: "utf8",
    lineEnding: "lf",
  };
}

function selectNodeContentsAndRelease(node: Node): void {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("window.getSelection() is unavailable");
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  const rect = range.getBoundingClientRect();
  node.dispatchEvent(
    new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      clientX: rect.right,
      clientY: rect.bottom,
    }),
  );
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

it("offers Add to chat for a rendered-markdown selection and references the snippet", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedMarkdown());
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  const onReferenceInChat = vi.fn<(reference: ChatFileReference) => void>();

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview
          workspaceRoot={WORKSPACE_ROOT}
          filePath={MARKDOWN_PATH}
          markdownPreviewDefault
          onReferenceInChat={onReferenceInChat}
        />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Handoff" })).toBeVisible();
    const list = document.querySelector(".editor-markdown-preview ul");
    if (!list) {
      throw new Error("rendered markdown list not found");
    }

    selectNodeContentsAndRelease(list);

    const addToChat = page.getByRole("button", { name: "Add to chat" });
    await expect.element(addToChat).toBeVisible();
    await addToChat.click();

    expect(onReferenceInChat).toHaveBeenCalledTimes(1);
    expect(onReferenceInChat).toHaveBeenCalledWith({
      path: MARKDOWN_PATH,
      snippet: "Ship the selection toolbar\nThen celebrate",
    });
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Add to chat"]')).toBeNull());
  } finally {
    restoreNativeApi();
  }
});

it("does not offer Add to chat in the markdown preview without a chat target", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedMarkdown());
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview
          workspaceRoot={WORKSPACE_ROOT}
          filePath={MARKDOWN_PATH}
          markdownPreviewDefault
        />
      </QueryClientProvider>,
    );

    await expect.element(page.getByRole("heading", { name: "Handoff" })).toBeVisible();
    const list = document.querySelector(".editor-markdown-preview ul");
    if (!list) {
      throw new Error("rendered markdown list not found");
    }

    selectNodeContentsAndRelease(list);

    // Give the deferred selection read a frame to settle before asserting.
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    expect(document.querySelector('[aria-label="Add to chat"]')).toBeNull();
  } finally {
    restoreNativeApi();
  }
});
