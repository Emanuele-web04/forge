// FILE: remarkComposerChips.ts
// Purpose: Remark plugin that rewrites composer inline tokens (skills, @-mentions,
//          agent mentions, bare link chips, and terminal selections) inside markdown
//          text nodes into custom elements, so user-message markdown renders the exact
//          same chips as the composer echo. Running inside remark (after parsing) means
//          tokens typed inside inline code or fenced blocks stay literal for free.
// Layer: Web chat presentation logic
// Exports: COMPOSER_CHIP_TAG_NAME, COMPOSER_CHIP_SEGMENT_ATTRIBUTE,
//          terminal chip constants, ComposerChipSegment,
//          createComposerChipsRemarkPlugin, parseComposerChipSegment

import type { ProviderMentionReference } from "@synara/contracts";
import {
  splitPromptIntoDisplaySegments,
  type ComposerPromptSegment,
} from "../composer-editor-mentions";

export const COMPOSER_CHIP_TAG_NAME = "composer-chip";
export const COMPOSER_CHIP_SEGMENT_ATTRIBUTE = "data-segment";
export const TERMINAL_CONTEXT_CHIP_TAG_NAME = "terminal-context-chip";
export const TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE = "data-context-index";

export interface TerminalContextChipToken {
  label: string;
  index: number;
}

export type ComposerChipSegment = Extract<
  ComposerPromptSegment,
  | { type: "skill" }
  | { type: "mention" }
  | { type: "agent-mention" }
  | { type: "link" }
  | { type: "slash-command" }
>;

const CHIP_SEGMENT_TYPES = new Set<ComposerChipSegment["type"]>([
  "skill",
  "mention",
  "agent-mention",
  "link",
  "slash-command",
]);

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

// Text inside these nodes is already a reference to something else (a markdown
// link label, an image alt, …); re-chipping it would double-decorate.
const SKIPPED_PARENT_TYPES = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

function isChipSegment(segment: ComposerPromptSegment): segment is ComposerChipSegment {
  return CHIP_SEGMENT_TYPES.has(segment.type as ComposerChipSegment["type"]);
}

function chipSegmentToNode(segment: ComposerChipSegment): MdastNode {
  return {
    type: "composerChip",
    data: {
      hName: COMPOSER_CHIP_TAG_NAME,
      // hast property `dataSegment` reaches the React component as `data-segment`.
      hProperties: { dataSegment: JSON.stringify(segment) },
    },
    children: [],
  };
}

function terminalContextTokenToNode(token: TerminalContextChipToken): MdastNode {
  return {
    type: "terminalContextChip",
    data: {
      hName: TERMINAL_CONTEXT_CHIP_TAG_NAME,
      hProperties: { dataContextIndex: String(token.index) },
    },
    children: [],
  };
}

export function parseComposerChipSegment(raw: unknown): ComposerChipSegment | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "type" in parsed &&
      CHIP_SEGMENT_TYPES.has((parsed as { type: ComposerChipSegment["type"] }).type)
    ) {
      return parsed as ComposerChipSegment;
    }
    return null;
  } catch {
    return null;
  }
}

export function createComposerChipsRemarkPlugin(
  mentionReferences: ReadonlyArray<ProviderMentionReference>,
  terminalContextTokens: ReadonlyArray<TerminalContextChipToken> = [],
) {
  const splitComposerText = (value: string): MdastNode[] => {
    if (value.length === 0) {
      return [];
    }
    const segments = splitPromptIntoDisplaySegments(value, mentionReferences);
    if (!segments.some(isChipSegment)) {
      return [{ type: "text", value }];
    }
    const replacements: MdastNode[] = [];
    for (const segment of segments) {
      if (isChipSegment(segment)) {
        replacements.push(chipSegmentToNode(segment));
        continue;
      }
      // Only text segments can appear alongside chips here: the display split
      // never emits terminal-context nodes.
      if (segment.type === "text" && segment.text.length > 0) {
        replacements.push({ type: "text", value: segment.text });
      }
    }
    return replacements;
  };

  const splitTextNode = (node: MdastNode): MdastNode[] => {
    const value = node.value ?? "";
    if (value.length === 0) {
      return [node];
    }

    const replacements: MdastNode[] = [];
    let cursor = 0;
    for (const token of terminalContextTokens) {
      const matchIndex = value.indexOf(token.label, cursor);
      if (matchIndex === -1) {
        continue;
      }
      replacements.push(...splitComposerText(value.slice(cursor, matchIndex)));
      replacements.push(terminalContextTokenToNode(token));
      cursor = matchIndex + token.label.length;
    }
    replacements.push(...splitComposerText(value.slice(cursor)));

    if (
      replacements.length === 1 &&
      replacements[0]?.type === "text" &&
      replacements[0].value === value
    ) {
      return [node];
    }
    return replacements;
  };

  const visitNode = (node: MdastNode): void => {
    if (!Array.isArray(node.children) || node.children.length === 0) {
      return;
    }
    let changed = false;
    const nextChildren: MdastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text") {
        const replacements = splitTextNode(child);
        if (replacements.length !== 1 || replacements[0] !== child) {
          changed = true;
        }
        nextChildren.push(...replacements);
        continue;
      }
      if (!SKIPPED_PARENT_TYPES.has(child.type)) {
        visitNode(child);
      }
      nextChildren.push(child);
    }
    if (changed) {
      node.children = nextChildren;
    }
  };

  return () => (tree: unknown) => {
    visitNode(tree as MdastNode);
  };
}
