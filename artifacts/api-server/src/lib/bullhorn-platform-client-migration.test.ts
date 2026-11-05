import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { runAppMigrations } from "@workspace/db/run-migrations";

function assertDedicatedDisposableDb(): void {
  if (process.env["ALLOW_BULLHORN_AUTH_SAFETY_DB_TESTS"] !== "1") {
    throw new Error("Set ALLOW_BULLHORN_AUTH_SAFETY_DB_TESTS=1 for disposable DB tests.");
  }
  const raw = process.env["DATABASE_URL"];
  if (!raw) throw new Error("DATABASE_URL is required for disposable DB tests.");
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, "");
  const hostParam = url.searchParams.get("host");
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const localSocket = Boolean(hostParam?.startsWith("/tmp/asktoact-auth-safety-"));
  if (!/^asktoact_auth_safety_test_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing non-dedicated database name: ${dbName}`);
  }
  if (!localHost && !localSocket) {
    throw new Error("Refusing non-local database host for platform-client migration tests.");
  }
}

function platformClientUpdateSql(): string {
  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../lib/db/migrations/0023_bullhorn_oauth_client.sql",
  );
  const update = fs
    .readFileSync(migrationPath, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .find((statement) => statement.startsWith("UPDATE"));
  if (!update) throw new Error("0023 has no UPDATE statement");
  return update;
}

beforeAll(async () => {
  assertDedicatedDisposableDb();
  await runAppMigrations();
});

describe("0023 platform-client backfill", () => {
  it("leaves a row with a stored client false and marks a client-less row true", async () => {
    const update = platformClientUpdateSql();
    expect(update).toContain("oauth_client_id");
    expect(update).toContain("oauth_client_secret");

    await pool.query("DELETE FROM bullhorn_tokens WHERE firm_id LIKE 'test_platform_backfill_%'");
    await pool.query("DELETE FROM firms WHERE id LIKE 'test_platform_backfill_%'");
    await pool.query(
      `INSERT INTO firms (id, name) VALUES
        ('test_platform_backfill_stored', 'stored client'),
        ('test_platform_backfill_empty', 'no client')`,
    );
    await pool.query(
      `INSERT INTO bullhorn_tokens (
         id, firm_id, refresh_token, oauth_url, login_url, auth_mode,
         oauth_client_id, oauth_client_secret, uses_platform_client
       ) VALUES
        (
          'test_platform_backfill_stored',
          'test_platform_backfill_stored',
          'refresh-stored',
          'https://auth-east.example/oauth',
          'https://rest-east.example/rest-services/login',
          'oauth',
          'enc:v1:stored-client-id',
          'enc:v1:stored-client-secret',
          false
        ),
        (
          'test_platform_backfill_empty',
          'test_platform_backfill_empty',
          'refresh-empty',
          'https://auth.example/oauth',
          'https://rest.example/rest-services/login',
          'oauth',
          NULL,
          NULL,
          false
        )`,
    );

    await pool.query(update);

    const { rows } = await pool.query<{
      firm_id: string;
      uses_platform_client: boolean;
    }>(
      `SELECT firm_id, uses_platform_client
       FROM bullhorn_tokens
       WHERE firm_id LIKE 'test_platform_backfill_%'
       ORDER BY firm_id`,
    );
    expect(rows).toEqual([
      { firm_id: "test_platform_backfill_empty", uses_platform_client: true },
      { firm_id: "test_platform_backfill_stored", uses_platform_client: false },
    ]);

    await pool.query("DELETE FROM bullhorn_tokens WHERE firm_id LIKE 'test_platform_backfill_%'");
    await pool.query("DELETE FROM firms WHERE id LIKE 'test_platform_backfill_%'");
  });

  it("uses the same client-less predicate in ensureColumns", () => {
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./ensure-columns.ts"),
      "utf8",
    );
    expect(source).toContain(
      "WHERE oauth_client_id IS NULL\n            AND oauth_client_secret IS NULL",
    );
  });
});
