// FILE: check-migration-lineage.ts
// Purpose: Fail closed when a released migration's (id, name) tracker identity changes.
// Layer: CI preflight

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFile = "apps/server/src/persistence/Migrations.ts";

/**
 * Every shipped Synara database records its applied migrations as (id, name)
 * rows in `effect_sql_migrations`, and the runtime reconciler in
 * `Migrations.ts` treats a name that does not match the ID as a foreign
 * lineage: it truncates the tracker and replays the schema. Renumbering or
 * renaming a migration that a release already wrote therefore corrupts every
 * database from that release. v0.6.0 moved `ProjectPullRequestPins` from 54 to
 * 69 and did exactly that.
 *
 * Appending new migrations is always safe. This guard rejects changes to pairs
 * any reachable release tag already shipped — not just the newest one, because
 * a database is wedged by the release *it* was created under, and users skip
 * versions. A pair that today's `MIGRATION_LINEAGE_ALIASES` knows how to repair
 * is exempt: that divergence is handled rather than merely present.
 */

export interface MigrationLineageEntry {
  readonly id: number;
  readonly name: string;
}

export interface MigrationLineageViolation {
  readonly id: number;
  readonly releasedName: string;
  readonly currentName: string | null;
}

/** A released (id, name) pair whose divergence from today's lineage is handled. */
export interface MigrationLineageAllowance {
  readonly id: number;
  readonly name: string;
}

/**
 * Divergences that already shipped and that the runtime handles by a mechanism
 * other than `MIGRATION_LINEAGE_ALIASES`. Each entry is a reviewed claim that
 * upgrading such a database is safe today; nothing may be added here without
 * naming the mechanism that makes it so.
 *
 * These exist because the guard was written after the fact. New divergences are
 * not supposed to reach this list — append a migration instead.
 */
const HANDLED_RELEASED_DIVERGENCES: readonly MigrationLineageAllowance[] = [
  // v0.0.15 and older recorded these two at 17/18 before the slots were reused.
  // `LAST_SHARED_LINEAGE_MIGRATION_ID` sits at 16 precisely because of them: a
  // divergence above that boundary takes the replay path, and every migration
  // past 16 is idempotent, so replaying 17.. over such a database is safe.
  { id: 17, name: "ProjectionThreadsArchivedAt" },
  { id: 18, name: "ProjectionThreadsArchivedAtIndex" },
  // Renamed in place (not renumbered) during the Synara identity cutover, so
  // migration 32 is the same migration under a new name. `reconcileMigrationLineage`
  // renames the tracker row back to the canonical name whenever the rows below
  // it are canonical, which is the only way this pair can occur.
  { id: 32, name: "ReconcileLegacyT3SchemaImport" },
];

const entriesBlockPattern = /export const migrationEntries\s*=\s*\[([\s\S]*?)\]\s*as const;/u;
const entryPattern = /\[\s*(\d+)\s*,\s*"([^"]+)"/gu;
const aliasesBlockPattern = /export const MIGRATION_LINEAGE_ALIASES[^=]*=\s*\[([\s\S]*?)\n\];/u;
const aliasPattern = /historicalId:\s*(\d+),\s*(?:\/\/[^\n]*\n\s*)*historicalName:\s*"([^"]+)"/gu;

export function parseMigrationLineage(source: string): MigrationLineageEntry[] {
  const block = entriesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    throw new Error(`Could not locate the migrationEntries array in ${migrationsFile}.`);
  }
  const entries: MigrationLineageEntry[] = [];
  for (const match of block[1].matchAll(entryPattern)) {
    entries.push({ id: Number(match[1]), name: match[2]! });
  }
  if (entries.length === 0) {
    throw new Error(`Parsed zero migrations from ${migrationsFile}; the guard cannot verify it.`);
  }
  return entries;
}

/**
 * The (id, name) pairs the runtime reconciler can repair without replaying a
 * schema. Absent block means no aliases are declared, which is the normal state
 * — only a parsed-but-empty block would be suspicious, and that reads the same.
 */
export function parseMigrationLineageAllowances(source: string): MigrationLineageAllowance[] {
  const block = aliasesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    return [];
  }
  return [...block[1].matchAll(aliasPattern)].map((match) => ({
    id: Number(match[1]),
    name: match[2]!,
  }));
}

/**
 * Structural problems that make the lineage unusable regardless of history:
 * the Effect migrator rejects duplicate IDs outright, and out-of-order entries
 * mean the file no longer reads as an append-only log.
 */
