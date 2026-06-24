import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Prevent idle-client disconnects (e.g. Neon compute pause, 57P01) from
// becoming uncaught exceptions that crash the process. The pool will
// automatically re-establish connections on the next query.
pool.on("error", (err) => {
  console.warn("[db] pool idle-client error (connection reset by server):", (err as Error).message);
});

export const db = drizzle(pool, { schema });

export * from "./schema";
