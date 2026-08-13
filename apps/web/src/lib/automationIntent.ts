// FILE: automationIntent.ts
// Purpose: Detects when a normal chat prompt is actually asking Synara to create an automation.
// Layer: Web composer helper
// Exports: automation intent parsers, resolver, and cadence/name formatters.
// Depends on: AutomationSchedule contract shared with the automation API.

import type {
  AutomationCompletionPolicy,
  AutomationMode,
  AutomationSchedule,
  ServerGenerateAutomationIntentResult,
} from "@synara/contracts";

import { completionPolicyFromStopWhen } from "@synara/shared/automationCompletionPolicy";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";

export interface ChatAutomationIntent {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly cadenceLabel: string;
  readonly maxIterations: number | null;
  readonly completionPolicy: AutomationCompletionPolicy;
  readonly executionScope: ChatAutomationExecutionScope;
}

export type ChatAutomationExecutionScope = "thread" | "standalone" | "worktree";

export interface ResolvedChatAutomationIntent {
  readonly intent: ChatAutomationIntent;
  readonly mode: AutomationMode;
  readonly source: "deterministic" | "generated";
  readonly requiresReview: boolean;
  readonly generatedConfidence: number | null;
  readonly generatedNeedsConfirmation: boolean;
  readonly reason: string | null;
}

interface ParsedSchedule {
  readonly schedule: AutomationSchedule;
  readonly cadenceLabel: string;
}

interface ParsedIterationLimit {
  readonly maxIterations: number;
  readonly textWithoutIterationLimit: string;
}

interface ParsedExecutionScope {
  readonly executionScope: ChatAutomationExecutionScope;
  readonly textWithoutExecutionScope: string;
}

const DEFAULT_DAILY_TIME = "09:00";
const GENERATED_INTENT_CONFIDENCE_THRESHOLD = 0.75;
const PROMPT_ENRICHMENT_MAX_WORDS = 10;
const PROMPT_ENRICHMENT_MAX_LENGTH = 80;
const MAX_NAME_LENGTH = 120;
const CRON_FIELD_PATTERN = "[*/0-9,-]+";
const PLAIN_INVOCATION_QUESTION_PREFIX_PATTERN =
  /^(?:what|why|how|who|when|where|which|can|could|would|should|do|does|did|is|are|am|will|qual|quale|quali|cosa|come|perche|dove|quando|chi|posso|puoi|potresti|dovrei)\b/;
const PLAIN_INVOCATION_POLITE_REQUEST_PATTERN =
  /^(?:(?:can|could|would|will|should)\s+you(?:\s+please)?|(?:puoi|potresti)(?:\s+per favore)?)\s+/i;
const PLAIN_INVOCATION_ACTION_PREFIX_PATTERN =
  /^(?:check|verify|monitor|watch|remind(?:\s+me)?|notify(?:\s+me)?|alert(?:\s+me)?|tell\s+me|controlla|verifica|monitora|avvisami|ricordami)\b/i;
const PLAIN_INVOCATION_POLITE_ACTION_PREFIX_PATTERN =
  /^(?:check|verify|monitor|watch|say|remind(?:\s+me)?|notify(?:\s+me)?|alert(?:\s+me)?|tell\s+me|controlla|verifica|monitora|avvisami|ricordami)\b/i;
const PLAIN_INVOCATION_AUTOMATION_CREATION_PREFIX_PATTERN = new RegExp(
  [
    "^(?:please\\s+)?(?:",
    "(?:make|create|set up|setup|add|start|build)\\s+(?:an?\\s+)?automation\\b",
    "|schedule\\s+(?:an?\\s+)?(?:automation|task|job|check|monitor)\\b",
    "|(?:crea|creare|aggiungi|imposta|fai)\\s+(?:un[' ]?)?",
    "(?:automazione|task|controllo|monitoraggio)\\b",
    ")",
  ].join(""),
  "i",
);

const WEEKDAY_BY_TOKEN: Record<string, number> = {
  sunday: 0,
  sun: 0,
  domenica: 0,
  monday: 1,
  mon: 1,
  lunedi: 1,
  tuesday: 2,
  tue: 2,
  martedi: 2,
  wednesday: 3,
  wed: 3,
  mercoledi: 3,
  thursday: 4,
  thu: 4,
  giovedi: 4,
  friday: 5,
  fri: 5,
  venerdi: 5,
  saturday: 6,
  sat: 6,
  sabato: 6,
};

const WEEKDAY_STRIP_PATTERN = [
  ...Object.keys(WEEKDAY_BY_TOKEN),
  "lunedi",
  "lunedì",
  "martedi",
  "martedì",
  "mercoledi",
  "mercoledì",
  "giovedi",
  "giovedì",
  "venerdi",
  "venerdì",
].join("|");

const TIME_PATTERN = "((?:[01]?\\d|2[0-3])(?::[0-5]\\d)?\\s*(?:am|pm)?)";
const INTERVAL_UNIT_PATTERN =
  "(?:seconds|second|secs|sec|secondi|secondo|minutes|minute|mins|minuti|minuto|min|hours|hour|hrs|hr|ore|ora|days|day|giorni|giorno|s|m|h|d|g)";
const BARE_INTERVAL_UNIT_PATTERN =
  "(?:seconds|second|secs|sec|secondi|secondo|minutes|minute|mins|minuti|minuto|min|hours|hour|hrs|hr|ore|ora|s|m|h)";
