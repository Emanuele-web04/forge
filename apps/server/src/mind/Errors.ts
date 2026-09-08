import { Schema } from "effect";

/**
 * Distinct, actionable rejections for the Mind service (plan 05 §6.3): every
 * cap and guard fails with its own error so agent tools and the UI can render
 * precise guidance instead of a generic failure.
 */
export class MindInvalidTextError extends Schema.TaggedErrorClass<MindInvalidTextError>()(
  "MindInvalidTextError",
  {
    reason: Schema.Literals(["empty", "tooLong"]),
    message: Schema.String,
  },
) {}

export class MindSecretRejectedError extends Schema.TaggedErrorClass<MindSecretRejectedError>()(
  "MindSecretRejectedError",
  {
    message: Schema.String,
  },
) {}

export class MindProjectCapReachedError extends Schema.TaggedErrorClass<MindProjectCapReachedError>()(
  "MindProjectCapReachedError",
  {
    projectId: Schema.String,
    count: Schema.Number,
    cap: Schema.Number,
    message: Schema.String,
  },
) {}

export class MindMemoryNotFoundError extends Schema.TaggedErrorClass<MindMemoryNotFoundError>()(
  "MindMemoryNotFoundError",
  {
    memoryId: Schema.String,
    message: Schema.String,
  },
) {}
