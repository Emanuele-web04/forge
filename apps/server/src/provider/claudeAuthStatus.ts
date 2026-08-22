/**
 * claudeAuthStatus - Pure interpretation of `claude auth status` output.
 *
 * Decides authenticated/unauthenticated/unknown from the CLI's JSON or text
 * output, detects the structured false negatives produced by refresh-token
 * rotation races, and derives subscription metadata labels. Pure functions
 * only; the health check in ProviderHealth owns spawning, locking, and
 * retries.
 */
import type { ServerProviderAuthStatus, ServerProviderStatusState } from "@synara/contracts";

import {
  detailFromResult,
  extractAuthBoolean,
  toTitleCaseWords,
  type CommandResult,
} from "./providerCliOutput";

function claudeAuthOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.toLowerCase();
}

function hasClaudeUnsupportedAuthStatusText(result: CommandResult): boolean {
  const lowerOutput = claudeAuthOutput(result);
  return (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  );
}

function hasClaudeLoginRequiredText(result: CommandResult): boolean {
  const lowerOutput = claudeAuthOutput(result);
  return (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude login`") ||
    lowerOutput.includes("run claude login")
  );
}

function readClaudeAuthStatusJsonMarker(result: CommandResult): {
  readonly attemptedJsonParse: boolean;
  readonly auth: boolean | undefined;
} {
  const trimmed = result.stdout.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return { attemptedJsonParse: false, auth: undefined };
  }
  try {
    return {
      attemptedJsonParse: true,
      auth: extractAuthBoolean(JSON.parse(trimmed)),
    };
  } catch {
    return { attemptedJsonParse: true, auth: undefined };
  }
}

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  if (hasClaudeUnsupportedAuthStatusText(result)) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Claude Agent authentication status command is unavailable in this version of Claude.",
    };
  }

  if (hasClaudeLoginRequiredText(result)) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  // `claude auth status` returns JSON with a `loggedIn` boolean.
  const parsedAuth = readClaudeAuthStatusJsonMarker(result);

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

export function isStructuredClaudeAuthFalseNegativeCandidate(
  result: CommandResult,
  parsed: ReturnType<typeof parseClaudeAuthStatusFromOutput>,
): boolean {
  return (
    parsed.authStatus === "unauthenticated" &&
    result.code === 0 &&
    readClaudeAuthStatusJsonMarker(result).auth === false &&
    !hasClaudeLoginRequiredText(result)
  );
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  switch (normalized) {
    case "max":
    case "maxplan":
    case "max5":
    case "max20":
      return "Max";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "apikey") return "apiKey";
  return undefined;
}

export function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return { type: "apiKey", label: "Claude API Key" };
  }
  if (input.subscriptionType) {
    const subscriptionLabel = claudeSubscriptionLabel(input.subscriptionType);
    return {
      type: input.subscriptionType,
      label: `Claude ${subscriptionLabel ?? toTitleCaseWords(input.subscriptionType)} Subscription`,
    };
  }
  return undefined;
}