export function findLineageStructureViolations(
  entries: readonly MigrationLineageEntry[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<number, string>();
  let previousId = 0;
  for (const entry of entries) {
    const duplicate = seen.get(entry.id);
    if (duplicate !== undefined) {
      problems.push(
        `Migration ${entry.id} is declared twice ("${duplicate}" and "${entry.name}").`,
      );
    }
    seen.set(entry.id, entry.name);
    if (entry.id <= previousId) {
      problems.push(`Migration ${entry.id} ("${entry.name}") is out of ascending order.`);
    }
    previousId = entry.id;
  }
  return problems;
}

export function findReleasedLineageViolations(
  released: readonly MigrationLineageEntry[],
  current: readonly MigrationLineageEntry[],
  allowances: readonly MigrationLineageAllowance[] = [],
): MigrationLineageViolation[] {
  const currentNamesById = new Map(current.map((entry) => [entry.id, entry.name]));
  const allowed = new Set(allowances.map((allowance) => `${allowance.id}:${allowance.name}`));
  const violations: MigrationLineageViolation[] = [];
  for (const entry of released) {
    const currentName = currentNamesById.get(entry.id);
    if (currentName === entry.name) continue;
    if (allowed.has(`${entry.id}:${entry.name}`)) continue;
    violations.push({
      id: entry.id,
      releasedName: entry.name,
      currentName: currentName ?? null,
    });
  }
  return violations;
}

function git(args: readonly string[]): { readonly status: number; readonly stdout: string } {
  const result = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

const defaultListTags = (pattern: string): readonly string[] => {
  const result = git(["tag", "--list", pattern, "--sort=-v:refname"]);
  return result.status === 0
    ? result.stdout
        .split("\n")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
};

/**
 * Every reachable release tag, newest first, or an empty list when history has
 * none — a shallow CI clone or a fork without tags must degrade to a warning,
 * never a hard failure.
 */
export function resolveReleaseTags(
  listTags: (pattern: string) => readonly string[] = defaultListTags,
): string[] {
  return [...listTags("v[0-9]*")];
}

interface TaggedViolation {
  readonly violation: MigrationLineageViolation;
  readonly tags: string[];
}

/**
 * Collapses per-tag violations to one line per broken pair. Every v0.5.x tag
 * shipping the same migration 54 is one mistake, not five.
 */
export function groupViolationsByPair(
  perTag: ReadonlyArray<{
    readonly tag: string;
    readonly violations: readonly MigrationLineageViolation[];
  }>,
): TaggedViolation[] {
  const grouped = new Map<string, TaggedViolation>();
  for (const { tag, violations } of perTag) {
    for (const violation of violations) {
      const key = `${violation.id}:${violation.releasedName}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.tags.push(tag);
        continue;
      }
      grouped.set(key, { violation, tags: [tag] });
    }
  }
  return [...grouped.values()].toSorted((left, right) => left.violation.id - right.violation.id);
}

function main(): void {
  const currentSource = readFileSync(resolve(repoRoot, migrationsFile), "utf8");
  const currentEntries = parseMigrationLineage(currentSource);
  const allowances = [
    ...parseMigrationLineageAllowances(currentSource),
    ...HANDLED_RELEASED_DIVERGENCES,
  ];

  const structureProblems = findLineageStructureViolations(currentEntries);
  if (structureProblems.length > 0) {
    console.error("Migration lineage is malformed:");
    for (const problem of structureProblems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  const tags = resolveReleaseTags();
  if (tags.length === 0) {
    console.warn(
      "Migration lineage check skipped: no release tag is reachable from this checkout. " +
        "Fetch tags (actions/checkout with fetch-depth: 0) to enable it.",
    );
    return;
  }

  const checked: string[] = [];
  const skipped: string[] = [];
  const perTag: Array<{ tag: string; violations: readonly MigrationLineageViolation[] }> = [];
  for (const tag of tags) {
    const released = git(["show", `${tag}:${migrationsFile}`]);
    if (released.status !== 0) {
      // Predates the file, or history is too shallow to read it. Either way this
      // tag carries no lineage claim we can verify.
      skipped.push(tag);
      continue;
    }
    let releasedEntries: MigrationLineageEntry[];
    try {
      releasedEntries = parseMigrationLineage(released.stdout);
    } catch {
      // A release whose entries array we cannot parse predates the shape this
      // guard understands; failing on it would block every future change.
      skipped.push(tag);
      continue;
    }
    checked.push(tag);
    const violations = findReleasedLineageViolations(releasedEntries, currentEntries, allowances);
    if (violations.length > 0) perTag.push({ tag, violations });
  }

  if (checked.length === 0) {
    console.warn(
      `Migration lineage check skipped: ${migrationsFile} is not readable at any of the ` +
        `${tags.length} release tags. Fetch full history to enable it.`,
    );
    return;
  }

  const skippedNote = skipped.length === 0 ? "" : ` (${skipped.length} unreadable tags skipped)`;
  if (perTag.length === 0) {
    console.log(
      `Migration lineage check passed: all migrations shipped across ${checked.length} release ` +
        `tags (${checked[checked.length - 1]}..${checked[0]}) keep their released (id, name)` +
        `${skippedNote}.`,
    );
    return;
  }

  console.error(
    "Migration lineage changed for migrations that were already shipped. " +
      "Released (id, name) pairs are recorded in every user's effect_sql_migrations table; " +
      "changing one makes the reconciler treat those databases as a foreign lineage and replay " +
      "their schema. Append a new migration instead of renumbering or renaming a shipped one, " +
      "or declare a reviewed MIGRATION_LINEAGE_ALIASES entry if the change already shipped.",
  );
  for (const { violation, tags: shippedIn } of groupViolationsByPair(perTag)) {
    console.error(
      `- migration ${violation.id}: ${shippedIn.join(", ")} shipped ` +
        `"${violation.releasedName}", ${migrationsFile} now has ${
          violation.currentName === null ? "no entry" : `"${violation.currentName}"`
        }.`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
