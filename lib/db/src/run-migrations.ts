import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}
interface Journal {
  entries: JournalEntry[];
}

/** Resolve the drizzle migrations folder for CLI, dev, or bundled production. */
export function resolveMigrationsFolder(): string {
  const fromEnv = process.env["APP_MIGRATIONS_DIR"];
  if (fromEnv && fs.existsSync(path.join(fromEnv, "meta/_journal.json"))) {
    return fromEnv;
  }

  const here = path.dirname(fileURLToPath(import.meta.url));

  // Bundled api-server: build.mjs copies lib/db/migrations → dist/app-migrations
  const bundled = path.join(here, "app-migrations");
  if (fs.existsSync(path.join(bundled, "meta/_journal.json"))) {
    return bundled;
  }

  // lib/db package source (tsx migrate:run)
  const packageMigrations = path.join(here, "../migrations");
  if (fs.existsSync(path.join(packageMigrations, "meta/_journal.json"))) {
    return packageMigrations;
  }

  throw new Error(
    "Could not locate drizzle migrations (checked APP_MIGRATIONS_DIR, app-migrations/, ../migrations)",
  );
}

/**
 * Apply pending SQL migrations from the drizzle journal. Idempotent for
 * already-applied schema objects (duplicate table/column errors are skipped).
 * Safe to run on every deploy and server startup.
 */
export async function runAppMigrations(options?: {
  databaseUrl?: string;
  migrationsFolder?: string;
}): Promise<{ applied: string[]; skipped: boolean }> {
  const url = options?.databaseUrl ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is required");

  const migrationsFolder = options?.migrationsFolder ?? resolveMigrationsFolder();
  const journalPath = path.join(migrationsFolder, "meta/_journal.json");
  const journal: Journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  const appliedTags: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      );
    `);

    const { rows: applied } = await client.query<{ created_at: string }>(
      `SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at ASC`,
    );
    const appliedTimestamps = new Set(applied.map((r) => String(r.created_at)));

    const pending = journal.entries.filter(
      (e) => !appliedTimestamps.has(String(e.when)),
    );

    if (pending.length === 0) {
      return { applied: [], skipped: true };
    }

    for (const entry of pending) {
      const sqlFile = path.join(migrationsFolder, `${entry.tag}.sql`);
      const sql = fs.readFileSync(sqlFile, "utf8");

      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const stmt of statements) {
        try {
          await client.query(stmt);
        } catch (e: unknown) {
          const err = e as { code?: string; message?: string };
          if (
            err.code === "42P07" ||
            err.code === "42710" ||
            err.code === "42701" ||
            err.code === "42P16"
          ) {
            continue;
          }
          throw e;
        }
      }

      await client.query(
        `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
        [entry.tag, entry.when],
      );
      appliedTags.push(entry.tag);
    }

    return { applied: appliedTags, skipped: false };
  } finally {
    client.release();
    await pool.end();
  }
}
