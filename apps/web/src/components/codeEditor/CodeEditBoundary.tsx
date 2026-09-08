import { EditProvider, type CreateEditor } from "@pierre/diffs/react";
import { useEffect, useState, type ReactNode } from "react";

import { PanelStateMessage } from "../chat/PanelStateMessage";
import { loadPierreEdit, resetPierreEditLoad } from "./pierreEdit";

export function CodeEditBoundary(props: { children: ReactNode }) {
  const [createEditor, setCreateEditor] = useState<CreateEditor<undefined> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    void loadPierreEdit().then(
      (module) => {
        if (active) {
          setCreateEditor(() => (options: Parameters<CreateEditor<undefined>>[0]) => {
            return new module.Editor(options);
          });
        }
      },
      () => {
        if (active) {
          resetPierreEditLoad();
          setLoadFailed(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  if (loadFailed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-[12px] text-muted-foreground">Could not load the editor.</p>
        <button
          type="button"
          className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-[var(--color-background-elevated-secondary)]"
          onClick={() => setAttempt((previous) => previous + 1)}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!createEditor) {
    return (
      <PanelStateMessage density="compact" fill="flex">
        <p>Loading editor...</p>
      </PanelStateMessage>
    );
  }
  return <EditProvider createEditor={createEditor}>{props.children}</EditProvider>;
}
