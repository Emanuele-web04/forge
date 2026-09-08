import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import type { ProjectReadFileResult, ProjectWriteFileResult } from "@synara/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { api } = vi.hoisted(() => ({
  api: { projects: { readFile: vi.fn(), writeFile: vi.fn() } },
}));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => api }));

import { useWorkspaceFileEditorSession } from "./useWorkspaceFileEditorSession";
import { projectQueryKeys } from "../lib/projectReactQuery";

const CWD = "/repo";
const FILE = "src/app.ts";
const loaded = (contents = "initial\n"): ProjectReadFileResult => ({
  relativePath: FILE,
  contents,
  version: "sha256:initial",
  truncated: false,
  encoding: "utf8-bom",
  lineEnding: "crlf",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function Session({ onClose }: { onClose: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const session = useWorkspaceFileEditorSession({
    cwd: CWD,
    filePath: FILE,
    enabled: true,
    surfaceRef,
    onClose,
  });
  return (
    <div ref={surfaceRef}>
      <textarea
        aria-label="Buffer"
        value={session.state.value}
        onChange={(e) => session.handleChange(e.target.value)}
      />
      <button onClick={session.save}>Save</button>
      <button onClick={session.overwrite}>Overwrite</button>
      <button onClick={session.requestClose}>Close</button>
      <button onClick={session.requestReload}>Reload</button>
      <button onClick={session.cancelPendingDiscard}>Cancel discard</button>
      <button onClick={session.confirmPendingDiscard}>Confirm discard</button>
      <output data-testid="saving">{String(session.state.saving)}</output>
      <output data-testid="dirty">{String(session.dirty)}</output>
      <output data-testid="intent">{session.pendingDiscard}</output>
      <output data-testid="conflict">{String(session.state.conflict)}</output>
      <output data-testid="error">{session.state.saveError}</output>
    </div>
  );
}

async function mount() {
  api.projects.readFile.mockReset().mockResolvedValue(loaded());
  api.projects.writeFile.mockReset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["server", "config"], { keybindings: [] });
  const onClose = vi.fn();
  const view = await render(
    <QueryClientProvider client={client}>
      <Session onClose={onClose} />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("textbox", { name: "Buffer" })).toHaveValue("initial\n");
  return { client, onClose, view };
}

it("keeps edits made during a save and cancels the deferred close", async () => {
  const { view, onClose } = await mount();
  const write = deferred<ProjectWriteFileResult>();
  api.projects.writeFile.mockReturnValue(write.promise);
  await page.getByRole("textbox").fill("first edit\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(page.getByTestId("saving")).toHaveTextContent("true");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  expect(onClose).not.toHaveBeenCalled();
  await page.getByRole("textbox").fill("newer edit\n");
  api.projects.readFile.mockResolvedValue(loaded("first edit\n"));
  write.resolve({ relativePath: FILE, version: "sha256:saved" });
  await expect.element(page.getByTestId("saving")).toHaveTextContent("false");
  await expect.element(page.getByRole("textbox")).toHaveValue("newer edit\n");
  await expect.element(page.getByTestId("dirty")).toHaveTextContent("true");
  expect(onClose).not.toHaveBeenCalled();
  expect(api.projects.writeFile).toHaveBeenCalledWith({
    cwd: CWD,
    relativePath: FILE,
    contents: "first edit\n",
    encoding: "utf8-bom",
    lineEnding: "crlf",
    expectedVersion: "sha256:initial",
  });
  await view.unmount();
});

it("retains a conflicted buffer after deferred close and preserves format on explicit overwrite", async () => {
  const { view, onClose } = await mount();
  const write = deferred<ProjectWriteFileResult>();
  api.projects.writeFile.mockReturnValueOnce(write.promise);
  await page.getByRole("textbox").fill("mine\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  write.reject(Object.assign(new Error("Changed on disk"), { code: "WORKSPACE_FILE_CONFLICT" }));
  await expect.element(page.getByTestId("conflict")).toHaveTextContent("true");
  expect(onClose).not.toHaveBeenCalled();
  await expect.element(page.getByRole("textbox")).toHaveValue("mine\n");
  api.projects.readFile.mockResolvedValue(loaded("mine\n"));
  api.projects.writeFile.mockResolvedValueOnce({
    relativePath: FILE,
    version: "sha256:overwritten",
  });
  await page.getByRole("button", { name: "Overwrite", exact: true }).click();
  await expect.element(page.getByTestId("dirty")).toHaveTextContent("false");
  expect(api.projects.writeFile).toHaveBeenLastCalledWith({
    cwd: CWD,
    relativePath: FILE,
    contents: "mine\n",
    encoding: "utf8-bom",
    lineEnding: "crlf",
  });
  await view.unmount();
});

it("preserves dirty text on background reads and requires a deliberate discard", async () => {
  const { client, view, onClose } = await mount();
  await page.getByRole("textbox").fill("mine\n");
  client.setQueryData(projectQueryKeys.readFile(CWD, FILE), loaded("agent edit\n"));
  await expect.element(page.getByRole("textbox")).toHaveValue("mine\n");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect.element(page.getByTestId("intent")).toHaveTextContent("close");
  await page.getByRole("button", { name: "Cancel discard", exact: true }).click();
  expect(onClose).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Confirm discard", exact: true }).click();
  expect(onClose).toHaveBeenCalledTimes(1);
  await view.unmount();
});

it("does not replace text typed while an explicit reload is pending", async () => {
  const { client, view } = await mount();
  const read = deferred<ProjectReadFileResult>();
  api.projects.readFile.mockReturnValueOnce(read.promise);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByRole("textbox").fill("typed during reload\n");
  read.resolve(loaded("disk\n"));
  await expect
    .poll(
      () =>
        client.getQueryData<ProjectReadFileResult>(projectQueryKeys.readFile(CWD, FILE))?.contents,
    )
    .toBe("disk\n");
  await expect.element(page.getByRole("textbox")).toHaveValue("typed during reload\n");
  await view.unmount();
});
