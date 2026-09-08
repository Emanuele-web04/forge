import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "./MessageCopyButton";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

/** Full provider-readable text; only the collapsed label is a preview. */
export function ReasoningContent(props: {
  text: string;
  cwd: string | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
}) {
  return (
    <div className="min-w-0" data-reasoning-content="true">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Provider thinking text · length differs from thinking token usage</span>
        <MessageCopyButton text={props.text} label="Copy full thinking" />
      </div>
      <div className="max-h-96 overflow-y-auto overscroll-contain pr-2 [scrollbar-gutter:stable]">
        <ChatMarkdown
          text={props.text}
          cwd={props.cwd}
          isStreaming={false}
          onImageExpand={props.onImageExpand}
        />
      </div>
    </div>
  );
}
