// FILE: WorkspaceFilePreview.editing.browser.tsx
// Purpose: Browser regressions for guarded Explorer editing and save-state UX.
// Layer: Focused component integration tests

import "../index.css";

import type {
  NativeApi,
  ProjectFileChangeEvent,
  ProjectReadFileResult,
  ProjectWatchFileInput,
} from "@synara/contracts";
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

it("revalidates on file events without overwriting a dirty edit buffer", async () => {
  const externalVersion = `sha256:${"4".repeat(64)}`;
  const externalFile = loadedFile({
    contents: "external edit\n",
    version: externalVersion,
  });
  const readFile = vi.fn().mockResolvedValueOnce(loadedFile()).mockResolvedValue(externalFile);
  const fileChangeSubscription: {
    listener?: (event: ProjectFileChangeEvent) => void;
  } = {};
  const unsubscribe = vi.fn();
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, callback: (event: ProjectFileChangeEvent) => void) => {
      fileChangeSubscription.listener = callback;
      return unsubscribe;
    },
  );
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveValue("export const value = 1;\n");
    await editor.fill("manual edit\n");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));

    fileChangeSubscription.listener?.({
      type: "changed",
      relativePath: FILE_PATH,
      mtimeMs: Date.now(),
    });

    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await expect.element(editor).toHaveValue("manual edit\n");
    await expect
      .element(page.getByText("This file changed on disk. Your unsaved edits are preserved."))
      .toBeVisible();

    const reloadButton = document.querySelector<HTMLButtonElement>('[role="alert"] button');
    expect(reloadButton).not.toBeNull();
    reloadButton?.click();
    await expect.element(editor).toHaveValue("external edit\n");
  } finally {
    restoreNativeApi();
  }
});

it("stops revalidation when a kept-mounted preview becomes hidden", async () => {
  const unsubscribe = vi.fn();
  const onFileChange = vi.fn(() => unsubscribe);
  const restoreNativeApi = installNativeApi({
    projects: { readFile: vi.fn().mockResolvedValue(loadedFile()), onFileChange },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("textbox", { name: `Edit ${FILE_PATH}` }))
      .toHaveValue("export const value = 1;\n");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));

    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview
          workspaceRoot={WORKSPACE_ROOT}
          filePath={FILE_PATH}
          editable
          liveRevalidationEnabled={false}
        />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
  } finally {
    restoreNativeApi();
  }
});

it("switches the watcher to a workspace path resolved by the file read", async () => {
  const resolvedPath = "packages/app/src/app.ts";
  const readFile = vi.fn().mockResolvedValue(loadedFile({ relativePath: resolvedPath }));
  const onFileChange = vi.fn(() => vi.fn());
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("textbox", { name: `Edit ${FILE_PATH}` }))
      .toHaveValue("export const value = 1;\n");
    await vi.waitFor(() =>
      expect(onFileChange).toHaveBeenLastCalledWith(
        { cwd: WORKSPACE_ROOT, relativePath: resolvedPath },
        expect.any(Function),
      ),
    );
  } finally {
    restoreNativeApi();
  }
});

it("preserves dirty edits when reloading the changed disk version fails", async () => {
  const externalFile = loadedFile({
    contents: "external edit\n",
    version: `sha256:${"5".repeat(64)}`,
  });
  const readFile = vi
    .fn()
    .mockResolvedValueOnce(loadedFile())
    .mockResolvedValueOnce(externalFile)
    .mockRejectedValueOnce(new Error("Transient read failure"));
  const fileChangeSubscription: {
    listener?: (event: ProjectFileChangeEvent) => void;
  } = {};
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, callback: (event: ProjectFileChangeEvent) => void) => {
      fileChangeSubscription.listener = callback;
      return vi.fn();
    },
  );
  const restoreNativeApi = installNativeApi({
    projects: { readFile, onFileChange },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );

    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveValue("export const value = 1;\n");
    await editor.fill("manual edit\n");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));
    fileChangeSubscription.listener?.({
      type: "changed",
      relativePath: FILE_PATH,
      mtimeMs: Date.now(),
    });

    const reloadButton = page.getByRole("button", { name: "Reload from disk" });
    await expect.element(reloadButton).toBeVisible();
    await reloadButton.click();

    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(3));
    await expect.element(editor).toHaveValue("manual edit\n");
    await expect.element(page.getByText("Transient read failure")).toBeVisible();
    await expect.element(page.getByRole("status", { name: "Unsaved changes" })).toBeVisible();
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

it("keeps a successful save when an older watcher read resolves afterwards", async () => {
  let completeRead!: (result: ProjectReadFileResult) => void;
  const pendingRead = new Promise<ProjectReadFileResult>((resolve) => {
    completeRead = resolve;
  });
  const readFile = vi.fn().mockResolvedValueOnce(loadedFile()).mockReturnValueOnce(pendingRead);
  const writeFile = vi.fn().mockResolvedValue({ relativePath: FILE_PATH, version: SAVED_VERSION });
  const subscription: { listener?: (event: ProjectFileChangeEvent) => void } = {};
  const onFileChange = vi.fn(
    (_input: ProjectWatchFileInput, callback: (event: ProjectFileChangeEvent) => void) => {
      subscription.listener = callback;
      return vi.fn();
    },
  );
  const restoreNativeApi = installNativeApi({
    projects: { readFile, writeFile, onFileChange },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();
  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} editable />
      </QueryClientProvider>,
    );
    const editor = page.getByRole("textbox", { name: `Edit ${FILE_PATH}` });
    await expect.element(editor).toHaveValue("export const value = 1;\n");
    await vi.waitFor(() => expect(onFileChange).toHaveBeenCalledTimes(1));
    subscription.listener?.({ type: "changed", relativePath: FILE_PATH, mtimeMs: 1 });
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await editor.fill("saved contents\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Unsaved changes"]')).toBeNull(),
    );
    completeRead(loadedFile());
    await pendingRead;
    await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await expect.element(editor).toHaveValue("saved contents\n");
    await editor.fill("next saved contents\n");
    pressKeyboardSave(editor.element());
    await vi.waitFor(() =>
      expect(writeFile).toHaveBeenNthCalledWith(2, {
        cwd: WORKSPACE_ROOT,
        relativePath: FILE_PATH,
        contents: "next saved contents\n",
        expectedVersion: SAVED_VERSION,
        encoding: "utf8",
        lineEnding: "lf",
      }),
    );
  } finally {
    completeRead(loadedFile());
    queryClient.clear();
    restoreNativeApi();
  }
});
