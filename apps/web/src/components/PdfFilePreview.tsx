// FILE: PdfFilePreview.tsx
// Purpose: In-app PDF viewer surface. Renders our own toolbar (file name, page
//          navigation, zoom) over a continuously-scrolling, centered stack of
//          pdf.js-rendered pages — replacing the browser's built-in PDF iframe so
//          the chrome matches the rest of Synara. Modeled on how Codex vendors a
//          custom pdf.js viewer (canvas + text layer + clickable links).
//          This component is the orchestrator: document load, container
//          measurement, page navigation, and zoom each live in their own hook
//          (usePdfDocument / useContainerSize / usePdfPageNavigation /
//          usePdfZoomController) and are composed here.
// Layer: Web chat/editor file-preview component
// Exports: PdfFilePreview

import { useEffect, useState } from "react";

import { basenameOfPath } from "~/file-icons";
import { Loader2Icon, TriangleAlertIcon } from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { useContainerSize } from "~/lib/pdf/useContainerSize";
import { usePdfDocument } from "~/lib/pdf/usePdfDocument";
import { usePdfPageNavigation } from "~/lib/pdf/usePdfPageNavigation";
import { usePdfZoomController } from "~/lib/pdf/usePdfZoomController";
import { cn } from "~/lib/utils";
import { PdfPageView } from "./pdf/PdfPageView";
import { PdfViewerToolbar } from "./pdf/PdfViewerToolbar";

export function PdfFilePreview(props: {
  /**
   * Workspace-relative path of the PDF (resolved server-side against cwd), or an
   * allowlisted absolute path (e.g. inside a session's scratch workspace).
   */
  filePath: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  /** Pre-resolved target for the "Open in editor" control in the toolbar. */
  openInTarget: string | null;
  className?: string;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
}) {
  const previewUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
  });
  const fileName = basenameOfPath(props.filePath);
  const doc = usePdfDocument(previewUrl);

  useEffect(() => {
    if (doc.status === "ready") {
      props.onPreviewReady?.();
    } else if (doc.status === "error") {
      props.onPreviewError?.();
    }
  }, [doc.status, props.onPreviewError, props.onPreviewReady]);

  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const containerSize = useContainerSize(scrollRoot);

  const navigation = usePdfPageNavigation({
    scrollRoot,
    numPages: doc.numPages,
    enabled: doc.status === "ready",
    resetKey: previewUrl,
  });
  const zoom = usePdfZoomController({
    firstPageSize: doc.firstPageSize,
    containerSize,
    currentPage: navigation.currentPage,
    scrollToPage: navigation.scrollToPage,
  });

  const pageNumbers = Array.from({ length: doc.numPages }, (_, index) => index + 1);

  const outerClassName = cn(
    "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]",
    props.className,
  );

  const readyDocument = doc.document;
  const firstPageSize = doc.firstPageSize;
  if (doc.status === "ready" && readyDocument && firstPageSize) {
    return (
      <div className={outerClassName}>
        <PdfViewerToolbar
          fileName={fileName}
          currentPage={navigation.currentPage}
          numPages={doc.numPages}
          onJumpToPage={navigation.jumpToPage}
          zoomMode={zoom.zoomMode}
          scale={zoom.scale}
          onZoomIn={zoom.onZoomIn}
          onZoomOut={zoom.onZoomOut}
          onSetScale={zoom.onSetScale}
          onFitWidth={zoom.onFitWidth}
          onFitPage={zoom.onFitPage}
          openInTarget={props.openInTarget}
        />
        <div ref={setScrollRoot} className="pdf-viewer-scroll min-h-0 flex-1 overflow-auto">
          {containerSize
            ? pageNumbers.map((pageNumber) => (
                <PdfPageView
                  key={`${previewUrl}:${pageNumber}`}
                  document={readyDocument}
                  pageNumber={pageNumber}
                  scale={zoom.scale}
                  intrinsicSize={firstPageSize}
                  scrollRoot={scrollRoot}
                  registerElement={navigation.registerElement}
                  onJumpToPage={navigation.jumpToPage}
                />
              ))
            : null}
        </div>
      </div>
    );
  }

  if (doc.status === "error") {
    return (
      <div className={outerClassName}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <TriangleAlertIcon className="size-5 text-destructive/80" aria-hidden="true" />
          <p className="text-[12px] text-muted-foreground">
            {doc.error ?? "Could not open this PDF."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={outerClassName}>
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        role="status"
        aria-label="Loading PDF..."
      >
        <Loader2Icon className="size-4 animate-spin opacity-60" aria-hidden="true" />
      </div>
    </div>
  );
}
