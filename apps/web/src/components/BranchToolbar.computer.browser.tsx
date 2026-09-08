import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { RuntimeUsageControls } from "./BranchToolbar";

afterEach(() => cleanup());

describe("explicit Computer activation", () => {
  it("lets the user select request-scoped access without changing runtime permissions", async () => {
    const onMode = vi.fn();
    const onRuntime = vi.fn();
    await render(
      <RuntimeUsageControls
        runtimeMode="approval-required"
        onRuntimeModeChange={onRuntime}
        computerControlMode="off"
        computerControlSupported
        onComputerControlModeChange={onMode}
      />,
    );
    await page.getByRole("button").click();
    await page
      .getByRole("menuitemradio", { name: "Computer: For this request", exact: true })
      .click();
    expect(onMode).toHaveBeenCalledExactlyOnceWith("request");
    expect(onRuntime).not.toHaveBeenCalled();
  });

  it("offers an explicit off choice even if the backend is unavailable", async () => {
    const onMode = vi.fn();
    await render(
      <RuntimeUsageControls
        runtimeMode="approval-required"
        onRuntimeModeChange={() => {}}
        computerControlMode="chat"
        computerControlEnabled
        computerControlSupported={false}
        onComputerControlModeChange={onMode}
      />,
    );
    await page.getByRole("button").click();
    await page.getByRole("menuitemradio", { name: "Computer: Off", exact: true }).click();
    expect(onMode).toHaveBeenCalledExactlyOnceWith("off");
  });
});
