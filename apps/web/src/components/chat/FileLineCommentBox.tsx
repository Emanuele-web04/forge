// FILE: FileLineCommentBox.tsx
// Purpose: Inline "Local comment" editor anchored under a file line in the
//          read-only preview. Mirrors Codex's per-line comment box: a Synara
//          badge header, the target line label, a borderless request field, and
//          Cancel/Comment actions (Comment stays disabled until non-empty text).
// Layer: Chat file-preview interaction UI

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { FILE_COMMENT_TEXT_MAX_CHARS, normalizeFileCommentText } from "~/lib/fileComments";
import { SynaraLogo } from "../SynaraLogo";
import { Button } from "../ui/button";

interface FileLineCommentBoxProps {
  // Pre-formatted target label, e.g. "line 12" or "lines 3-5".
  lineLabel: string;
  top: number;
  left: number;
  width: number;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}

export function FileLineCommentBox(props: FileLineCommentBoxProps) {
  const { onCancel, onSubmit } = props;
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the field as soon as the box opens so the user can type immediately.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const normalized = normalizeFileCommentText(value);
  const canSubmit = normalized.length > 0 && normalized.length <= FILE_COMMENT_TEXT_MAX_CHARS;

  const submit = () => {
    const text = normalizeFileCommentText(value);
    if (text.length === 0 || text.length > FILE_COMMENT_TEXT_MAX_CHARS) {
      return;
    }
    onSubmit(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    // Cmd/Ctrl+Enter commits; a bare Enter inserts a newline so multi-line
    // requests stay possible.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="editor-file-viewer__comment-box"
      style={{ top: props.top, left: props.left, width: props.width }}
      // Keep clicks/selection inside the box from reaching the file surface
      // (context menu, selection toolbar, the gutter affordance).
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-[13px] font-semibold text-[var(--color-text-foreground)]">
          <span className="editor-file-viewer__comment-badge">
            <SynaraLogo className="size-3 text-[var(--color-text-foreground-secondary)]" />
          </span>
          Local comment
        </span>
        <span className="text-[12px] text-muted-foreground">Comment on {props.lineLabel}</span>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Request change"
        rows={2}
        maxLength={FILE_COMMENT_TEXT_MAX_CHARS}
        className="editor-file-viewer__comment-input"
      />
      <div className="flex items-center justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="px-3.5"
          disabled={!canSubmit}
          onClick={submit}
        >
          Comment
        </Button>
      </div>
    </div>
  );
}
