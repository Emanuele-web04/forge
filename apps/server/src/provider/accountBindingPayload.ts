import { Schema } from "effect";

export const ThreadAccountBinding = Schema.Struct({
  ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  agentGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  principalFingerprint: Schema.optional(Schema.String),
});
export type ThreadAccountBinding = typeof ThreadAccountBinding.Type;

const isBinding = Schema.is(ThreadAccountBinding);

export function readAccountBindingFromRuntimePayload(
  runtimePayload: unknown,
): ThreadAccountBinding | undefined {
  if (typeof runtimePayload !== "object" || runtimePayload === null) return undefined;
  const candidate = (runtimePayload as Record<string, unknown>)["accountBinding"];
  return isBinding(candidate) ? candidate : undefined;
}