const INTERVAL_PATTERN = `(\\d{1,4})\\s*(${INTERVAL_UNIT_PATTERN})`;
const BARE_INTERVAL_LEADING_REMAINDER_PATTERN =
  "(?=$|\\s*(?:,|and\\b|to\\b|then\\b)|\\s+(?:check|verify|monitor|watch|remind|notify|alert|tell|controlla|verifica|monitora|avvisami|ricordami)\\b)";
const BARE_INTERVAL_LEADING_ACTION_PATTERN = new RegExp(
  `^(?:every|each|ogni)\\s+${BARE_INTERVAL_UNIT_PATTERN}\\b\\s+(?:check|verify|monitor|watch|remind|notify|alert|tell|controlla|verifica|monitora|avvisami|ricordami)\\b`,
  "i",
);

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSearchText(value: string): string {
  return normalizeInlineText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Plain composer text is intentionally conservative so questions keep reaching the model.
function isLikelyPlainAutomationQuestion(value: string): boolean {
  const text = normalizeInlineText(value);
  if (!text) {
    return false;
  }
  if (/[?？]\s*$/.test(text)) {
    return true;
  }
  return PLAIN_INVOCATION_QUESTION_PREFIX_PATTERN.test(normalizeSearchText(text));
}

function isLikelyAutomationQuestionCandidate(value: string): boolean {
  if (isLikelyPlainAutomationQuestion(value)) {
    return true;
  }
  return /^tell me\s+(?:what|why|how|who|when|where|which|qual|quale|quali|cosa|come|perche|dove|quando|chi)\b/.test(
    normalizeSearchText(value),
  );
}

// Allows natural requests like "could you remind me every day" without reopening broad questions.
function stripPlainAutomationPoliteRequest(value: string): string | null {
  const normalized = normalizeInlineText(value);
  const match = PLAIN_INVOCATION_POLITE_REQUEST_PATTERN.exec(normalized);
  if (!match) {
    return null;
  }
  return normalizeInlineText(normalized.slice(match[0].length))
    .replace(/[?？]+$/g, "")
    .replace(/^(?:to|di|che)\s+/i, "");
}

function wordCount(value: string): number {
  return normalizeInlineText(value).split(/\s+/).filter(Boolean).length;
}

// Bare composer text must start like an automation task, not just contain a schedule phrase.
function isLikelyPlainAutomationAction(value: string, politeRequest: boolean): boolean {
  const pattern = politeRequest
    ? PLAIN_INVOCATION_POLITE_ACTION_PREFIX_PATTERN
    : PLAIN_INVOCATION_ACTION_PREFIX_PATTERN;
  const normalized = normalizeInlineText(value);
  return (
    pattern.test(normalized) ||
    PLAIN_INVOCATION_AUTOMATION_CREATION_PREFIX_PATTERN.test(normalized) ||
    BARE_INTERVAL_LEADING_ACTION_PATTERN.test(normalized)
  );
}

// Clear creation phrasing may need AI fallback even when local schedule parsing is incomplete.
export function extractPlainChatAutomationCreationInvocation(value: string): string | null {
  const normalizedInvocation = normalizeInlineText(value);
  if (!normalizedInvocation) {
    return null;
  }
  const politeInvocation = stripPlainAutomationPoliteRequest(normalizedInvocation);
  const candidate = politeInvocation ?? normalizedInvocation;
  const candidateIsQuestion =
    politeInvocation === null
      ? isLikelyAutomationQuestionCandidate(normalizedInvocation)
      : isLikelyAutomationQuestionCandidate(candidate);
  if (candidateIsQuestion) {
    return null;
  }
  return PLAIN_INVOCATION_AUTOMATION_CREATION_PREFIX_PATTERN.test(candidate) ? candidate : null;
}

// Keeps a clarification carry-forward parseable as an automation across turns. Explicit
// /automation markers and cadence-only remainders lose their trigger once stripped, so we
// re-seed a canonical creation scaffold when none survives; the parser strips it back out.
export function ensureAutomationConversationScaffold(message: string): string {
  const normalized = normalizeInlineText(message);
  if (!normalized) {
    return "create an automation";
  }
  if (PLAIN_INVOCATION_AUTOMATION_CREATION_PREFIX_PATTERN.test(normalized)) {
    return normalized;
  }
  return `create an automation ${normalized}`;
}

function removeMatchedText(value: string, match: RegExpExecArray): string {
  return normalizeInlineText(
    `${value.slice(0, match.index)} ${value.slice(match.index + match[0].length)}`,
  )
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/^(?:and|then|to|e|poi|che|di|per)\s+/i, "");
}

