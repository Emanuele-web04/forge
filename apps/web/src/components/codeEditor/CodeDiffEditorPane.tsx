import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo, useRef, type RefObject } from "react";

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
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        {
          name: props.fileName,
          contents: originalRef.current,
          cacheKey: `diff-edit:${props.fileName}:old:${props.originalVersion}`,
        },
        {
          name: props.fileName,
          contents: modifiedRef.current,
          cacheKey: `diff-edit:${props.fileName}:new:${props.modifiedVersion}`,
        },
      ),
    [props.fileName, props.modifiedVersion, props.originalVersion],
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
          key={props.renderSideBySide ? "split" : "unified"}
          fileDiff={fileDiff}
          options={options}
          edit={!(props.readOnly ?? false)}
          editorOptions={editorOptions}
        />
      </CodeEditBoundary>
    </div>
  );
}
