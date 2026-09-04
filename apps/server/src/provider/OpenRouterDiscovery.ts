// FILE: OpenRouterDiscovery.ts
// Purpose: Fetches models directly from the OpenRouter API and normalizes them
//          to Synara's ProviderModelDescriptor format.
// Layer: Server provider domain
// Exports: fetchOpenRouterModels, OpenRouterModelDto
//
// This module provides a supplementary model source for providers (Pi, OpenCode)
// so that newly released OpenRouter models appear in the model picker without
// waiting for a Synara, Pi extension, or OpenCode CLI update.

import {
  type ProviderModelDescriptor,
  type ProviderReasoningEffortDescriptor,
} from "@synara/contracts";
import { outboundHttp, decodeOutboundJson } from "@synara/shared/outboundHttp";

// ── DTO matching OpenRouter's GET /api/v1/models response ─────────────

interface OpenRouterModelDto {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly context_length?: number | null;
  readonly pricing?: {
    readonly prompt?: string;
    readonly completion?: string;
  } | null;
  readonly architecture?: {
    readonly modality?: string;
  } | null;
}

interface OpenRouterModelsResponse {
  readonly data: ReadonlyArray<OpenRouterModelDto>;
}

// ── Constants ─────────────────────────────────────────────────────────

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_ORIGIN = "openrouter.ai";
const OPENROUTER_SERVICE_NAME = "openrouter-discovery";
const DISCOVERY_TIMEOUT_MS = 15_000;

// ── Fetch and normalize OpenRouter models ────────────────────────────

/**
 * Fetches all models from the OpenRouter API and normalizes them into
 * Synara's ProviderModelDescriptor format.
 *
 * Returns an empty array on network failure, timeout, or parse error —
 * never throws, so callers can treat it as a best-effort supplement.
 */
export async function fetchOpenRouterModels(): Promise<
  ReadonlyArray<ProviderModelDescriptor>
> {
  try {
    const response = await outboundHttp.request({
      policy: {
        service: OPENROUTER_SERVICE_NAME,
        allowedOrigins: [OPENROUTER_ORIGIN],
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        maxRequestBytes: 1024,
        maxResponseBytes: 1024 * 1024, // 1 MB — OpenRouter's model list is ~700 KB
        maxRedirects: 0,
        maxConcurrent: 2,
        maxQueued: 4,
        requirePublicAddress: true,
      },
      url: OPENROUTER_MODELS_URL,
      method: "GET",
    });

    if (response.status < 200 || response.status >= 300) {
      return [];
    }

    const parsed = decodeOutboundJson(response, { maxDepth: 8, maxNodes: 200_000 }) as
      | OpenRouterModelsResponse
      | undefined;
    if (!parsed || !Array.isArray(parsed.data)) {
      return [];
    }

    return parsed.data
      .map((dto) => toProviderModelDescriptor(dto))
      .filter((descriptor): descriptor is ProviderModelDescriptor => descriptor !== null);
  } catch {
    // Network errors, timeouts, DNS failures — return empty, never throw.
    return [];
  }
}

// ── Convert a single OpenRouter DTO ───────────────────────────────────

function toProviderModelDescriptor(
  dto: OpenRouterModelDto,
): ProviderModelDescriptor | null {
  const id = dto.id?.trim();
  const name = dto.name?.trim();
  if (!id || !name) {
    return null;
  }

  // Slug matches the convention used by Pi adapter for upstream provider models:
  //   provider/model-id (e.g. "openrouter/openai/gpt-4o")
  const slug = `openrouter/${id}`;

  // Build reasoning descriptors if the model has pricing data (signals it's
  // a real model, not a router or special endpoint) or supports reasoning.
  const supportedReasoningEfforts = inferReasoningEfforts(dto);
  const defaultReasoningEffort =
    supportedReasoningEfforts.length > 0 ? "high" : undefined;

  return {
    slug,
    name,
    ...(dto.description?.trim() ? { description: dto.description.trim() } : {}),
    upstreamProviderId: "openrouter",
    upstreamProviderName: "OpenRouter",
    ...(supportedReasoningEfforts.length > 0
      ? { supportedReasoningEfforts }
      : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
  };
}

// ── Infer reasoning support from model metadata ───────────────────────

/**
 * OpenRouter doesn't expose reasoning support in the list endpoint directly.
 * We infer it from known reasoning-model patterns and context length.
 * Models with very large context (> 500k) or "reasoning" in the name/description
 * are flagged with a reasonable effort ladder.
 */
function inferReasoningEfforts(
  dto: OpenRouterModelDto,
): ReadonlyArray<ProviderReasoningEffortDescriptor> {
  const id = dto.id.toLowerCase();
  const name = dto.name.toLowerCase();
  const desc = (dto.description ?? "").toLowerCase();
  const context = dto.context_length ?? 0;

  const isReasoningModel =
    id.includes("reasoning") ||
    name.includes("reasoning") ||
    desc.includes("reasoning") ||
    desc.includes("thinking") ||
    desc.includes("deepseek-r1") ||
    desc.includes("deepseek-r1") ||
    id.includes("claude-opus") ||
    id.includes("claude-sonnet") ||
    id.includes("claude-fable") ||
    id.includes("o1") ||
    id.includes("o3") ||
    id.includes("deepseek-reasoner");

  if (isReasoningModel || context > 500_000) {
    return [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra High" },
    ];
  }

  return [];
}