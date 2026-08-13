import type { RevocationEvent, RevocationKind } from "@synara/contracts";
import { getTableColumns, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { revocationEvents } from "../db/schema";
import type { RevocationLog } from "./interfaces";

export const REVOCATION_RETENTION_MS = 24 * 60 * 60 * 1000;

type RevocationWriter = Pick<NodePgDatabase<typeof schema>, "insert">;
type RevocationEventInput = { hostId: string; kind: RevocationKind; subject?: string };

/**
 * Writes events on the caller's transaction. Retention deliberately does NOT
 * run here: callers hold FOR UPDATE row locks and advisory locks, and a
 * backlog sweep inside their transaction would serialize unrelated host
 * mutations behind it. The poll path (`read`) owns retention instead.
 */
export async function writeRevocationEvents(
  writer: RevocationWriter,
  values: readonly RevocationEventInput[],
): Promise<void> {
  if (values.length > 0) {
    await writer.insert(revocationEvents).values(
      values.map((event) => ({
        hostId: event.hostId,
        kind: event.kind,
        subject: event.subject ?? null,
      })),
    );
  }
}

export function createRevocationLog(db: NodePgDatabase<typeof schema>): RevocationLog {
  async function cleanupAndInsert(
    values: Array<{ hostId: string; kind: RevocationKind; subject?: string }>,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await writeRevocationEvents(tx, values);
    });
  }

  return {
    record(hostId, kind, subject) {
      return cleanupAndInsert([{ hostId, kind, ...(subject ? { subject } : {}) }]);
    },

    async read(after) {
      // Retention lives on the poll path (relay, every ~5s), where no host
      // row locks are held — see writeRevocationEvents.
      await db
        .delete(revocationEvents)
        .where(sql`${revocationEvents.createdAt} < now() - interval '24 hours'`);
      // The watermark is bounded by the oldest transaction that could still
      // commit a LOWER id, not by wall-clock age. `created_at` defaults to
      // now(), which in Postgres is transaction-START time, so a writer that
      // blocked on a row lock longer than any fixed window would produce an
      // event that already looks "old"; the poller would advance past it and
      // the event would be lost forever. The row's own xmin against
      // pg_snapshot_xmin is the real boundary: a row whose inserting
      // transaction is below every in-flight xmin is fully settled.
      const rows = await db
        .select({
          ...getTableColumns(revocationEvents),
          safeForWatermark: sql<boolean>`${revocationEvents}.xmin::text::bigint < pg_snapshot_xmin(pg_current_snapshot())::text::bigint`,
        })
        .from(revocationEvents)
        .where(gt(revocationEvents.id, after))
        .orderBy(revocationEvents.id);
      // Stop at the FIRST unsettled row: ids above it may interleave with a
      // writer that has not committed yet, so nothing past that point is safe
      // to skip on the next poll even if individual later rows look settled.
      let watermark = after;
      for (const row of rows) {
        if (!row.safeForWatermark) break;
        watermark = row.id;
      }
      const events: RevocationEvent[] = rows.map((row) => ({
        id: row.id,
        hostId: row.hostId,
        kind: row.kind,
        subject: row.subject,
        createdAt: row.createdAt.toISOString(),
      }));
      return { events, watermark };
    },
  };
}
