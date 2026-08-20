/**
 * Server-side defaults for JobOrder create so ChatGPT cannot omit company
 * address, Internal Department, Sales Rep, or well-formed description HTML.
 * Explicit additionalFields always win.
 */
import {
  applyFormattedJobDescriptions,
  companyAddressForJob,
  normalizeJobOnSite,
} from "./job-description-html.js";

export type CreateJobOrderDefaultDeps = {
  resolveSessionOwnerId: () => Promise<number>;
  findUserIdByExactEmail: (email: string) => Promise<number | null>;
  fetchCompanyAddress: (
    companyId: number,
  ) => Promise<Record<string, unknown> | null>;
  fetchUserPrimaryDepartmentName: (userId: number) => Promise<string | null>;
  listInternalDepartmentOptions: () => Promise<string[]>;
};

function ownerIdFromField(owner: unknown): number | undefined {
  if (typeof owner === "number" && Number.isFinite(owner) && owner > 0) {
    return owner;
  }
  if (owner && typeof owner === "object" && !Array.isArray(owner)) {
    const id = (owner as { id?: unknown }).id;
    if (typeof id === "number" && Number.isFinite(id) && id > 0) return id;
  }
  return undefined;
}

function hasOwnAddress(fields: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(fields, "address")) return false;
  const addr = fields.address;
  if (addr == null) return true; // explicit null/clear — do not overwrite
  if (typeof addr !== "object" || Array.isArray(addr)) return true;
  return Object.keys(addr as object).length > 0;
}

/**
 * Build the JobOrder create body with firm defaults applied.
 * Does not call Bullhorn write APIs — only the injected read helpers.
 */
export async function buildCreateJobOrderBody(
  args: {
    title: string;
    clientCorporationId: number;
    clientContactId?: number;
    additionalFields?: Record<string, unknown>;
    /** AskToAct portal user email — preferred Sales Rep when no owner override. */
    portalUserEmail?: string | null;
  },
  deps: CreateJobOrderDefaultDeps,
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = { ...(args.additionalFields ?? {}) };

  // ── Sales Rep (owner) ────────────────────────────────────────────────────
  const explicitOwnerId = ownerIdFromField(fields.owner);
  let ownerId = explicitOwnerId;
  if (ownerId === undefined) {
    const email = args.portalUserEmail?.trim().toLowerCase();
    if (email) {
      ownerId = (await deps.findUserIdByExactEmail(email)) ?? undefined;
    }
    if (ownerId === undefined) {
      ownerId = await deps.resolveSessionOwnerId();
    }
    fields.owner = { id: ownerId };
  }

  // ── Internal Department from Sales Rep primary department ────────────────
  if (
    !Object.prototype.hasOwnProperty.call(fields, "correlatedCustomText1") &&
    ownerId !== undefined
  ) {
    const deptName = await deps.fetchUserPrimaryDepartmentName(ownerId);
    if (deptName?.trim()) {
      const options = await deps.listInternalDepartmentOptions();
      const match = options.find(
        (o) => o.toLowerCase() === deptName.trim().toLowerCase(),
      );
      if (match) fields.correlatedCustomText1 = match;
    }
  }

  // ── Company address (never invent country; keep when Remote) ─────────────
  if (!hasOwnAddress(fields)) {
    const companyAddr = await deps.fetchCompanyAddress(args.clientCorporationId);
    const copied = companyAddressForJob(companyAddr);
    if (copied) fields.address = copied;
  }

  // ── Work Location Requirements (onSite) ──────────────────────────────────
  if (Object.prototype.hasOwnProperty.call(fields, "onSite")) {
    const normalized = normalizeJobOnSite(fields.onSite);
    if (normalized) {
      fields.onSite = normalized;
      if (normalized === "Remote" && fields.isWorkFromHome === undefined) {
        fields.isWorkFromHome = true;
      }
    }
  } else {
    fields.onSite = "On-Site";
  }

  // ── Description HTML ─────────────────────────────────────────────────────
  applyFormattedJobDescriptions(fields);

  const body: Record<string, unknown> = {
    title: args.title,
    clientCorporation: { id: args.clientCorporationId },
    ...fields,
  };
  if (args.clientContactId !== undefined) {
    body.clientContact = { id: args.clientContactId };
  }
  // Drop undefined (compact)
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) delete body[k];
  }
  return body;
}
