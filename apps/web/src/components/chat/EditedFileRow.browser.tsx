// FILE: EditedFileRow.browser.tsx
// Purpose: Verify changed-file review/open actions remain independent, accessible, and path-safe.
// Layer: Browser UI test

import "../../index.css";

import type { EditorId, NativeApi } from "@synara/contracts";
import type { PropsWithChildren } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  toastAdd: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { resolveEditorLabel } from "~/editorMetadata";
import { WorkspaceFileOpenerContext } from "~/lib/workspaceFileOpener";
import { EditedFileRow } from "./EditedFileRow";

const AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [
  "file-manager",
  "vscode",
  "cursor",
  "webstorm",
  "terminal",
  "iterm",
];
const FILE_PATH = "apps/web/src/components/chat/EditedFileRow.tsx";
const ROOTLESS_FILE_PATH = "a/very/long/path/that/does/not/exist/EditedFileRow.tsx";
const WORKSPACE_ROOT = "/workspace/synara";
const FILE_MANAGER_LABEL = resolveEditorLabel("file-manager", navigator.platform);

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let restoreNativeApi: (() => void) | undefined;

function mockOpenInEditor() {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  const openInEditor = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { shell: { openInEditor } } as unknown as NativeApi,
  });
  restoreNativeApi = () => {
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
  return openInEditor;
}

