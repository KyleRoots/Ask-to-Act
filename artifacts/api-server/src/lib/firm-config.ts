import { db, firmConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { firmContext, getFirmAuthMode } from "./bullhorn-auth.js";
import { logger } from "./logger.js";

/**
 * Per-firm custom-field configuration: discovery + resolution.
 *
 * Bullhorn custom fields map to different opaque API names per tenant (Myticas'
 * "Internal Department" is `correlatedCustomText1` on JobOrder, but another firm
 * may use `customText5`). The read path resolves these per firm via this module
 * instead of hardcoding Myticas names. Discovery reads the firm's own Bullhorn
 * meta; resolution falls back to Myticas' known fields so Myticas stays
 * byte-identical and a not-yet-discovered firm degrades safely (never crashes).
 */

// Myticas' real Internal Department field per entity — the fallback when a firm
// has no discovered config row yet.
const MYTICAS_DEPT_FIELDS: Record<string, string> = {
  JobOrder: "correlatedCustomText1",
  Placement: "correlatedCustomText1",
  ClientContact: "customText1",
  Candidate: "customText3",
  Lead: "customText1",
  Opportunity: "customText1",
};

// Entities whose custom-field config we discover. Lead/Opportunity may be
// disabled on a firm's CRM; discovery tolerates per-entity failures.
const DISCOVERY_ENTITIES = [
  "Candidate",
  "JobOrder",
  "Placement",
  "ClientContact",
  "CorporateUser",
  "Lead",
  "Opportunity",
] as const;

// Safe Bullhorn field-name shape. A field name read back from persisted JSON is
// re-validated against this before being used in ANY query, so a tampered or
// garbage config value can never inject query syntax.
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

// Controlled synonyms for the Internal Department concept, most-specific first.
// A synonym is only accepted when EXACTLY ONE configured field carries that
// label (never guess when ambiguous).
const DEPT_SYNONYMS = ["internal department", "department", "office", "branch"];

interface EntityFieldMeta {
  label?: string;
  type?: string;
  dataType?: string;
}
interface EntityConfig {
  fields: Record<string, EntityFieldMeta>;
  labels: Record<string, string>;
}
export interface FirmFieldMap {
  version: number;
  entities: Record<string, EntityConfig>;
  semantics: { internalDepartment: Record<string, string> };
  missing: { internalDepartment: string[] };
}

// In-memory per-firm cache. Config changes only on (re)discovery, which
// invalidates the entry. `null` is cached too (firm has no config row yet) to
// avoid re-querying on every read.
const configCache = new Map<string, FirmFieldMap | null>();

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

export function invalidateFirmConfigCache(firmId?: string): void {
  if (firmId) configCache.delete(firmId);
  else configCache.clear();
}

/** Loads (and caches) a firm's discovered field map, or null if none yet. */
export async function getFirmFieldMap(firmId: string): Promise<FirmFieldMap | null> {
  if (configCache.has(firmId)) return configCache.get(firmId) ?? null;
  const rows = await db
    .select({ fieldMap: firmConfigTable.fieldMap })
    .from(firmConfigTable)
    .where(eq(firmConfigTable.firmId, firmId))
    .limit(1);
  const map = (rows[0]?.fieldMap as FirmFieldMap | undefined) ?? null;
  configCache.set(firmId, map);
  return map;
}

/**
 * Resolves the "Internal Department" API field for a firm + entity. Prefers the
 * firm's DISCOVERED mapping; otherwise falls back to Myticas' known field (keeps
 * Myticas byte-identical, degrades new firms safely). Returns null only when
 * neither yields a syntactically valid field name.
 */
export async function resolveDeptField(
  firmId: string | null,
  entity: string,
): Promise<string | null> {
  let resolved: string | undefined;
  if (firmId) {
    try {
      const map = await getFirmFieldMap(firmId);
      resolved = map?.semantics?.internalDepartment?.[entity];
    } catch (err) {
      logger.warn({ firmId, entity, err }, "firm-config: field-map load failed; using fallback");
    }
  }
  const field = resolved ?? MYTICAS_DEPT_FIELDS[entity];
  if (!field || !SAFE_FIELD_NAME_RE.test(field)) return null;
  return field;
}

/** Picks the Internal Department field from an entity's configured custom fields. */
function detectDeptField(configured: Array<{ name: string; label?: string }>): string | undefined {
  const byLabel = new Map<string, string[]>();
  for (const f of configured) {
    if (!f.label) continue;
    const n = normalizeLabel(f.label);
    const arr = byLabel.get(n) ?? [];
    arr.push(f.name);
    byLabel.set(n, arr);
  }
  for (const syn of DEPT_SYNONYMS) {
    const hits = byLabel.get(syn);
    if (hits && hits.length === 1) return hits[0];
  }
  return undefined;
}

export interface DiscoverySummary {
  firmId: string;
  entitiesDiscovered: string[];
  entitiesFailed: { entity: string; error: string }[];
  internalDepartment: Record<string, string>;
  missingInternalDepartment: string[];
}

/**
 * Discovers a firm's custom-field config from its own Bullhorn instance and
 * persists it. Runs each describe within the firm's context; tolerates
 * per-entity failures (e.g. a disabled CRM entity) without aborting the whole
 * run. Invalidates the in-memory cache so the next read sees fresh config.
 */
export async function discoverFirmConfig(firmId: string): Promise<DiscoverySummary> {
  // Lazy import breaks the firm-config <-> bullhorn-client module cycle.
  const { describeEntity } = await import("./bullhorn-client.js");

  const entities: FirmFieldMap["entities"] = {};
  const internalDepartment: Record<string, string> = {};
  const missing: string[] = [];
  const discovered: string[] = [];
  const failed: { entity: string; error: string }[] = [];

  await firmContext.run({ firmId }, async () => {
    for (const entity of DISCOVERY_ENTITIES) {
      try {
        const desc = (await describeEntity({ entityType: entity })) as {
          configuredCustomFields?: Array<{
            name: string;
            label?: string;
            type?: unknown;
            dataType?: unknown;
          }>;
        };
        const configured = Array.isArray(desc.configuredCustomFields)
          ? desc.configuredCustomFields.filter(
              (f): f is { name: string; label?: string; type?: unknown; dataType?: unknown } =>
                typeof f.name === "string",
            )
          : [];

        const fields: Record<string, EntityFieldMeta> = {};
        const labels: Record<string, string> = {};
        for (const f of configured) {
          fields[f.name] = {
            ...(f.label ? { label: f.label } : {}),
            ...(typeof f.type === "string" ? { type: f.type } : {}),
            ...(typeof f.dataType === "string" ? { dataType: f.dataType } : {}),
          };
          if (f.label) labels[normalizeLabel(f.label)] = f.name;
        }
        entities[entity] = { fields, labels };
        discovered.push(entity);

        const dept = detectDeptField(configured);
        if (dept) internalDepartment[entity] = dept;
        else missing.push(entity);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ entity, error: msg });
        logger.warn(
          { firmId, entity, error: msg },
          "firm-config: discovery failed for entity (may be a disabled CRM entity)",
        );
      }
    }
  });

  const fieldMap: FirmFieldMap = {
    version: 1,
    entities,
    semantics: { internalDepartment },
    missing: { internalDepartment: missing },
  };

  // Defensive backstop: the "service" firm (Myticas) is managed by the platform
  // and MUST keep NO firm_config row so resolution stays on the byte-identical
  // fallback path. Never persist a row for it, even if called directly. The
  // discover-config route already rejects this case with a clear 409.
  if ((await getFirmAuthMode(firmId)) === "service") {
    logger.warn(
      { firmId },
      "firm-config: skipping persist for service firm (managed config, stays on fallback)",
    );
    return {
      firmId,
      entitiesDiscovered: discovered,
      entitiesFailed: failed,
      internalDepartment,
      missingInternalDepartment: missing,
    };
  }

  const now = new Date();
  await db
    .insert(firmConfigTable)
    .values({ firmId, fieldMap, discoveredAt: now })
    .onConflictDoUpdate({
      target: firmConfigTable.firmId,
      set: { fieldMap, discoveredAt: now, updatedAt: now },
    });
  invalidateFirmConfigCache(firmId);

  logger.info(
    {
      firmId,
      discovered: discovered.length,
      failed: failed.length,
      deptMapped: Object.keys(internalDepartment).length,
    },
    "firm-config: discovery complete",
  );

  return {
    firmId,
    entitiesDiscovered: discovered,
    entitiesFailed: failed,
    internalDepartment,
    missingInternalDepartment: missing,
  };
}
