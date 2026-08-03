// FILE: ui/src/components/InstanceGate.tsx
// Purpose: Holds a page behind the instance fetch so no auth method is ever
// rendered before we know the deployment offers it.
// Layer: Account UI presentation
// Depends on: instance hook, Shell, Notice.

import type { InstanceInfo } from "@synara/contracts";
import type { ReactNode } from "react";
import { useInstance } from "../instance";
import { Notice, Spinner } from "./Field";
import { Shell } from "./Shell";

export function InstanceGate({
  children,
}: {
  children: (instance: InstanceInfo) => ReactNode;
}): ReactNode {
  const state = useInstance();

  if (state.status === "loading") {
    return (
      <Shell title="Connecting" subtitle="Checking how this instance signs people in.">
        <div className="flex justify-center py-6 text-ink-faint">
          <Spinner />
        </div>
      </Shell>
    );
  }

  if (state.status === "error") {
    return (
      <Shell title="Instance unreachable">
        <div className="space-y-4">
          <Notice tone="error">{state.message}</Notice>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            The account service did not answer. Check that it is running, then reload this page.
          </p>
        </div>
      </Shell>
    );
  }

  return <>{children(state.instance)}</>;
}
