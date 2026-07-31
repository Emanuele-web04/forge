/**
 * Provider-neutral ACP session-config interpretation, shared by the Droid and
 * OMP ACP support modules.
 *
 * @module AcpConfigOptions
 */
import { type ProviderModelDescriptor } from "@synara/contracts";
import type * as Acp from "@agentclientprotocol/sdk";

export function availableAuthMethodIds(
  initializeResult: Acp.InitializeResponse,
): ReadonlySet<string> {
  return new Set((initializeResult.authMethods ?? []).map((method) => method.id.trim()));
}

export function flattenConfigOptions(
  options: Acp.SessionConfigSelectOptions,
): ReadonlyArray<Acp.SessionConfigSelectOption> {
  return options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

export function findSelectConfig(
  options: ReadonlyArray<Acp.SessionConfigOption>,
  input: { readonly id: string; readonly category: string },
): Extract<Acp.SessionConfigOption, { readonly type: "select" }> | undefined {
  return options.find(
    (option): option is Extract<Acp.SessionConfigOption, { readonly type: "select" }> =>
      option.type === "select" && (option.id === input.id || option.category === input.category),
  );
}

export function buildAcpModelDescriptor(
  model: Acp.SessionConfigSelectOption,
  levelOption: Extract<Acp.SessionConfigOption, { readonly type: "select" }> | undefined,
): ProviderModelDescriptor {
  const efforts = levelOption ? flattenConfigOptions(levelOption.options) : [];
  const optionDescriptors = levelOption
    ? [
        {
          id: "reasoningEffort",
          label: levelOption.name,
          type: "select" as const,
          options: efforts.map((effort) => ({
            id: effort.value,
            label: effort.name,
            ...(effort.description ? { description: effort.description } : {}),
          })),
          ...(levelOption.currentValue ? { currentValue: levelOption.currentValue } : {}),
        },
      ]
    : undefined;
  return {
    slug: model.value,
    name: model.name,
    ...(model.description ? { description: model.description } : {}),
    supportedReasoningEfforts: efforts.map((effort) => ({
      value: effort.value,
      label: effort.name,
      ...(effort.description ? { description: effort.description } : {}),
    })),
    ...(optionDescriptors ? { optionDescriptors } : {}),
    supportsFastMode: false,
    supportsThinkingToggle: false,
  };
}
