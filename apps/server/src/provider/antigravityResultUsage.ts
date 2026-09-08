function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseAntigravityPrintResult(stdout: string, elapsedMs?: number) {
  try {
    const records = stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const streamed = records.some((record) => typeof record.event === "string");
    const result = (
      streamed ? records.findLast((record) => record.event === "result")?.result : records[0]
    ) as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object" || typeof result.status !== "string")
      return undefined;
    // The result envelope includes historical turns, errors and idle time.
    // step_update usage belongs to this invocation. Repeated updates replace
    // the same step instead of counting that model request twice.
    const steps = new Map<number, Record<string, unknown>>();
    const states = new Map<number, Record<string, unknown>>();
    for (const record of records) {
      const step = record.step_update as Record<string, unknown> | undefined;
      if (record.event === "step_update" && step && typeof step.step_index === "number") {
        const previous = states.get(step.step_index);
        states.set(step.step_index, {
          ...previous,
          ...step,
          text_delta: `${typeof previous?.text_delta === "string" ? previous.text_delta : ""}${typeof step.text_delta === "string" ? step.text_delta : ""}`,
        });
      }
      if (
        record.event === "step_update" &&
        step &&
        typeof step.step_index === "number" &&
        step.usage &&
        typeof step.usage === "object"
      ) {
        steps.set(step.step_index, step.usage as Record<string, unknown>);
      }
    }
    const raw = streamed
      ? steps.size > 0
        ? [...steps.values()].reduce<Record<string, number>>((sum, usage) => {
            for (const key of [
              "input_tokens",
              "output_tokens",
              "cache_read_tokens",
              "thinking_tokens",
            ]) {
              const count = number(usage[key]);
              if (count !== undefined) sum[key] = (sum[key] ?? 0) + count;
            }
            return sum;
          }, {})
        : undefined
      : (number(result.num_turns) ?? 1) <= 1
        ? (result.usage as Record<string, unknown> | undefined)
        : undefined;
    const inputTokens = number(raw?.input_tokens);
    const outputTokens = number(raw?.output_tokens);
    const cachedInputTokens = number(raw?.cache_read_tokens);
    const reasoningOutputTokens = number(raw?.thinking_tokens);
    const duration = streamed ? undefined : number(result.duration_seconds);
    const lastStep = [...states.entries()].toSorted(([a], [b]) => a - b).at(-1)?.[1];
    // agy may retain an earlier stream error in the result envelope even
    // after recovering within the first user turn. Require the same positive
    // final-step evidence as timeout recovery; the error string alone never
    // establishes success, and terminal stream errors still veto recovery.
    const recoveredStreamError =
      result.error === "The stream was interrupted. Please continue the task you were working on.";
    const completedResponse =
      streamed &&
      (result.status === "SUCCESS" ||
        (number(result.num_turns) ?? 1) > 1 ||
        result.error === "timeout waiting for response" ||
        recoveredStreamError) &&
      lastStep?.step_type === "agent_response" &&
      lastStep.state === "DONE" &&
      typeof lastStep.text_delta === "string" &&
      lastStep.text_delta.trim().length > 0 &&
      [...states.values()].every((step) => step.state === "DONE") &&
      !records.some((record) => record.event === "error");
    return {
      completedResponse,
      response:
        typeof result.response === "string" && result.response.trim()
          ? result.response
          : completedResponse && typeof lastStep?.text_delta === "string"
            ? lastStep.text_delta
            : "",
      error: typeof result.error === "string" ? result.error : undefined,
      failed: result.status === "ERROR",
      usage:
        inputTokens !== undefined && outputTokens !== undefined
          ? {
              // agy reports uncached input separately from cache_read_tokens.
              inputTokens: inputTokens + (cachedInputTokens ?? 0),
              outputTokens,
              ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
              ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
              ...(elapsedMs !== undefined
                ? { durationMs: elapsedMs }
                : duration !== undefined
                  ? { durationMs: duration * 1000 }
                  : {}),
            }
          : undefined,
    };
  } catch {
    return undefined;
  }
}
