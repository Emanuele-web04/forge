// FILE: BrowserPanel.annotations.browser.tsx
// Purpose: Browser-runtime coverage for annotation toolbar and session orchestration.
// Layer: BrowserPanel browser tests

import "../index.css";

import { useCallback, useState } from "react";
import {
  ThreadId,
  type BrowserAnnotationEvent,
  type BrowserAnnotationMethods,
  type BrowserAnnotationSession,
} from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { BrowserAnnotationDraft } from "../lib/browserAnnotations";
import { BrowserAnnotationButton } from "./BrowserPanel";
import { browserAnnotationTheme } from "./BrowserPanel.logic";
import { useBrowserAnnotations } from "./browser/useBrowserAnnotations";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const SOURCE = { url: "https://example.test/page", pageTitle: "Fixture page" };
const DOCUMENT_KEY = `sha256:${"0".repeat(64)}`;
const DOCUMENT = { token: "document-a", key: DOCUMENT_KEY, url: SOURCE.url };

interface AnnotationMethodsHarness {
  readonly methods: BrowserAnnotationMethods;
  readonly start: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  readonly syncMarkers: ReturnType<typeof vi.fn>;
  emit: (event: BrowserAnnotationEvent) => void;
}

function createMethodsHarness(): AnnotationMethodsHarness {
  let listener: ((event: BrowserAnnotationEvent) => void) | null = null;
  const session: BrowserAnnotationSession = {
    sessionId: "session-a",
    threadId: THREAD_A,
    tabId: "tab-a",
    document: DOCUMENT,
    source: SOURCE,
  };
  const start = vi.fn(async () => session);
  const cancel = vi.fn(async () => {});
  const syncMarkers = vi.fn(async () => {});
  return {
    methods: {
      start,
      cancel,
      syncMarkers,
      onEvent: (nextListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) {
            listener = null;
          }
        };
      },
    },
    start,
    cancel,
    syncMarkers,
    emit: (event) => listener?.(event),
  };
}

function committedEvent(
  overrides: Partial<Extract<BrowserAnnotationEvent, { kind: "committed" }>> = {},
): Extract<BrowserAnnotationEvent, { kind: "committed" }> {
  return {
    kind: "committed",
    threadId: THREAD_A,
    tabId: "tab-a",
    sessionId: "session-a",
    document: DOCUMENT,
    source: SOURCE,
    annotation: {
      id: "annotation-a",
      source: SOURCE,
      selector: "#primary-action",
      tagName: "button",
      role: "button",
      name: "Primary action",
      text: "Continue",
      fingerprint: "button|primary-action",
      comment: null,
      capturedAt: "2026-07-23T12:00:00.000Z",
    },
    ...overrides,
  };
}

