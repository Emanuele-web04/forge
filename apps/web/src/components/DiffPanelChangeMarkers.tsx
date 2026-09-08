import type { FileDiffMetadata } from "@pierre/diffs/react";
import { useEffect, useState, type RefObject } from "react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { readDiffFileAnchors, resolveDiffRenderSurface } from "~/lib/diffScrollSurface";
import {
  DIFF_CHANGE_MARKER_HEIGHT_PX,
  resolveDiffChangeMarkers,
  type DiffChangeMarker,
  type DiffChangeMarkerKind,
} from "./DiffPanel.logic";

const CHANGE_MARKER_COLOR_BY_KIND: Record<DiffChangeMarkerKind, string> = {
  added: "var(--success)",
  removed: "var(--destructive)",
  modified: "var(--muted-foreground)",
};

const CHANGE_MARKER_LABEL_BY_KIND: Record<DiffChangeMarkerKind, string> = {
  added: "Added",
  removed: "Deleted",
  modified: "Modified",
};

export function DiffPanelChangeMarkers(props: {
  viewportRef: RefObject<HTMLElement | null>;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  onSelectFilePath: (filePath: string) => void;
}) {
  const { renderableFiles, viewportRef } = props;
  const [markers, setMarkers] = useState<ReadonlyArray<DiffChangeMarker>>([]);

  useEffect(() => {
    const surface = resolveDiffRenderSurface(viewportRef.current);
    if (!surface || renderableFiles.length === 0) {
      setMarkers([]);
      return;
    }

    const changeTypeByPath = new Map(
      renderableFiles.map((fileDiff) => [resolveFileDiffPath(fileDiff), fileDiff.type] as const),
    );

    let frame = 0;
    const measure = () => {
      frame = 0;
      const anchors = readDiffFileAnchors(surface);
      const surfaceTop = surface.getBoundingClientRect().top - surface.scrollTop;
      const files = anchors.flatMap((anchor) => {
        const changeType = changeTypeByPath.get(anchor.path);
        if (!changeType) {
          return [];
        }
        return [
          {
            path: anchor.path,
            offsetTop: anchor.element.getBoundingClientRect().top - surfaceTop,
            changeType,
          },
        ];
      });
      setMarkers(
        resolveDiffChangeMarkers({
          files,
          scrollHeight: surface.scrollHeight,
          stripHeight: surface.clientHeight,
        }),
      );
    };
    const schedule = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(surface);
    for (const anchor of readDiffFileAnchors(surface)) {
      resizeObserver.observe(anchor.element);
    }

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
    };
  }, [renderableFiles, viewportRef]);

  if (markers.length === 0) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label="Change markers"
      className="pointer-events-none absolute inset-y-0 right-[10px] z-10 w-[6px]"
    >
      {markers.map((marker) => (
        <button
          key={marker.path}
          type="button"
          aria-label={`${CHANGE_MARKER_LABEL_BY_KIND[marker.kind]}: ${marker.path}`}
          title={marker.path}
          className="pointer-events-auto absolute left-0 w-full cursor-pointer rounded-full opacity-70 transition-opacity hover:opacity-100"
          style={{
            top: `${marker.top}px`,
            height: `${DIFF_CHANGE_MARKER_HEIGHT_PX}px`,
            backgroundColor: CHANGE_MARKER_COLOR_BY_KIND[marker.kind],
          }}
          onClick={() => {
            props.onSelectFilePath(marker.path);
          }}
        />
      ))}
    </div>
  );
}
