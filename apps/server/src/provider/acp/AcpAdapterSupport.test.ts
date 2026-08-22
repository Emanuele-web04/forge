import { describe, expect, it } from "vitest";
import * as AcpErrors from "./AcpErrors.ts";

import {
  acpPermissionOutcome,
  canonicalItemTypeFromAcpToolKind,
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  resolveAcpFullAccessPermissionOutcome,
  resolveAcpPermissionPolicy,
  selectAcpFullAccessPermissionOptionId,
  selectAcpPermissionOptionId,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps every ACP tool kind to its canonical runtime item type", () => {
    expect(
      ["execute", "edit", "delete", "move", "fetch", "search", "read", undefined].map((kind) => [
        kind,
        canonicalItemTypeFromAcpToolKind(kind),
      ]),
    ).toEqual([
      ["execute", "command_execution"],
      ["edit", "file_change"],
      ["delete", "file_change"],
      ["move", "file_change"],
      ["fetch", "web_search"],
      ["search", "dynamic_tool_call"],
      ["read", "dynamic_tool_call"],
      [undefined, "dynamic_tool_call"],
    ]);
  });

  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("selects the provider's real permission option id for approval decisions", () => {
    const options = [
      { kind: "reject_once", optionId: "deny-now" },
      { kind: "allow_once", optionId: "allow-this-tool" },
      { kind: "allow_always", optionId: "allow-session" },
    ] as const;

    expect(selectAcpPermissionOptionId("accept", options)).toBe("allow-this-tool");
    expect(selectAcpPermissionOptionId("acceptForSession", options)).toBe("allow-session");
    expect(selectAcpPermissionOptionId("decline", options)).toBe("deny-now");
    expect(selectAcpPermissionOptionId("cancel", options)).toBeUndefined();
  });

  it("prefers request-scoped Full Access approvals and falls back to persistent grants", () => {
    expect(
      selectAcpFullAccessPermissionOptionId([
        { kind: "allow_once", optionId: "allow-once" },
        { kind: "allow_always", optionId: "allow-session" },
      ]),
    ).toBe("allow-once");
    expect(
      selectAcpFullAccessPermissionOptionId([{ kind: "allow_always", optionId: "allow-session" }]),
    ).toBe("allow-session");
  });

  it("keeps Full Access operational with the allow options offered by the provider", () => {
    expect(
      resolveAcpFullAccessPermissionOutcome([{ kind: "allow_always", optionId: "allow-session" }]),
    ).toEqual({ outcome: "selected", optionId: "allow-session" });
    expect(
      resolveAcpFullAccessPermissionOutcome([{ kind: "reject_once", optionId: "deny-now" }]),
    ).toEqual({ outcome: "cancelled" });
  });

  it("keeps Plan above Full Access and releases the gate for the next default turn", () => {
    const options = [
      { kind: "allow_once", optionId: "implement-once" },
      { kind: "allow_always", optionId: "implement-always" },
      { kind: "reject_once", optionId: "stay-in-plan" },
    ] as const;

    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "full-access",
        interactionMode: "plan",
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "stay-in-plan" });
    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "full-access",
        interactionMode: "plan",
        options: [{ kind: "allow_always", optionId: "implement" }],
      }),
    ).toEqual({ outcome: "cancelled" });
    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "full-access",
        interactionMode: "default",
        options,
      }),
    ).toEqual({ outcome: "selected", optionId: "implement-once" });
  });

  it("surfaces Default prompts only for active approval-required turns", () => {
    const options = [{ kind: "allow_once", optionId: "allow" }] as const;

    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "approval-required",
        interactionMode: "default",
        options,
      }),
    ).toBeUndefined();
    expect(
      resolveAcpPermissionPolicy({
        runtimeMode: "full-access",
        interactionMode: undefined,
        options,
      }),
    ).toEqual({ outcome: "cancelled" });
  });

  it("reads failed ACP tool details without treating successful tools as failures", () => {
    expect(
      readAcpFailedToolDetail({
        status: "failed",
        detail: " Failed to request permission ",
        title: "Shell",
      }),
    ).toBe("Failed to request permission");
    expect(readAcpFailedToolDetail({ status: "failed", title: "Shell failed" })).toBe(
      "Shell failed",
    );
    expect(readAcpFailedToolDetail({ status: "failed" })).toBe("Tool call failed.");
    expect(readAcpFailedToolDetail({ status: "completed", detail: "ignored" })).toBeUndefined();
  });

  it("classifies provider-cancelled turns with failed tools as failed", () => {
    expect(
      classifyAcpPromptTurnCompletion({
        stopReason: "cancelled",
        failedToolDetail: "Failed to request permission from user",
      }),
    ).toEqual({
      state: "failed",
      errorMessage: "Failed to request permission from user",
    });
    expect(classifyAcpPromptTurnCompletion({ stopReason: "cancelled" })).toEqual({
      state: "cancelled",
    });
    expect(
      classifyAcpPromptTurnCompletion({
        stopReason: "end_turn",
        failedToolDetail: "Recovered tool failure",
      }),
    ).toEqual({ state: "completed" });
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      "cursor",
      "thread-1" as never,
      "session/prompt",
      new AcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });

  it("surfaces provider detail from generic ACP internal errors", () => {
    const error = mapAcpToAdapterError(
      "droid",
      "thread-1" as never,
      "session/prompt",
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Internal error: Agent error",
        data: '402 {"title":"Payment Required"}',
      }),
    );

    expect(error.message).toContain('402 {"title":"Payment Required"}');
    expect(error.message).not.toContain("Internal error: Agent error");
  });

  it("preserves filesystem detail from ACP persistence errors", () => {
    const error = mapAcpToAdapterError(
      "grok",
      "thread-1" as never,
      "session/start",
      new AcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Path not found.",
        data: {
          code: "FS_NOT_FOUND",
          detail: "No such file or directory (os error 2)",
        },
      }),
    );

    expect(error.message).toContain("Path not found.");
    expect(error.message).toContain("No such file or directory (os error 2)");
  });
});
