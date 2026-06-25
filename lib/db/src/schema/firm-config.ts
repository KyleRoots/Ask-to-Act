import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./firms";

/**
 * Per-firm Bullhorn custom-field configuration, discovered from that firm's own
 * Bullhorn instance. Custom fields (e.g. "Internal Department") map to different
 * opaque API names per tenant (correlatedCustomText1 on one firm, customText5 on
 * another), so the read path must resolve them per firm instead of hardcoding
 * Myticas' names.
 *
 * `fieldMap` shape (version 1):
 * {
 *   version: 1,
 *   entities: {
 *     JobOrder: {
 *       fields:  { correlatedCustomText1: { label, type, dataType }, ... },
 *       labels:  { "internal department": "correlatedCustomText1", ... }
 *     }, ...
 *   },
 *   semantics: {
 *     internalDepartment: { JobOrder: "correlatedCustomText1", Placement: "...", ... }
 *   },
 *   missing: { internalDepartment: ["Candidate", ...] }  // entities with no detected mapping
 * }
 */
export const firmConfigTable = pgTable("firm_config", {
  firmId: text("firm_id")
    .primaryKey()
    .references(() => firmsTable.id, { onDelete: "cascade" }),
  fieldMap: jsonb("field_map").notNull(),
  discoveredAt: timestamp("discovered_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertFirmConfigSchema = createInsertSchema(firmConfigTable).omit({
  updatedAt: true,
});
export type InsertFirmConfig = z.infer<typeof insertFirmConfigSchema>;
export type FirmConfig = typeof firmConfigTable.$inferSelect;
