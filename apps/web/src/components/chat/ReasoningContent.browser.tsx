import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ReasoningContent } from "./ReasoningContent";

it("renders the whole thinking in a bounded scroll region with a full-copy action", async () => {
  const text = "First paragraph\n\n" + "Readable reasoning. ".repeat(1000) + "\n\nFinal paragraph";
  const screen = await render(
    <ReasoningContent text={text} cwd={undefined} onImageExpand={() => {}} />,
  );
  await expect.element(screen.getByText("First paragraph", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText("Final paragraph", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Copy full thinking" })).toBeVisible();
  const scroller = document.querySelector("[data-reasoning-content] .overflow-y-auto")!;
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  expect(scroller.clientHeight).toBeLessThanOrEqual(384);
});