function setClipboard(writeText: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

function TestProviders(props: PropsWithChildren<{ openFile: (path: string) => boolean }>) {
  return (
    <WorkspaceFileOpenerContext.Provider value={{ openFile: props.openFile }}>
      {props.children}
    </WorkspaceFileOpenerContext.Provider>
  );
}

function editedFileRow(props: {
  openFile: (path: string) => boolean;
  onReview?: () => void;
  filePath?: string;
  fileKind?: string;
  workspaceRoot?: string;
}) {
  return (
    <TestProviders openFile={props.openFile}>
      <EditedFileRow
        filePath={props.filePath ?? FILE_PATH}
        fileKind={props.fileKind ?? "modified"}
        additions={12}
        deletions={3}
        workspaceRoot={props.workspaceRoot}
        keybindings={[]}
        availableEditors={AVAILABLE_EDITORS}
        resolvedTheme="light"
        fontSize={13}
        withFirstReset
        onReview={props.onReview ?? vi.fn()}
      />
    </TestProviders>
  );
}

async function openFileOptions(filePath = FILE_PATH) {
  const menuButton = page.getByRole("button", { name: `Open ${filePath} options` });
  await menuButton.click();
  return menuButton;
}

function fileManagerMenuItem() {
  return page.getByRole("menuitemradio", { name: FILE_MANAGER_LABEL });
}

beforeEach(() => {
  localStorage.clear();
  harness.toastAdd.mockReset();
});

afterEach(() => {
  restoreNativeApi?.();
  restoreNativeApi = undefined;
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
  vi.restoreAllMocks();
});

describe("EditedFileRow", () => {
  it("defers editor preference listeners until its launcher menu is opened", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    await render(editedFileRow({ openFile: () => true, workspaceRoot: WORKSPACE_ROOT }));
    const preferenceListenerCalls = () =>
      addEventListener.mock.calls.filter(
        ([eventName]) => eventName === "storage" || eventName === "synara:local_storage_change",
      );

    expect(preferenceListenerCalls()).toHaveLength(0);
    await openFileOptions();
    await vi.waitFor(() => expect(preferenceListenerCalls()).toHaveLength(2));
  });

  it("keeps row review, Review, Open, and menu trigger as keyboard-reachable sibling buttons", async () => {
    const onReview = vi.fn();
    const openFile = vi.fn(() => true);
    const openInEditor = mockOpenInEditor();

    const screen = await render(
      editedFileRow({ openFile, onReview, workspaceRoot: WORKSPACE_ROOT }),
    );
    const pathButton = page.getByRole("button", { name: `Review changes to ${FILE_PATH}` });
    const reviewButton = page.getByRole("button", { name: "Review", exact: true });
    const openButton = page.getByRole("button", { name: "Open", exact: true });
    const menuButton = page.getByRole("button", {
      name: `Open ${FILE_PATH} options`,
      exact: true,
    });

    expect(screen.container.querySelector("button button")).toBeNull();
    await pathButton.click();
    await reviewButton.click();
    expect(onReview).toHaveBeenCalledTimes(2);

    await openButton.click();
    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile).toHaveBeenCalledWith(FILE_PATH);
    expect(openInEditor).not.toHaveBeenCalled();
    expect(onReview).toHaveBeenCalledTimes(2);

    pathButton.element().focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(reviewButton.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(openButton.element());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(menuButton.element());
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText(FILE_MANAGER_LABEL, { exact: true })).toBeInTheDocument();
  });

  it("lists installed launchers in file-action order, then copies both path forms", async () => {
    const openInEditor = mockOpenInEditor();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await render(editedFileRow({ openFile: () => true, workspaceRoot: WORKSPACE_ROOT }));

    const menuButton = await openFileOptions();
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[role='menuitemradio']"), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual([FILE_MANAGER_LABEL, "VS Code", "Cursor", "WebStorm", "Terminal", "iTerm"]);
    const menuTexts = Array.from(
      document.querySelectorAll<HTMLElement>("[role='menu'] [role^='menuitem']"),
      (item) => item.textContent?.trim(),
    );
    expect(menuTexts.slice(-2)).toEqual(["Copy absolute path", "Copy relative path"]);

    await page.getByRole("menuitem", { name: "Copy absolute path" }).click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "/workspace/synara/apps/web/src/components/chat/EditedFileRow.tsx",
      );
    });
    await menuButton.click();
    await page.getByRole("menuitem", { name: "Copy relative path" }).click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(FILE_PATH);
    });
    expect(harness.toastAdd).toHaveBeenLastCalledWith({
      type: "success",
      title: "Path copied",
      description: FILE_PATH,
    });

    await menuButton.click();
    await page.getByText("VS Code", { exact: true }).click();
    expect(openInEditor).toHaveBeenCalledWith(
      "/workspace/synara/apps/web/src/components/chat/EditedFileRow.tsx",
      "vscode",
    );
  });

  it("keeps copy actions usable while disabling opens for deleted files", async () => {
    const openFile = vi.fn(() => true);
    const openInEditor = mockOpenInEditor();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await render(
      editedFileRow({
        openFile,
        fileKind: "deleted",
        workspaceRoot: WORKSPACE_ROOT,
      }),
    );

    expect(page.getByRole("button", { name: "Open", exact: true }).element()).toBeDisabled();
    await openFileOptions();
    expect(fileManagerMenuItem().element()).toBeDisabled();
    await page.getByText("Copy relative path", { exact: true }).click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(FILE_PATH));
    expect(openFile).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("does not fall back externally when the in-app opener reports a missing file", async () => {
    const openFile = vi.fn(() => false);
    const openInEditor = mockOpenInEditor();
    await render(editedFileRow({ openFile, workspaceRoot: WORKSPACE_ROOT }));

    await page.getByRole("button", { name: "Open", exact: true }).click();
    expect(openFile).toHaveBeenCalledWith(FILE_PATH);
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("disables relative Open actions without a workspace root and stays contained when narrow", async () => {
    const openFile = vi.fn(() => false);
    mockOpenInEditor();
    const host = document.createElement("div");
    host.style.cssText = "width:250px;overflow:hidden;";
    document.body.append(host);

    const screen = await render(
      editedFileRow({
        openFile,
        filePath: ROOTLESS_FILE_PATH,
      }),
      { container: host },
    );
    try {
      expect(page.getByRole("button", { name: "Open", exact: true }).element()).toBeDisabled();
      expect(openFile).not.toHaveBeenCalled();

      const row = screen.container.querySelector<HTMLElement>("[data-edited-file-row='true']");
      expect(row).not.toBeNull();
      expect(row!.scrollWidth).toBeLessThanOrEqual(row!.clientWidth);
      expect(page.getByRole("button", { name: "Review", exact: true }).element()).toBeVisible();

      await openFileOptions(ROOTLESS_FILE_PATH);
      expect(fileManagerMenuItem().element()).toBeDisabled();
      expect(page.getByRole("menuitem", { name: "Copy absolute path" }).element()).toBeDisabled();
      expect(
        page.getByRole("menuitem", { name: "Copy relative path" }).element(),
      ).not.toBeDisabled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
