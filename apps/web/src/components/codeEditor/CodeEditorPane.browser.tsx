import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CodeEditorPane } from "./CodeEditorPane";
import { CodeDiffEditorPane } from "./CodeDiffEditorPane";
import type { CodeEditHistoryControls } from "./pierreEdit";

function Harness({ diff = false }: { diff?: boolean }) {
  const [value, setValue] = useState("const value = 1;\n");
  const [split, setSplit] = useState(true);
  const [dark, setDark] = useState(true);
  const [saved, setSaved] = useState(0);
  const [controls] = useState(() => createRef<CodeEditHistoryControls>());
  const common = {
    fileName: "sample.ts",
    resolvedTheme: dark ? ("dark" as const) : ("light" as const),
    onChange: setValue,
    onSave: () => setSaved((n) => n + 1),
    historyControlsRef: controls,
  };
  return (
    <div style={{ width: 900, height: 500 }}>
      <button onClick={() => controls.current?.revertTo("const value = 999;\n")}>
        Edit via history API
      </button>
      <button onClick={() => controls.current?.undo()}>Undo</button>
      <button onClick={() => controls.current?.redo()}>Redo</button>
      <button onClick={() => setSplit((v) => !v)}>Layout</button>
      <button onClick={() => setDark((v) => !v)}>Theme</button>
      <output data-testid="buffer">{value}</output>
      <output data-testid="saved">{saved}</output>
      {diff ? (
        <CodeDiffEditorPane
          {...common}
          original="const value = 0;\n"
          originalVersion={0}
          modified={value}
          modifiedVersion={0}
          renderSideBySide={split}
        />
      ) : (
        <CodeEditorPane {...common} value={value} valueVersion={0} />
      )}
    </div>
  );
}

function mount(diff = false) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Harness diff={diff} />
    </QueryClientProvider>,
  );
}

it("does not mark unchanged CRLF lines as changes alongside a real edit", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <CodeDiffEditorPane
        original={"one\r\ntwo\r\nthree\r\n"}
        originalVersion={0}
        modified={"one\nchanged\nthree\n"}
        modifiedVersion={0}
        fileName="same.txt"
        resolvedTheme="light"
        renderSideBySide
        onChange={() => {}}
        onSave={() => {}}
      />
    </QueryClientProvider>,
  );
  await expect.element(page.getByRole("textbox")).toBeVisible();
  const content = page.getByRole("textbox").element();
  await expect
    .poll(() => content.querySelectorAll('[data-line-type="change-addition"]').length)
    .toBe(1);
  await expect.element(page.getByRole("textbox")).toHaveTextContent("changed");
  await view.unmount();
});

it("real Pierre file editor accepts typing, undo, redo and keeps edits across theme change", async () => {
  const view = await mount();
  await page.getByRole("textbox").click({ position: { x: 15, y: 5 } });
  await userEvent.keyboard("x");
  await expect.poll(() => page.getByTestId("buffer").element().textContent).toContain("x");
  await page.getByRole("button", { name: "Edit via history API" }).click();
  await expect.element(page.getByTestId("buffer")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => page.getByTestId("buffer").element().textContent).toContain("x");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect.element(page.getByTestId("buffer")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Theme", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveTextContent("const value = 999;");
  await view.unmount();
});

it("real Pierre diff editor preserves current buffer on split/unified remount", async () => {
  const view = await mount(true);
  await expect.element(page.getByRole("textbox")).toBeVisible();
  await page.getByRole("button", { name: "Edit via history API" }).click();
  await expect.element(page.getByTestId("buffer")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveTextContent("const value = 999;");
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await expect.element(page.getByRole("textbox")).toHaveTextContent("const value = 999;");
  await view.unmount();
});
