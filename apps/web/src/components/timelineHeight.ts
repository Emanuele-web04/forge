// FILE: timelineHeight.ts
// Purpose: Estimates chat row heights before ResizeObserver measurements arrive.
// Layer: Web chat virtualization utility
// Exports: message/work height estimators used by MessagesTimeline and browser tests

import type { MessageId } from "@synara/contracts";

import type { TurnDiffFileChange } from "../types";
import { DEFAULT_CHAT_FONT_SIZE_PX, normalizeChatFontSizePx } from "../appSettings";
import { deriveDisplayedUserMessageState } from "../lib/terminalContext";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";
import { resolveCollapsedUserMessageLineEstimate } from "./chat/userMessageCollapse";
import { hasLeadingUserMedia, resolveUserTurnMarker } from "./chat/userTurnMarker";
import {
  getChatTranscriptAssistantCharWidthPx,
  getChatTranscriptLineHeightPx,
  getChatTranscriptUserCharWidthPx,
  getChatTranscriptUserMessageLineHeightPx,
} from "./chat/chatTypography";

const ASSISTANT_CHARS_PER_LINE_FALLBACK = 72;
const USER_CHARS_PER_LINE_FALLBACK = 56;
const ASSISTANT_BASE_HEIGHT_PX = 78;
const USER_BASE_HEIGHT_PX = 97;
const USER_ATTACHMENT_THUMBNAIL_SIZE_PX = 60;
const USER_ATTACHMENT_THUMBNAIL_GAP_PX = 8;
const USER_ATTACHMENT_THUMBNAILS_PER_ROW = 4;
const USER_ATTACHMENT_ROW_MARGIN_BOTTOM_PX = 4;
const USER_PASTED_TEXT_CARD_HEIGHT_PX = 52;
const USER_PASTED_TEXT_CARD_GAP_PX = 6;
const USER_MESSAGE_TOGGLE_HEIGHT_PX = 20;
const USER_DISPATCH_CHIP_HEIGHT_PX = 24;
const USER_DISPATCH_CHIP_MARGIN_BOTTOM_PX = 6;
const USER_DISPATCH_CHIP_WITH_MEDIA_MARGIN_BOTTOM_PX = 12;
const USER_BUBBLE_WIDTH_RATIO = 0.8;
const USER_BUBBLE_HORIZONTAL_PADDING_PX = 32;
const ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX = 8;
const MIN_USER_CHARS_PER_LINE = 4;
const MIN_ASSISTANT_CHARS_PER_LINE = 20;
const ASSISTANT_INLINE_CODE_WIDTH_MULTIPLIER = 1.2;
const ASSISTANT_INLINE_CODE_WRAP_OVERHEAD_CHARS = 2;
const INLINE_CODE_SPAN_REGEX = /`([^`\n]+)`/g;
const TURN_DIFF_SUMMARY_CHROME_HEIGHT_PX = 76;
const TURN_DIFF_FILE_ROW_HEIGHT_PX = 36;
const TURN_DIFF_FILE_LIST_TOGGLE_HEIGHT_PX = 34;
const TURN_DIFF_MAX_VISIBLE_FILES = 5;
const WORK_GROUP_CHROME_HEIGHT_PX = 24;
const WORK_GROUP_HEADER_HEIGHT_PX = 20;
const WORK_ENTRY_ROW_HEIGHT_PX = 30;
const WORK_ENTRY_CHANGED_FILES_HEIGHT_PX = 24;
const WORK_ENTRY_GAP_PX = 2;
const INLINE_TOOL_PREVIEW_MARGIN_TOP_PX = 10;
const INLINE_TOOL_PREVIEW_ROW_HEIGHT_PX = 22;
const INLINE_TOOL_PREVIEW_ROW_GAP_PX = 1;
const INLINE_TOOL_PREVIEW_TOGGLE_MARGIN_TOP_PX = 4;
const INLINE_TOOL_PREVIEW_TOGGLE_HEIGHT_PX = 18;
const INLINE_TOOL_PREVIEW_CONTAINER_CHROME_HEIGHT_PX = 0;
const changedFilesSummaryHeightCache = new WeakMap<
  ReadonlyArray<TurnDiffFileChange>,
  { collapsed?: number; expanded?: number }
>();

interface TimelineMessageHeightInput {
  id?: MessageId;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ReadonlyArray<{ id: string; type?: "image" | "file" | "assistant-selection" }>;
  dispatchMode?: "queue" | "steer";
  dispatchOrigin?: "user" | "automation" | "agent";
  diffSummaryFiles?: ReadonlyArray<TurnDiffFileChange>;
  diffSummaryFileListExpanded?: boolean;
  inlineToolEntries?: ReadonlyArray<TimelineWorkEntryHeightInput>;
  inlineToolExpanded?: boolean;
}

interface TimelineHeightEstimateLayout {
  timelineWidthPx: number | null;
  chatFontSizePx?: number;
}

interface TimelineWorkEntryHeightInput {
  tone: "thinking" | "tool" | "info" | "error";
  command?: string | null;
  detail?: string | null;
  changedFiles?: ReadonlyArray<string>;
}

interface TimelineWorkGroupEstimateOptions {
  expanded: boolean;
  maxVisibleEntries: number;
}

function estimateWrappedLineCount(text: string, charsPerLine: number): number {
  if (text.length === 0) return 1;

  // Avoid allocating via split for long logs; iterate once and count wrapped lines.
  let lines = 0;
  let currentLineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
      currentLineLength = 0;
      continue;
    }
    currentLineLength += 1;
  }

  lines += Math.max(1, Math.ceil(currentLineLength / charsPerLine));
  return lines;
}

function isFinitePositiveNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function estimateCharsPerLineForUser(
  timelineWidthPx: number | null,
  chatFontSizePx: number,
): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) return USER_CHARS_PER_LINE_FALLBACK;
  const bubbleWidthPx = timelineWidthPx * USER_BUBBLE_WIDTH_RATIO;
  const textWidthPx = Math.max(bubbleWidthPx - USER_BUBBLE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(
    MIN_USER_CHARS_PER_LINE,
    Math.floor(textWidthPx / getChatTranscriptUserCharWidthPx(chatFontSizePx)),
  );
}

function estimateCharsPerLineForAssistant(
  timelineWidthPx: number | null,
  chatFontSizePx: number,
): number {
  if (!isFinitePositiveNumber(timelineWidthPx)) return ASSISTANT_CHARS_PER_LINE_FALLBACK;
  const textWidthPx = Math.max(timelineWidthPx - ASSISTANT_MESSAGE_HORIZONTAL_PADDING_PX, 0);
  return Math.max(
    MIN_ASSISTANT_CHARS_PER_LINE,
    Math.floor(textWidthPx / getChatTranscriptAssistantCharWidthPx(chatFontSizePx)),
  );
}

export function estimateChangedFilesSummaryHeight(
  files: ReadonlyArray<TurnDiffFileChange>,
  fileListExpanded = false,
): number {
  if (files.length === 0) return 0;

  const cacheKey = fileListExpanded ? "expanded" : "collapsed";
  const cachedHeights = changedFilesSummaryHeightCache.get(files);
  const cachedHeight = cachedHeights?.[cacheKey];
  if (typeof cachedHeight === "number") {
    return cachedHeight;
  }

  // The changed-files card renders a flat list with a five-file collapsed cap.
  const visibleRowCount = fileListExpanded
    ? files.length
    : Math.min(files.length, TURN_DIFF_MAX_VISIBLE_FILES);
  const toggleHeight =
    !fileListExpanded && files.length > TURN_DIFF_MAX_VISIBLE_FILES
      ? TURN_DIFF_FILE_LIST_TOGGLE_HEIGHT_PX
      : 0;

  const height =
    TURN_DIFF_SUMMARY_CHROME_HEIGHT_PX +
    visibleRowCount * TURN_DIFF_FILE_ROW_HEIGHT_PX +
    toggleHeight;
  changedFilesSummaryHeightCache.set(files, {
    ...cachedHeights,
    [cacheKey]: height,
  });

  return height;
}

function estimateTimelineWorkEntryHeight(entry: TimelineWorkEntryHeightInput): number {
  const hasChangedFiles = (entry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !entry.command && !entry.detail;

  return (
    WORK_ENTRY_ROW_HEIGHT_PX +
    (hasChangedFiles && !previewIsChangedFiles ? WORK_ENTRY_CHANGED_FILES_HEIGHT_PX : 0)
  );
}

// Bias work-log estimates upward so fast scrolls do not stack rows before they are measured.
export function estimateTimelineWorkGroupHeight(
  entries: ReadonlyArray<TimelineWorkEntryHeightInput>,
  options: TimelineWorkGroupEstimateOptions,
): number {
  if (entries.length === 0) return WORK_GROUP_CHROME_HEIGHT_PX;

  const visibleEntries =
    options.expanded || entries.length <= options.maxVisibleEntries
      ? entries
      : entries.slice(-options.maxVisibleEntries);
  const showHeader =
    entries.length > options.maxVisibleEntries ||
    visibleEntries.some((entry) => entry.tone !== "tool");

  return (
    WORK_GROUP_CHROME_HEIGHT_PX +
    (showHeader ? WORK_GROUP_HEADER_HEIGHT_PX : 0) +
    visibleEntries.reduce((total, entry) => total + estimateTimelineWorkEntryHeight(entry), 0) +
    Math.max(visibleEntries.length - 1, 0) * WORK_ENTRY_GAP_PX
  );
}

// Estimate the inline tool preview block that can appear under assistant messages.
export function estimateTimelineInlineToolPreviewHeight(
  entries: ReadonlyArray<TimelineWorkEntryHeightInput>,
  options: TimelineWorkGroupEstimateOptions,
): number {
  if (entries.length === 0) return 0;

  const visibleEntries =
    options.expanded || entries.length <= options.maxVisibleEntries
      ? entries
      : entries.slice(0, options.maxVisibleEntries);
  const hasToggle = entries.length > options.maxVisibleEntries;

  return (
    INLINE_TOOL_PREVIEW_MARGIN_TOP_PX +
    INLINE_TOOL_PREVIEW_CONTAINER_CHROME_HEIGHT_PX +
    visibleEntries.length * INLINE_TOOL_PREVIEW_ROW_HEIGHT_PX +
    Math.max(visibleEntries.length - 1, 0) * INLINE_TOOL_PREVIEW_ROW_GAP_PX +
    (hasToggle
      ? INLINE_TOOL_PREVIEW_TOGGLE_MARGIN_TOP_PX + INLINE_TOOL_PREVIEW_TOGGLE_HEIGHT_PX
      : 0)
  );
}

function expandAssistantInlineCodeForEstimate(text: string): string {
  return text.replace(INLINE_CODE_SPAN_REGEX, (_match, code: string) =>
    "x".repeat(
      Math.max(
        code.length + 2,
        Math.ceil(
          code.length * ASSISTANT_INLINE_CODE_WIDTH_MULTIPLIER +
            ASSISTANT_INLINE_CODE_WRAP_OVERHEAD_CHARS,
        ),
      ),
    ),
  );
}

export function estimateTimelineMessageHeight(
  message: TimelineMessageHeightInput,
  layout: TimelineHeightEstimateLayout = { timelineWidthPx: null },
): number {
  const chatFontSizePx = normalizeChatFontSizePx(
    layout.chatFontSizePx ?? DEFAULT_CHAT_FONT_SIZE_PX,
  );
  const lineHeightPx = getChatTranscriptLineHeightPx(chatFontSizePx);

  if (message.role === "assistant") {
    const charsPerLine = estimateCharsPerLineForAssistant(layout.timelineWidthPx, chatFontSizePx);
    const estimatedLines = estimateWrappedLineCount(
      expandAssistantInlineCodeForEstimate(message.text),
      charsPerLine,
    );
    const changedFilesHeight = estimateChangedFilesSummaryHeight(
      message.diffSummaryFiles ?? [],
      message.diffSummaryFileListExpanded ?? false,
    );
    const inlineToolPreviewHeight = estimateTimelineInlineToolPreviewHeight(
      message.inlineToolEntries ?? [],
      {
        expanded: message.inlineToolExpanded ?? false,
        maxVisibleEntries: 4,
      },
    );
    return (
      ASSISTANT_BASE_HEIGHT_PX +
      estimatedLines * lineHeightPx +
      changedFilesHeight +
      inlineToolPreviewHeight
    );
  }

  if (message.role === "user") {
    const charsPerLine = estimateCharsPerLineForUser(layout.timelineWidthPx, chatFontSizePx);
    const lineHeightPx = getChatTranscriptUserMessageLineHeightPx(chatFontSizePx);
    const displayedUserMessage = deriveDisplayedUserMessageState(message.text, {
      hideImageOnlyBootstrapPrompt: (message.attachments?.length ?? 0) > 0,
      messageId: message.id,
    });
    const renderedText =
      displayedUserMessage.contexts.length > 0
        ? [
            buildInlineTerminalContextText(displayedUserMessage.contexts),
            displayedUserMessage.visibleText,
          ]
            .filter((part) => part.length > 0)
            .join(" ")
        : displayedUserMessage.visibleText;
    const fullEstimatedLines =
      renderedText.length > 0 ? estimateWrappedLineCount(renderedText, charsPerLine) : 0;
    const userMessageEstimate = resolveCollapsedUserMessageLineEstimate(fullEstimatedLines);
    const imageAttachmentCount =
      message.attachments?.filter((attachment) => attachment.type === "image").length ?? 0;
    const assistantSelectionCount =
      message.attachments?.filter((attachment) => attachment.type === "assistant-selection")
        .length ?? 0;
    const fileAttachmentCount =
      message.attachments?.filter((attachment) => attachment.type === "file").length ?? 0;
    // Prompt-serialized reference cards are not wire attachments, so count them
    // from the parsed display state to keep virtualization estimates aligned.
    const fileCommentCount = displayedUserMessage.fileComments.length;
    const pastedTextCount = displayedUserMessage.pastedTexts.length;
    const browserAnnotationCount = displayedUserMessage.browserAnnotations.length;
    const workItemCount = displayedUserMessage.workItems.length;
    const imageAttachmentHeight =
      imageAttachmentCount > 0
        ? Math.ceil(imageAttachmentCount / USER_ATTACHMENT_THUMBNAILS_PER_ROW) *
            USER_ATTACHMENT_THUMBNAIL_SIZE_PX +
          Math.max(Math.ceil(imageAttachmentCount / USER_ATTACHMENT_THUMBNAILS_PER_ROW) - 1, 0) *
            USER_ATTACHMENT_THUMBNAIL_GAP_PX
        : 0;
    const assistantSelectionHeight = assistantSelectionCount > 0 ? 40 : 0;
    const fileAttachmentHeight = fileAttachmentCount > 0 ? 40 : 0;
    const fileCommentHeight = fileCommentCount > 0 ? 40 : 0;
    const pastedTextHeight =
      pastedTextCount > 0
        ? pastedTextCount * USER_PASTED_TEXT_CARD_HEIGHT_PX +
          Math.max(pastedTextCount - 1, 0) * USER_PASTED_TEXT_CARD_GAP_PX
        : 0;
    // Browser annotations always render as one compact strip: two pills plus a
    // popover trigger for any overflow. The hidden list is portalled and does
    // not change the virtualized transcript row's measured height.
    const browserAnnotationHeight = browserAnnotationCount > 0 ? 40 : 0;
    const workItemHeight = workItemCount > 0 ? 40 : 0;
    const attachmentHeight =
      imageAttachmentHeight +
        assistantSelectionHeight +
        fileAttachmentHeight +
        fileCommentHeight +
        pastedTextHeight +
        browserAnnotationHeight +
        workItemHeight >
      0
        ? imageAttachmentHeight +
          assistantSelectionHeight +
          fileAttachmentHeight +
          fileCommentHeight +
          pastedTextHeight +
          browserAnnotationHeight +
          workItemHeight +
          (renderedText.length > 0 ? USER_ATTACHMENT_ROW_MARGIN_BOTTOM_PX : 0)
        : 0;
    const dispatchChipHeight =
      resolveUserTurnMarker(message) !== null
        ? USER_DISPATCH_CHIP_HEIGHT_PX +
          (hasLeadingUserMedia({
            imageCount: imageAttachmentCount,
            fileCount: fileAttachmentCount,
            assistantSelectionCount,
            browserAnnotationCount,
            fileCommentCount,
            pastedTextCount,
            workItemCount,
          })
            ? USER_DISPATCH_CHIP_WITH_MEDIA_MARGIN_BOTTOM_PX
            : USER_DISPATCH_CHIP_MARGIN_BOTTOM_PX)
        : 0;
    const toggleHeight = userMessageEstimate.collapsible ? USER_MESSAGE_TOGGLE_HEIGHT_PX : 0;
    return (
      USER_BASE_HEIGHT_PX +
      userMessageEstimate.renderedLines * lineHeightPx +
      attachmentHeight +
      dispatchChipHeight +
      toggleHeight
    );
  }

  // `system` messages are not rendered in the chat timeline, but keep a stable
  // explicit branch in case they are present in timeline data.
  const charsPerLine = estimateCharsPerLineForAssistant(layout.timelineWidthPx, chatFontSizePx);
  const estimatedLines = estimateWrappedLineCount(
    expandAssistantInlineCodeForEstimate(message.text),
    charsPerLine,
  );
  return ASSISTANT_BASE_HEIGHT_PX + estimatedLines * lineHeightPx;
}
