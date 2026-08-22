// FILE: PdfResourceLifecycle.browser.tsx
// Purpose: Browser regressions for A -> B -> A PDF/image resources and PDF page drafts.
// Layer: Focused component lifecycle tests

import "../index.css";

import { useState } from "react";
import { page as browserPage } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { PDFDocumentProxy } from "~/lib/pdf/pdfEngine";
import { usePdfDocument } from "~/lib/pdf/usePdfDocument";
import { LocalImagePreview } from "./LocalImagePreview";
import { PdfFilePreview } from "./PdfFilePreview";
import { PdfViewerToolbar } from "./pdf/PdfViewerToolbar";

const { loadPdfDocumentMock } = vi.hoisted(() => ({
  loadPdfDocumentMock: vi.fn(),
}));

vi.mock("~/lib/pdf/pdfEngine", () => ({
  loadPdfDocument: loadPdfDocumentMock,
  renderPageTextLayer: vi.fn(),
}));

vi.mock("./chat/OpenInPicker", () => ({
  OpenInPicker: () => null,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function responseForDocument(id: number): Response {
  return new Response(new Uint8Array([id]), { status: 200 });
}

function createPdfDocument(label: string): {
  document: PDFDocumentProxy;
  destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn(() => Promise.resolve());
  const document = {
    numPages: 1,
    destroy,
    getPage: vi.fn(() =>
      Promise.resolve({
        getViewport: () => ({ width: 612, height: 792 }),
      }),
    ),
  } as unknown as PDFDocumentProxy;
  documentLabels.set(document, label);
  return { document, destroy };
}

const documentLabels = new WeakMap<PDFDocumentProxy, string>();
let fetchRequests: Map<string, Deferred<Response>[]>;

beforeEach(() => {
  fetchRequests = new Map();
  loadPdfDocumentMock.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const request = deferred<Response>();
      const requests = fetchRequests.get(url) ?? [];
      requests.push(request);
      fetchRequests.set(url, requests);
      return request.promise;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("local preview resource generations", () => {
  it("does not revive a destroyed PDF document after A -> B -> A", async () => {
    const firstA = createPdfDocument("first-a");
    const secondA = createPdfDocument("second-a");
    loadPdfDocumentMock
      .mockResolvedValueOnce(firstA.document)
      .mockResolvedValueOnce(secondA.document);

    function PdfHarness() {
      const [url, setUrl] = useState("/a.pdf");
      const pdf = usePdfDocument(url);
      const label = pdf.document ? documentLabels.get(pdf.document) : "none";
      return (
        <>
          <button type="button" onClick={() => setUrl("/b.pdf")}>
            Show B
          </button>
          <button type="button" onClick={() => setUrl("/a.pdf")}>
            Show A
          </button>
          <output data-testid="pdf-state">{`${pdf.status}:${label}`}</output>
        </>
      );
    }

    await render(<PdfHarness />);
    await vi.waitFor(() => expect(fetchRequests.get("/a.pdf")).toHaveLength(1));
    fetchRequests.get("/a.pdf")?.[0]?.resolve(responseForDocument(1));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="pdf-state"]')?.textContent).toBe(
        "ready:first-a",
      ),
    );

    await browserPage.getByRole("button", { name: "Show B" }).click();
    await vi.waitFor(() => expect(fetchRequests.get("/b.pdf")).toHaveLength(1));
    await vi.waitFor(() => expect(firstA.destroy).toHaveBeenCalledOnce());
    await browserPage.getByRole("button", { name: "Show A" }).click();
    await vi.waitFor(() => expect(fetchRequests.get("/a.pdf")).toHaveLength(2));

    expect(document.querySelector('[data-testid="pdf-state"]')?.textContent).toBe("loading:none");
    fetchRequests.get("/a.pdf")?.[1]?.resolve(responseForDocument(2));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="pdf-state"]')?.textContent).toBe(
        "ready:second-a",
      ),
    );
    expect(firstA.destroy).toHaveBeenCalledOnce();
  });

  it("renders a fresh image after an errored A -> B -> A transition", async () => {
    function ImageHarness() {
      const [src, setSrc] = useState("a.png");
      return (
        <>
          <button type="button" onClick={() => setSrc("b.png")}>
            Show B image
          </button>
          <button type="button" onClick={() => setSrc("a.png")}>
            Show A image
          </button>
          <LocalImagePreview src={src} cwd="/workspace" alt={src} />
        </>
      );
    }

    await render(<ImageHarness />);
    document
      .querySelector<HTMLImageElement>(".local-image-preview__img")
      ?.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Couldn’t open this image"));

    await browserPage.getByRole("button", { name: "Show B image" }).click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".local-image-preview__img")?.alt).toBe(
        "b.png",
      ),
    );
    await browserPage.getByRole("button", { name: "Show A image" }).click();

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLImageElement>(".local-image-preview__img")?.alt).toBe(
        "a.png",
      ),
    );
    expect(document.body.textContent).not.toContain("Couldn’t open this image");
  });

  it("reports PDF document load failures to its preview owner", async () => {
    const onPreviewError = vi.fn();

    await render(
      <PdfFilePreview
        filePath="missing.pdf"
        cwd="/workspace"
        openInTarget={null}
        onPreviewError={onPreviewError}
      />,
    );
    await vi.waitFor(() => expect([...fetchRequests.values()].flat()).toHaveLength(1));
    [...fetchRequests.values()][0]?.[0]?.resolve(new Response(null, { status: 404 }));

    await vi.waitFor(() => expect(onPreviewError).toHaveBeenCalledOnce());
  });
});

describe("PDF page draft", () => {
  it("does not revive an old draft when currentPage returns to its base", async () => {
    function ToolbarHarness() {
      const [currentPage, setCurrentPage] = useState(1);
      return (
        <>
          <button type="button" onClick={() => setCurrentPage(2)}>
            Navigate to 2
          </button>
          <button type="button" onClick={() => setCurrentPage(1)}>
            Navigate to 1
          </button>
          <PdfViewerToolbar
            fileName="document.pdf"
            currentPage={currentPage}
            numPages={9}
            onJumpToPage={setCurrentPage}
            zoomMode={{ type: "custom", scale: 1 }}
            scale={1}
            onZoomIn={vi.fn()}
            onZoomOut={vi.fn()}
            onSetScale={vi.fn()}
            onFitWidth={vi.fn()}
            onFitPage={vi.fn()}
            openInTarget={null}
          />
        </>
      );
    }

    await render(<ToolbarHarness />);
    await browserPage.getByRole("textbox", { name: "Current page" }).fill("9");
    await browserPage.getByRole("button", { name: "Navigate to 2" }).click();
    await browserPage.getByRole("button", { name: "Navigate to 1" }).click();

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[aria-label="Current page"]')?.value,
      ).toBe("1"),
    );
  });
});
