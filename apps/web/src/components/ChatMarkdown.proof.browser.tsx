import "../index.css";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";

vi.mock("../lib/localImageUrls", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/localImageUrls")>(),
  buildLocalImageUrl: () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#126b42";
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = "white";
    context.font = "20px sans-serif";
    context.fillText("Verified result", 35, 100);
    return canvas.toDataURL("image/png");
  },
}));

it("renders completion proof inline with expand and download controls", async () => {
  await page.viewport(1000, 800);
  const onImageExpand = vi.fn();
  const mounted = await render(<div style={{ width: 600 }}><ChatMarkdown
    cwd="/workspace"
    text={"## Completion report\n\nVerified the saved result.\n\n![Saved result](/private/generated_images/browser-proof/thread/result.png)\n\nUntested: production billing."}
    onImageExpand={onImageExpand}
  /></div>);
  try {
    const image = mounted.getByRole("img", { name: "Saved result" });
    await expect.element(image).toBeVisible();
    await vi.waitFor(() => expect(document.querySelector(".chat-generated-image")?.getAttribute("data-status")).toBe("ready"));
    await mounted.getByRole("button", { name: "Expand generated image" }).click();
    expect(onImageExpand).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    await mounted.getByRole("button", { name: "Expand generated image" }).hover();
    await expect.element(mounted.getByRole("link", { name: "Download generated image" })).toBeVisible();
    await expect.element(mounted.getByText("Untested: production billing.")).toBeVisible();
  } finally {
    await mounted.unmount();
  }
});
