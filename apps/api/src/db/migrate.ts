import { migrate } from "drizzle-orm/node-postgres/migrator";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { createDb } from "./index";

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, pool } = createDb(databaseUrl);
  const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));
  await migrate(db, { migrationsFolder });
  await pool.end();
}

// `db:migrate` runs this file directly. Without the entrypoint below it
// imported cleanly and exited 0 having done nothing, which is worse than
// failing: the documented "apply without booting the server" path silently
// left the schema behind.
if (argv[1] && import.meta.url === new URL(`file://${argv[1]}`).href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write("DATABASE_URL is required to run migrations.\n");
    process.exit(1);
  }
  await runMigrations(databaseUrl);
  process.stdout.write("Migrations applied.\n");
}
