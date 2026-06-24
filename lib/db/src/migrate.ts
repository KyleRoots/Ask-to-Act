import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const url = process.env["DATABASE_URL"];
if (!url) throw new Error("DATABASE_URL is required");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../migrations");
const journalPath = path.join(migrationsFolder, "meta/_journal.json");

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}
interface Journal {
  entries: JournalEntry[];
}

const journal: Journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

const pool = new pg.Pool({ connectionString: url });
const client = await pool.connect();

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
    console.log("No pending migrations — database is up to date.");
    process.exit(0);
  }

  for (const entry of pending) {
    const sqlFile = path.join(migrationsFolder, `${entry.tag}.sql`);
    const sql = fs.readFileSync(sqlFile, "utf8");

    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    console.log(`Applying migration: ${entry.tag} (${statements.length} statements)`);

    for (const stmt of statements) {
      try {
        await client.query(stmt);
      } catch (e: unknown) {
        const err = e as { code?: string; message?: string };
        // Idempotency: skip if object already exists or constraint already present
        if (err.code === "42P07" || err.code === "42710" || err.code === "42P16") {
          // 42P07 = relation already exists, 42710 = duplicate_object, 42P16 = invalid_table_definition
          continue;
        }
        throw e;
      }
    }

    await client.query(
      `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      [entry.tag, entry.when],
    );
    console.log(`  ✓ ${entry.tag}`);
  }

  console.log("All migrations applied successfully.");
} catch (e: unknown) {
  const err = e as Error & { code?: string; detail?: string };
  console.error("Migration failed:", err.message);
  if (err.code) console.error("Postgres code:", err.code);
  if (err.detail) console.error("Detail:", err.detail);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
