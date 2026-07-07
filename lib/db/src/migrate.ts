import { runAppMigrations } from "./run-migrations.js";

try {
  const result = await runAppMigrations();
  if (result.skipped) {
    console.log("No pending migrations — database is up to date.");
  } else {
    for (const tag of result.applied) {
      console.log(`  ✓ ${tag}`);
    }
    console.log("All migrations applied successfully.");
  }
} catch (e: unknown) {
  const err = e as Error & { code?: string; detail?: string };
  console.error("Migration failed:", err.message);
  if (err.code) console.error("Postgres code:", err.code);
  if (err.detail) console.error("Detail:", err.detail);
  process.exit(1);
}
