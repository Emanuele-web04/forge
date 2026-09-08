// FILE: subagents.ts
// Purpose: Shared parsing helpers for subagent runtime payloads used by server ingestion and web UI.
// Exports: Payload decoders for receiver ids, receiver agents, agent states, and identity hints.

export interface ParsedSubagentReceiverAgent {
  providerThreadId: string;
  agentId?: string | undefined;
  nickname?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  background?: boolean | undefined;
  prompt?: string | undefined;
  modelIsRequestedHint?: boolean | undefined;
}

export interface ParsedSubagentAgentState {
  threadId: string;
  agentId?: string | undefined;
  nickname?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  prompt?: string | undefined;
  status?: string | undefined;
  message?: string | undefined;
}

export interface ParsedSubagentIdentityHint {
  providerThreadId?: string | undefined;
  agentId?: string | undefined;
  nickname?: string | undefined;
  role?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  background?: boolean | undefined;
  prompt?: string | undefined;
  status?: string | undefined;
  message?: string | undefined;
  modelIsRequestedHint?: boolean | undefined;
}

export interface ParsedSubagentIdentityDirectory {
  readonly byProviderThreadId: ReadonlyMap<string, ParsedSubagentIdentityHint>;
  readonly byAgentId: ReadonlyMap<string, ParsedSubagentIdentityHint>;
}

// Internal agent definitions that only exist to carry effort (already surfaced
// separately); they must never render as a subagent role/nickname suffix.
const WORKER_TIER_ROLE_PATTERN = /^worker-(?:low|medium|high|xhigh)$/i;

export function isWorkerTierSubagentRole(role: string | null | undefined): boolean {
  return typeof role === "string" && WORKER_TIER_ROLE_PATTERN.test(role.trim());
}