function AnnotationHarness(props: {
  harness: AnnotationMethodsHarness;
  onAdd: (annotation: Omit<BrowserAnnotationDraft, "ordinal">) => void;
}) {
  const [annotations, setAnnotations] = useState<BrowserAnnotationDraft[]>([]);
  const [browserStateVersion, setBrowserStateVersion] = useState(1);
  const [activeTabId, setActiveTabId] = useState<string | null>("tab-a");
  const addAnnotation = useCallback(
    (_threadId: ThreadId, annotation: Omit<BrowserAnnotationDraft, "ordinal">) => {
      props.onAdd(annotation);
      setAnnotations((current) => [
        ...current,
        {
          ...annotation,
          ordinal: current.reduce((max, item) => Math.max(max, item.ordinal), 0) + 1,
        },
      ]);
      return true;
    },
    [props.onAdd],
  );
  const controller = useBrowserAnnotations({
    methods: props.harness.methods,
    threadId: THREAD_A,
    activeTabId,
    browserStateVersion,
    enabled: activeTabId !== null,
    annotations,
    addAnnotation,
    onError: () => {},
  });

  return (
    <>
      <BrowserAnnotationButton controller={controller} disabled={activeTabId === null} />
      <button type="button" onClick={() => setAnnotations([])}>
        Remove annotations
      </button>
      <button type="button" onClick={() => setBrowserStateVersion((version) => version + 1)}>
        Navigate document
      </button>
      <button type="button" onClick={() => setActiveTabId("tab-b")}>
        Switch tab
      </button>
    </>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("BrowserPanel annotations", () => {
  it("resolves theme colors from the opaque overlay surface token", () => {
    const root = document.createElement("div");
    root.classList.add("dark");
    root.style.setProperty("--color-text-accent", "#123456");
    root.style.setProperty("--color-background-control-opaque", "#234567");
    root.style.setProperty(
      "--composer-surface",
      "color-mix(in srgb, rgb(0 0 0) 25%, rgb(255 255 255))",
    );
    document.body.append(root);

    const theme = browserAnnotationTheme(root);
    expect(theme).toMatchObject({
      mode: "dark",
      accent: "rgb(18, 52, 86)",
      surface: "rgb(35, 69, 103)",
    });
    expect(theme.surface).not.toMatch(/(?:var|color-mix)\(/);
    root.remove();
  });

  it("exposes a pressed continuous control and cancels through toggle or Escape", async () => {
    const harness = createMethodsHarness();
    const mounted = await render(<AnnotationHarness harness={harness} onAdd={() => {}} />);
    const annotate = mounted.getByRole("button", { name: "Annotate page" });

    await expect.element(annotate).toHaveAttribute("aria-pressed", "false");
    await annotate.click();
    await expect
      .element(mounted.getByRole("button", { name: "Cancel annotation" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(harness.start).toHaveBeenCalledWith({
      threadId: THREAD_A,
      tabId: "tab-a",
      theme: expect.objectContaining({
        mode: expect.stringMatching(/^(light|dark)$/),
        surface: expect.stringMatching(/^rgb/),
        primary: expect.stringMatching(/^rgb/),
      }),
    });

    await mounted.getByRole("button", { name: "Cancel annotation" }).click();
    await expect.element(mounted.getByRole("button", { name: "Annotate page" })).toBeVisible();
    expect(harness.cancel).toHaveBeenCalledWith({ threadId: THREAD_A, tabId: "tab-a" });

    await mounted.getByRole("button", { name: "Annotate page" }).click();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await expect.element(mounted.getByRole("button", { name: "Annotate page" })).toBeVisible();
    expect(harness.cancel).toHaveBeenCalledTimes(2);

    await mounted.unmount();
  });

  it("commits an optional comment, ignores stale scope, and reprojects after mutations", async () => {
    const harness = createMethodsHarness();
    const onAdd = vi.fn();
    const mounted = await render(<AnnotationHarness harness={harness} onAdd={onAdd} />);

    await mounted.getByRole("button", { name: "Annotate page" }).click();
    await expect.element(mounted.getByRole("button", { name: "Cancel annotation" })).toBeVisible();
    harness.emit(
      committedEvent({
        threadId: THREAD_B,
      }),
    );
    harness.emit(
      committedEvent({
        tabId: "tab-b",
      }),
    );
    expect(onAdd).not.toHaveBeenCalled();

    harness.emit(committedEvent());
    await vi.waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "annotation-a",
          tabId: "tab-a",
          comment: null,
        }),
      );
      expect(harness.syncMarkers).toHaveBeenLastCalledWith(
        expect.objectContaining({
          threadId: THREAD_A,
          tabId: "tab-a",
          markers: [
            expect.objectContaining({
              id: "annotation-a",
              ordinal: 1,
            }),
          ],
        }),
      );
    });
    await expect.element(mounted.getByRole("button", { name: "Cancel annotation" })).toBeVisible();

    await mounted.getByRole("button", { name: "Remove annotations" }).click();
    await vi.waitFor(() => {
      expect(harness.syncMarkers).toHaveBeenLastCalledWith(
        expect.objectContaining({ tabId: "tab-a", markers: [] }),
      );
    });
    const syncCountBeforeNavigation = harness.syncMarkers.mock.calls.length;
    await mounted.getByRole("button", { name: "Navigate document" }).click();
    await vi.waitFor(() => {
      expect(harness.syncMarkers.mock.calls.length).toBeGreaterThan(syncCountBeforeNavigation);
    });
    const syncCountBeforeDocumentEvent = harness.syncMarkers.mock.calls.length;
    harness.emit({
      kind: "document-changed",
      threadId: THREAD_A,
      tabId: "tab-a",
      sessionId: null,
      document: { token: "document-b", key: DOCUMENT_KEY, url: SOURCE.url },
      source: SOURCE,
    });
    await vi.waitFor(() => {
      expect(harness.syncMarkers.mock.calls.length).toBeGreaterThan(syncCountBeforeDocumentEvent);
    });

    await mounted.unmount();
  });

  it("cleans up an active session when the logical tab changes or the panel unmounts", async () => {
    const harness = createMethodsHarness();
    const mounted = await render(<AnnotationHarness harness={harness} onAdd={() => {}} />);
    await mounted.getByRole("button", { name: "Annotate page" }).click();
    await expect.element(mounted.getByRole("button", { name: "Cancel annotation" })).toBeVisible();

    await mounted.getByRole("button", { name: "Switch tab" }).click();
    await vi.waitFor(() => {
      expect(harness.cancel).toHaveBeenCalledWith({ threadId: THREAD_A, tabId: "tab-a" });
    });

    await mounted.getByRole("button", { name: "Annotate page" }).click();
    await mounted.unmount();
    expect(harness.cancel).toHaveBeenCalledWith({ threadId: THREAD_A, tabId: "tab-b" });
  });

  it("keeps the control disabled without a live runtime", async () => {
    const controller = {
      active: false,
      starting: false,
      toggle: vi.fn(),
    };
    const mounted = await render(<BrowserAnnotationButton controller={controller} disabled />);
    const annotate = mounted.getByRole("button", { name: "Annotate page" });

    await expect.element(annotate).toBeDisabled();
    await expect.element(annotate).toHaveAttribute("aria-pressed", "false");
    await expect.element(annotate).toHaveAttribute("title", "Annotate page");
    await mounted.unmount();
  });

  it("keeps the cursor mounted and gives pending annotation mode a solid selected state", async () => {
    const toggle = vi.fn();
    const mounted = await render(
      <BrowserAnnotationButton
        controller={{ active: false, starting: false, toggle }}
        disabled={false}
      />,
    );
    const annotate = mounted.getByRole("button", { name: "Annotate page" });
    const pointer = annotate.element().querySelector("[data-slot='central-icon']");

    expect(pointer).not.toBeNull();
    expect(annotate.element().classList.contains("bg-primary")).toBe(false);

    await mounted.rerender(
      <BrowserAnnotationButton
        controller={{ active: true, starting: true, toggle }}
        disabled={false}
      />,
    );
    const cancel = mounted.getByRole("button", { name: "Cancel annotation" });

    expect(cancel.element().querySelector("[data-slot='central-icon']")).toBe(pointer);
    expect(cancel.element().querySelector(".animate-spin")).toBeNull();
    expect(cancel.element().classList.contains("bg-primary")).toBe(true);
    await expect.element(cancel).toHaveAttribute("aria-busy", "true");
    await mounted.unmount();
  });
});
