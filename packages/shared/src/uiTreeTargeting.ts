/**
 * Resolving a label to the one accessibility node it means.
 *
 * Two families ask this question — the iOS simulator's UIKit tree and the Linux
 * desktop's AT-SPI tree — and each used to answer it with its own copy of the
 * same algorithm. The algorithm is the same either way, so it lives here once
 * and each family supplies only the parts that genuinely differ: what a node's
 * label is, what counts as its role, how two labels are compared, and how it
 * decides a node is on screen.
 *
 * Two rules carry most of the value, and they are the reason this is one module
 * rather than a convention:
 *
 * - An exact label wins outright over a longer one that merely contains it. A
 *   screen showing both "Developer" and "Developer Mode" must not be ambiguous
 *   when the caller said "Developer".
 * - Ambiguity is refused, never guessed. Taking the first of several matches is
 *   a coin flip the caller cannot see, so the refusal names the candidates and
 *   lets them narrow it instead.
 *
 * Nothing here throws on its own behalf: both refusals are built by the calling
 * family, because the error type, the wording, and how many candidates are worth
 * naming are all things the transport to the agent decides.
 *
 * @module uiTreeTargeting
 */

export interface UiTreeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface UiTreePoint {
  readonly x: number;
  readonly y: number;
}

/** Depth-first, parents before children — the order candidate lists are capped in. */
export function flattenUiTree<TNode>(
  root: TNode,
  childrenOf: (node: TNode) => readonly TNode[],
): readonly TNode[] {
  const nodes: TNode[] = [];
  const visit = (node: TNode): void => {
    nodes.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return nodes;
}

/**
 * Where an interaction with this node lands: its own control point when it has
 * one, else the centre of its frame.
 *
 * The control point is not a refinement. UIKit merges a settings row and the
 * switch inside it into a single element whose frame spans the row, so the frame
 * centre of a switch row is dead space that swallows the tap.
 */
export function uiTreeActivationPoint(node: {
  readonly frame: UiTreeRect;
  readonly activationPoint?: UiTreePoint | null | undefined;
}): UiTreePoint {
  return (
    node.activationPoint ?? {
      x: node.frame.x + node.frame.width / 2,
      y: node.frame.y + node.frame.height / 2,
    }
  );
}

/** What the caller asked for. Both parts are optional; a family may require either. */
export interface UiTreeQuery {
  readonly label?: string | undefined;
  readonly role?: string | undefined;
}

export interface UiTreeTargetMatch<TNode> {
  /** False when the match is real but outside the usable area of the display. */
  readonly onScreen: boolean;
  readonly node: TNode;
}

/** Everything the two families disagree about, and nothing they agree on. */
export interface UiTreeTargetSpec<TNode> {
  /** The text this node answers to; the empty string for a node with none. */
  readonly labelOf: (node: TNode) => string;
  /** Whether the node answers to a requested role. */
  readonly matchesRole: (node: TNode, role: string) => boolean;
  /**
   * Both sides of the "did this label match at all" test pass through this, so
   * each family decides for itself whether case and surrounding space matter.
   */
  readonly matchKey: (label: string) => string;
  /**
   * Both sides of the "is this the label, exactly" test. Kept separate from
   * `matchKey` because the two families disagree about how strict promotion to an
   * exact match should be, and folding them together would silently move one of
   * them.
   */
  readonly exactKey: (label: string) => string;
  readonly isOnScreen: (node: TNode) => boolean;
  /**
   * Judge ambiguity among the on-screen matches first.
   *
   * A long list that repeats one label down its length is otherwise
   * unresolvable, when in practice the one the human can see is the one meant.
   * Off for a family whose ambiguity refusal is meant to name every match,
   * on-screen or not.
   */
  readonly preferOnScreen: boolean;
  /** The refusal for a query nothing matched. `pool` is everything considered. */
  readonly noMatch: (pool: readonly TNode[]) => Error;
  /** The refusal for a query more than one node matched, after ranking. */
  readonly ambiguous: (matches: readonly TNode[]) => Error;
}

/**
 * The one node `query` names, or the family's refusal.
 *
 * `pool` is already flattened and already scoped — to labelled nodes, to one
 * window, to whatever the family considers eligible — because that scope is also
 * what the "nothing matched" refusal has to list, and deriving it twice is how
 * the two drift apart.
 */
export function resolveUiTreeTarget<TNode>(input: {
  readonly pool: readonly TNode[];
  readonly query: UiTreeQuery;
  readonly spec: UiTreeTargetSpec<TNode>;
}): UiTreeTargetMatch<TNode> {
  const { pool, query, spec } = input;
  const role = query.role;
  const byRole = role === undefined ? pool : pool.filter((node) => spec.matchesRole(node, role));
  const matches = query.label === undefined ? byRole : matchesForLabel(byRole, query.label, spec);
  if (matches.length === 0) throw spec.noMatch(pool);

  const ranked = spec.preferOnScreen ? preferOnScreenMatches(matches, spec) : matches;
  if (ranked.length > 1) throw spec.ambiguous(ranked);

  // `ranked` is non-empty: it is either `matches`, which was just checked, or the
  // on-screen subset, which `preferOnScreenMatches` only returns when it has
  // entries of its own.
  const node = ranked[0] as TNode;
  return { onScreen: spec.isOnScreen(node), node };
}

function matchesForLabel<TNode>(
  nodes: readonly TNode[],
  label: string,
  spec: UiTreeTargetSpec<TNode>,
): readonly TNode[] {
  const exact = spec.exactKey(label);
  const exactMatches = nodes.filter((node) => spec.exactKey(spec.labelOf(node)) === exact);
  if (exactMatches.length > 0) return exactMatches;
  const wanted = spec.matchKey(label);
  return nodes.filter((node) => spec.matchKey(spec.labelOf(node)).includes(wanted));
}

function preferOnScreenMatches<TNode>(
  matches: readonly TNode[],
  spec: UiTreeTargetSpec<TNode>,
): readonly TNode[] {
  const visible = matches.filter((node) => spec.isOnScreen(node));
  return visible.length > 0 ? visible : matches;
}
