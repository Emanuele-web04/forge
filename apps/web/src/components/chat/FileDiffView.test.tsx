import type { DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fileDiffCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: (props: Record<string, unknown>) => {
    fileDiffCalls.push(props);
    return <div data-testid="file-diff" />;
  },
  Virtualizer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { FileDiffCard } from "./FileDiffView";

const fileDiff = {
  name: "b/src/example.ts",
  type: "change",
  hunks: [],
  splitLineCount: 0,
  unifiedLineCount: 0,
  isPartial: true,
  deletionLines: [],
  additionLines: [],
} as unknown as FileDiffMetadata;

describe("FileDiffCard line comments", () => {
  beforeEach(() => {
    fileDiffCalls.length = 0;
  });

  it("keeps line comment features disabled when their props are omitted", () => {
    renderToStaticMarkup(<FileDiffCard fileDiff={fileDiff} theme="dark" />);

    const call = fileDiffCalls[0];
    expect(call?.lineAnnotations).toBeUndefined();
    expect(call?.renderAnnotation).toBeUndefined();
    expect(call?.options).not.toHaveProperty("enableGutterUtility");
    expect(call?.options).not.toHaveProperty("onGutterUtilityClick");
  });

  it.each([
    ["deletions", "LEFT"],
    ["additions", "RIGHT"],
    [undefined, "RIGHT"],
  ] as const)("maps a %s gutter line to the %s review side", (side, expectedSide) => {
    const onStartLineComment = vi.fn();
    const annotations: ReadonlyArray<DiffLineAnnotation<{ id: string }>> = [
      { lineNumber: 12, side: "additions", metadata: { id: "note-1" } },
    ];
    const renderAnnotation = vi.fn(() => null);

    renderToStaticMarkup(
      <FileDiffCard
        fileDiff={fileDiff}
        theme="light"
        lineAnnotations={annotations}
        renderAnnotation={renderAnnotation}
        onStartLineComment={onStartLineComment}
      />,
    );

    const call = fileDiffCalls[0];
    if (!call) {
      throw new Error("Expected FileDiff to render");
    }
    expect(call?.lineAnnotations).toEqual(annotations);
    expect(call?.lineAnnotations).not.toBe(annotations);
    expect(call?.renderAnnotation).not.toBe(renderAnnotation);
    expect(call?.options).toHaveProperty("enableGutterUtility", true);

    const pierreRenderAnnotation = call.renderAnnotation as (
      annotation: DiffLineAnnotation<{ id: string }>,
    ) => React.ReactNode;
    pierreRenderAnnotation(annotations[0]!);
    expect(renderAnnotation).toHaveBeenCalledWith({ id: "note-1" });

    const onGutterUtilityClick = (
      call.options as { onGutterUtilityClick: (range: SelectedLineRange) => void }
    ).onGutterUtilityClick;
    onGutterUtilityClick({ start: 12, end: 12, ...(side ? { side } : {}) });

    expect(onStartLineComment).toHaveBeenCalledWith({
      path: "src/example.ts",
      line: 12,
      side: expectedSide,
    });
  });
});
