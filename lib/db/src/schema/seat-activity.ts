import { pgTable, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

export const seatActivityTable = pgTable(
  "seat_activity",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    callCount: integer("call_count").notNull().default(0),
    firstCallAt: timestamp("first_call_at").notNull().defaultNow(),
    lastCallAt: timestamp("last_call_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.year, table.month] }),
    index("seat_activity_firm_id_idx").on(table.firmId),
  ],
);

export type SeatActivity = typeof seatActivityTable.$inferSelect;
