// FILE: WorkspaceFilePreview.editing.browser.tsx
// Purpose: Browser regressions for guarded Explorer editing and save-state UX.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const FILE_PATH = "src/app.ts";
const LOADED_VERSION = `sha256:${"1".repeat(64)}`;
const SAVED_VERSION = `sha256:${"2".repeat(64)}`;

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

function loadedFile(overrides: Partial<ProjectReadFileResult> = {}): ProjectReadFileResult {
  return {
    relativePath: FILE_PATH,
    contents: "export const value = 1;\n",
    truncated: false,
    version: LOADED_VERSION,
    encoding: "utf8",
    lineEnding: "lf",
    ...overrides,
  };
}

function pressKeyboardSave(element: Element): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("tracks dirty state and saves the loaded version with Ctrl+S", async () => {
  const readFile = vi.fn().mockResolvedValue(loadedFile());
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveValue("export const value = 1;\n");
    await editor.fill("export const value = 2;\n");
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();

    pressKeyboardSave(editor.element());

    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenCalledWith({
        cwd: WORKSPACE_ROOT,
        relativePath: FILE_PATH,
        contents: "export const value = 2;\n",
        expectedVersion: LOADED_VERSION,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Unsaved changes"]')).toBeNull(),
    );
  } finally {
    restoreNativeApi();
  }
});

it("keeps the buffer dirty and shows guarded write failures", async () => {
  const conflictMessage =
    "This file changed on disk after it was opened. Reload it before saving to avoid overwriting those changes.";
  const readFile = vi.fn().mockResolvedValue(loadedFile());
  const writeFile = vi.fn().mockRejectedValue(new Error(conflictMessage));
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await editor.fill("manual edit\n");
    pressKeyboardSave(editor.element());

    await expect.element(page.getByRole("alert")).toHaveTextContent(conflictMessage);
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();
    await expect.element(editor).toHaveValue("manual edit\n");
    expect(writeFile).toHaveBeenCalledTimes(1);
  } finally {
    restoreNativeApi();
  }
});

it("keeps markdown task previews and guarded versions in sync after an editor save", async () => {
  const markdownPath = "README.md";
  const taskVersion = `sha256:${"3".repeat(64)}`;
  let completeTaskWrite!: (result: { relativePath: string; version: string }) => void;
  const pendingTaskWrite = new Promise<{ relativePath: string; version: string }>((resolve) => {
    completeTaskWrite = resolve;
  });
  const readFile = vi.fn().mockResolvedValue(
    loadedFile({
      relativePath: markdownPath,
      contents: "- [ ] task\n",
    }),
  );
  const writeFile = vi
    .fn()
    .mockResolvedValueOnce({ relativePath: markdownPath, version: SAVED_VERSION })
    .mockReturnValueOnce(pendingTaskWrite);
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={markdownPath} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${markdownPath}` });
    await editor.fill("- [ ] updated task\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    await page.getByRole("radio", { name: "Preview" }).click();

    const checkbox = page.getByRole("checkbox");
    await checkbox.click();
    await expect.element(checkbox).toBeChecked();
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenNthCalledWith(2, {
        cwd: WORKSPACE_ROOT,
        relativePath: markdownPath,
        contents: "- [x] updated task\n",
        expectedVersion: SAVED_VERSION,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
    completeTaskWrite({ relativePath: markdownPath, version: taskVersion });
  } finally {
    restoreNativeApi();
  }
});

it("keeps oversized and mixed-line-ending files read-only", async () => {
  const readFile = vi
    .fn()
    .mockResolvedValueOnce(
      loadedFile({ truncated: true, version: null, encoding: null, lineEnding: null }),
    )
    .mockResolvedValueOnce(loadedFile({ lineEnding: "mixed" }));
  const restoreNativeApi = installNativeApi({
    projects: { readFile },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain("Shown partially"));
    expect(document.querySelector("textarea")).toBeNull();

    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath="src/mixed.ts" editable />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Read-only"));
    expect(document.querySelector("textarea")).toBeNull();
  } finally {
    restoreNativeApi();
  }
});
