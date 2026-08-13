// FILE: api/feedback/route.ts
// Purpose: Receives explicit Synara feedback and delivers it to the maintainer through Resend.
// Layer: App Router route handler (Node.js runtime)
// Depends on: Server-only Resend, recipient, and verified sender configuration.

import { consumeFeedbackRateLimit } from "@/lib/feedbackRateLimit";

export const runtime = "nodejs";

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM_EMAIL = "Synara Feedback <feedback@trysynara.com>";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_DETAILS_LENGTH = 5_000;
const SEND_TIMEOUT_MS = 15_000;

const CATEGORY_LABELS = {
  bug: "Bug",
  session: "Session",
  ui: "UI",
  performance: "Performance",
  idea: "Idea",
  other: "Other",
} as const;

type FeedbackCategory = keyof typeof CATEGORY_LABELS;
type DiagnosticValue = string | number | boolean | null;

interface ParsedFeedback {
  category: FeedbackCategory | null;
  details: string;
  diagnostics: Record<string, DiagnosticValue>;
}

const DIAGNOSTIC_FIELDS = [
  "appVersion",
  "submittedAt",
  "provider",
  "model",
  "projectKind",
  "environmentMode",
  "runtimeMode",
  "interactionMode",
  "sessionStatus",
  "latestTurnState",
  "messageCount",
  "activityCount",
  "hasPendingApproval",
  "hasPendingUserInput",
  "hasThreadError",
  "userAgent",
  "platform",
  "language",
  "viewport",
] as const;

function corsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === "synara://app") return origin;

  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    ) {
      return origin;
    }
  } catch {
    return null;
  }
  return null;
}

function responseHeaders(origin: string | null): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    vary: "origin",
    ...(origin
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-synara-feedback",
        }
      : {}),
  };
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(origin),
  });
}

function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDiagnostics(value: unknown): Record<string, DiagnosticValue> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, DiagnosticValue> = {};
  for (const key of DIAGNOSTIC_FIELDS) {
    const field = value[key];
    if (field === null) {
      result[key] = null;
      continue;
    }
    if (typeof field === "string") {
      const maximumLength = key === "userAgent" ? 1_024 : 256;
      result[key] = field.slice(0, maximumLength);
      continue;
    }
    if (typeof field === "boolean") {
      result[key] = field;
      continue;
    }
    if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) {
      result[key] = field;
      continue;
    }
    return null;
  }
  return result;
}

function parseFeedback(value: unknown): ParsedFeedback | null {
  if (!isRecord(value)) return null;
  const details = typeof value.details === "string" ? value.details.trim() : "";
  if (details.length === 0 || details.length > MAX_DETAILS_LENGTH) return null;

  const category = value.category;
  if (category !== null && (typeof category !== "string" || !(category in CATEGORY_LABELS))) {
    return null;
  }
  const diagnostics = parseDiagnostics(value.diagnostics);
  if (!diagnostics) return null;

  return {
    category: category as FeedbackCategory | null,
    details,
    diagnostics,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character] ?? character;
  });
}

function diagnosticSummary(feedback: ParsedFeedback): string {
  const diagnostics = feedback.diagnostics;
  return `I had this issue in Synara: version(${String(diagnostics.appVersion)}), provider: ${String(diagnostics.provider)}, model: ${String(diagnostics.model)}, runtime mode: ${String(diagnostics.runtimeMode)}, interaction mode: ${String(diagnostics.interactionMode)}, session: ${String(diagnostics.sessionStatus)}, latest turn: ${String(diagnostics.latestTurnState)}.`;
}

function diagnosticsLines(diagnostics: Record<string, DiagnosticValue>): string[] {
  return DIAGNOSTIC_FIELDS.map((key) => `${key}: ${String(diagnostics[key])}`);
}

async function sendEmail(feedback: ParsedFeedback): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const toEmail = process.env.SYNARA_FEEDBACK_TO_EMAIL?.trim();
  if (!apiKey || !toEmail) throw new Error("Feedback delivery is not configured.");

  const categoryLabel = feedback.category ? CATEGORY_LABELS[feedback.category] : "General";
  const hiddenSummary = diagnosticSummary(feedback);
  const lines = diagnosticsLines(feedback.diagnostics);
  const text = [feedback.details, "", "--- Diagnostic context ---", hiddenSummary, ...lines].join(
    "\n",
  );
  const html = `
    <h2>${escapeHtml(categoryLabel)} feedback</h2>
    <p style="white-space:pre-wrap">${escapeHtml(feedback.details)}</p>
    <hr />
    <p><strong>Diagnostic context</strong></p>
    <p>${escapeHtml(hiddenSummary)}</p>
    <pre>${escapeHtml(lines.join("\n"))}</pre>
  `;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.SYNARA_FEEDBACK_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL,
        to: [toEmail],
        subject: `[Synara Feedback] ${categoryLabel} · v${String(feedback.diagnostics.appVersion)}`,
        text,
        html,
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as {
      id?: unknown;
      message?: unknown;
    } | null;
    if (!response.ok || typeof payload?.id !== "string") {
      const reason = typeof payload?.message === "string" ? payload.message : "Unknown error";
      throw new Error(`Resend rejected feedback delivery: ${reason}`);
    }
    return payload.id;
  } finally {
    clearTimeout(timeout);
  }
}

export function OPTIONS(request: Request): Response {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = corsOrigin(request);
  if (requestOrigin && !allowedOrigin) {
    return jsonResponse({ error: "Origin is not allowed." }, 403, null);
  }
  return new Response(null, {
    status: 204,
    headers: responseHeaders(allowedOrigin),
  });
}

export async function POST(request: Request): Promise<Response> {
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = corsOrigin(request);
  if (requestOrigin && !allowedOrigin) {
    return jsonResponse({ error: "Origin is not allowed." }, 403, null);
  }
  if (request.headers.get("x-synara-feedback") !== "1") {
    return jsonResponse({ error: "Invalid feedback client." }, 400, allowedOrigin);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Feedback is too large." }, 413, allowedOrigin);
  }

  const rateLimit = await consumeFeedbackRateLimit(requestIp(request));
  if (!rateLimit.allowed) {
    const response = jsonResponse(
      { error: "Too many feedback reports. Please try again later." },
      429,
      allowedOrigin,
    );
    response.headers.set("retry-after", String(rateLimit.retryAfter));
    return response;
  }

  let body: unknown;
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
      return jsonResponse({ error: "Feedback is too large." }, 413, allowedOrigin);
    }
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Feedback payload is invalid." }, 400, allowedOrigin);
  }

  const feedback = parseFeedback(body);
  if (!feedback) {
    return jsonResponse({ error: "Feedback payload is invalid." }, 400, allowedOrigin);
  }

  try {
    await sendEmail(feedback);
    return jsonResponse({ ok: true }, 200, allowedOrigin);
  } catch (error) {
    console.error("[feedback] delivery failed", error);
    const unavailable = error instanceof Error && error.message.includes("not configured");
    return jsonResponse(
      {
        error: unavailable
          ? "Feedback delivery is temporarily unavailable."
          : "Feedback could not be delivered.",
      },
      unavailable ? 503 : 502,
      allowedOrigin,
    );
  }
}
