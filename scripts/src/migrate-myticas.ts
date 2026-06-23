/**
 * Myticas zero-state migration
 *
 * Creates the Myticas firm record (Customer Zero) and links all existing
 * users that have no firm_id to it. Safe to run more than once.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts exec tsx src/migrate-myticas.ts
 */

import { db, firmsTable, usersTable } from "@workspace/db";
import { isNull } from "drizzle-orm";

const MYTICAS_FIRM_ID = "firm_myticas_28404";

async function main() {
  console.log("Creating Myticas firm record...");

  await db
    .insert(firmsTable)
    .values({
      id: MYTICAS_FIRM_ID,
      name: "Myticas Consulting",
      subscriptionStatus: "active",
      seatLimit: null,
    })
    .onConflictDoUpdate({
      target: firmsTable.id,
      set: {
        name: "Myticas Consulting",
        subscriptionStatus: "active",
      },
    });

  console.log(`✓ Firm record: ${MYTICAS_FIRM_ID}`);

  const updated = await db
    .update(usersTable)
    .set({ firmId: MYTICAS_FIRM_ID, role: "admin" })
    .where(isNull(usersTable.firmId))
    .returning({ id: usersTable.id, name: usersTable.name });

  if (updated.length === 0) {
    console.log("✓ No unlinked users found — already migrated.");
  } else {
    for (const u of updated) {
      console.log(`✓ Linked user: ${u.name} (${u.id}) → ${MYTICAS_FIRM_ID} [role: admin]`);
    }
  }

  console.log("\n✅ Myticas migration complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
