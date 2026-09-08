import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ComputerInputPauseNotice } from "./ComputerInputPauseNotice";

const probe = vi.hoisted(() => ({
  getState: vi.fn(),
  click: undefined as undefined | (() => Promise<void>),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ computer: { getState: probe.getState } }),
}));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => {
    probe.click = props.onClick as unknown as () => Promise<void>;
    return <button>{props.children}</button>;
  },
}));

beforeEach(() => {
  probe.getState.mockReset();
  probe.click = undefined;
});

it.each([{}, { inputPause: { windowId: "1357", message: "Still paused" } }])(
  "checks readiness without capturing pixels or replaying input",
  async (result) => {
    probe.getState.mockResolvedValue(result);
    renderToStaticMarkup(
      <ComputerInputPauseNotice pause={{ windowId: "1357", message: "Paused" }} windows={[]} />,
    );
    await probe.click!();
    expect(probe.getState).toHaveBeenCalledExactlyOnceWith({
      windowId: "1357",
      includeScreenshot: false,
    });
  },
);

it("handles a failed readiness request without retrying", async () => {
  probe.getState.mockRejectedValue(new Error("Disconnected"));
  renderToStaticMarkup(
    <ComputerInputPauseNotice pause={{ windowId: "1357", message: "Paused" }} windows={[]} />,
  );
  await expect(probe.click!()).resolves.toBeUndefined();
  expect(probe.getState).toHaveBeenCalledTimes(1);
});
