import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MindConfirmInput,
  MindConfirmResult,
  MindError,
  MindForgetInput,
  MindForgetResult,
  MindJournalEntry,
  MindJournalOp,
  MindListInput,
  MindListResult,
  MindMemory,
  MindMemoryId,
  MindMemoryMatch,
  MindPinInput,
  MindPinResult,
  MindPruneInput,
  MindPruneResult,
  MindRecallInput,
  MindRecallResult,
  MindRememberInput,
  MindRememberResult,
  MIND_MEMORY_TEXT_MAX_CHARS,
  MIND_RECALL_MAX_DIGEST_CHARS,
  MIND_RECALL_MAX_ITEMS,
} from "./mind";
import { ProjectId, ThreadId, TurnId } from "./baseSchemas";

function decodeSync<S extends Schema.Top>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema as never)(input) as Schema.Schema.Type<S>;
}

function decodes<S extends Schema.Top>(schema: S, input: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(input);
    return true;
  } catch {
    return false;
  }
}

const makeProjectId = () =>
  Schema.decodeUnknownSync(ProjectId)("proj_" + Math.random().toString(36).slice(2, 10));
const makeMemoryId = () =>
  Schema.decodeUnknownSync(MindMemoryId)("mem_" + Math.random().toString(36).slice(2, 10));
const makeTurnId = () =>
  Schema.decodeUnknownSync(TurnId)("turn_" + Math.random().toString(36).slice(2, 10));
const makeThreadId = () =>
  Schema.decodeUnknownSync(ThreadId)("thread_" + Math.random().toString(36).slice(2, 10));
const isoNow = () => new Date().toISOString();

const validMemory = () => ({
  memoryId: makeMemoryId(),
  projectId: makeProjectId(),
  text: "The project uses SQLite for durable memory.",
  weight: 0.9,
  accessCount: 3,
  pinned: false,
  createdAt: isoNow(),
  updatedAt: isoNow(),
});

describe("MindMemoryId", () => {
  it("brands non-empty, trimmed strings", () => {
    const id = Schema.decodeUnknownSync(MindMemoryId)("  memory-abc  ");
    expect(id).toBe("memory-abc");
    expect(Schema.is(MindMemoryId)("memory-abc")).toBe(true);
  });

  it("rejects blank or empty ids", () => {
    expect(() => Schema.decodeUnknownSync(MindMemoryId)("   ")).toThrow();
    expect(() => Schema.decodeUnknownSync(MindMemoryId)("")).toThrow();
  });
});

describe("MindMemory", () => {
  it("decodes and encodes a valid memory", () => {
    const input = validMemory();
    const decoded = decodeSync(MindMemory, input);
    expect(decoded.text).toBe(input.text);
    expect(decoded.weight).toBe(input.weight);
    expect(decoded.accessCount).toBe(input.accessCount);
    expect(decoded.pinned).toBe(false);
    const encoded = Schema.encodeSync(MindMemory)(decoded);
    expect(encoded.text).toBe(input.text);
  });

  it("rejects text longer than the max", () => {
    const tooLong = "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS + 1);
    expect(
      decodes(MindMemory, {
        ...validMemory(),
        text: tooLong,
      }),
    ).toBe(false);
  });

  it("accepts text exactly at the max", () => {
    const exact = "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS);
    expect(
      decodes(MindMemory, {
        ...validMemory(),
        text: exact,
      }),
    ).toBe(true);
  });

  it("rejects weights outside [0, 1]", () => {
    expect(
      decodes(MindMemory, {
        ...validMemory(),
        weight: -0.01,
      }),
    ).toBe(false);
    expect(
      decodes(MindMemory, {
        ...validMemory(),
        weight: 1.01,
      }),
    ).toBe(false);
  });

  it("accepts boundary weights", () => {
    expect(decodeSync(MindMemory, { ...validMemory(), weight: 0 }).weight).toBe(0);
    expect(decodeSync(MindMemory, { ...validMemory(), weight: 1 }).weight).toBe(1);
  });
});

