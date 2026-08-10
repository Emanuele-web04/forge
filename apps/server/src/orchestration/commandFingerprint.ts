import * as Crypto from "node:crypto";

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  OrchestrationCommand,
  type OrchestrationCommand as Command,
} from "@synara/contracts";
import { Schema } from "effect";

export const ORCHESTRATION_COMMAND_FINGERPRINT_VERSION = 1;

export interface OrchestrationCommandFingerprint {
  readonly version: number;
  readonly value: string;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalizeJson(record[key])]),
    );
  }
  return value;
}

// Fingerprint v1 predates provider profiles. Only schema-owned model-selection
// fields omit the reserved default; arbitrary JSON payloads remain untouched.
function preserveV1ModelSelectionFingerprint(intent: Record<string, unknown>) {
  const compatibleIntent = { ...intent };
  for (const key of ["modelSelection", "defaultModelSelection"] as const) {
    const selection = compatibleIntent[key];
    if (
      selection !== null &&
      typeof selection === "object" &&
      (selection as Record<string, unknown>).profileId === DEFAULT_PROVIDER_PROFILE_ID
    ) {
      const { profileId: _profileId, ...legacySelection } = selection as Record<string, unknown>;
      compatibleIntent[key] = legacySelection;
    }
  }
  return compatibleIntent;
}

function commandIntent(command: Command): Record<string, unknown> {
  const decoded = Schema.decodeUnknownSync(OrchestrationCommand)(command);
  const { commandId: _commandId, ...intent } = decoded;
  if (intent.type !== "thread.turn.start") {
    return preserveV1ModelSelectionFingerprint(intent);
  }

  return preserveV1ModelSelectionFingerprint({
    ...intent,
    message: {
      ...intent.message,
      attachments: intent.message.attachments.map((attachment) => {
        switch (attachment.type) {
          case "assistant-selection":
            return {
              type: attachment.type,
              assistantMessageId: attachment.assistantMessageId,
              text: attachment.text,
            };
          case "image":
          case "file":
            // Name, MIME, and size are resolved from the managed server ledger. Only the
            // attachment identity belongs to the idempotent client command intent.
            return { type: attachment.type, id: attachment.id };
        }
      }),
    },
  });
}

export function fingerprintOrchestrationCommand(command: Command): OrchestrationCommandFingerprint {
  const canonical = JSON.stringify(
    canonicalizeJson({
      version: ORCHESTRATION_COMMAND_FINGERPRINT_VERSION,
      command: commandIntent(command),
    }),
  );
  return {
    version: ORCHESTRATION_COMMAND_FINGERPRINT_VERSION,
    value: Crypto.createHash("sha256").update(canonical).digest("hex"),
  };
}
