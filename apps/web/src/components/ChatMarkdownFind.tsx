// FILE: ChatMarkdownFind.tsx
// Purpose: Applies in-thread find decoration after markdown parsing.
// Layer: Web chat presentation helper

import React, { useMemo, type ReactNode } from "react";

import {
  collectCaseInsensitiveSubstringRanges,
  normalizeFindQuery,
  splitTextWithFindMatches,
  splitTextWithFindRanges,
  wrapFindQueryInHtml,
  type ThreadFindRange,
} from "./chat/threadFind.logic";

interface ChatFindRenderState {
  query: string;
  ranges: readonly ThreadFindRange[];
  activeRange: ThreadFindRange | null;
}

const EMPTY_CHAT_FIND_RENDER_STATE: ChatFindRenderState = {
  query: "",
  ranges: [],
  activeRange: null,
};

const ChatFindRenderContext = React.createContext<ChatFindRenderState>(
  EMPTY_CHAT_FIND_RENDER_STATE,
);

export function ChatFindRenderProvider(props: {
  query: string;
  sourceText: string;
  activeRange: ThreadFindRange | null;
  children: ReactNode;
}) {
  const ranges = useMemo(
    () => collectCaseInsensitiveSubstringRanges(props.sourceText, props.query),
    [props.query, props.sourceText],
  );
  const value = useMemo<ChatFindRenderState>(
    () => ({ query: props.query, ranges, activeRange: props.activeRange }),
    [props.activeRange, props.query, ranges],
  );
  return (
    <ChatFindRenderContext.Provider value={value}>{props.children}</ChatFindRenderContext.Provider>
  );
}

function findMatchClassName(part: {
  active: boolean;
  continuesBefore?: boolean;
  continuesAfter?: boolean;
}): string {
  return [
    "chat-find-match",
    part.active ? "chat-find-match-active" : "",
    part.continuesBefore ? "chat-find-match-continues-before" : "",
    part.continuesAfter ? "chat-find-match-continues-after" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderFindTextParts(parts: ReturnType<typeof splitTextWithFindMatches>): ReactNode {
  if (parts.length === 1 && !parts[0]!.match) {
    return parts[0]!.text;
  }
  return parts.map((part, index) =>
    part.match ? (
      <span
        key={`${part.startOffset ?? index}:${index}`}
        className={findMatchClassName(part)}
        data-chat-find-match={part.active ? "active" : "true"}
        data-chat-find-start={part.startOffset}
      >
        {part.text}
      </span>
    ) : (
      <span key={`text:${index}`}>{part.text}</span>
    ),
  );
}

function renderFindWrappedText(
  text: string,
  query: string,
  activeRange: ThreadFindRange | null,
  sourceOffset: number,
): ReactNode {
  return renderFindTextParts(splitTextWithFindMatches(text, query, activeRange, sourceOffset));
}

export function FindAwareMarkdownText(props: { text: string; sourceOffset: number }) {
  const highlight = React.useContext(ChatFindRenderContext);
  return renderFindTextParts(
    splitTextWithFindRanges(
      props.text,
      highlight.ranges,
      highlight.activeRange,
      props.sourceOffset,
    ),
  );
}

export function FindAwareCodeFallback(props: {
  children: ReactNode;
  code: string;
  sourceOffset: number;
}) {
  const highlight = React.useContext(ChatFindRenderContext);
  if (normalizeFindQuery(highlight.query).length === 0) {
    return props.children;
  }
  return (
    <code>
      {renderFindWrappedText(
        props.code,
        highlight.query,
        highlight.activeRange,
        props.sourceOffset,
      )}
    </code>
  );
}

export function FindAwareShikiHtml(props: { html: string; sourceOffset: number }) {
  const highlight = React.useContext(ChatFindRenderContext);
  const html =
    normalizeFindQuery(highlight.query).length > 0
      ? wrapFindQueryInHtml(props.html, highlight.query, props.sourceOffset, highlight.activeRange)
      : props.html;
  return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
}