describe("MindJournalOp", () => {
  it.each(["remember", "reinforce", "confirm", "forget", "pin", "unpin", "prune"] as const)(
    "accepts %s",
    (op) => {
      expect(Schema.decodeUnknownSync(MindJournalOp)(op)).toBe(op);
    },
  );

  it("rejects unknown journal ops", () => {
    expect(() => Schema.decodeUnknownSync(MindJournalOp)("archive")).toThrow();
  });
});

describe("MindJournalEntry", () => {
  it("decodes a valid journal row with null turnId", () => {
    const entry = decodeSync(MindJournalEntry, {
      memoryId: makeMemoryId(),
      projectId: makeProjectId(),
      turnId: null,
      op: "remember",
      weightDelta: 0.02,
      createdAt: isoNow(),
    });
    expect(entry.turnId).toBeNull();
    expect(entry.weightDelta).toBe(0.02);
  });

  it("decodes an entry with an optional weightDelta", () => {
    const entry = decodeSync(MindJournalEntry, {
      memoryId: makeMemoryId(),
      projectId: makeProjectId(),
      turnId: makeTurnId(),
      op: "confirm",
      createdAt: isoNow(),
    });
    expect(entry.weightDelta).toBeUndefined();
  });
});

describe("MindRememberInput", () => {
  it("decodes and encodes a valid remember request", () => {
    const input = {
      projectId: makeProjectId(),
      threadId: makeThreadId(),
      turnId: makeTurnId(),
      text: "Use FTS5 for memory search.",
    };
    const decoded = decodeSync(MindRememberInput, input);
    expect(decoded.text).toBe(input.text);
    expect(decoded.threadId).toBe(input.threadId);
    expect(decoded.turnId).toBe(input.turnId);
    const encoded = Schema.encodeSync(MindRememberInput)(decoded);
    expect(encoded.text).toBe(input.text);
  });

  it("decodes without optional threadId or turnId", () => {
    const input = {
      projectId: makeProjectId(),
      text: "A standalone memory.",
    };
    const decoded = decodeSync(MindRememberInput, input);
    expect(decoded.threadId).toBeUndefined();
    expect(decoded.turnId).toBeUndefined();
  });

  it("rejects text beyond the schema max", () => {
    const tooLong = "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS * 2 + 1);
    expect(
      decodes(MindRememberInput, {
        projectId: makeProjectId(),
        text: tooLong,
      }),
    ).toBe(false);
  });

  it("accepts text within the schema max", () => {
    const text = "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS * 2);
    expect(
      decodes(MindRememberInput, {
        projectId: makeProjectId(),
        text,
      }),
    ).toBe(true);
  });
});

describe("MindRememberResult", () => {
  it("decodes created and reinforced statuses", () => {
    const input = {
      memory: validMemory(),
      status: "created",
    };
    expect(decodeSync(MindRememberResult, input).status).toBe("created");
    expect(decodeSync(MindRememberResult, { ...input, status: "reinforced" }).status).toBe(
      "reinforced",
    );
  });
});

describe("MindRecallInput and Result", () => {
  it("decodes a recall query", () => {
    const input = {
      projectId: makeProjectId(),
      query: "FTS5",
    };
    const decoded = decodeSync(MindRecallInput, input);
    expect(decoded.query).toBe("FTS5");
  });

  it("decodes a recall result within item and digest bounds", () => {
    const memory = validMemory();
    const matches = Array.from({ length: MIND_RECALL_MAX_ITEMS }, () => ({
      memory,
      rank: 1,
      decayedWeight: 0.5,
    }));
    const input = {
      items: matches,
      digest: "x".repeat(MIND_RECALL_MAX_DIGEST_CHARS),
    };
    const decoded = decodeSync(MindRecallResult, input);
    expect(decoded.items.length).toBe(MIND_RECALL_MAX_ITEMS);
    expect(decoded.digest.length).toBe(MIND_RECALL_MAX_DIGEST_CHARS);
  });

  it("rejects too many recall matches", () => {
    const memory = validMemory();
    const matches = Array.from({ length: MIND_RECALL_MAX_ITEMS + 1 }, () => ({
      memory,
      rank: 1,
      decayedWeight: 0.5,
    }));
    expect(
      decodes(MindRecallResult, {
        items: matches,
        digest: "short",
      }),
    ).toBe(false);
  });

  it("rejects a digest over the max", () => {
    const memory = validMemory();
    expect(
      decodes(MindRecallResult, {
        items: [{ memory, rank: 1, decayedWeight: 0.5 }],
        digest: "x".repeat(MIND_RECALL_MAX_DIGEST_CHARS + 1),
      }),
    ).toBe(false);
  });
});

