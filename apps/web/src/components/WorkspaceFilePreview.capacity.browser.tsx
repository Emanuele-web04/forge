// FILE: WorkspaceFilePreview.capacity.browser.tsx
// Purpose: Browser regressions for last-good file preview during capacity errors.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { invalidateProjectFileQueriesForCwds } from "~/lib/projectReactQuery";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const FILE_PATH = "src/app.ts";
const LOADED_VERSION = `sha256:${"1".repeat(64)}`;
const CAPACITY_MESSAGE = "WebSocket expensive-read request capacity exceeded.";

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

function capacityError(): Error {
  return Object.assign(new Error(CAPACITY_MESSAGE), {
    code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
    retryable: true,
    retryAfterMs: 1,
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("keeps last-good file contents when a refetch hits expensive-read capacity", async () => {
  const readFile = vi.fn().mockResolvedValueOnce(loadedFile()).mockRejectedValue(capacityError());
  const restoreNativeApi = installNativeApi({
    projects: { readFile },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();

  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} />
      </QueryClientProvider>,
    );

    await expect.element(page.getByText("export const value = 1;")).toBeVisible();

    await invalidateProjectFileQueriesForCwds(queryClient, [WORKSPACE_ROOT]);

    await vi.waitFor(
      () => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("export const value = 1;");
        expect(text).not.toContain(CAPACITY_MESSAGE);
        expect(text.includes("File refresh delayed.") || text.includes("Refreshing file...")).toBe(
          true,
        );
      },
      { timeout: 10_000 },
    );
  } finally {
    restoreNativeApi();
  }
});
