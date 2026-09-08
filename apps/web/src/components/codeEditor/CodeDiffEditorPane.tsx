import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { normalizeLineEndings } from "@synara/shared/text";
import { useMemo, useRef, useState, type RefObject } from "react";

import { buildDiffPanelUnsafeCSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { CodeEditBoundary } from "./CodeEditBoundary";
import {
  CODE_EDITOR_LOADING_FALLBACK,
  useCodeEditorSaveKeyDownHandler,
  useCodeEditorSessionOptions,
} from "./CodeEditorPane";
import type { CodeEditHistoryControls, CodeEditHistoryState } from "./pierreEdit";

export interface CodeDiffEditorPaneProps {
  original: string;
  originalVersion: number;
  modified: string;
  modifiedVersion: number;
  fileName: string;
  resolvedTheme: "light" | "dark";
  renderSideBySide: boolean;
  readOnly?: boolean;
  className?: string;
  onChange: (value: string) => void;
  onSave: () => void;
  historyControlsRef?: RefObject<CodeEditHistoryControls | null> | undefined;
  onHistoryChange?: ((history: CodeEditHistoryState) => void) | undefined;
}

export function CodeDiffEditorPane(props: CodeDiffEditorPaneProps) {
  const originalRef = useRef(props.original);
  originalRef.current = props.original;
  const modifiedRef = useRef(props.modified);
  modifiedRef.current = props.modified;
  // A layout switch remounts FileDiff (below), and the remount must start from
  // the buffer as it is now, not from the snapshot parsed at the last load or
  // reload. Bump a parse generation whenever the layout changes so the memo
  // re-reads the current contents for the new instance.
  const layout = props.renderSideBySide ? "split" : "unified";
  const [parseGeneration, setParseGeneration] = useState({ layout, version: 0 });
  if (parseGeneration.layout !== layout) {
    setParseGeneration({ layout, version: parseGeneration.version + 1 });
  }
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        {
          name: props.fileName,
          contents: normalizeLineEndings(originalRef.current),
          cacheKey: `diff-edit:${props.fileName}:old:${props.originalVersion}:${parseGeneration.version}`,
        },
        {
          name: props.fileName,
          contents: normalizeLineEndings(modifiedRef.current),
          cacheKey: `diff-edit:${props.fileName}:new:${props.modifiedVersion}:${parseGeneration.version}`,
        },
      ),
    [props.fileName, props.modifiedVersion, props.originalVersion, parseGeneration.version],
  );
  const editorOptions = useCodeEditorSessionOptions({
    onChange: props.onChange,
    onHistoryChange: props.onHistoryChange,
    historyControlsRef: props.historyControlsRef,
  });
  const options = useMemo(
    () => ({
      theme: resolveDiffThemeName(props.resolvedTheme),
      themeType: props.resolvedTheme,
      unsafeCSS: buildDiffPanelUnsafeCSS(props.resolvedTheme),
      diffStyle: props.renderSideBySide ? ("split" as const) : ("unified" as const),
      lineDiffType: "word" as const,
      disableFileHeader: true,
      overflow: "scroll" as const,
    }),
    [props.renderSideBySide, props.resolvedTheme],
  );
  const saveKeyDownHandler = useCodeEditorSaveKeyDownHandler(props.onSave);

  return (
    <div
      className={cn("min-h-0 min-w-0 flex-1 overflow-auto", props.className)}
      onKeyDownCapture={saveKeyDownHandler}
    >
      <CodeEditBoundary fallback={CODE_EDITOR_LOADING_FALLBACK}>
        {/* diffStyle is effectively mount-time config on FileDiff, so a layout
            switch must remount the instance (same treatment as the diff panel). */}
        <FileDiff
          key={layout}
          fileDiff={fileDiff}
          options={options}
          edit={!(props.readOnly ?? false)}
          editorOptions={editorOptions}
        />
      </CodeEditBoundary>
    </div>
  );
}
