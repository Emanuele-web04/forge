import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectFloatingBrowserPanelRect,
  selectFloatingBrowserRequested,
  useFloatingBrowserRequestStore,
} from "./floatingBrowserRequestStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const RECT_A = { left: 40, top: 80, width: 320, height: 200 };
const RECT_B = { left: 120, top: 60, width: 480, height: 300 };

describe("floating browser request store", () => {
  beforeEach(() => {
    useFloatingBrowserRequestStore.setState({ requestedByThreadId: {}, rectByThreadId: {} });
  });

  it("remembers a background thread until it is dismissed", () => {
    const store = useFloatingBrowserRequestStore.getState();
    store.request(THREAD_A);
    store.request(THREAD_B);

    expect(
      selectFloatingBrowserRequested(THREAD_A)(useFloatingBrowserRequestStore.getState()),
    ).toBe(true);
    store.dismiss(THREAD_A);
    expect(
      selectFloatingBrowserRequested(THREAD_A)(useFloatingBrowserRequestStore.getState()),
    ).toBe(false);
    expect(
      selectFloatingBrowserRequested(THREAD_B)(useFloatingBrowserRequestStore.getState()),
    ).toBe(true);
  });

  it("keeps each thread's card rect until that thread is dismissed", () => {
    const store = useFloatingBrowserRequestStore.getState();
    store.request(THREAD_A);
    store.rememberRect(THREAD_A, RECT_A);
    store.rememberRect(THREAD_B, RECT_B);

    expect(
      selectFloatingBrowserPanelRect(THREAD_A)(useFloatingBrowserRequestStore.getState()),
    ).toEqual(RECT_A);
    expect(
      selectFloatingBrowserPanelRect(THREAD_B)(useFloatingBrowserRequestStore.getState()),
    ).toEqual(RECT_B);

    store.dismiss(THREAD_A);
    expect(
      selectFloatingBrowserPanelRect(THREAD_A)(useFloatingBrowserRequestStore.getState()),
    ).toBe(undefined);
    expect(
      selectFloatingBrowserPanelRect(THREAD_B)(useFloatingBrowserRequestStore.getState()),
    ).toEqual(RECT_B);
  });
});
