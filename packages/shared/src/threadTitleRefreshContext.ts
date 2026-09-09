// FILE: threadTitleRefreshContext.ts
// Purpose: Bounded redacted input assembler for automatic title refresh (#1041).
// Layer: Shared pure utility. Only title + recent user intent + compact summary enter.
// Never accepts tool output, hidden prompts, attachments, or secrets; patterns that
// look credential-like are replaced with [redacted]. Output hard-capped.

export const THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS = 2_000;
export const THREAD_TITLE_REFRESH_MAX_INTENTS = 5;

export interface ThreadTitleRefreshContextInput {
  readonly currentTitle: string;
  readonly recentUserIntents: ReadonlyArray<string>;
  readonly compactSummary: string | null | undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function redactCredentials(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|secret|bearer|authorization)\b\s*[:=]\s*\S+/gi,
      "$1: [redacted]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[redacted]");
}

function usableLines(input: ThreadTitleRefreshContextInput): {
  title: string;
  intents: string[];
  summary: string | null;
} {
  const title = redactCredentials(normalize(input.currentTitle));
  const intents = input.recentUserIntents
    .map((intent) => redactCredentials(normalize(intent)))
    .filter((intent) => intent.length > 0)
    .slice(-THREAD_TITLE_REFRESH_MAX_INTENTS);
  const summaryRaw =
    input.compactSummary === null || input.compactSummary === undefined
      ? ""
      : redactCredentials(normalize(input.compactSummary));
  return { title, intents, summary: summaryRaw.length > 0 ? summaryRaw : null };
}

/** Assemble bounded context. Returns null when nothing usable remains. */
export function buildThreadTitleRefreshContext(
  input: ThreadTitleRefreshContextInput,
  maxChars: number = THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS,
): string | null {
  const { title, intents, summary } = usableLines(input);
  if (intents.length === 0 && summary === null) return null;

  const lines: string[] = [];
  if (title.length > 0) lines.push(`Current title: ${title}`);
  for (const intent of intents) lines.push(`User intent: ${intent}`);
  if (summary !== null) lines.push(`Summary: ${summary}`);

  let context = lines.join("\n");
  if (context.length <= maxChars) return context;

  // Shrink deterministically: drop oldest intents first, then trim summary, then title line.
  const keptIntents = [...intents];
  while (keptIntents.length > 1) {
    keptIntents.shift();
    const attempt = [
      ...(title.length > 0 ? [`Current title: ${title}`] : []),
      ...keptIntents.map((intent) => `User intent: ${intent}`),
      ...(summary !== null ? [`Summary: ${summary}`] : []),
    ].join("\n");
    if (attempt.length <= maxChars) return attempt;
  }
  let tail = [
    ...(title.length > 0 ? [`Current title: ${title}`] : []),
    ...keptIntents.map((intent) => `User intent: ${intent}`),
    ...(summary !== null ? [`Summary: ${summary}`] : []),
  ].join("\n");
  if (tail.length > maxChars) tail = tail.slice(-maxChars);
  return tail;
}
