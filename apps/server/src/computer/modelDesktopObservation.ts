import { AsyncLocalStorage } from "node:async_hooks";

const observation = new AsyncLocalStorage<{ active: boolean }>();

export function isModelDesktopObservationActive(): boolean {
  return observation.getStore()?.active === true;
}

/** Detached continuations lose observation authority when their operation ends. */
export async function withModelDesktopObservation<A>(observe: () => Promise<A>): Promise<A> {
  const scope = { active: true };
  try {
    return await observation.run(scope, observe);
  } finally {
    scope.active = false;
  }
}
