import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Schema } from "effect";

import type { McpConsumerBinding } from "../consumerBinding.ts";
import { PARATY_MCP_PRESET } from "./paraty.ts";

export type OutboundMcpPreset = {
  readonly id: string;
  readonly displayName: string;
  readonly endpoint: URL;
  readonly clientMetadata: OAuthClientMetadata;
  readonly publicClientId?: string;
  readonly consumers: ReadonlyArray<McpConsumerBinding<string>>;
};

export class OutboundMcpPresetError extends Schema.TaggedErrorClass<OutboundMcpPresetError>()(
  "OutboundMcpPresetError",
  { category: Schema.String },
) {
  override get message(): string {
    return `Outbound MCP preset is unavailable (${this.category}).`;
  }
}

export type OutboundMcpPresetRegistry = {
  readonly all: () => ReadonlyArray<OutboundMcpPreset>;
  readonly get: (presetId: string) => OutboundMcpPreset | null;
  readonly getConsumer: (
    consumerId: string,
  ) => { readonly preset: OutboundMcpPreset; readonly binding: McpConsumerBinding<string> } | null;
};

function validatePreset(preset: OutboundMcpPreset): void {
  if (
    preset.id.trim() === "" ||
    preset.displayName.trim() === "" ||
    preset.endpoint.protocol !== "https:" ||
    preset.endpoint.username !== "" ||
    preset.endpoint.password !== "" ||
    preset.clientMetadata.redirect_uris.length !== 0 ||
    preset.publicClientId?.trim() === ""
  ) {
    throw new OutboundMcpPresetError({ category: "invalid-preset" });
  }
}

export function makeOutboundMcpPresetRegistry(
  presets: ReadonlyArray<OutboundMcpPreset>,
): OutboundMcpPresetRegistry {
  const byId = new Map<string, OutboundMcpPreset>();
  const consumers = new Map<
    string,
    { readonly preset: OutboundMcpPreset; readonly binding: McpConsumerBinding<string> }
  >();
  for (const preset of presets) {
    validatePreset(preset);
    if (byId.has(preset.id)) {
      throw new OutboundMcpPresetError({ category: "duplicate-preset" });
    }
    byId.set(preset.id, preset);
    for (const binding of preset.consumers) {
      if (!binding.presetIds.has(preset.id)) {
        throw new OutboundMcpPresetError({ category: "invalid-consumer" });
      }
      if (consumers.has(binding.id)) {
        throw new OutboundMcpPresetError({ category: "duplicate-consumer" });
      }
      consumers.set(binding.id, { preset, binding });
    }
  }
  const ordered = [...byId.values()];
  return {
    all: () => ordered,
    get: (presetId) => byId.get(presetId) ?? null,
    getConsumer: (consumerId) => consumers.get(consumerId) ?? null,
  };
}

export const OUTBOUND_MCP_PRESETS = makeOutboundMcpPresetRegistry([PARATY_MCP_PRESET]);

export { PARATY_MCP_PRESET } from "./paraty.ts";