// Composer automations are thread-bound by default; these phrases intentionally opt out.
function extractExecutionScope(value: string): ParsedExecutionScope | null {
  const patterns: ReadonlyArray<{
    readonly executionScope: ChatAutomationExecutionScope;
    readonly pattern: RegExp;
  }> = [
    {
      executionScope: "worktree",
      pattern: /\b(?:in|on|with|using|su|con)\s+(?:a\s+|un\s+)?(?:new\s+|nuovo\s+)?worktree\b/i,
    },
    { executionScope: "worktree", pattern: /\b(?:new|nuovo)\s+worktree\b/i },
    {
      executionScope: "standalone",
      pattern:
        /\b(?:run|create|make|start|save|crea|fai|avvia)\s+(?:it\s+)?(?:as\s+)?(?:a\s+|un\s+)?standalone(?:\s+automation)?\b/i,
    },
    { executionScope: "standalone", pattern: /\bstandalone(?:\s+automation)?\b/i },
    { executionScope: "standalone", pattern: /\bseparate\s+(?:run|automation|task)\b/i },
    {
      executionScope: "standalone",
      pattern: /\b(?:as|in|into|inside|within)\s+(?:a\s+)?(?:new|separate)\s+run\b/i,
    },
    {
      executionScope: "standalone",
      pattern: /\bfor\s+(?:every|each|all)\s+(?:new\s+)?chats?\b/i,
    },
    {
      executionScope: "standalone",
      pattern: /\b(?:per|in)\s+ogni\s+(?:nuova\s+)?chat\b/i,
    },
  ];

  for (const { executionScope, pattern } of patterns) {
    const match = pattern.exec(value);
    if (!match) {
      continue;
    }
    return {
      executionScope,
      textWithoutExecutionScope: removeMatchedText(value, match),
    };
  }

  return null;
}

export function detectChatAutomationExecutionScope(value: string): ChatAutomationExecutionScope {
  return extractExecutionScope(value)?.executionScope ?? "thread";
}

interface ParsedStopClause {
  readonly stopWhen: string;
  readonly textWithoutStopClause: string;
}

function extractStopClause(value: string): ParsedStopClause | null {
  const patterns: readonly RegExp[] = [
    /\bstop\s+when\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\buntil\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\bkeep\s+monitoring\s+until\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\bif\s+(.+?),\s*stop\b/i,
    /\bquando\s+(.+?),\s*fermati\b/i,
    /\bfinch[eé]\s+(.+?)(?=(?:[.!?]\s+|$))/i,
    /\bfino\s+a\s+quando\s+(.+?)(?=(?:[.!?]\s+|$))/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    const stopWhen = match?.[1]
      ?.trim()
      .replace(/[.!?]+$/g, "")
      .trim();
    if (!match || !stopWhen) {
      continue;
    }
    const textWithoutStopClause = normalizeInlineText(
      `${value.slice(0, match.index)} ${value.slice(match.index + match[0].length)}`,
    )
      .replace(/([.!?])\s+[.!?]/g, "$1")
      .replace(/^(?:and|then|e|poi)\s+/i, "");
    return {
      stopWhen,
      textWithoutStopClause,
    };
  }
  return null;
}

// Pulls bounded-loop language out of the saved prompt so the scheduler can stop itself.
function extractIterationLimit(value: string): ParsedIterationLimit | null {
  const patterns: readonly RegExp[] = [
    /\bfor\s+(\d{1,4})\s+(?:times?|runs?|iterations?|turns?)(?:\s+(?:in\s+)?total)?\b/i,
    /\b(?:a\s+)?total\s+of\s+(\d{1,4})\s+(?:times?|runs?|iterations?|turns?)\b/i,
    /\b(\d{1,4})\s+(?:times?|runs?|iterations?|turns?)\s+(?:(?:in\s+)?total|overall)\b/i,
    /\bper\s+(\d{1,4})\s+(?:volte|iterazioni|run|giri)(?:\s+in\s+totale)?\b/i,
    /\b(?:per\s+)?un\s+totale\s+di\s+(\d{1,4})\s+(?:volte|iterazioni|run|giri)\b/i,
    /\b(\d{1,4})\s+(?:volte|iterazioni|run|giri)\s+in\s+totale\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    const amount = Number.parseInt(match?.[1] ?? "", 10);
    if (!match || !Number.isFinite(amount) || amount <= 0) {
      continue;
    }
    const textWithoutIterationLimit = removeMatchedText(value, match).replace(/(?:,\s*)$/g, "");
    return {
      maxIterations: amount,
      textWithoutIterationLimit,
    };
  }
  return null;
}

export function extractChatAutomationInvocation(value: string): string | null {
  const text = normalizeInlineText(value);
  if (!text) {
    return null;
  }

  const slashMatch = /^\/automation(?:\s+([\s\S]*))?$/i.exec(text);
  if (slashMatch) {
    return normalizeInlineText(slashMatch[1] ?? "");
  }

  const withoutInlineMarker = text.replace(
    /(^|\s)(?:@automation(?::)?|\/automation)(?=\s|$)/i,
    " ",
  );
  if (withoutInlineMarker !== text) {
    return normalizeInlineText(withoutInlineMarker);
  }

  return null;
}

