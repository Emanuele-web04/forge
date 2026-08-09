export interface CollapsedBreadcrumbLayout {
  visibleTail: number;
  showEllipsis: boolean;
}

interface BreadcrumbMeasurement {
  containerWidth: number;
  renderedFileWidth: number;
  prefixWidths: number[];
  ellipsisWidth: number;
  trailingReserveWidth: number;
}

function countTrailingCrumbsThatFit(
  prefixWidths: number[],
  availableWidth: number,
  initialUsedWidth: number,
): number {
  let usedWidth = initialUsedWidth;
  let visibleTail = 0;

  for (let index = prefixWidths.length - 1; index >= 0; index -= 1) {
    const nextWidth = prefixWidths[index] ?? 0;
    if (usedWidth + nextWidth > availableWidth) break;
    usedWidth += nextWidth;
    visibleTail += 1;
  }

  return visibleTail;
}

export function calculateBreadcrumbLayout(
  measurement: BreadcrumbMeasurement,
): CollapsedBreadcrumbLayout | null {
  const availableWidth = Math.max(
    0,
    measurement.containerWidth - measurement.renderedFileWidth - measurement.trailingReserveWidth,
  );
  const totalPrefixWidth = measurement.prefixWidths.reduce((sum, width) => sum + width, 0);
  if (totalPrefixWidth <= availableWidth) return null;

  const showEllipsis = measurement.ellipsisWidth <= availableWidth;
  const initialUsedWidth = showEllipsis ? measurement.ellipsisWidth : 0;
  return {
    visibleTail: countTrailingCrumbsThatFit(
      measurement.prefixWidths,
      availableWidth,
      initialUsedWidth,
    ),
    showEllipsis,
  };
}
