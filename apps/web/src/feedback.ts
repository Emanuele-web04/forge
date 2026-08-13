// FILE: feedback.ts
// Purpose: Owns feedback categories, privacy-safe diagnostics, and delivery.
// Layer: Web feature logic
// Depends on: The public trysynara feedback endpoint.

import { APP_VERSION } from "./branding";

/**
 * `lead` opens the reported summary in the reporter's voice, so the category is
 * readable as a sentence rather than as an enum value.
 */
export const FEEDBACK_CATEGORIES = [
  { value: "bug", label: "Bug", lead: "I ran into a bug" },
  { value: "session", label: "Session", lead: "I hit a session problem" },
  { value: "ui", label: "UI", lead: "Something looked wrong" },
  { value: "performance", label: "Performance", lead: "Synara felt slow" },
  { value: "idea", label: "Idea", lead: "I have an idea" },
  { value: "other", label: "Other", lead: "I have some feedback" },
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]["value"];

const UNCATEGORIZED_LEAD = "I have some feedback";

export interface FeedbackThreadContext {
  provider: string | null;
  model: string | null;
  projectKind: string | null;
  environmentMode: string | null;
  runtimeMode: string | null;
  interactionMode: string | null;
  sessionStatus: string | null;
  latestTurnState: string | null;
  messageCount: number;
  activityCount: number;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  hasThreadError: boolean;
}

export type FeedbackDiagnostics = FeedbackThreadContext & {
  appVersion: string;
  submittedAt: string;
  userAgent: string;
  platform: string;
  language: string;
  viewport: string;
};

export interface FeedbackSubmission {
  category: FeedbackCategory | null;
  details: string;
  /** Reader-facing rendering of `diagnostics`; the reporter never sees or edits it. */
  summary: string;
  diagnostics: FeedbackDiagnostics;
}

const DEFAULT_FEEDBACK_ENDPOINT = "https://www.trysynara.com/api/feedback";
const FEEDBACK_REQUEST_TIMEOUT_MS = 20_000;

function formatStateFlags(diagnostics: FeedbackThreadContext): string {
  const flags: string[] = [];
  if (diagnostics.hasThreadError) flags.push("the thread was in an error state");
  if (diagnostics.hasPendingApproval) flags.push("an approval was pending");
  if (diagnostics.hasPendingUserInput) flags.push("the agent was waiting for input");
  return flags.length > 0 ? `${flags.join(", ")}.` : "nothing pending.";
}

/**
 * Renders diagnostics as the report a maintainer reads first, since incoming
 * feedback arrives without any context about what the reporter was doing.
 */
export function formatFeedbackSummary(input: {
  category: FeedbackCategory | null;
  diagnostics: FeedbackDiagnostics;
}): string {
  const { diagnostics } = input;
  const category = FEEDBACK_CATEGORIES.find((option) => option.value === input.category);
  const lead = category?.lead ?? UNCATEGORIZED_LEAD;
  const usageContext = diagnostics.provider
    ? diagnostics.model
      ? `, using ${diagnostics.provider} with ${diagnostics.model}`
      : `, using ${diagnostics.provider}`
    : " outside an active chat";

  const rows: Array<[string, string | null]> = [
    ["Report type", category?.label ?? "Unspecified"],
    ["App version", diagnostics.appVersion],
    ["Provider", diagnostics.provider],
    ["Model", diagnostics.model],
    ["Project kind", diagnostics.projectKind],
    ["Environment mode", diagnostics.environmentMode],
    ["Runtime mode", diagnostics.runtimeMode],
    ["Interaction mode", diagnostics.interactionMode],
    ["Session status", diagnostics.sessionStatus],
    ["Latest turn state", diagnostics.latestTurnState],
    [
      "Thread size",
      `${diagnostics.messageCount} messages, ${diagnostics.activityCount} activities`,
    ],
    ["At submission", formatStateFlags(diagnostics)],
    ["Platform", `${diagnostics.platform}, viewport ${diagnostics.viewport}`],
    ["Language", diagnostics.language],
    ["User agent", diagnostics.userAgent],
    ["Submitted at", diagnostics.submittedAt],
  ];

  const detailLines = rows
    .filter((row): row is [string, string] => row[1] !== null && row[1] !== "")
    .map(([label, value]) => `${label}: ${value}`);

  return [`${lead} in Synara ${diagnostics.appVersion}${usageContext}.`, "", ...detailLines].join(
    "\n",
  );
}

export function buildFeedbackSubmission(input: {
  category: FeedbackCategory | null;
  details: string;
  context: FeedbackThreadContext;
  now?: Date;
  userAgent?: string;
  platform?: string;
  language?: string;
  viewport?: { width: number; height: number };
}): FeedbackSubmission {
  const viewport = input.viewport ?? { width: window.innerWidth, height: window.innerHeight };
  const diagnostics: FeedbackDiagnostics = {
    ...input.context,
    appVersion: APP_VERSION,
    submittedAt: (input.now ?? new Date()).toISOString(),
    userAgent: input.userAgent ?? navigator.userAgent,
    platform: input.platform ?? navigator.platform,
    language: input.language ?? navigator.language,
    viewport: `${viewport.width}x${viewport.height}`,
  };

  return {
    category: input.category,
    details: input.details.trim(),
    summary: formatFeedbackSummary({
      category: input.category,
      diagnostics,
    }),
    diagnostics,
  };
}

function feedbackEndpoint(): string {
  return import.meta.env.VITE_FEEDBACK_ENDPOINT?.trim() || DEFAULT_FEEDBACK_ENDPOINT;
}

export async function submitFeedback(
  submission: FeedbackSubmission,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FEEDBACK_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(feedbackEndpoint(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-synara-feedback": "1",
      },
      body: JSON.stringify(submission),
      signal: controller.signal,
    });
    if (response.ok) return;

    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof payload?.error === "string" ? payload.error.trim() : "";
    throw new Error(message || `Feedback could not be sent (${response.status}).`);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Feedback delivery timed out. Please try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}
