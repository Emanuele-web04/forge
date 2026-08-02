// FILE: QrCode.tsx
// Purpose: Renders a pairing URL as a scannable QR code.
// Layer: Settings UI
// Depends on: qrcode-generator (encoding only; the SVG is ours).

import { memo, useMemo } from "react";
import qrcode from "qrcode-generator";

import { cn } from "~/lib/utils";

/**
 * Error-correction level.
 *
 * `M` over the denser `L`: a pairing code is often scanned off a screen at an
 * angle with glare, and the extra redundancy costs a few modules rather than a
 * failed scan.
 */
const ERROR_CORRECTION = "M" as const;

export const QrCode = memo(function QrCode(props: {
  readonly value: string;
  /** Rendered size in CSS pixels. */
  readonly size?: number;
  readonly className?: string;
  readonly title: string;
}) {
  const size = props.size ?? 192;

  const path = useMemo(() => {
    // Type number 0 lets the encoder pick the smallest version that fits, so a
    // short tailnet URL stays coarse (and therefore easy to scan) instead of
    // being padded into a dense grid.
    const encoder = qrcode(0, ERROR_CORRECTION);
    encoder.addData(props.value);
    encoder.make();
    const moduleCount = encoder.getModuleCount();
    const segments: string[] = [];
    for (let row = 0; row < moduleCount; row += 1) {
      for (let column = 0; column < moduleCount; column += 1) {
        if (!encoder.isDark(row, column)) continue;
        segments.push(`M${column} ${row}h1v1h-1z`);
      }
    }
    return { d: segments.join(""), moduleCount };
  }, [props.value]);

  // The quiet zone is part of the spec, not decoration: without it many scanners
  // cannot find the code at all against a dark UI.
  const quietZone = 4;
  const viewBoxSize = path.moduleCount + quietZone * 2;

  return (
    <svg
      role="img"
      aria-label={props.title}
      width={size}
      height={size}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      shapeRendering="crispEdges"
      className={cn("rounded-md bg-white p-0", props.className)}
    >
      <title>{props.title}</title>
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      <g transform={`translate(${quietZone} ${quietZone})`} fill="#000000">
        <path d={path.d} />
      </g>
    </svg>
  );
});