describe("MindMemoryMatch", () => {
  it("decodes a match", () => {
    const memory = validMemory();
    const match = decodeSync(MindMemoryMatch, { memory, rank: 0.75, decayedWeight: 0.6 });
    expect(match.memory.text).toBe(memory.text);
    expect(match.rank).toBe(0.75);
    expect(match.decayedWeight).toBe(0.6);
  });
});

describe("MindConfirmInput and Result", () => {
  it("decodes a confirm request", () => {
    const input = {
      projectId: makeProjectId(),
      memoryId: makeMemoryId(),
      turnId: makeTurnId(),
    };
    const decoded = decodeSync(MindConfirmInput, input);
    expect(decoded.memoryId).toBe(input.memoryId);
  });

  it("decodes a confirm result", () => {
    const input = {
      memory: validMemory(),
      alreadyConfirmedInTurn: true,
    };
    const decoded = decodeSync(MindConfirmResult, input);
    expect(decoded.alreadyConfirmedInTurn).toBe(true);
  });
});

describe("MindForgetInput and Result", () => {
  it("decodes a forget request and result", () => {
    const input = {
      projectId: makeProjectId(),
      memoryId: makeMemoryId(),
    };
    expect(decodeSync(MindForgetInput, input).memoryId).toBe(input.memoryId);
    expect(decodeSync(MindForgetResult, { deleted: true }).deleted).toBe(true);
  });
});

describe("MindPinInput and Result", () => {
  it("decodes pin requests", () => {
    const input = {
      projectId: makeProjectId(),
      memoryId: makeMemoryId(),
      pinned: true,
    };
    const decoded = decodeSync(MindPinInput, input);
    expect(decoded.pinned).toBe(true);
    expect(decodeSync(MindPinResult, { memory: validMemory() }).memory.pinned).toBe(false);
  });
});

describe("MindPruneResult", () => {
  it("decodes a list of deleted ids", () => {
    const ids = [makeMemoryId(), makeMemoryId()];
    const decoded = decodeSync(MindPruneResult, { deletedIds: ids });
    expect(decoded.deletedIds).toEqual(ids);
  });
});

describe("MindPruneInput", () => {
  it("decodes a prune request", () => {
    const input = { projectId: makeProjectId() };
    const decoded = decodeSync(MindPruneInput, input);
    expect(decoded.projectId).toBe(input.projectId);
  });
});

describe("MindListInput and Result", () => {
  it("decodes a list request with an optional query", () => {
    const input = {
      projectId: makeProjectId(),
      query: "search",
    };
    const decoded = decodeSync(MindListInput, input);
    expect(decoded.query).toBe("search");
  });

  it("decodes a list result", () => {
    const input = {
      memories: [validMemory()],
    };
    const decoded = decodeSync(MindListResult, input);
    expect(decoded.memories.length).toBe(1);
  });
});

describe("MindError", () => {
  it("is a tagged error with message and code", () => {
    const error = new MindError({ message: "cap reached", code: "mind.memory-cap-reached" });
    expect(error.message).toBe("cap reached");
    expect(error.code).toBe("mind.memory-cap-reached");
    expect(Schema.is(MindError)(error)).toBe(true);
  });
});
