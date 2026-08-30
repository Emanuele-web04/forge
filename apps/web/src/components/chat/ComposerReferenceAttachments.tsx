// FILE: ComposerReferenceAttachments.tsx
// Purpose: Render assistant-selection, file-comment, pasted-text, file, and image
//   composer attachments in one reusable row.
// Layer: Chat composer presentation

import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { type BrowserAnnotationDraft } from "../../lib/browserAnnotations";
import { type PastedTextDraft } from "../../lib/composerPastedText";
import { workItemKey, type WorkItemDraft } from "../../lib/composerWorkItems";
import { type FileCommentDraft } from "../../lib/fileComments";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { ComposerPastedTextCard } from "./PastedTextChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";
import { BrowserAnnotationStrip } from "./BrowserAnnotationStrip";
import { WorkItemAttachmentChip } from "./WorkItemAttachmentChip";

interface ComposerReferenceAttachmentsProps {
  assistantSelections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  browserAnnotations?: ReadonlyArray<BrowserAnnotationDraft>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  pastedTexts?: ReadonlyArray<PastedTextDraft>;
  workItems?: ReadonlyArray<WorkItemDraft>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedImageIdSet: ReadonlySet<string>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveAssistantSelections: () => void;
  onRemoveBrowserAnnotation?: (annotationId: string) => void;
  onRemoveFileComments: () => void;
  onRemovePastedText?: (pastedTextId: string) => void;
  onShowPastedTextInField?: (pastedTextId: string) => void;
  onRemoveWorkItem?: (itemKey: string) => void;
  onRemoveFile: (fileId: string) => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerReferenceAttachments({
  assistantSelections,
  browserAnnotations = [],
  fileComments,
  pastedTexts: pastedTextsProp,
  workItems: workItemsProp,
  files,
  images,
  nonPersistedImageIdSet,
  onExpandImage,
  onRemoveAssistantSelections,
  onRemoveBrowserAnnotation,
  onRemoveFileComments,
  onRemovePastedText,
  onShowPastedTextInField,
  onRemoveWorkItem,
  onRemoveFile,
  onRemoveImage,
}: ComposerReferenceAttachmentsProps) {
  const pastedTexts = pastedTextsProp ?? [];
  const workItems = workItemsProp ?? [];
  if (
    assistantSelections.length === 0 &&
    browserAnnotations.length === 0 &&
    fileComments.length === 0 &&
    pastedTexts.length === 0 &&
    workItems.length === 0 &&
    files.length === 0 &&
    images.length === 0
  ) {
    return null;
  }

  return (
    <div className="-mx-1.5 -mt-1 mb-2 flex flex-wrap items-start gap-1.5">
      <AssistantSelectionsSummaryChip
        selections={assistantSelections}
        onRemove={assistantSelections.length > 0 ? onRemoveAssistantSelections : undefined}
      />
      <BrowserAnnotationStrip
        annotations={browserAnnotations}
        onRemove={onRemoveBrowserAnnotation}
      />
      <FileCommentsSummaryChip
        comments={fileComments}
        onRemove={fileComments.length > 0 ? onRemoveFileComments : undefined}
      />
      {pastedTexts.map((pasted) => (
        <ComposerPastedTextCard
          key={pasted.id}
          text={pasted.text}
          metrics={{ lineCount: pasted.lineCount, charCount: pasted.charCount }}
          onShowInTextField={() => onShowPastedTextInField?.(pasted.id)}
          onRemove={() => onRemovePastedText?.(pasted.id)}
        />
      ))}
      {workItems.map((item) => (
        <WorkItemAttachmentChip
          key={workItemKey(item)}
          item={item}
          onRemove={onRemoveWorkItem ? () => onRemoveWorkItem(workItemKey(item)) : undefined}
        />
      ))}
      {files.map((file) => (
        <FileAttachmentChip key={file.id} file={file} variant="card" onRemove={onRemoveFile} />
      ))}
      {images.map((image) => (
        <ComposerImageAttachmentChip
          key={image.id}
          image={image}
          images={images}
          nonPersisted={nonPersistedImageIdSet.has(image.id)}
          onExpandImage={onExpandImage}
          onRemoveImage={onRemoveImage}
        />
      ))}
    </div>
  );
}
