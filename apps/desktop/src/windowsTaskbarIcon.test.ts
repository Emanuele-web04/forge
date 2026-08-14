import { afterEach, describe, expect, it, vi } from "vitest";

import type { BrowserWindow } from "electron";

import { refreshWindowsTaskbarIcon } from "./windowsTaskbarIcon";

interface FakeWindowState {
  destroyed?: boolean;
  visible?: boolean;
}

function makeWindow({ destroyed = false, visible = true }: FakeWindowState = {}) {
  return {
    isDestroyed: vi.fn(() => destroyed),
    isVisible: vi.fn(() => visible),
    setSkipTaskbar: vi.fn(),
  } as unknown as BrowserWindow;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshWindowsTaskbarIcon", () => {
  it("detaches the taskbar button and re-registers it after the refresh delay", () => {
    vi.useFakeTimers();
    const window = makeWindow();

    refreshWindowsTaskbarIcon(window);

    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(249);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(false);
    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there is no window", () => {
    vi.useFakeTimers();
    expect(() => refreshWindowsTaskbarIcon(null)).not.toThrow();
  });

  it("does nothing when the window is destroyed", () => {
    vi.useFakeTimers();
    const window = makeWindow({ destroyed: true });

    refreshWindowsTaskbarIcon(window);

    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("does nothing when the window is hidden", () => {
    vi.useFakeTimers();
    const window = makeWindow({ visible: false });

    refreshWindowsTaskbarIcon(window);

    expect(window.setSkipTaskbar).not.toHaveBeenCalled();
  });

  it("never re-registers the button when the window is destroyed before the delay elapses", () => {
    vi.useFakeTimers();
    const window = makeWindow();

    refreshWindowsTaskbarIcon(window);
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(249);
    (window.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    vi.advanceTimersByTime(1);

    expect(window.setSkipTaskbar).toHaveBeenCalledTimes(1);
  });
});
