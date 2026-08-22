// FILE: WorkspaceSearchPalette.browser.tsx
// Purpose: Browser regressions for the Cmd+P workspace search palette:
//          result rows, status semantics (prompt/no-results/error outside the
//          listbox), selection routing, and the open-time index prewarm.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceSearchPalette, type WorkspaceSearchPaletteMode } from "./WorkspaceSearchPalette";

const WORKSPACE_ROOT = "/Users/tester/project";

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

async function renderPalette(mode: WorkspaceSearchPaletteMode) {
  const handlers = {
    onOpenChange: vi.fn<(open: boolean) => void>(),
    onOpenFile: vi.fn<(relativePath: string) => void>(),
    onOpenDirectory: vi.fn<(relativePath: string) => void>(),
  };
  await render(
    <QueryClientProvider client={makeQueryClient()}>
      <WorkspaceSearchPalette
        open
        mode={mode}
        cwd={WORKSPACE_ROOT}
        onOpenChange={handlers.onOpenChange}
        onOpenFile={handlers.onOpenFile}
        onOpenDirectory={handlers.onOpenDirectory}
      />
    </QueryClientProvider>,
  );
  return handlers;
}

// No manual DOM cleanup: the palette renders through a Base UI portal, and
// wiping document.body would pull the portal out from under React before
// vitest-browser-react's automatic unmount runs (removeChild crashes).

it("prewarms the search index on open and shows the prompt outside the listbox", async () => {
  const prewarmSearchIndex = vi.fn().mockResolvedValue({ started: true });
  const searchEntries = vi.fn().mockResolvedValue({ entries: [], truncated: false });
  const restoreNativeApi = installNativeApi({
    projects: { prewarmSearchIndex, searchEntries },
  } as unknown as NativeApi);

  try {
    await renderPalette("files");

    await vi.waitFor(() =>
      expect(prewarmSearchIndex).toHaveBeenCalledWith({ cwd: WORKSPACE_ROOT }),
    );
    await expect.element(page.getByText("Type to search for files")).toBeVisible();
    // The status copy must never live inside role="listbox" — assistive tech
    // treats listbox children as options.
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox?.textContent ?? "").not.toContain("Type to search for files");
    expect(searchEntries).not.toHaveBeenCalled();
  } finally {
    restoreNativeApi();
  }
});

it("renders file and directory rows and routes clicks to the right handler", async () => {
  const searchEntries = vi.fn().mockResolvedValue({
    entries: [
      { path: "apps/web/src/components/Composer.tsx", kind: "file" },
      { path: "apps/web/src/components", kind: "directory" },
    ],
    truncated: false,
  });
  const restoreNativeApi = installNativeApi({
    projects: {
      prewarmSearchIndex: vi.fn().mockResolvedValue({ started: true }),
      searchEntries,
    },
  } as unknown as NativeApi);

  try {
    const handlers = await renderPalette("files");
    await page.getByPlaceholder("Search files").fill("comp");

    await expect.element(page.getByText("Composer.tsx")).toBeVisible();
    await vi.waitFor(() =>
      expect(searchEntries).toHaveBeenCalledWith({
        cwd: WORKSPACE_ROOT,
        query: "comp",
        limit: 30,
      }),
    );
    // Both rows are options inside the listbox, none of the status copy is.
    const options = document.querySelectorAll('[role="listbox"] [role="option"]');
    expect(options.length).toBe(2);

    await page.getByText("Composer.tsx").click();
    expect(handlers.onOpenFile).toHaveBeenCalledWith("apps/web/src/components/Composer.tsx");
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
    expect(handlers.onOpenDirectory).not.toHaveBeenCalled();
  } finally {
    restoreNativeApi();
  }
});

it("opens directories in the explorer handler", async () => {
  const searchEntries = vi.fn().mockResolvedValue({
    entries: [{ path: "apps/web/src/components", kind: "directory" }],
    truncated: false,
  });
  const restoreNativeApi = installNativeApi({
    projects: {
      prewarmSearchIndex: vi.fn().mockResolvedValue({ started: true }),
      searchEntries,
    },
  } as unknown as NativeApi);

  try {
    const handlers = await renderPalette("files");
    await page.getByPlaceholder("Search files").fill("comp");

    await expect.element(page.getByText("components")).toBeVisible();
    await page.getByText("components").click();
    expect(handlers.onOpenDirectory).toHaveBeenCalledWith("apps/web/src/components");
    expect(handlers.onOpenFile).not.toHaveBeenCalled();
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
  } finally {
    restoreNativeApi();
  }
});

it("selects the auto-highlighted first row with Enter", async () => {
  const searchEntries = vi.fn().mockResolvedValue({
    entries: [
      { path: "apps/web/src/components/Composer.tsx", kind: "file" },
      { path: "apps/web/src/components/ComposerRow.tsx", kind: "file" },
    ],
    truncated: false,
  });
  const restoreNativeApi = installNativeApi({
    projects: {
      prewarmSearchIndex: vi.fn().mockResolvedValue({ started: true }),
      searchEntries,
    },
  } as unknown as NativeApi);

  try {
    const handlers = await renderPalette("files");
    await page.getByPlaceholder("Search files").fill("comp");
    await expect.element(page.getByText("Composer.tsx", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(handlers.onOpenFile).toHaveBeenCalledWith("apps/web/src/components/Composer.tsx"),
    );
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
  } finally {
    restoreNativeApi();
  }
});

it("shows no-results only once the search settles, and error copy on failure", async () => {
  const searchEntries = vi
    .fn()
    .mockResolvedValueOnce({ entries: [], truncated: false })
    .mockRejectedValueOnce(new Error("boom"));
  const restoreNativeApi = installNativeApi({
    projects: {
      prewarmSearchIndex: vi.fn().mockResolvedValue({ started: true }),
      searchEntries,
    },
  } as unknown as NativeApi);

  try {
    await renderPalette("files");
    const input = page.getByPlaceholder("Search files");

    await input.fill("nope");
    await expect.element(page.getByText("No matching files")).toBeVisible();

    await input.fill("nope again");
    await expect.element(page.getByText("File search failed. Try again.")).toBeVisible();
  } finally {
    restoreNativeApi();
  }
});

it("renders snippet rows and gates short queries behind the prompt", async () => {
  const searchContent = vi.fn().mockResolvedValue({
    matches: [
      {
        path: "apps/web/src/lib/utils.ts",
        lineNumber: 12,
        lineText: "export function cn(...inputs: ClassValue[]) {",
      },
    ],
    truncated: false,
  });
  const restoreNativeApi = installNativeApi({
    projects: {
      prewarmSearchIndex: vi.fn().mockResolvedValue({ started: true }),
      searchContent,
    },
  } as unknown as NativeApi);

  try {
    const handlers = await renderPalette("snippets");
    const input = page.getByPlaceholder("Search code");
    const shortQuery = "a".repeat(PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH - 1);

    await input.fill(shortQuery);
    await expect
      .element(
        page.getByText(
          `Type at least ${PROJECT_SEARCH_CONTENT_MIN_QUERY_LENGTH} characters to search code`,
        ),
      )
      .toBeVisible();
    expect(searchContent).not.toHaveBeenCalled();

    await input.fill("function cn");
    await expect.element(page.getByText("utils.ts")).toBeVisible();
    expect(document.body.textContent).toContain("export function cn");

    await page.getByText("utils.ts").click();
    expect(handlers.onOpenFile).toHaveBeenCalledWith("apps/web/src/lib/utils.ts");
    expect(handlers.onOpenChange).toHaveBeenCalledWith(false);
  } finally {
    restoreNativeApi();
  }
});
