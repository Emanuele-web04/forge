import { PullRequestProvider } from "@synara/contracts";
import { Schema } from "effect";

export class PullRequestCapabilityError extends Schema.TaggedErrorClass<PullRequestCapabilityError>()(
  "PullRequestCapabilityError",
  {
    provider: PullRequestProvider,
    capability: Schema.Literals(["merge", "stateMutation", "comment"]),
  },
) {
  override get message(): string {
    return "This pull request provider does not support that operation.";
  }
}
