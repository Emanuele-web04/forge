// FILE: chatSelectionActions.ts
// Purpose: Helpers for reading assistant text selections from the transcript without re-render churn.
// Layer: Chat transcript interaction helpers

export interface TranscriptAssistantSelection {
  assistantMessageId: string;
  text: string;
}

export interface TranscriptSelectionActionLayout {
  left: number;
  top: number;
  placement: "top" | "bottom";
}

const TRANSCRIPT_SELECTION_ACTION_WIDTH_PX = 292;
const TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX = 32;
const TRANSCRIPT_SELECTION_ACTION_GAP_PX = 8;
const NON_BREAKING_SPACE_PATTERN = /\u00a0/g;
const WHITESPACE_PATTERN = /\s/;
const INLINE_MARKDOWN_DELIMITER_CHARS = new Set(["*", "_", "`", "~"]);

interface NormalizedSourceText {
  text: string;
  rawStarts: number[];
  rawEnds: number[];
}

function normalizeSelectionText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(NON_BREAKING_SPACE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Browser selections read rendered text, while marker offsets must point back into raw markdown.
function buildNormalizedSourceText(
  value: string,
  options: { ignoreInlineMarkdownDelimiters?: boolean | undefined } = {},
): NormalizedSourceText {
  const text: string[] = [];
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  let pendingSpaceStart: number | null = null;
  let pendingSpaceEnd = 0;

  const pushPendingSpace = () => {
    if (pendingSpaceStart === null) {
      return;
    }
    text.push(" ");
    rawStarts.push(pendingSpaceStart);
    rawEnds.push(pendingSpaceEnd);
    pendingSpaceStart = null;
    pendingSpaceEnd = 0;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (options.ignoreInlineMarkdownDelimiters && INLINE_MARKDOWN_DELIMITER_CHARS.has(char)) {
      continue;
    }
    if (char === "\u00a0" || WHITESPACE_PATTERN.test(char)) {
      pendingSpaceStart ??= index;
      pendingSpaceEnd = index + 1;
      continue;
    }
    pushPendingSpace();
    text.push(char);
    rawStarts.push(index);
    rawEnds.push(index + 1);
  }
  pushPendingSpace();

  return { text: text.join(""), rawStarts, rawEnds };
}

export function resolveTranscriptMarkerRange(input: {
  messageText: string;
  selectedText: string;
}): { startOffset: number; endOffset: number } | null {
  const selectedText = input.selectedText.trim();
  if (selectedText.length === 0) {
    return null;
  }
  const firstIndex = input.messageText.indexOf(selectedText);
  if (
    firstIndex >= 0 &&
    input.messageText.indexOf(selectedText, firstIndex + selectedText.length) < 0
  ) {
    return {
      startOffset: firstIndex,
      endOffset: firstIndex + selectedText.length,
    };
  }
  return (
    resolveNormalizedTranscriptMarkerRange(input) ??
    resolveNormalizedTranscriptMarkerRange({
      ...input,
      ignoreInlineMarkdownDelimiters: true,
    })
  );
}

function resolveNormalizedTranscriptMarkerRange(input: {
  messageText: string;
  selectedText: string;
  ignoreInlineMarkdownDelimiters?: boolean;
}): { startOffset: number; endOffset: number } | null {
  const selectedText = normalizeSelectionText(input.selectedText);
  if (selectedText.length === 0) {
    return null;
  }

  const source = buildNormalizedSourceText(input.messageText, {
    ignoreInlineMarkdownDelimiters: input.ignoreInlineMarkdownDelimiters,
  });
  const firstIndex = source.text.indexOf(selectedText);
  if (firstIndex < 0) {
    return null;
  }
  if (source.text.indexOf(selectedText, firstIndex + selectedText.length) >= 0) {
    return null;
  }

  const lastIndex = firstIndex + selectedText.length - 1;
  const startOffset = source.rawStarts[firstIndex];
  const endOffset = source.rawEnds[lastIndex];
  return startOffset === undefined || endOffset === undefined ? null : { startOffset, endOffset };
}

function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }
  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

// Rect of the active window selection, for positioning floating selection actions.
export function getActiveSelectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection) {
    return null;
  }
  return getSelectionRect(selection);
}

// `closest()` that escapes open shadow roots (e.g. the @pierre/diffs custom
// element) by hopping from a shadow root to its host element.
export function closestThroughShadow(start: Node | null, selector: string): HTMLElement | null {
  let node: Node | null = start;
  while (node) {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const match = element?.closest<HTMLElement>(selector) ?? null;
    if (match) {
      return match;
    }
    const root = (element ?? node).getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function selectionContainerForNode(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-assistant-message-id]") ?? null;
}

export function readTranscriptAssistantSelection(input: {
  container: HTMLElement | null;
}): { selection: TranscriptAssistantSelection; selectionRect: DOMRect | null } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const anchorContainer = selectionContainerForNode(selection.anchorNode);
  const focusContainer = selectionContainerForNode(selection.focusNode);
  if (!anchorContainer || !focusContainer || anchorContainer !== focusContainer) {
    return null;
  }
  const { container } = input;
  if (!container || !container.contains(anchorContainer)) {
    return null;
  }

  const assistantMessageId = anchorContainer.dataset.assistantMessageId?.trim() ?? "";
  const text = selection
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
  if (assistantMessageId.length === 0 || text.length === 0) {
    return null;
  }

  return {
    selection: {
      assistantMessageId,
      text,
    },
    selectionRect: getSelectionRect(selection),
  };
}

export function resolveTranscriptSelectionActionLayout(input: {
  selectionRect: DOMRect | null;
  pointer: { x: number; y: number };
  viewport?: { width: number; height: number } | null;
  size?: { width: number; height: number } | null;
}): TranscriptSelectionActionLayout {
  const surfaceWidth = input.size?.width ?? TRANSCRIPT_SELECTION_ACTION_WIDTH_PX;
  const surfaceHeight = input.size?.height ?? TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX;
  const viewportWidth =
    input.viewport?.width ??
    (typeof window === "undefined" ? input.pointer.x + 8 : window.innerWidth);
  const viewportHeight =
    input.viewport?.height ??
    (typeof window === "undefined" ? input.pointer.y + 8 : window.innerHeight);

  const anchorCenterX =
    input.selectionRect !== null
      ? input.selectionRect.left + input.selectionRect.width / 2
      : input.pointer.x;
  const selectionTop = input.selectionRect?.top ?? input.pointer.y;
  const selectionBottom = input.selectionRect?.bottom ?? input.pointer.y;
  const availableAbove = selectionTop;
  const availableBelow = viewportHeight - selectionBottom;
  const placement =
    availableAbove >= surfaceHeight + TRANSCRIPT_SELECTION_ACTION_GAP_PX ||
    availableAbove >= availableBelow
      ? "top"
      : "bottom";
  const unclampedTop =
    placement === "top"
      ? selectionTop - surfaceHeight - TRANSCRIPT_SELECTION_ACTION_GAP_PX
      : selectionBottom + TRANSCRIPT_SELECTION_ACTION_GAP_PX;

  return {
    left: Math.max(
      8,
      Math.min(
        Math.round(anchorCenterX - surfaceWidth / 2),
        Math.max(viewportWidth - surfaceWidth - 8, 8),
      ),
    ),
    top: Math.max(
      8,
      Math.min(Math.round(unclampedTop), Math.max(viewportHeight - surfaceHeight - 8, 8)),
    ),
    placement,
  };
}
