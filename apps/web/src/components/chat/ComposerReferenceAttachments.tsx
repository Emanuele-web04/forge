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
import { type FileCommentDraft } from "../../lib/fileComments";
import { type WorkItemReferenceDraft } from "../../lib/workItemReferences";
import { type ChatAssistantSelectionAttachment } from "../../types";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerImageAttachmentChip } from "./ComposerImageAttachmentChip";
import { ComposerWorkItemReferenceChip } from "./ComposerWorkItemReferenceChip";
import { FileAttachmentChip } from "./FileAttachmentChip";
import { ComposerPastedTextCard } from "./PastedTextChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";
import { BrowserAnnotationStrip } from "./BrowserAnnotationStrip";

interface ComposerReferenceAttachmentsProps {
  assistantSelections: ReadonlyArray<ChatAssistantSelectionAttachment>;
  browserAnnotations?: ReadonlyArray<BrowserAnnotationDraft>;
  fileComments: ReadonlyArray<FileCommentDraft>;
  workItemReferences?: ReadonlyArray<WorkItemReferenceDraft>;
  pastedTexts?: ReadonlyArray<PastedTextDraft>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  nonPersistedImageIdSet: ReadonlySet<string>;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onRemoveAssistantSelections: () => void;
  onRemoveBrowserAnnotation?: (annotationId: string) => void;
  onRemoveFileComments: () => void;
  onRemoveWorkItemReference?: (draftId: string) => void;
  onRemovePastedText?: (pastedTextId: string) => void;
  onShowPastedTextInField?: (pastedTextId: string) => void;
  onRemoveFile: (fileId: string) => void;
  onRemoveImage: (imageId: string) => void;
}

export function ComposerReferenceAttachments({
  assistantSelections,
  browserAnnotations = [],
  fileComments,
  workItemReferences = [],
  pastedTexts: pastedTextsProp,
  files,
  images,
  nonPersistedImageIdSet,
  onExpandImage,
  onRemoveAssistantSelections,
  onRemoveBrowserAnnotation,
  onRemoveFileComments,
  onRemoveWorkItemReference,
  onRemovePastedText,
  onShowPastedTextInField,
  onRemoveFile,
  onRemoveImage,
}: ComposerReferenceAttachmentsProps) {
  const pastedTexts = pastedTextsProp ?? [];
  if (
    assistantSelections.length === 0 &&
    browserAnnotations.length === 0 &&
    fileComments.length === 0 &&
    workItemReferences.length === 0 &&
    pastedTexts.length === 0 &&
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
      {workItemReferences.map((reference) => (
        <ComposerWorkItemReferenceChip
          key={reference.draftId}
          reference={reference}
          onRemove={
            onRemoveWorkItemReference
              ? () => onRemoveWorkItemReference(reference.draftId)
              : undefined
          }
        />
      ))}
      {pastedTexts.map((pasted) => (
        <ComposerPastedTextCard
          key={pasted.id}
          text={pasted.text}
          metrics={{ lineCount: pasted.lineCount, charCount: pasted.charCount }}
          onShowInTextField={() => onShowPastedTextInField?.(pasted.id)}
          onRemove={() => onRemovePastedText?.(pasted.id)}
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
