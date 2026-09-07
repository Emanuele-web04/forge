import type { OrchestrationThreadActivity, TurnId } from "@synara/contracts";
import { formatContextWindowTokens } from "./contextWindow";

export interface MessageUsageMetric {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly exactValue?: string;
}

type Tokens = {
  input: number | null;
  output: number | null;
  read: number | null;
  write: number | null;
};
const empty = (): Tokens => ({ input: null, output: null, read: null, write: null });
const keys = ["input", "output", "read", "write"] as const;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function fromUsage(value: Record<string, unknown>): Tokens {
  return {
    input: count(value.inputTokens),
    output: count(value.outputTokens),
    read: count(value.cachedInputTokens),
    write: count(value.cacheCreationInputTokens),
  };
}
function sum(values: readonly Tokens[]): Tokens {
  const result = empty();
  for (const key of keys) {
    if (values.length && values.every((value) => value[key] !== null))
      result[key] = values.reduce((total, value) => total + value[key]!, 0);
  }
  return result;
}
function difference(current: Tokens, before: Tokens | undefined): Tokens {
  // A provider restart/compaction can reset all cumulative counters.
  const reset =
    before &&
    keys.some(
      (key) => current[key] !== null && before[key] !== null && current[key]! < before[key]!,
    );
  if (!before || reset) return current;
  const result = empty();
  for (const key of keys)
    result[key] =
      current[key] === null || before[key] === null ? null : current[key]! - before[key]!;
  return result;
}
function metrics(tokens: Tokens, scope: string): MessageUsageMetric[] {
  if (keys.every((key) => tokens[key] === null)) return [];
  const definitions = [
    [
      "↑",
      "input",
      "Input",
      "Includes cache reads and writes; instructions, tools, history and messages all contribute.",
    ],
    ["↓", "output", "Output", "Provider-reported generated tokens."],
    ["R", "read", "Cache read", "Input tokens reused from cache."],
    [
      "W",
      "write",
      "Cache write",
      "Input tokens written to cache. A first request may write cache without reading it.",
    ],
  ] as const;
  const result = definitions.map(([label, key, name, explanation]) => ({
    label,
    exactValue: tokens[key] === null ? "—" : tokens[key]!.toLocaleString("en-US"),
    value: tokens[key] === null ? "—" : formatContextWindowTokens(tokens[key]),
    detail: `${scope} · ${name}: ${tokens[key] === null ? "not reported" : `${tokens[key]!.toLocaleString("en-US")} tokens`}. ${explanation}`,
  }));
  const ratio =
    tokens.input !== null && tokens.input > 0 && tokens.read !== null && tokens.read <= tokens.input
      ? tokens.read / tokens.input
      : null;
  return [
    ...result,
    {
      label: "CH",
      value: ratio === null ? "—" : `${(ratio * 100).toFixed(1)}%`,
      detail: `${scope} · Cache hit: cache reads / total input (including cache reads and writes). ${ratio === null ? "Not enough reported data." : "Weighted by tokens, not an average of request percentages."}`,
    },
  ];
}

/** One accounting pass feeds both footers. Never sum context-window snapshots. */
export function deriveConversationUsage(activities: readonly OrchestrationThreadActivity[]) {
  const grouped = new Map<TurnId, OrchestrationThreadActivity[]>();
  for (const activity of activities) {
    if (!activity.turnId || !["context-window.updated", "turn.completed"].includes(activity.kind))
      continue;
    const group = grouped.get(activity.turnId);
    if (group) group.push(activity);
    else grouped.set(activity.turnId, [activity]);
  }
  const byTurnId = new Map<TurnId, readonly MessageUsageMetric[]>();
  const baselines = new Map<string, Tokens>();
  const seenSessions = new Set<string>();
  const accounted: Tokens[] = [];
  let incomplete = false;
  for (const [turnId, events] of grouped) {
    const raw = record(
      events.findLast((event) => event.kind === "context-window.updated")?.payload,
    );
    const completion = record(events.findLast((event) => event.kind === "turn.completed")?.payload);
    const models = Object.values(record(completion.modelUsage)).map(record);
    let tokens = empty();
    let scope = "This turn";
    let contribution: Tokens | undefined;
    if (
      models.length &&
      models.every(
        (model) => count(model.inputTokens) !== null && count(model.outputTokens) !== null,
      )
    ) {
      // Projection normalizes Claude model input to include cache reads/writes.
      tokens = sum(
        models.map((model) => {
          const usage = fromUsage(model);
          usage.read = count(model.cacheReadInputTokens);
          return usage;
        }),
      );
      contribution = tokens;
    } else if (completion.provider === "antigravity") {
      tokens = fromUsage(record(completion.usage));
      contribution = tokens;
    } else if (raw.provider === "codex") {
      const session = `codex:${String(raw.usageSessionId ?? "legacy")}`;
      const cumulative = fromUsage(record(raw.cumulativeUsage));
      if (cumulative.input !== null && cumulative.output !== null) {
        contribution = difference(cumulative, baselines.get(session));
        tokens = contribution;
        if (
          !baselines.has(session) &&
          (seenSessions.has(session) || seenSessions.has("codex:legacy"))
        ) {
          // Older app versions saved only the last request. The session total
          // remains exact, but the boundary for this particular turn is unknown.
          tokens = fromUsage(raw);
          scope = "Latest request only; historical turn baseline unavailable";
        }
        baselines.set(session, cumulative);
      } else {
        tokens = fromUsage(raw);
        scope = "Latest request only; legacy turn totals unavailable";
      }
      seenSessions.add(session);
    }
    const values = metrics(tokens, scope);
    if (values.length) byTurnId.set(turnId, values);
    if (contribution && keys.some((key) => contribution![key] !== null))
      accounted.push(contribution);
    else if (raw.provider !== "codex") incomplete = true;
  }
  // A later Codex cumulative snapshot covers its earlier legacy requests.
  const hasLegacyCodexWithoutTotal = [...seenSessions].some((session) => !baselines.has(session));
  incomplete ||= hasLegacyCodexWithoutTotal;
  return {
    byTurnId,
    cumulative: metrics(
      sum(accounted),
      incomplete
        ? "Recorded conversation usage; some historical turns have no totals"
        : "Conversation total",
    ),
  };
}

export function deriveMessageUsageByTurnId(activities: readonly OrchestrationThreadActivity[]) {
  return deriveConversationUsage(activities).byTurnId;
}
