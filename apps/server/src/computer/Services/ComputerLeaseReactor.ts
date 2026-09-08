import { Effect, Scope, ServiceMap } from "effect";

export interface ComputerLeaseReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ComputerLeaseReactor extends ServiceMap.Service<
  ComputerLeaseReactor,
  ComputerLeaseReactorShape
>()("synara/computer/Services/ComputerLeaseReactor") {}
