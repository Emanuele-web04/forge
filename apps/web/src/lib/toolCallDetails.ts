// FILE: toolCallDetails.ts
// Purpose: Extract bounded command/edit details from provider tool lifecycle payloads.
// Layer: Web transcript data utility
// Exports: deriveWorkLogToolDetails, mergeWorkLogToolDetails
// Depends on: provider runtime item metadata already truncated by server ingestion

import type { ToolLifecycleItemType } from "@synara/contracts";
import { stripTrailingToolExitCode as stripTrailingExitCode } from "@synara/shared/toolOutputSummary";

type WorkLogRequestKind = "command" | "file-read" | "file-change" | "permissions" | "tool";

export interface WorkLogToolOutputDetails {
  output?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
}

export interface WorkLogToolEditDetails {
  path?: string;
  oldText?: string;
  newText?: string;
}

export interface WorkLogToolDetails {
  kind: "command" | "file-change";
  title: string;
  command?: string;
  output?: WorkLogToolOutputDetails;
  diff?: string;
  content?: string;
  edits?: ReadonlyArray<WorkLogToolEditDetails>;
  files?: ReadonlyArray<string>;
}

export interface DeriveWorkLogToolDetailsInput {
  payload: Record<string, unknown> | null;
  itemType?: ToolLifecycleItemType | undefined;
  requestKind?: WorkLogRequestKind | undefined;
  command?: string | undefined;
  rawCommand?: string | undefined;
  detail?: string | undefined;
  changedFiles?: ReadonlyArray<string> | undefined;
  label: string;
  toolTitle?: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function firstOutputText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    if (value.trim().length === 0) {
      continue;
    }
    return value;
  }
  return undefined;
}

function asRawOutputRecord(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) {
    return record;
  }
  const output = firstOutputText(value);
  return output !== undefined ? { output } : null;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = asFiniteNumber(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

function outputText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return stripTrailingExitCode(value).output ?? undefined;
}

function outputExitCode(value: unknown): number | undefined {
  const normalized = asTrimmedString(value);
  return normalized ? stripTrailingExitCode(normalized).exitCode : undefined;
}

function commandEqualsDetail(command: string | undefined, detail: string | undefined): boolean {
  if (!command || !detail) {
    return false;
  }
  return command.trim() === stripTrailingExitCode(detail).output;
}