function parseTimeOfDay(value: string | undefined): string | null {
  const match = /^([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?$/i.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }
  const meridiem = match[3]?.toLowerCase();
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (Number.isNaN(hour) || (meridiem && hour > 12)) {
    return null;
  }
  const safeHour =
    meridiem === "pm" && hour < 12 ? hour + 12 : meridiem === "am" && hour === 12 ? 0 : hour;
  const safeMinute = Number.isNaN(minute) ? 0 : Math.min(59, Math.max(0, minute));
  return `${String(safeHour).padStart(2, "0")}:${String(safeMinute).padStart(2, "0")}`;
}

function intervalUnitToSeconds(unit: string): number {
  if (
    unit === "s" ||
    unit === "sec" ||
    unit === "secs" ||
    unit === "second" ||
    unit === "seconds" ||
    unit === "secondo" ||
    unit === "secondi"
  ) {
    return 1;
  }
  if (
    unit === "m" ||
    unit === "min" ||
    unit === "mins" ||
    unit === "minute" ||
    unit === "minutes" ||
    unit === "minuto" ||
    unit === "minuti"
  ) {
    return 60;
  }
  if (
    unit === "h" ||
    unit === "hr" ||
    unit === "hrs" ||
    unit === "hour" ||
    unit === "hours" ||
    unit === "ora" ||
    unit === "ore"
  ) {
    return 3600;
  }
  return 86_400;
}

function intervalUnitLabel(unit: string): "s" | "m" | "h" | "d" {
  const seconds = intervalUnitToSeconds(unit);
  if (seconds === 1) return "s";
  if (seconds === 60) return "m";
  if (seconds === 3600) return "h";
  return "d";
}

export function formatAutomationIntentCadence(schedule: AutomationSchedule): string {
  if (schedule.type === "interval") {
    const seconds = schedule.everySeconds;
    if (seconds % 86_400 === 0) return `Every ${seconds / 86_400}d`;
    if (seconds % 3_600 === 0) return `Every ${seconds / 3_600}h`;
    if (seconds % 60 === 0) return `Every ${seconds / 60}m`;
    return `Every ${seconds}s`;
  }
  if (schedule.type === "once") {
    return `Once at ${new Date(schedule.runAt).toLocaleString()}`;
  }
  if (schedule.type === "cron") {
    return `Cron ${schedule.expression}`;
  }
  if (schedule.type === "daily") {
    return `Daily at ${schedule.timeOfDay}`;
  }
  if (schedule.type === "weekdays") {
    return `Weekdays at ${schedule.timeOfDay}`;
  }
  if (schedule.type === "weekly") {
    return `Weekly at ${schedule.timeOfDay}`;
  }
  return "Manual";
}

function parseIntervalSchedule(searchText: string): ParsedSchedule | null {
  const match =
    searchText.match(new RegExp(`\\b(?:every|each)\\s+${INTERVAL_PATTERN}\\b`)) ??
    searchText.match(new RegExp(`\\bogni\\s+${INTERVAL_PATTERN}\\b`));
  const bareMatch =
    match == null
      ? (searchText.match(
          new RegExp(
            `^(?:every|each)\\s+(${BARE_INTERVAL_UNIT_PATTERN})\\b${BARE_INTERVAL_LEADING_REMAINDER_PATTERN}`,
          ),
        ) ??
        searchText.match(new RegExp(`\\b(?:every|each)\\s+(${BARE_INTERVAL_UNIT_PATTERN})$`)) ??
        searchText.match(
          new RegExp(
            `^ogni\\s+(${BARE_INTERVAL_UNIT_PATTERN})\\b${BARE_INTERVAL_LEADING_REMAINDER_PATTERN}`,
          ),
        ) ??
        searchText.match(new RegExp(`\\bogni\\s+(${BARE_INTERVAL_UNIT_PATTERN})$`)))
      : null;
  if (!match && !bareMatch) {
    return null;
  }

  const amount = match ? Number.parseInt(match[1] ?? "", 10) : 1;
  const unit = match?.[2] ?? bareMatch?.[1] ?? "m";
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const everySeconds = amount * intervalUnitToSeconds(unit);

  const schedule = {
    type: "interval",
    everySeconds,
  } as const;
  return {
    schedule,
    cadenceLabel: `Every ${amount}${intervalUnitLabel(unit)}`,
  };
}

function parseOnceSchedule(searchText: string, nowIso: string): ParsedSchedule | null {
  const match =
    searchText.match(new RegExp(`\\bin\\s+${INTERVAL_PATTERN}\\b`)) ??
    searchText.match(new RegExp(`\\b(?:tra|fra)\\s+${INTERVAL_PATTERN}\\b`));
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = match[2] ?? "m";
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const delaySeconds = amount * intervalUnitToSeconds(unit);
  if (delaySeconds < 5) {
    return null;
  }
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    return null;
  }
  const runAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  return {
    schedule: { type: "once", runAt },
    cadenceLabel: `In ${amount}${intervalUnitLabel(unit)}`,
  };
}

function parseCronSchedule(searchText: string): ParsedSchedule | null {
  const match = searchText.match(
    new RegExp(
      `\\bcron\\s+(${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN})(?=\\s|$)`,
    ),
  );
  if (!match?.[1]) {
    return null;
  }
  const expression = match[1].trim();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    schedule: { type: "cron", expression, timezone },
    cadenceLabel: `Cron ${expression}`,
  };
}

function parseDailySchedule(searchText: string): ParsedSchedule | null {
  const timedDailyMatch =
    searchText.match(new RegExp(`\\b(?:daily|every day)\\s+at\\s+${TIME_PATTERN}\\b`)) ??
    searchText.match(
      new RegExp(`\\b(?:ogni giorno|tutti i giorni)\\s+(?:alle|a)\\s+${TIME_PATTERN}\\b`),
    );
  if (timedDailyMatch) {
    const timeOfDay = parseTimeOfDay(timedDailyMatch[1]);
    return timeOfDay
      ? {
          schedule: { type: "daily", timeOfDay },
          cadenceLabel: `Daily at ${timeOfDay}`,
        }
      : null;
  }

  if (
    /\b(?:daily|every day)\s+at\b/.test(searchText) ||
    /\b(?:ogni giorno|tutti i giorni)\s+(?:alle|a)\b/.test(searchText)
  ) {
    return null;
  }

  const dailyMatch =
    searchText.match(/\b(?:daily|every day)\b/) ??
    searchText.match(/\b(?:ogni giorno|tutti i giorni)\b/);
  if (!dailyMatch) {
    return null;
  }

  const timeOfDay = DEFAULT_DAILY_TIME;
  return {
    schedule: { type: "daily", timeOfDay },
    cadenceLabel: `Daily at ${timeOfDay}`,
  };
}

