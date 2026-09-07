import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  NATIVE_SURFACE_OCCLUSION_SYNC_EVENT,
  observeNativeSurfaceOverlay,
} from "./nativeSurfaceOcclusion";

it("notifies on mount, resize, movement, hiding and cleanup without observing unrelated DOM", async () => {
  const notify = vi.fn();
  window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, notify);
  const mounted = await render(<div ref={observeNativeSurfaceOverlay} style={{ width: 120, height: 120 }} />);
  const element = mounted.container.firstElementChild as HTMLElement;
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    await settle();
    expect(notify).toHaveBeenCalled();
    for (const update of [
      () => { element.style.width = "150px"; },
      () => { element.style.transform = "translateX(100px)"; },
      () => { element.style.display = "none"; },
      () => { element.style.display = "block"; },
    ]) {
      notify.mockClear();
      update();
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      await settle();
    }
    notify.mockClear();
    document.body.dataset.unrelated = "changed";
    await settle();
    expect(notify).not.toHaveBeenCalled();
    await mounted.unmount();
    expect(notify).toHaveBeenCalled();
    notify.mockClear();
    element.style.width = "200px";
    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(observeNativeSurfaceOverlay(null)).toBeUndefined();
  } finally {
    window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, notify);
    delete document.body.dataset.unrelated;
  }
});
