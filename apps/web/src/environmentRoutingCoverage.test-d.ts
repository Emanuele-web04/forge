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

import {
  CWD_LOCAL_OR_THREAD_ROUTED_METHODS,
  CWD_ROUTED_METHODS,
  LOCAL_ONLY_THREAD_METHODS,
  PROJECT_LOCAL_OR_OTHER_ROUTED_METHODS,
  PROJECT_ROUTED_METHODS,
  ROUTED_METHODS,
} from "./environmentRoutedApi";

/** The declared input of a NativeApi method, or `never` for zero-arg methods. */
type FirstArgument<F> = F extends (input: infer I, ...rest: never[]) => unknown ? I : never;

/**
 * Methods of one group whose input carries `Key`, REQUIRED OR OPTIONAL.
 *
 * One matcher for every ownership key, so adding a key category below is a
 * single line rather than a new hand-written block that can be narrower than
 * the one beside it. The three holes this check has already had were all the
 * same mistake — a match that saw fewer shapes than it appeared to — and three
 * near-identical blocks is how the fourth would arrive.
 */
type MethodsWithKey<Group, Key extends string> = {
  [Method in keyof Group]: FirstArgument<Group[Method]> extends Record<Key, string>
    ? Method
    : undefined extends FirstArgument<Group[Method]>
      ? never
      : FirstArgument<Group[Method]> extends Partial<Record<Key, string | undefined>>
        ? [FirstArgument<Group[Method]>] extends [never]
          ? never
          : Method
        : never;
}[keyof Group];

/** `"group.method"` for every method in the contract carrying `Key`. */
type ByContract<Key extends string> = {
  [Group in keyof NativeApi]: MethodsWithKey<NativeApi[Group], Key> extends never
    ? never
    : `${Group & string}.${MethodsWithKey<NativeApi[Group], Key> & string}`;
}[keyof NativeApi];

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

/**
 * Methods of one API group whose input names a bare filesystem path.
 *
 * Same structural derivation as the thread-scoped set, and the reason it must
 * exist: a `cwd` carries no host identity, so one of these left unrouted does
 * not fail — it silently succeeds against the wrong machine's checkout.
 *
 * THIS CHECK HAS ALREADY HAD THAT BUG ITSELF. It first matched only a REQUIRED
 * `{ readonly cwd: string }`, which structurally cannot see `cwd?:`. Six
 * path-scoped methods — `filesystem.browse` and five provider discovery calls —
 * were therefore unrouted behind a check reporting full coverage, and nothing
 * errored, which is the only reason it survived review. The guard was asserting
 * a completeness it did not have.
 *
 * The lesson is about the SHAPE of the failure, not the fix: a structural match
 * is only as complete as the shapes it enumerates, and every shape it omits is
 * invisible BY CONSTRUCTION rather than merely untested. Narrowing the match
 * below — dropping the optional branch, requiring a more specific type —
 * reopens the hole silently. Widen it when in doubt; a false positive costs a
 * table entry, a false negative costs someone's working tree.
 *
 * KNOWN LIMIT OF THIS CHECK: it only sees a path carried as a FIELD of the
 * first argument. `shell.openInEditor(cwd, editor)` passes it POSITIONALLY and
 * is therefore invisible here, as would be any future method shaped that way.
 * All three `shell.*` methods are desktop surfaces on the user's own machine
 * (open an editor, open a browser, reveal in Finder) and are refused on a
 * remote host by `editor-launch` / `desktop-dialogs` in
 * environmentCapabilities.ts rather than routed — so the gap is covered today,
 * but it is covered by a refusal a human wrote, NOT by this check. A new
 * positional-path method would slip through silently. Prefer an input object
 * for anything new that names a path.
 */
type CwdScopedByContract = ByContract<"cwd">;

type CwdDecidedMethods =
  | DeclaredIn<typeof CWD_ROUTED_METHODS>
  | DeclaredIn<typeof CWD_LOCAL_OR_THREAD_ROUTED_METHODS>;