function parseWeekdaysSchedule(searchText: string): ParsedSchedule | null {
  const timedWeekdaysMatch =
    searchText.match(
      new RegExp(`\\b(?:weekdays|every weekday|workdays)\\s+at\\s+${TIME_PATTERN}\\b`),
    ) ??
    searchText.match(
      new RegExp(
        `\\b(?:giorni lavorativi|ogni giorno lavorativo)\\s+(?:alle|a)\\s+${TIME_PATTERN}\\b`,
      ),
    );
  if (timedWeekdaysMatch) {
    const timeOfDay = parseTimeOfDay(timedWeekdaysMatch[1]);
    return timeOfDay
      ? {
          schedule: { type: "weekdays", timeOfDay },
          cadenceLabel: `Weekdays at ${timeOfDay}`,
        }
      : null;
  }

  if (
    /\b(?:weekdays|every weekday|workdays)\s+at\b/.test(searchText) ||
    /\b(?:giorni lavorativi|ogni giorno lavorativo)\s+(?:alle|a)\b/.test(searchText)
  ) {
    return null;
  }

  const weekdaysMatch =
    searchText.match(/\b(?:weekdays|every weekday|workdays)\b/) ??
    searchText.match(/\b(?:giorni lavorativi|ogni giorno lavorativo)\b/);
  if (!weekdaysMatch) {
    return null;
  }

  const timeOfDay = DEFAULT_DAILY_TIME;
  return {
    schedule: { type: "weekdays", timeOfDay },
    cadenceLabel: `Weekdays at ${timeOfDay}`,
  };
}

function parseWeeklySchedule(searchText: string): ParsedSchedule | null {
  const weekdayTokens = Object.keys(WEEKDAY_BY_TOKEN).join("|");
  const timedWeeklyMatch =
    searchText.match(new RegExp(`\\bevery\\s+(${weekdayTokens})\\s+at\\s+${TIME_PATTERN}\\b`)) ??
    searchText.match(
      new RegExp(`\\bogni\\s+(${weekdayTokens})\\s+(?:alle|a)\\s+${TIME_PATTERN}\\b`),
    );
  if (timedWeeklyMatch) {
    const dayOfWeek = WEEKDAY_BY_TOKEN[timedWeeklyMatch[1] ?? ""];
    const timeOfDay = parseTimeOfDay(timedWeeklyMatch[2]);
    return dayOfWeek !== undefined && timeOfDay
      ? {
          schedule: { type: "weekly", dayOfWeek, timeOfDay },
          cadenceLabel: `Weekly at ${timeOfDay}`,
        }
      : null;
  }

  if (
    new RegExp(`\\bevery\\s+(?:${weekdayTokens})\\s+at\\b`).test(searchText) ||
    new RegExp(`\\bogni\\s+(?:${weekdayTokens})\\s+(?:alle|a)\\b`).test(searchText)
  ) {
    return null;
  }

  const weeklyMatch =
    searchText.match(new RegExp(`\\bevery\\s+(${weekdayTokens})\\b`)) ??
    searchText.match(new RegExp(`\\bogni\\s+(${weekdayTokens})\\b`));
  if (!weeklyMatch) {
    return null;
  }

  const dayOfWeek = WEEKDAY_BY_TOKEN[weeklyMatch[1] ?? ""];
  if (dayOfWeek === undefined) {
    return null;
  }

  const timeOfDay = DEFAULT_DAILY_TIME;
  return {
    schedule: { type: "weekly", dayOfWeek, timeOfDay },
    cadenceLabel: `Weekly at ${timeOfDay}`,
  };
}

function parseSchedule(searchText: string, nowIso: string): ParsedSchedule | null {
  if (/\b(?:between|around|circa|verso)\b/.test(searchText)) {
    return null;
  }
  return (
    parseCronSchedule(searchText) ??
    parseOnceSchedule(searchText, nowIso) ??
    parseIntervalSchedule(searchText) ??
    parseWeekdaysSchedule(searchText) ??
    parseWeeklySchedule(searchText) ??
    parseDailySchedule(searchText)
  );
}