// Collects command output without stringifying the full payload; ingestion already bounds each field.
function extractToolOutputDetails(input: {
  payload: Record<string, unknown> | null;
  detail?: string | undefined;
  command?: string | undefined;
}): WorkLogToolOutputDetails | undefined {
  const data = asRecord(input.payload?.data);
  const rawOutput = asRawOutputRecord(data?.rawOutput);
  const rawOutputDetails = asRecord(rawOutput?.details);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const result = asRecord(data?.result);
  const partialResult = asRecord(data?.partialResult);
  const stdout = outputText(
    firstOutputText(
      rawOutput?.stdout,
      rawOutput?.out,
      data?.stdout,
      itemResult?.stdout,
      result?.stdout,
    ),
  );
  const stderr = outputText(
    firstOutputText(
      rawOutput?.stderr,
      rawOutput?.err,
      data?.stderr,
      itemResult?.stderr,
      result?.stderr,
    ),
  );
  let output = outputText(
    firstOutputText(
      rawOutput?.output,
      rawOutput?.content,
      data?.output,
      itemResult?.output,
      itemResult?.content,
      result?.output,
      result?.content,
      partialResult?.output,
      partialResult?.content,
      rawOutputDetails?.output,
    ),
  );
  if (
    !stdout &&
    !stderr &&
    !output &&
    input.detail &&
    !commandEqualsDetail(input.command, input.detail)
  ) {
    output = stripTrailingExitCode(input.detail).output ?? undefined;
  }
  const exitCode = firstNumber(
    rawOutput?.exitCode,
    rawOutput?.code,
    data?.exitCode,
    itemResult?.exitCode,
    result?.exitCode,
    outputExitCode(input.detail),
  );
  const truncated = rawOutput?.truncated === true || data?.__synaraTruncated === true;
  if (!stdout && !stderr && !output && exitCode === undefined && !truncated) {
    return undefined;
  }
  return {
    ...(output ? { output } : {}),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

function extractUnifiedDiff(payload: Record<string, unknown> | null): string | undefined {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputDetails = asRecord(rawOutput?.details);
  const result = asRecord(data?.result);
  const resultDetails = asRecord(result?.details);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  return firstString(
    data?.unifiedDiff,
    data?.diff,
    data?.patch,
    rawOutput?.unifiedDiff,
    rawOutput?.diff,
    rawOutput?.patch,
    rawOutputDetails?.unifiedDiff,
    rawOutputDetails?.diff,
    rawOutputDetails?.patch,
    result?.unifiedDiff,
    result?.diff,
    result?.patch,
    resultDetails?.unifiedDiff,
    resultDetails?.diff,
    resultDetails?.patch,
    itemResult?.unifiedDiff,
    itemResult?.diff,
    itemResult?.patch,
  );
}

function extractWriteContent(payload: Record<string, unknown> | null): string | undefined {
  const data = asRecord(payload?.data);
  const input = asRecord(data?.input);
  const rawInput = asRecord(data?.rawInput);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  return firstString(
    data?.content,
    input?.content,
    rawInput?.content,
    item?.content,
    itemInput?.content,
  );
}

function editText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractEditPath(record: Record<string, unknown>): string | undefined {
  return firstString(
    record.path,
    record.filePath,
    record.file_path,
    record.filename,
    record.file,
    record.relativePath,
  );
}

function normalizeEditEntry(value: unknown): WorkLogToolEditDetails | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const path = extractEditPath(record);
  const oldText = editText(
    record.oldText ?? record.old_string ?? record.oldString ?? record.before ?? record.original,
  );
  const newText = editText(
    record.newText ?? record.new_string ?? record.newString ?? record.after ?? record.replacement,
  );
  if (oldText === undefined && newText === undefined) {
    return undefined;
  }
  return {
    ...(path ? { path } : {}),
    ...(oldText !== undefined ? { oldText } : {}),
    ...(newText !== undefined ? { newText } : {}),
  };
}

function collectEditEntries(value: unknown, target: WorkLogToolEditDetails[]) {
  if (!Array.isArray(value)) {
    const edit = normalizeEditEntry(value);
    if (edit) {
      target.push(edit);
    }
    return;
  }
  for (const entry of value) {
    const edit = normalizeEditEntry(entry);
    if (edit) {
      target.push(edit);
    }
  }
}

function dedupeEditEntries(edits: ReadonlyArray<WorkLogToolEditDetails>): WorkLogToolEditDetails[] {
  const seen = new Set<string>();
  const deduped: WorkLogToolEditDetails[] = [];
  for (const edit of edits) {
    const key = JSON.stringify([edit.path ?? "", edit.oldText ?? "", edit.newText ?? ""]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(edit);
  }
  return deduped;
}

function extractEditEntries(payload: Record<string, unknown> | null): WorkLogToolEditDetails[] {
  const data = asRecord(payload?.data);
  const input = asRecord(data?.input);
  const rawInput = asRecord(data?.rawInput);
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const edits: WorkLogToolEditDetails[] = [];
  collectEditEntries(data?.edits, edits);
  collectEditEntries(input?.edits, edits);
  collectEditEntries(rawInput?.edits, edits);
  collectEditEntries(item?.edits, edits);
  collectEditEntries(itemInput?.edits, edits);
  collectEditEntries(rawInput, edits);
  collectEditEntries(input, edits);
  return dedupeEditEntries(edits);
}

function detailsTitle(input: DeriveWorkLogToolDetailsInput): string {
  return input.toolTitle ?? input.label;
}

function shouldBuildCommandDetails(input: DeriveWorkLogToolDetailsInput): boolean {
  return (
    input.requestKind === "command" ||
    input.itemType === "command_execution" ||
    Boolean(input.command)
  );
}

function shouldBuildFileChangeDetails(input: DeriveWorkLogToolDetailsInput): boolean {
  return input.requestKind === "file-change" || input.itemType === "file_change";
}

export function deriveWorkLogToolDetails(
  input: DeriveWorkLogToolDetailsInput,
): WorkLogToolDetails | undefined {
  const command = input.rawCommand ?? input.command;
  if (shouldBuildCommandDetails(input)) {
    const output = extractToolOutputDetails({
      payload: input.payload,
      detail: input.detail,
      command,
    });
    if (!command && !output) {
      return undefined;
    }
    return {
      kind: "command",
      title: detailsTitle(input),
      ...(command ? { command } : {}),
      ...(output ? { output } : {}),
    };
  }

  if (!shouldBuildFileChangeDetails(input)) {
    return undefined;
  }
  const diff = extractUnifiedDiff(input.payload);
  const content = extractWriteContent(input.payload);
  const edits = extractEditEntries(input.payload);
  const output = extractToolOutputDetails({
    payload: input.payload,
    command: undefined,
  });
  const files = input.changedFiles?.length ? input.changedFiles : undefined;
  if (!diff && !content && edits.length === 0 && !output) {
    return undefined;
  }
  return {
    kind: "file-change",
    title: detailsTitle(input),
    ...(diff ? { diff } : {}),
    ...(content ? { content } : {}),
    ...(edits.length > 0 ? { edits } : {}),
    ...(files ? { files } : {}),
    ...(output ? { output } : {}),
  };
}

function mergeStringArrays(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> | undefined {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function mergeOutputs(
  left: WorkLogToolOutputDetails | undefined,
  right: WorkLogToolOutputDetails | undefined,
): WorkLogToolOutputDetails | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...(left.output || right.output ? { output: right.output ?? left.output } : {}),
    ...(left.stdout || right.stdout ? { stdout: right.stdout ?? left.stdout } : {}),
    ...(left.stderr || right.stderr ? { stderr: right.stderr ?? left.stderr } : {}),
    ...(left.exitCode !== undefined || right.exitCode !== undefined
      ? { exitCode: right.exitCode ?? left.exitCode }
      : {}),
    ...(left.truncated === true || right.truncated === true ? { truncated: true } : {}),
  };
}

export function mergeWorkLogToolDetails(
  left: WorkLogToolDetails | undefined,
  right: WorkLogToolDetails | undefined,
): WorkLogToolDetails | undefined {
  if (!left) return right;
  if (!right) return left;
  if (left.kind !== right.kind) return right;
  const output = mergeOutputs(left.output, right.output);
  const files = mergeStringArrays(left.files, right.files);
  return {
    kind: right.kind,
    title: right.title || left.title,
    ...((right.command ?? left.command) ? { command: right.command ?? left.command } : {}),
    ...(output ? { output } : {}),
    ...((right.diff ?? left.diff) ? { diff: right.diff ?? left.diff } : {}),
    ...((right.content ?? left.content) ? { content: right.content ?? left.content } : {}),
    ...((right.edits ?? left.edits) ? { edits: right.edits ?? left.edits } : {}),
    ...(files ? { files } : {}),
  };
}
