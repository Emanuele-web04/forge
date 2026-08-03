// FILE: ui/src/instance.ts
// Purpose: Loads /api/v1/instance so pages render only the auth methods this
// deployment actually has configured.
// Layer: Account UI data access
// Depends on: @synara/contracts (type only).

import type { InstanceInfo } from "@synara/contracts";
import { useEffect, useState } from "react";

export type SocialProvider = InstanceInfo["authMethods"]["social"][number];

export type InstanceState =
  | { status: "loading" }
  | { status: "ready"; instance: InstanceInfo }
  | { status: "error"; message: string };

// Module-level cache: every ceremony page needs the instance, and a user
// bouncing between /login and /signup should not re-fetch it each time.
let cached: InstanceInfo | undefined;
let inFlight: Promise<InstanceInfo> | undefined;

export async function fetchInstance(): Promise<InstanceInfo> {
  if (cached) return cached;
  inFlight ??= (async () => {
    const res = await fetch("/api/v1/instance", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Instance info unavailable (${res.status})`);
    const body = (await res.json()) as InstanceInfo;
    cached = body;
    return body;
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

export function useInstance(): InstanceState {
  const [state, setState] = useState<InstanceState>(
    cached ? { status: "ready", instance: cached } : { status: "loading" },
  );

  useEffect(() => {
    if (cached) return;
    let active = true;
    fetchInstance()
      .then((instance) => {
        if (active) setState({ status: "ready", instance });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not reach this Synara instance.",
        });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}
