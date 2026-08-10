import { createHash } from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_PROFILE_ID,
  MessageId,
  ThreadId,
  type SynaraCreateThreadsInput,
} from "@synara/contracts";

export function slugifyAgentTask(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export function gatewayIsoNow(): string {
  return new Date().toISOString();
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableGatewayDigest(value: unknown, length = 32): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, length);
}

/** Preserves pre-profile hashes for retries of already-reserved create operations. */
export function fingerprintGatewayCreateThreadsInput(input: SynaraCreateThreadsInput): string {
  return stableGatewayDigest(
    {
      ...input,
      threads: input.threads.map(({ target, ...thread }) => {
        if (target.profileId !== DEFAULT_PROVIDER_PROFILE_ID) {
          return { ...thread, target };
        }
        const { profileId: _profileId, ...legacyTarget } = target;
        return { ...thread, target: legacyTarget };
      }),
    },
    64,
  );
}

export function makeAgentCreationIds(operationId: string, index: number) {
  const id = stableGatewayDigest({ operationId, index }, 32);
  return {
    threadId: ThreadId.makeUnsafe(`agent-${id}`),
    threadCreateCommandId: CommandId.makeUnsafe(`agent:${id}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`agent:${id}:turn-start`),
    messageId: MessageId.makeUnsafe(`agent:${id}:message`),
    compensateCommandId: CommandId.makeUnsafe(`agent:${id}:compensate-delete`),
  };
}