/**
 * Every `cwd`-keyed method in the contract has a routing decision.
 *
 * When this errors, TypeScript names the method: one whose input carries `cwd`
 * was added without deciding whose filesystem it means. Add it to
 * `CWD_ROUTED_METHODS` (route it by path ownership) or to
 * `CWD_LOCAL_OR_THREAD_ROUTED_METHODS` with a comment saying what routes it
 * instead. Do not silence this by widening the types — the failure it prevents
 * is a write landing on the wrong machine's checkout, which nothing at runtime
 * will catch, because it succeeds.
 */
const _everyCwdScopedMethodHasARoutingDecision: never = null as unknown as Exclude<
  CwdScopedByContract,
  CwdDecidedMethods
>;
void _everyCwdScopedMethodHasARoutingDecision;

/** Nothing is path-routed that the contract does not actually key by `cwd`. */
const _nothingCwdRoutedThatIsNotCwdScoped: never = null as unknown as Exclude<
  DeclaredIn<typeof CWD_ROUTED_METHODS>,
  CwdScopedByContract
>;
void _nothingCwdRoutedThatIsNotCwdScoped;

/**
 * No method is routed by BOTH its id and its path.
 *
 * Two routing rules for one call can disagree, and the order they run in would
 * silently decide which machine a write lands on. `terminal.open`,
 * `terminal.restart` and `git.handoffThread` carry a `cwd` AND a `threadId`;
 * the id is the more specific key, so they stay in `ROUTED_METHODS` and are
 * excused from path routing.
 */
const _nothingIsRoutedTwice: never = null as unknown as Extract<
  DeclaredIn<typeof ROUTED_METHODS>,
  DeclaredIn<typeof CWD_ROUTED_METHODS>
>;
void _nothingIsRoutedTwice;

/**
 * Every `projectId`-keyed method in the contract has a routing decision.
 *
 * The THIRD ownership key, added after the panel found eight project-scoped
 * methods executing locally: stopping a remote project's dev server killed
 * nothing while the real process kept running, and a pull-request action was
 * attempted against the local server's idea of the repository.
 *
 * Uses the same `ByContract` matcher as `cwd` rather than a third hand-written
 * block. That is the actual lesson from this check's history: it has been
 * narrower than it looked three times — required-only, then positional, then
 * missing a key category entirely — and near-identical blocks that can drift
 * apart is how the fourth would arrive.
 */
type ProjectScopedByContract = ByContract<"projectId">;

const _everyProjectScopedMethodHasARoutingDecision: never = null as unknown as Exclude<
  ProjectScopedByContract,
  | DeclaredIn<typeof PROJECT_ROUTED_METHODS>
  | DeclaredIn<typeof PROJECT_LOCAL_OR_OTHER_ROUTED_METHODS>
  // `dispatchCommand`'s argument is the command union; its project-scoped
  // members are routed per-call at runtime by `resolveCallEnvironmentId`.
  | "orchestration.dispatchCommand"
>;
void _everyProjectScopedMethodHasARoutingDecision;

/** Nothing is project-routed that the contract does not actually key that way. */
const _nothingProjectRoutedThatIsNotProjectScoped: never = null as unknown as Exclude<
  DeclaredIn<typeof PROJECT_ROUTED_METHODS>,
  ProjectScopedByContract
>;
void _nothingProjectRoutedThatIsNotProjectScoped;

/**
 * No method is routed by BOTH its project and its path.
 *
 * Same hazard as the id/path pair: two rules for one call, with evaluation
 * order silently deciding the host. `projects.runDevServer` carries both and
 * stays path-routed.
 */
const _nothingIsProjectAndPathRouted: never = null as unknown as Extract<
  DeclaredIn<typeof PROJECT_ROUTED_METHODS>,
  DeclaredIn<typeof CWD_ROUTED_METHODS>
>;
void _nothingIsProjectAndPathRouted;
