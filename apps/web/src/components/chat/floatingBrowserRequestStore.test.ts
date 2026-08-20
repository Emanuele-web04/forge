import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectFloatingBrowserRequested,
  useFloatingBrowserRequestStore,
} from "./floatingBrowserRequestStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("floating browser request store", () => {
  beforeEach(() => {
    useFloatingBrowserRequestStore.setState({ requestedByThreadId: {} });
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
});
