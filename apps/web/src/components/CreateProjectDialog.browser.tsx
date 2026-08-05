import "../index.css";

import { page } from "vitest/browser";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({
  onProvisionProgress: vi.fn(() => () => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      onProvisionProgress: nativeApi.onProvisionProgress,
    },
  }),
}));

import { CreateProjectDialog } from "./CreateProjectDialog";

describe("CreateProjectDialog GitHub source", () => {
  afterEach(() => {
    nativeApi.onProvisionProgress.mockClear();
  });

  it("disables GitHub when the server does not advertise provisioning", async () => {
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable={false}
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      (page.getByRole("radio", { name: "GitHub" }).element() as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("derives the clone folder from owner/repository and submits a parent directory", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
    );

    await page.getByRole("radio", { name: "GitHub" }).click();
    expect(document.body.textContent).toContain("What you need");
    expect(document.body.textContent).toContain("Private access");
    await page.getByLabelText("Repository").fill("openai/codex");

    expect((page.getByLabelText("Folder name").element() as HTMLInputElement).value).toBe("codex");
    expect(document.body.textContent).toContain("Final location: /Users/test/Developer/codex");

    await page.getByRole("button", { name: "Clone and add" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [value, options] = onSubmit.mock.calls[0] ?? [];
    expect(value).toMatchObject({
      source: "github",
      repository: "openai/codex",
      destinationParent: "/Users/test/Developer",
      directoryName: "codex",
      spaceId: null,
    });
    expect(value.operationId).toEqual(expect.any(String));
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects invalid clone folder names before provisioning", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByLabelText("Repository").fill("openai/codex");
    await page.getByLabelText("Folder name").fill("CON");
    await page.getByRole("button", { name: "Clone and add" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent("Choose a valid folder name");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("aborts the active clone when the dialog is closed", async () => {
    const submittedSignals: AbortSignal[] = [];
    const onSubmit = vi.fn(
      (_value: unknown, options: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          submittedSignals.push(options.signal);
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const onOpenChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <CreateProjectDialog
          open={open}
          githubProvisioningAvailable
          spaces={[]}
          activeSpaceId={null}
          defaultCloneParent="/Users/test"
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
          onSubmit={onSubmit}
        />
      );
    }
    await render(<Harness />);

    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByLabelText("Repository").fill("openai/codex");
    await page.getByRole("button", { name: "Clone and add" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await page.getByRole("button", { name: "Cancel clone" }).click();

    expect(submittedSignals[0]?.aborted).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