function sanitizeSubagentRole(role: string | undefined): string | undefined {
  return role !== undefined && isWorkerTierSubagentRole(role) ? undefined : role;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstStringValue(
  object: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!object) {
    return undefined;
  }
  for (const key of keys) {
    const value = asTrimmedString(object[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function extractSubagentIdentityFromSource(
  item: Record<string, unknown>,
): ParsedSubagentIdentityHint | null {
  const source = asRecord(item.source);
  const subagent =
    asRecord(source?.subAgent) ?? asRecord(source?.sub_agent) ?? asRecord(item.subAgent);
  const threadSpawn = asRecord(subagent?.thread_spawn) ?? asRecord(subagent?.threadSpawn);
  const providerThreadId =
    asTrimmedString(
      item.threadId ??
        item.thread_id ??
        item.conversationId ??
        item.conversation_id ??
        item.receiverThreadId ??
        item.receiver_thread_id,
    ) ?? firstStringValue(threadSpawn, ["threadId", "thread_id"]);
  const agentId =
    asTrimmedString(item.agentId ?? item.agent_id ?? item.id) ??
    firstStringValue(threadSpawn, ["agentId", "agent_id", "id"]) ??
    firstStringValue(subagent, ["agentId", "agent_id", "id"]);
  const nickname =
    firstStringValue(item, ["agentNickname", "agent_nickname", "nickname"]) ??
    firstStringValue(threadSpawn, ["agentNickname", "agent_nickname", "nickname", "name"]) ??
    firstStringValue(subagent, ["agentNickname", "agent_nickname", "nickname", "name"]);
  const role = sanitizeSubagentRole(
    firstStringValue(item, ["agentRole", "agent_role", "agentType", "agent_type"]) ??
      firstStringValue(threadSpawn, ["agentRole", "agent_role", "agentType", "agent_type"]) ??
      firstStringValue(subagent, ["agentRole", "agent_role", "agentType", "agent_type"]),
  );

  if (!providerThreadId && !agentId && !nickname && !role) {
    return null;
  }

  return {
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(nickname ? { nickname } : {}),
    ...(role ? { role } : {}),
  };
}

function pushUniqueThreadId(
  target: string[],
  seen: Set<string>,
  threadId: string | undefined,
): void {
  if (!threadId || seen.has(threadId)) {
    return;
  }
  seen.add(threadId);
  target.push(threadId);
}

function normalizeSubagentIdentifier(value: unknown): string | undefined {
  return asTrimmedString(value);
}

export function decodeSubagentReceiverThreadIds(
  item: Record<string, unknown> | null | undefined,
): ReadonlyArray<string> {
  if (!item) {
    return [];
  }
  const plural = ["receiverThreadIds", "receiver_thread_ids", "threadIds", "thread_ids"] as const;
  for (const key of plural) {
    const values = asArray(item[key]);
    if (!values) {
      continue;
    }
    const threadIds = values
      .map((value) => normalizeSubagentIdentifier(value))
      .filter((value): value is string => value !== undefined);
    if (threadIds.length > 0) {
      return threadIds;
    }
  }

  const singular = firstStringValue(item, [
    "receiverThreadId",
    "receiver_thread_id",
    "threadId",
    "thread_id",
    "newThreadId",
    "new_thread_id",
  ]);
  return singular ? [singular] : [];
}

export function decodeSubagentReceiverAgents(
  item: Record<string, unknown>,
  fallbackThreadIds: ReadonlyArray<string>,
): ReadonlyArray<ParsedSubagentReceiverAgent> {
  const topLevelModel = firstStringValue(item, [
    "model",
    "modelName",
    "model_name",
    "requestedModel",
    "requested_model",
  ]);
  const topLevelEffort = firstStringValue(item, ["effort", "reasoningEffort", "reasoning_effort"]);
  const topLevelPrompt = firstStringValue(item, ["prompt", "task", "message"]);
  const agentsValue =
    asArray(item.receiverAgents) ?? asArray(item.receiver_agents) ?? asArray(item.agents);
  const decodedAgents =
    agentsValue?.flatMap((entry, index) => {
      const object = asRecord(entry);
      if (!object) {
        return [];
      }

      const providerThreadId =
        firstStringValue(object, [
          "threadId",
          "thread_id",
          "receiverThreadId",
          "receiver_thread_id",
          "newThreadId",
          "new_thread_id",
        ]) ??
        fallbackThreadIds[index] ??
        undefined;
      if (!providerThreadId) {
        return [];
      }

      const agentId = firstStringValue(object, [
        "agentId",
        "agent_id",
        "receiverAgentId",
        "receiver_agent_id",
        "newAgentId",
        "new_agent_id",
        "id",
      ]);
      const nickname = firstStringValue(object, [
        "agentNickname",
        "agent_nickname",
        "receiverAgentNickname",
        "receiver_agent_nickname",
        "newAgentNickname",
        "new_agent_nickname",
        "nickname",
        "name",
      ]);
      const role = sanitizeSubagentRole(
        firstStringValue(object, [
          "agentRole",
          "agent_role",
          "receiverAgentRole",
          "receiver_agent_role",
          "newAgentRole",
          "new_agent_role",
          "agentType",
          "agent_type",
        ]),
      );
      const directModel = firstStringValue(object, ["model", "modelName", "model_name"]);
      const requestedModel = firstStringValue(object, ["requestedModel", "requested_model"]);
      const model = directModel ?? requestedModel ?? topLevelModel;
      const effort =
        firstStringValue(object, ["effort", "reasoningEffort", "reasoning_effort"]) ??
        topLevelEffort;
      const background = object.background === true || item.background === true;
      const prompt = firstStringValue(object, ["prompt", "task", "message"]) ?? topLevelPrompt;

      return [
        {
          providerThreadId,
          ...(agentId ? { agentId } : {}),
          ...(nickname ? { nickname } : {}),
          ...(role ? { role } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(background ? { background } : {}),
          ...(prompt ? { prompt } : {}),
          ...(model && !directModel ? { modelIsRequestedHint: true } : {}),
        },
      ];
    }) ?? [];

  if (decodedAgents.length > 0) {
    return decodedAgents;
  }

  const providerThreadId = fallbackThreadIds[0];
  if (!providerThreadId) {
    return [];
  }

  const agentId = firstStringValue(item, ["newAgentId", "new_agent_id", "agentId", "agent_id"]);
  const nickname = firstStringValue(item, [
    "newAgentNickname",
    "new_agent_nickname",
    "agentNickname",
    "agent_nickname",
    "receiverAgentNickname",
    "receiver_agent_nickname",
  ]);
  const role = sanitizeSubagentRole(
    firstStringValue(item, [
      "receiverAgentRole",
      "receiver_agent_role",
      "newAgentRole",
      "new_agent_role",
      "agentRole",
      "agent_role",
      "agentType",
      "agent_type",
    ]),
  );

  return [
    {
      providerThreadId,
      ...(agentId ? { agentId } : {}),
      ...(nickname ? { nickname } : {}),
      ...(role ? { role } : {}),
      ...(topLevelModel ? { model: topLevelModel, modelIsRequestedHint: true } : {}),
      ...(topLevelEffort ? { effort: topLevelEffort } : {}),
      ...(item.background === true ? { background: true } : {}),
      ...(topLevelPrompt ? { prompt: topLevelPrompt } : {}),
    },
  ];
}

function buildSubagentAgentState(
  threadId: string,
  object: Record<string, unknown> | null,
): ParsedSubagentAgentState {
  const agentId = firstStringValue(object, ["agentId", "agent_id"]);
  const nickname = firstStringValue(object, [
    "agentNickname",
    "agent_nickname",
    "receiverAgentNickname",
    "receiver_agent_nickname",
  ]);
  const role = sanitizeSubagentRole(
    firstStringValue(object, [
      "agentRole",
      "agent_role",
      "receiverAgentRole",
      "receiver_agent_role",
      "agentType",
      "agent_type",
    ]),
  );
  const model = firstStringValue(object, [
    "model",
    "modelName",
    "model_name",
    "requestedModel",
    "requested_model",
  ]);
  const prompt = firstStringValue(object, ["prompt", "task", "message"]);
  const status = firstStringValue(object, ["status", "state"]);
  const message = firstStringValue(object, ["summary", "message", "latestUpdate", "latest_update"]);

  return {
    threadId,
    ...(agentId ? { agentId } : {}),
    ...(nickname ? { nickname } : {}),
    ...(role ? { role } : {}),
    ...(model ? { model } : {}),
    ...(prompt ? { prompt } : {}),
    ...(status ? { status } : {}),
    ...(message ? { message } : {}),
  };
}

export function decodeSubagentAgentStates(
  item: Record<string, unknown> | null | undefined,
): Record<string, ParsedSubagentAgentState> {
  const candidate =
    asRecord(item?.statuses) ??
    asRecord(item?.agentsStates) ??
    asRecord(item?.agents_states) ??
    asRecord(item?.agentStates) ??
    asRecord(item?.agent_states);
  if (candidate) {
    const decoded: Record<string, ParsedSubagentAgentState> = {};
    for (const [rawThreadId, rawValue] of Object.entries(candidate)) {
      const object = asRecord(rawValue);
      const threadId =
        asTrimmedString(rawThreadId) ?? firstStringValue(object, ["threadId", "thread_id"]);
      if (!threadId) {
        continue;
      }
      decoded[threadId] = buildSubagentAgentState(threadId, object);
    }
    return decoded;
  }

  const values =
    asArray(item?.agentStatuses) ?? asArray(item?.agent_statuses) ?? asArray(item?.statuses);
  if (!values) {
    return {};
  }

  const decoded: Record<string, ParsedSubagentAgentState> = {};
  for (const rawValue of values) {
    const object = asRecord(rawValue);
    const threadId = firstStringValue(object, ["threadId", "thread_id"]);
    if (!threadId) {
      continue;
    }
    decoded[threadId] = buildSubagentAgentState(threadId, object);
  }
  return decoded;
}

export function collectSubagentProviderThreadIds(
  item: Record<string, unknown>,
): ReadonlyArray<string> {
  const orderedThreadIds: string[] = [];
  const seen = new Set<string>();

  for (const threadId of decodeSubagentReceiverThreadIds(item)) {
    pushUniqueThreadId(orderedThreadIds, seen, threadId);
  }
  for (const agent of decodeSubagentReceiverAgents(item, orderedThreadIds)) {
    pushUniqueThreadId(orderedThreadIds, seen, agent.providerThreadId);
  }
  for (const threadId of Object.keys(decodeSubagentAgentStates(item))) {
    pushUniqueThreadId(orderedThreadIds, seen, threadId);
  }

  const sourceIdentity = extractSubagentIdentityFromSource(item);
  pushUniqueThreadId(orderedThreadIds, seen, sourceIdentity?.providerThreadId);

  pushUniqueThreadId(
    orderedThreadIds,
    seen,
    firstStringValue(item, [
      "newThreadId",
      "new_thread_id",
      "receiverThreadId",
      "receiver_thread_id",
    ]),
  );

  return orderedThreadIds;
}

export function extractSubagentIdentityHints(
  item: Record<string, unknown>,
): ReadonlyArray<ParsedSubagentIdentityHint> {
  const hints: ParsedSubagentIdentityHint[] = [];
  const seen = new Set<string>();

  const pushHint = (hint: ParsedSubagentIdentityHint | null | undefined) => {
    if (!hint) {
      return;
    }
    const key = [
      hint.providerThreadId ?? "",
      hint.agentId ?? "",
      hint.nickname ?? "",
      hint.role ?? "",
      hint.model ?? "",
      hint.effort ?? "",
      hint.background ? "1" : "0",
      hint.prompt ?? "",
      hint.status ?? "",
      hint.message ?? "",
      hint.modelIsRequestedHint ? "1" : "0",
    ].join("\u0001");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    hints.push(hint);
  };

  pushHint(extractSubagentIdentityFromSource(item));
  pushHint({
    providerThreadId: firstStringValue(item, [
      "newThreadId",
      "new_thread_id",
      "receiverThreadId",
      "receiver_thread_id",
      "threadId",
      "thread_id",
    ]),
    agentId: firstStringValue(item, [
      "newAgentId",
      "new_agent_id",
      "receiverAgentId",
      "receiver_agent_id",
      "agentId",
      "agent_id",
    ]),
    nickname: firstStringValue(item, [
      "newAgentNickname",
      "new_agent_nickname",
      "receiverAgentNickname",
      "receiver_agent_nickname",
      "agentNickname",
      "agent_nickname",
      "nickname",
    ]),
    role: sanitizeSubagentRole(
      firstStringValue(item, [
        "newAgentRole",
        "new_agent_role",
        "receiverAgentRole",
        "receiver_agent_role",
        "agentRole",
        "agent_role",
        "agentType",
        "agent_type",
      ]),
    ),
  });

  const receiverThreadIds = decodeSubagentReceiverThreadIds(item);
  for (const receiverAgent of decodeSubagentReceiverAgents(item, receiverThreadIds)) {
    pushHint(receiverAgent);
  }

  for (const state of Object.values(decodeSubagentAgentStates(item))) {
    pushHint({
      providerThreadId: state.threadId,
      agentId: state.agentId,
      nickname: state.nickname,
      role: state.role,
      model: state.model,
      prompt: state.prompt,
      status: state.status,
      message: state.message,
    });
  }

  return hints.filter(
    (hint) =>
      hint.providerThreadId !== undefined ||
      hint.agentId !== undefined ||
      hint.nickname !== undefined ||
      hint.role !== undefined,
  );
}

function selectMergedModel(input: {
  existing: ParsedSubagentIdentityHint | undefined;
  incoming: ParsedSubagentIdentityHint;
}): {
  model: string | undefined;
  modelIsRequestedHint: boolean | undefined;
} {
  const existingModel = input.existing?.model;
  const incomingModel = input.incoming.model;
  if (!incomingModel) {
    return {
      model: existingModel,
      modelIsRequestedHint: input.existing?.modelIsRequestedHint,
    };
  }
  if (
    input.incoming.modelIsRequestedHint === true &&
    existingModel !== undefined &&
    input.existing?.modelIsRequestedHint !== true
  ) {
    return {
      model: existingModel,
      modelIsRequestedHint: input.existing?.modelIsRequestedHint,
    };
  }
  return {
    model: incomingModel,
    modelIsRequestedHint: input.incoming.modelIsRequestedHint,
  };
}

function mergeSubagentIdentityHints(
  existing: ParsedSubagentIdentityHint | undefined,
  incoming: ParsedSubagentIdentityHint,
): ParsedSubagentIdentityHint {
  const mergedModel = selectMergedModel({ existing, incoming });
  return {
    providerThreadId: incoming.providerThreadId ?? existing?.providerThreadId,
    agentId: incoming.agentId ?? existing?.agentId,
    nickname: incoming.nickname ?? existing?.nickname,
    role: incoming.role ?? existing?.role,
    model: mergedModel.model,
    effort: incoming.effort ?? existing?.effort,
    background: incoming.background ?? existing?.background,
    prompt: incoming.prompt ?? existing?.prompt,
    status: incoming.status ?? existing?.status,
    message: incoming.message ?? existing?.message,
    modelIsRequestedHint: mergedModel.modelIsRequestedHint,
  };
}

export function buildSubagentIdentityDirectory(
  hints: ReadonlyArray<ParsedSubagentIdentityHint>,
): ParsedSubagentIdentityDirectory {
  const byProviderThreadId = new Map<string, ParsedSubagentIdentityHint>();
  const byAgentId = new Map<string, ParsedSubagentIdentityHint>();

  const upsert = (hint: ParsedSubagentIdentityHint) => {
    const providerThreadId = asTrimmedString(hint.providerThreadId);
    const agentId = asTrimmedString(hint.agentId);
    if (
      providerThreadId === undefined &&
      agentId === undefined &&
      hint.nickname === undefined &&
      hint.role === undefined
    ) {
      return;
    }

    const existingByThread = providerThreadId
      ? byProviderThreadId.get(providerThreadId)
      : undefined;
    const existingByAgent = agentId ? byAgentId.get(agentId) : undefined;
    const existing =
      existingByAgent !== undefined
        ? mergeSubagentIdentityHints(existingByThread, existingByAgent)
        : existingByThread;
    const merged = mergeSubagentIdentityHints(existing, {
      ...hint,
      ...(providerThreadId ? { providerThreadId } : {}),
      ...(agentId ? { agentId } : {}),
    });

    if (providerThreadId) {
      byProviderThreadId.set(providerThreadId, merged);
    }
    if (agentId) {
      byAgentId.set(agentId, merged);
    }
    if (merged.providerThreadId && merged.agentId) {
      byProviderThreadId.set(merged.providerThreadId, merged);
      byAgentId.set(merged.agentId, merged);
    }
  };

  for (const hint of hints) {
    upsert(hint);
  }

  return {
    byProviderThreadId,
    byAgentId,
  };
}

export function resolveSubagentIdentityFromDirectory(
  directory: ParsedSubagentIdentityDirectory,
  input: {
    providerThreadId?: string | null | undefined;
    agentId?: string | null | undefined;
  },
): ParsedSubagentIdentityHint | undefined {
  const normalizedProviderThreadId = asTrimmedString(input.providerThreadId);
  const normalizedAgentId = asTrimmedString(input.agentId);
  const threadEntry = normalizedProviderThreadId
    ? directory.byProviderThreadId.get(normalizedProviderThreadId)
    : undefined;
  const agentEntry = normalizedAgentId ? directory.byAgentId.get(normalizedAgentId) : undefined;
  if (!threadEntry && !agentEntry) {
    return undefined;
  }

  return mergeSubagentIdentityHints(agentEntry, {
    ...threadEntry,
    providerThreadId:
      threadEntry?.providerThreadId ?? agentEntry?.providerThreadId ?? normalizedProviderThreadId,
    agentId: threadEntry?.agentId ?? agentEntry?.agentId ?? normalizedAgentId,
  });
}
