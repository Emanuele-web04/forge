import "../../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";
it("expands thinking independently from tool details", async () => {
  const screen = await render(
    <div style={{ width: 360 }}>
      <TimelineWorkEntryRow
        workEntry={{
          id: "thinking",
          createdAt: "2026-09-05T00:00:00Z",
          tone: "tool",
          label: "Reasoning trace",
          detail: "Check the constraints before executing the command.",
        }}
        chatMetaFontSizePx={12}
        markdownCwd={undefined}
        onImageExpand={() => {}}
        timestampFormat="locale"
      />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: /Thinking/ });
  await expect.element(trigger).toBeVisible();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(screen.getByText("Check the constraints before executing the command.").last())
    .toBeVisible();
  await trigger.click();
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
});