function stripAutomationScaffold(value: string): string {
  let cleaned = normalizeInlineText(value);
  cleaned = cleaned
    .replace(
      /^(?:please\s+)?(?:make|create|set up|setup|add|start|build)\s+(?:an?\s+)?automation\s*(?:for\s+(?:me|myself)\b\s*)?(?:where|that|to|which)?\s*/i,
      "",
    )
    .replace(
      /^(?:please\s+)?(?:crea|creare|aggiungi|imposta|fai)\s+(?:un[' ]?)?(?:automazione|task|controllo|monitoraggio)\s*(?:per\s+(?:me|noi)\b\s*)?(?:che|per|dove)?\s*/i,
      "",
    )
    .replace(
      /^(?:please\s+)?schedule\s+(?:an?\s+)?(?:automation|task|job|check|monitor|reminder)\s*(?:for\s+(?:me|myself)\b\s*)?(?:to|that)?\s*/i,
      "",
    )
    .replace(/^(?:please\s+)?automate\s+(?:this|that|it)?\s*/i, "")
    .replace(/^(?:where|that|to|for|che|per|dove)\s+/i, "");

  cleaned = cleaned
    .replace(
      new RegExp(
        `\\b(?:you\\s+)?wake\\s+up\\s+(?:every|each)\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:you\\s+)?run\\s+(?:it|this)?\\s*(?:every|each)\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(`\\b(?:every|each)\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`, "i"),
      "",
    )
    .replace(
      new RegExp(
        `^(?:every|each)\\s+${BARE_INTERVAL_UNIT_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*${BARE_INTERVAL_LEADING_REMAINDER_PATTERN}`,
        "i",
      ),
      "",
    )
    .replace(new RegExp(`\\b(?:every|each)\\s+${BARE_INTERVAL_UNIT_PATTERN}$`, "i"), "")
    .replace(new RegExp(`\\bogni\\s+${INTERVAL_PATTERN}\\b\\s*(?:e|poi|per|,)?\\s*`, "i"), "")
    .replace(
      new RegExp(
        `^ogni\\s+${BARE_INTERVAL_UNIT_PATTERN}\\b\\s*(?:e|poi|per|,)?\\s*${BARE_INTERVAL_LEADING_REMAINDER_PATTERN}`,
        "i",
      ),
      "",
    )
    .replace(new RegExp(`\\bogni\\s+${BARE_INTERVAL_UNIT_PATTERN}$`, "i"), "")
    .replace(new RegExp(`\\bin\\s+${INTERVAL_PATTERN}\\b\\s*(?:and|to|then|,)?\\s*`, "i"), "")
    .replace(
      new RegExp(`\\b(?:tra|fra)\\s+${INTERVAL_PATTERN}\\b\\s*(?:e|poi|per|,)?\\s*`, "i"),
      "",
    )
    .replace(
      new RegExp(
        `\\bcron\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s+${CRON_FIELD_PATTERN}\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:daily|every day)(?:\\s+(?:at|around)\\s+${TIME_PATTERN})?\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:ogni giorno|tutti i giorni)(?:\\s+(?:alle|a)\\s+${TIME_PATTERN})?\\s*(?:e|poi|per|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:weekdays|every weekday|workdays)(?:\\s+at\\s+${TIME_PATTERN})?\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\b(?:giorni lavorativi|ogni giorno lavorativo)(?:\\s+(?:alle|a)\\s+${TIME_PATTERN})?\\s*(?:e|poi|per|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\bevery\\s+(?:${WEEKDAY_STRIP_PATTERN})(?:\\s+at\\s+${TIME_PATTERN})?\\s*(?:and|to|then|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(
      new RegExp(
        `\\bogni\\s+(?:${WEEKDAY_STRIP_PATTERN})(?:\\s+(?:alle|a)\\s+${TIME_PATTERN})?\\s*(?:e|poi|per|,)?\\s*`,
        "i",
      ),
      "",
    )
    .replace(/^(?:please)\s+/i, "")
    .replace(/^(?:and|then|to|e|poi|che|di|per)\s+/i, "");

  return normalizeInlineText(cleaned);
}

function stripUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, " ");
}

function truncateName(value: string): string {
  const normalized = normalizeInlineText(value);
  if (normalized.length <= MAX_NAME_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}...`;
}

function sentenceCase(value: string): string {
  const trimmed = normalizeInlineText(value);
  if (!trimmed) {
    return "Chat automation";
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function deriveAutomationIntentName(prompt: string): string {
  const withoutUrls = stripUrls(prompt);
  const availabilitySubject = withoutUrls.match(
    /\b(?:check|verify|monitor|watch|controlla|verifica|monitora)\s+(?:if|whether|se)?\s*(.+?)\s+(?:is|are|e|available|disponibile|disponibili|in stock)\b/i,
  );
  if (availabilitySubject?.[1]) {
    return truncateName(`Check ${sentenceCase(availabilitySubject[1])} availability`);
  }

  const actionSeed = withoutUrls.replace(
    /^(?:please\s+)?(?:check|verify|monitor|watch|notify|remind|tell me|controlla|verifica|monitora|avvisami|ricordami)\s+(?:me\s+)?/i,
    "",
  );
  return truncateName(sentenceCase(actionSeed));
}

export function parseChatAutomationInvocation(
  invocation: string,
  options: { readonly nowIso?: string } = {},
): ChatAutomationIntent | null {
  const normalizedInvocation = normalizeInlineText(invocation);
  if (!normalizedInvocation) {
    return null;
  }

  const executionScope = extractExecutionScope(normalizedInvocation);
  const scopedInvocation = executionScope?.textWithoutExecutionScope ?? normalizedInvocation;
  const searchText = normalizeSearchText(scopedInvocation);
  const parsedSchedule = parseSchedule(searchText, options.nowIso ?? new Date().toISOString());
  if (!parsedSchedule) {
    return null;
  }

  const iterationLimit = extractIterationLimit(scopedInvocation);
  const prompt = stripAutomationScaffold(
    iterationLimit?.textWithoutIterationLimit ?? scopedInvocation,
  );
  if (!prompt) {
    return null;
  }
  const stopClause = extractStopClause(prompt);
  const taskPrompt = stopClause?.textWithoutStopClause
    ? stripAutomationScaffold(stopClause.textWithoutStopClause)
    : prompt;
  if (!taskPrompt) {
    return null;
  }
  return {
    name: deriveAutomationIntentName(taskPrompt),
    prompt: taskPrompt,
    schedule: parsedSchedule.schedule,
    cadenceLabel: parsedSchedule.cadenceLabel,
    maxIterations: iterationLimit?.maxIterations ?? null,
    completionPolicy: completionPolicyFromStopWhen(stopClause?.stopWhen ?? ""),
    executionScope: executionScope?.executionScope ?? "thread",
  };
}

// Parses unmarked composer text only when it looks like an instruction, not a question.
export function parsePlainChatAutomationInvocation(
  invocation: string,
  options: { readonly nowIso?: string } = {},
): ChatAutomationIntent | null {
  const normalizedInvocation = normalizeInlineText(invocation);
  if (!normalizedInvocation) {
    return null;
  }
  const politeInvocation = stripPlainAutomationPoliteRequest(normalizedInvocation);
  const candidate = politeInvocation ?? normalizedInvocation;
  if (!isLikelyPlainAutomationAction(candidate, politeInvocation !== null)) {
    return null;
  }
  const candidateIsQuestion =
    politeInvocation === null
      ? isLikelyAutomationQuestionCandidate(normalizedInvocation)
      : isLikelyAutomationQuestionCandidate(candidate);
  if (candidateIsQuestion) {
    return null;
  }
  return parseChatAutomationInvocation(candidate, options);
}

// Parses only explicit scheduled intents so regular automation questions keep going to the model.
export function parseChatAutomationIntent(
  value: string,
  options: { readonly nowIso?: string } = {},
): ChatAutomationIntent | null {
  const invocation = extractChatAutomationInvocation(value);
  if (invocation === null) {
    return null;
  }
  return parseChatAutomationInvocation(invocation, options);
}

export function shouldGenerateAutomationIntent(input: {
  readonly deterministicIntent: ChatAutomationIntent | null;
  readonly automationMessage: string;
}): boolean {
  const message = normalizeInlineText(input.automationMessage);
  if (!message) {
    return false;
  }
  if (!input.deterministicIntent) {
    return true;
  }
  const prompt = normalizeInlineText(input.deterministicIntent.prompt);
  return (
    prompt.length > 0 &&
    (prompt.length <= PROMPT_ENRICHMENT_MAX_LENGTH ||
      wordCount(prompt) <= PROMPT_ENRICHMENT_MAX_WORDS)
  );
}

function stripGeneratedPromptScaffolding(value: string): string {
  const withoutExecutionScope = extractExecutionScope(value)?.textWithoutExecutionScope ?? value;
  const withoutIterationLimit =
    extractIterationLimit(withoutExecutionScope)?.textWithoutIterationLimit ??
    withoutExecutionScope;
  const withoutSchedule = stripAutomationScaffold(withoutIterationLimit);
  const stopClause = extractStopClause(withoutSchedule);
  return normalizeInlineText(
    stopClause?.textWithoutStopClause
      ? stripAutomationScaffold(stopClause.textWithoutStopClause)
      : withoutSchedule,
  );
}

// Prefer the model's structured run cap, but recover old/generated prompt scaffolding too.
function maxIterationsFromGeneratedIntent(
  generatedIntent: ServerGenerateAutomationIntentResult,
): number | null {
  return (
    generatedIntent.maxIterations ??
    (generatedIntent.taskPrompt
      ? (extractIterationLimit(generatedIntent.taskPrompt)?.maxIterations ?? null)
      : null)
  );
}

function generatedAutomationPromptEnrichment(
  generatedIntent: ServerGenerateAutomationIntentResult | null,
): Pick<ChatAutomationIntent, "name" | "prompt" | "maxIterations"> | null {
  if (
    generatedIntent?.isAutomation !== true ||
    generatedIntent.taskPrompt === null ||
    generatedIntent.confidence < GENERATED_INTENT_CONFIDENCE_THRESHOLD
  ) {
    return null;
  }
  const prompt = stripGeneratedPromptScaffolding(generatedIntent.taskPrompt);
  if (!prompt) {
    return null;
  }
  return {
    name: generatedIntent.name ?? deriveAutomationIntentName(prompt),
    prompt,
    maxIterations: maxIterationsFromGeneratedIntent(generatedIntent),
  };
}

function generatedAutomationIntentToChatIntent(
  generatedIntent: ServerGenerateAutomationIntentResult | null,
  executionScope: ChatAutomationExecutionScope,
): ChatAutomationIntent | null {
  if (generatedIntent?.isAutomation !== true || generatedIntent.taskPrompt === null) {
    return null;
  }

  if (
    generatedIntent.confidence < GENERATED_INTENT_CONFIDENCE_THRESHOLD &&
    !generatedIntent.needsConfirmation
  ) {
    return null;
  }

  const schedule = generatedIntent.schedule ?? { type: "manual" as const };
  const prompt = stripGeneratedPromptScaffolding(generatedIntent.taskPrompt);
  if (!prompt) {
    return null;
  }
  const resolvedExecutionScope = executionScopeForGeneratedMode(
    generatedIntent.mode,
    executionScope,
  );
  return {
    name: generatedIntent.name ?? deriveAutomationIntentName(prompt),
    prompt,
    schedule,
    cadenceLabel: formatAutomationIntentCadence(schedule),
    maxIterations: maxIterationsFromGeneratedIntent(generatedIntent),
    completionPolicy: generatedIntent.completionPolicy ?? { type: "none" },
    executionScope: resolvedExecutionScope,
  };
}

// Generated mode can recover out-of-thread phrasing the deterministic regexes do not know.
function executionScopeForGeneratedMode(
  mode: AutomationMode | null,
  fallback: ChatAutomationExecutionScope,
): ChatAutomationExecutionScope {
  if (mode === null) {
    return fallback;
  }
  // Only heartbeat runs inside the thread the user is looking at; the other modes open a
  // thread of their own, which is the same execution scope choice standalone always had.
  if (automationRequiresTargetThread(mode)) {
    return "thread";
  }
  return fallback === "worktree" ? "worktree" : "standalone";
}

// Outside the current thread, keep the generator's choice between one reused thread
// (dedicated) and a fresh thread per run (standalone) instead of flattening both.
function modeForExecutionScope(input: {
  readonly executionScope: ChatAutomationExecutionScope;
  readonly defaultMode: AutomationMode;
  readonly generatedMode: AutomationMode | null;
}): AutomationMode {
  if (input.executionScope === "thread") {
    return input.defaultMode;
  }
  return input.generatedMode === "dedicated" ? "dedicated" : "standalone";
}

export function resolveChatAutomationIntent(input: {
  readonly deterministicIntent: ChatAutomationIntent | null;
  readonly generatedIntent: ServerGenerateAutomationIntentResult | null;
  readonly defaultMode: AutomationMode;
  readonly executionScope: ChatAutomationExecutionScope;
}): ResolvedChatAutomationIntent | null {
  if (input.deterministicIntent) {
    const resolvedExecutionScope =
      input.deterministicIntent.executionScope === "thread"
        ? executionScopeForGeneratedMode(input.generatedIntent?.mode ?? null, input.executionScope)
        : input.deterministicIntent.executionScope;
    // A stop clause no longer forces heartbeat: completion policies apply to both modes,
    // so the requested execution scope is honoured as asked.
    const mode = modeForExecutionScope({
      executionScope: resolvedExecutionScope,
      defaultMode: input.defaultMode,
      generatedMode: input.generatedIntent?.mode ?? null,
    });
    const enrichment = generatedAutomationPromptEnrichment(input.generatedIntent);
    const enrichmentNeedsConfirmation =
      enrichment !== null && (input.generatedIntent?.needsConfirmation ?? false);
    const deterministicIntent =
      resolvedExecutionScope === input.deterministicIntent.executionScope
        ? input.deterministicIntent
        : { ...input.deterministicIntent, executionScope: resolvedExecutionScope };
    const intent = enrichment
      ? {
          ...deterministicIntent,
          name: enrichment.name,
          prompt: enrichment.prompt,
          maxIterations: enrichment.maxIterations ?? deterministicIntent.maxIterations,
        }
      : deterministicIntent;
    return {
      intent,
      mode,
      source: "deterministic",
      requiresReview:
        // Any LLM-influenced draft requires human review before creating: when the prompt
        // is terse the generator rewrites name/prompt/maxIterations even though the schedule
        // parsed deterministically (enrichment !== null), so the confirmation must not be
        // skipped. Purely local parses keep their finer gating, including the deliberate
        // bounded-fast-loop auto-submit (which skips generation, so enrichment stays null).
        enrichment !== null || resolvedExecutionScope !== "thread",
      generatedConfidence: enrichment ? (input.generatedIntent?.confidence ?? null) : null,
      generatedNeedsConfirmation: enrichmentNeedsConfirmation,
      reason: enrichmentNeedsConfirmation ? (input.generatedIntent?.reason ?? null) : null,
    };
  }

  const generatedIntent = generatedAutomationIntentToChatIntent(
    input.generatedIntent,
    input.executionScope,
  );
  if (!generatedIntent) {
    return null;
  }

  const generatedSchedule = input.generatedIntent?.schedule;
  const fastRecurringInterval =
    generatedSchedule?.type === "interval" && generatedSchedule.everySeconds < 60;

  const mode = modeForExecutionScope({
    executionScope: generatedIntent.executionScope,
    defaultMode: input.defaultMode,
    generatedMode: input.generatedIntent?.mode ?? null,
  });
  return {
    intent: generatedIntent,
    mode,
    source: "generated",
    // Generated (LLM-interpreted) intents always require a human confirmation step: a
    // misread message must never silently create a recurring background automation, no
    // matter how confident the model is. Deterministic explicit intents keep their
    // finer-grained gating above, including the intentional bounded-fast-loop
    // auto-submit, which never reaches this branch because generation is skipped for it
    // in resolveComposerAutomationRequest.
    requiresReview: true,
    generatedConfidence: input.generatedIntent?.confidence ?? null,
    generatedNeedsConfirmation:
      (input.generatedIntent?.needsConfirmation ?? false) || fastRecurringInterval,
    reason: input.generatedIntent?.reason ?? null,
  };
}
