import type { ProviderRuntimeEvent } from "@synara/contracts";

import {
  sanitizeUnmappedProviderData,
  sanitizeUnmappedProviderDetail,
} from "./unmappedProviderEvents.ts";

export const PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE = 64;
export const PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES = 512 * 1024;

export function isTerminalProviderRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return event.type === "turn.completed" || event.type === "session.exited";
}

export function providerRuntimeEventBytes(event: ProviderRuntimeEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES + 1;
  }
}

function sanitizeUnmappedEventForIngress(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (event.type !== "event.unmapped") {
    return event;
  }
  const data =
    event.payload.data === undefined ? undefined : sanitizeUnmappedProviderData(event.payload.data);
  const detail = sanitizeUnmappedProviderDetail(event.payload.detail);
  return {
    ...event,
    payload: {
      ...event.payload,
      ...(detail === undefined ? {} : { detail }),
      ...(data === undefined ? {} : { data }),
    },
    ...(event.raw === undefined
      ? {}
      : {
          raw: {
            ...event.raw,
            payload: {
              synaraSanitized: true,
              reason: "unmapped provider payload retained in bounded event data",
            },
          },
        }),
  };
}

/**
 * Raw provider payloads are diagnostic data. Compact them before the callback
 * ingress so one pathological native message cannot consume the whole budget.
 */
export function compactProviderRuntimeEventForIngress(
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent {
  const sanitizedEvent = sanitizeUnmappedEventForIngress(event);
  const originalBytes = providerRuntimeEventBytes(sanitizedEvent);
  if (
    originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES ||
    sanitizedEvent.raw === undefined
  ) {
    return sanitizedEvent;
  }
  return {
    ...sanitizedEvent,
    raw: {
      source: sanitizedEvent.raw.source,
      ...(sanitizedEvent.raw.method !== undefined ? { method: sanitizedEvent.raw.method } : {}),
      ...(sanitizedEvent.raw.messageType !== undefined
        ? { messageType: sanitizedEvent.raw.messageType }
        : {}),
      payload: {
        synaraTruncated: true,
        reason: "provider runtime event exceeded the callback ingress size limit",
        originalBytes,
      },
    },
  };
}
