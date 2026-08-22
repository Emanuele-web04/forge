// FILE: WorkspaceFilePreview.relocation.browser.tsx
// Purpose: Browser regressions for out-of-root preview relocation and revalidation.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { invalidateProjectFileQueriesForCwds } from "~/lib/projectReactQuery";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

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

afterEach(() => {
  document.body.innerHTML = "";
});

it("relocates a workspace-relative image after its in-root preview fails", async () => {
  const workspaceRoot = "/Users/tester/Documents/Claude/Skills";
  const requestedPath = "Claude/Outbox/shot.png";
  const relocatedPath = "/Users/tester/Documents/Claude/Outbox/shot.png";
  const resolveOutOfRootFileReference = vi.fn().mockResolvedValue({ fullPath: relocatedPath });
  const createLocalFilePreviewGrant = vi.fn().mockResolvedValue({
    grant: "preview-grant",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const restoreNativeApi = installNativeApi({
    projects: {
      resolveOutOfRootFileReference,
      createLocalFilePreviewGrant,
    },
  } as unknown as NativeApi);

  try {
    await render(
      <QueryClientProvider client={makeQueryClient()}>
        <WorkspaceFilePreview workspaceRoot={workspaceRoot} filePath={requestedPath} />
      </QueryClientProvider>,
    );

    document
      .querySelector<HTMLImageElement>(".local-image-preview__img")
      ?.dispatchEvent(new Event("error"));

    await vi.waitFor(() =>
      expect(resolveOutOfRootFileReference).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        relativePath: requestedPath,
      }),
    );
    await vi.waitFor(() =>
      expect(createLocalFilePreviewGrant).toHaveBeenCalledWith({ path: relocatedPath }),
    );
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLAnchorElement>(".local-image-error__action")?.href ??
          document.querySelector<HTMLImageElement>(".local-image-preview__img")?.src,
      ).toContain("path=%2FUsers%2Ftester%2FDocuments%2FClaude%2FOutbox%2Fshot.png"),
    );
  } finally {
    restoreNativeApi();
  }
});

it("returns to a newly created workspace file after relocation", async () => {
  const workspaceRoot = "/Users/tester/Documents/Claude/Skills";
  const requestedPath = "Claude/Outbox/note.md";
  const relocatedPath = "/Users/tester/Documents/Claude/Outbox/note.md";
  let workspaceFileExists = false;
  const resolveOutOfRootFileReference = vi
    .fn()
    .mockResolvedValueOnce({ fullPath: relocatedPath })
    .mockResolvedValueOnce({ fullPath: null });
  const readFile = vi.fn(async (input: { relativePath: string; previewGrant?: string }) => {
    if (input.relativePath === relocatedPath) {
      if (input.previewGrant !== "preview-grant") {
        throw new Error("Absolute file read requires its preview grant");
      }
      return { relativePath: relocatedPath, contents: "external contents", truncated: false };
    }
    if (!workspaceFileExists) {
      throw new Error("Workspace file not found");
    }
    return { relativePath: requestedPath, contents: "workspace contents", truncated: false };
  });
  const createLocalFilePreviewGrant = vi.fn().mockResolvedValue({
    grant: "preview-grant",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const restoreNativeApi = installNativeApi({
    projects: {
      readFile,
      resolveOutOfRootFileReference,
      createLocalFilePreviewGrant,
    },
  } as unknown as NativeApi);
  const queryClient = makeQueryClient();

  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={workspaceRoot} filePath={requestedPath} />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(document.body.textContent).toContain("external contents"));

    workspaceFileExists = true;
    await invalidateProjectFileQueriesForCwds(queryClient, [workspaceRoot]);

    await vi.waitFor(() => expect(resolveOutOfRootFileReference).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.body.textContent).toContain("workspace contents"));
    expect(document.body.textContent).not.toContain("external contents");
  } finally {
    restoreNativeApi();
  }
});
