// FILE: environmentRoutingCoverage.test-d.ts
// Purpose: Break the BUILD when a thread-scoped NativeApi method is added
//          without a routing decision.
// Layer: Web transport routing tests (type-level)
//
// WHY THIS IS A TYPE TEST AND NOT A RUNTIME ONE
//
// The previous runtime check filtered the contract through a hand-written list
// of the same seven method names the implementation used, so a method missing
// from BOTH lists agreed with itself and passed. Four holes in this epic have
// now shipped behind exactly that shape.
//
// Here the thread-scoped set is DERIVED BY THE COMPILER from the NativeApi
// contract — a method whose first argument structurally carries `threadId` is
// thread-scoped, whatever it is named and whoever adds it. Nothing in this file
// restates that set. The only hand-written input is the routing DECISION
// (route it, or excuse it as local-only), which is the thing a human must
// actually make. Leave a thread-scoped method out of both tables and
// `bun typecheck` fails; it cannot ship.

import type { NativeApi } from "@synara/contracts";

import { LOCAL_ONLY_THREAD_METHODS, ROUTED_METHODS } from "./environmentRoutedApi";

/** The declared input of a NativeApi method, or `never` for zero-arg methods. */
type FirstArgument<F> = F extends (input: infer I, ...rest: never[]) => unknown ? I : never;

/**
 * Methods of one API group whose input names a thread.
 *
 * Structural, not nominal: any new input type carrying `threadId: string` is
 * caught, with no schema list to keep in sync. Methods whose `threadId` is
 * OPTIONAL are intentionally excluded here — they are server-wide queries that
 * merely accept a thread filter, and `createEnvironmentRoutedApi` routes them
 * per-call when the caller does supply one.
 */
type ThreadScopedMethods<Group> = {
  [Method in keyof Group]: FirstArgument<Group[Method]> extends { readonly threadId: string }
    ? Method
    : never;
}[keyof Group];

/** `"terminal.write" | "provider.compactThread" | ...` across the whole contract. */
type ThreadScopedByContract = {
  [Group in keyof NativeApi]: ThreadScopedMethods<NativeApi[Group]> extends never
    ? never
    : `${Group & string}.${ThreadScopedMethods<NativeApi[Group]> & string}`;
}[keyof NativeApi];

/** `"terminal.write" | ...` for whatever a decision table actually lists. */
type DeclaredIn<Table> = {
  [Group in keyof Table]: Table[Group] extends ReadonlyArray<infer Method>
    ? `${Group & string}.${Method & string}`
    : never;
}[keyof Table];

type DecidedMethods =
  | DeclaredIn<typeof ROUTED_METHODS>
  | DeclaredIn<typeof LOCAL_ONLY_THREAD_METHODS>;

/**
 * Every thread-scoped method in the contract has a routing decision.
 *
 * When this line errors, TypeScript names the offending method in the message:
 * a method whose input carries `threadId` was added without deciding where it
 * runs. Add it to `ROUTED_METHODS` (it acts on the thread's host) or to
 * `LOCAL_ONLY_THREAD_METHODS` with a comment saying why it belongs on the
 * user's own machine. Do not silence this by widening the types.
 */
const _everyThreadScopedMethodHasARoutingDecision: never = null as unknown as Exclude<
  ThreadScopedByContract,
  DecidedMethods
>;
void _everyThreadScopedMethodHasARoutingDecision;

/**
 * Nothing is listed that the contract does not actually consider thread-scoped.
 *
 * Guards the other direction: routing a method whose input has no `threadId`
 * would send it to an arbitrary environment, and stale entries left behind
 * after a contract change would rot silently.
 */
const _nothingRoutedThatIsNotThreadScoped: never = null as unknown as Exclude<
  DeclaredIn<typeof ROUTED_METHODS>,
  // `dispatchCommand`'s argument IS the command (a union whose thread-scoped
  // members carry `threadId`), and `listProviderDeliveryBlockers` takes an
  // OPTIONAL thread filter. Both are routed per-call at runtime instead.
  | ThreadScopedByContract
  | "orchestration.dispatchCommand"
  | "orchestration.listProviderDeliveryBlockers"
>;
void _nothingRoutedThatIsNotThreadScoped;
