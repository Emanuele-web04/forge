function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const RESULT_STATUSES = new Set([
  "SUCCESS",
  "ERROR",
  "CANCELED",
  "INTERRUPTED",
  "INVALID",
  "WAITING",
  "RUNNING",
]);
const STREAM_EVENTS = new Set(["init", "step_update", "result", "error"]);

type Step = {
  state?: unknown;
  type?: unknown;
  text: string;
};

/** Consume complete records as they arrive; an interrupted final line must not erase prior output. */
export function createAntigravityPrintResultParser() {
  let pending = "";
  let structured = false;
  let streamed = false;
  let streamError: string | undefined;
  let malformedRecord = false;
  let result: Record<string, unknown> | undefined;
  const steps = new Map<number, Step>();

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(trimmed));
    } catch {
      // A truncated protocol header is not a legacy answer. Ordinary markdown
      // and JSON answers still use the plain-text fallback.
      if (/^\{\s*"(?:event|status)"\s*:/.test(trimmed)) structured = true;
      if (structured) malformedRecord = true;
      return;
    }
    if (!value) return;
    if (typeof value.event !== "string" || !STREAM_EVENTS.has(value.event)) {
      if (typeof value.status === "string" && RESULT_STATUSES.has(value.status)) {
        structured = true;
        result = value;
      }
      return;
    }
    structured = true;
    streamed = true;
    if (value.event === "result") {
      const envelope = record(value.result);
      if (envelope && typeof envelope.status === "string") result = envelope;
      else malformedRecord = true;
    } else if (value.event === "error") {
      streamError =
        typeof value.message === "string" && value.message.trim()
          ? value.message
          : "Antigravity stream failed.";
    } else if (value.event === "step_update") {
      const update = record(value.step_update);
      const index = update?.step_index;
      if (!update || typeof index !== "number" || !Number.isInteger(index) || index < 0) {
        malformedRecord = true;
        return;
      }
      const previous = steps.get(index);
      steps.set(index, {
        state: update.state ?? previous?.state,
        type: update.step_type ?? previous?.type,
        text: `${previous?.text ?? ""}${typeof update.text_delta === "string" ? update.text_delta : ""}`,
      });
    }
  };

  return {
    write(chunk: string) {
      pending += chunk;
      let start = 0;
      let end = pending.indexOf("\n", start);
      while (end !== -1) {
        consume(pending.slice(start, end));
        start = end + 1;
        end = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    },
    finish() {
      consume(pending);
      pending = "";
      if (!structured) return undefined;
      const state =
        result?.status === "CANCELED" || result?.status === "INTERRUPTED"
          ? "interrupted"
          : streamError || (result && result.status !== "SUCCESS")
            ? "failed"
            : result?.status === "SUCCESS"
              ? "completed"
              : undefined;
      let lastResponseIndex = -1;
      let lastResponse: Step | undefined;
      for (const [index, step] of steps) {
        if (step.type === "agent_response" && index > lastResponseIndex) {
          lastResponseIndex = index;
          lastResponse = step;
        }
      }
      const completedResponse =
        streamed &&
        !malformedRecord &&
        (state === undefined || state === "completed") &&
        lastResponse?.state === "DONE" &&
        lastResponse.text.trim().length > 0 &&
        [...steps.entries()].every(
          ([index, step]) =>
            step.state === "DONE" && (step.type !== "error" || index < lastResponseIndex),
        );
      return {
        state,
        completedResponse,
        response:
          typeof result?.response === "string" && result.response.trim()
            ? result.response
            : (lastResponse?.text ?? ""),
        error:
          typeof result?.error === "string"
            ? result.error
            : (streamError ??
              (state === "failed"
                ? `Antigravity ended with status ${result?.status}.`
                : undefined)),
        failed: state === "failed",
      };
    },
  };
}

export function parseAntigravityPrintResult(stdout: string) {
  const parser = createAntigravityPrintResultParser();
  parser.write(stdout);
  return parser.finish();
}
