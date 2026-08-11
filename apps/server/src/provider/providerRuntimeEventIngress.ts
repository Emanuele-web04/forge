import type { ProviderRuntimeEvent } from "@synara/contracts";

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

/**
 * Raw provider payloads are diagnostic data. Compact them before the callback
 * ingress so one pathological native message cannot consume the whole budget.
 */
export function compactProviderRuntimeEventForIngress(
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent {
  const originalBytes = providerRuntimeEventBytes(event);
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES || event.raw === undefined) {
    return event;
  }
  return {
    ...event,
    raw: {
      source: event.raw.source,
      ...(event.raw.method !== undefined ? { method: event.raw.method } : {}),
      ...(event.raw.messageType !== undefined ? { messageType: event.raw.messageType } : {}),
      payload: {
        synaraTruncated: true,
        reason: "provider runtime event exceeded the callback ingress size limit",
        originalBytes,
      },
    },
  };
}
