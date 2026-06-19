import { getSession, invalidateSession } from "./bullhorn-auth.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 1;

async function bullhornFetch(
  path: string,
  params: Record<string, string | number>,
  retries = MAX_RETRIES,
): Promise<unknown> {
  const session = await getSession();
  const url = new URL(path, session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  let res = await fetch(url.toString(), {
    redirect: "follow",
  });

  if (res.status === 401 && retries > 0) {
    logger.warn("Bullhorn: 401 received, re-authenticating");
    await invalidateSession();
    return bullhornFetch(path, params, retries - 1);
  }

  if (res.status === 429) {
    throw new Error("Bullhorn API rate limit exceeded. Please try again shortly.");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bullhorn API error (${res.status}): ${text}`);
  }

  return res.json();
}

const SENSITIVE_FIELD_RE =
  /(password|secret|token|apikey|api_key|sessionid|session_id|credential|ssn|socialsecurity)/i;

/** True if a field name looks like a credential/secret that must never be returned. */
function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD_RE.test(name);
}

/**
 * Strips credential-like fields from a comma-separated fields list before it is
 * sent to Bullhorn. Defense-in-depth so callers can never request (or exfiltrate)
 * a field such as `password`. Falls back to "id" if nothing safe remains.
 */
function sanitizeFields(fields: string): string {
  const kept = fields
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !isSensitiveField(f));
  return kept.length > 0 ? kept.join(",") : "id";
}

/**
 * Entities that have a meaningful standalone record view in the Bullhorn UI, so
 * a deep link to open them is useful. Transactional/junction entities
 * (JobSubmission, Placement, Note, Task, etc.) are intentionally excluded.
 */
const UI_LINKABLE_ENTITIES = new Set<string>([
  "Candidate",
  "ClientContact",
  "ClientCorporation",
  "JobOrder",
  "Lead",
  "Opportunity",
]);

// Cache the swimlane-derived host keyed by the restUrl it was derived from, so a
// cluster migration/failover that changes restUrl on re-auth recomputes the host.
let memoDerivedUiBase: { restUrl: string; base: string | null } | undefined;

/**
 * Resolves the Bullhorn UI base URL used to build record deep links. Prefers an
 * explicit BULLHORN_UI_BASE_URL override; otherwise derives the cluster host
 * from the REST swimlane (e.g. rest45.bullhornstaffing.com ->
 * cls45.bullhornstaffing.com). Returns null when it cannot be determined, in
 * which case deep links are simply omitted.
 */
async function resolveUiBaseUrl(): Promise<string | null> {
  const configured = process.env.BULLHORN_UI_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  let restUrl: string;
  try {
    restUrl = (await getSession()).restUrl;
  } catch {
    return null;
  }
  if (memoDerivedUiBase?.restUrl === restUrl) return memoDerivedUiBase.base;
  let base: string | null = null;
  try {
    const host = new URL(restUrl).hostname;
    const m = /^rest(\d+)\.bullhornstaffing\.com$/i.exec(host);
    base = m ? `https://cls${m[1]}.bullhornstaffing.com` : null;
  } catch {
    base = null;
  }
  memoDerivedUiBase = { restUrl, base };
  return base;
}

/**
 * Adds a `bullhornUrl` deep link to each linkable record in a Bullhorn REST
 * response (mutating it in place). Handles both the `{ data: ... }` envelope
 * returned by search/query (and entity GET on this instance) and a bare
 * single-record payload (`{ id, ... }`), so `get_*` links don't depend on
 * Bullhorn always wrapping single records. No-op for non-linkable entities or
 * when the UI base URL cannot be resolved. Records without a numeric `id` are
 * left untouched.
 */
async function enrichWithProfileUrls(
  entity: string,
  json: unknown,
): Promise<unknown> {
  if (!UI_LINKABLE_ENTITIES.has(entity)) return json;
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const base = await resolveUiBaseUrl();
  if (!base) return json;
  const addUrl = (rec: unknown) => {
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      const r = rec as Record<string, unknown>;
      if (typeof r.id === "number") {
        r.bullhornUrl = `${base}/BullhornStaffing/OpenWindow.cfm?Entity=${entity}&id=${r.id}`;
      }
    }
  };
  const obj = json as Record<string, unknown>;
  if ("data" in obj) {
    // search/query list envelope or entity-GET single-record envelope
    const data = obj.data;
    if (Array.isArray(data)) data.forEach(addUrl);
    else addUrl(data);
  } else {
    // bare single-record payload (e.g. an unwrapped entity GET)
    addUrl(obj);
  }
  return json;
}

async function searchEntity(
  entity: string,
  query: string,
  fields: string,
  count: number,
  start: number,
): Promise<unknown> {
  fields = sanitizeFields(fields);
  const session = await getSession();
  const url = new URL(`search/${entity}`, session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);
  url.searchParams.set("query", query);
  url.searchParams.set("fields", fields);
  url.searchParams.set("count", String(count));
  url.searchParams.set("start", String(start));

  let res = await fetch(url.toString(), { redirect: "follow" });

  if (res.status === 401) {
    logger.warn("Bullhorn: 401 on search, re-authenticating");
    await invalidateSession();
    const session2 = await getSession();
    const url2 = new URL(`search/${entity}`, session2.restUrl);
    url2.searchParams.set("BhRestToken", session2.BhRestToken);
    url2.searchParams.set("query", query);
    url2.searchParams.set("fields", fields);
    url2.searchParams.set("count", String(count));
    url2.searchParams.set("start", String(start));
    res = await fetch(url2.toString(), { redirect: "follow" });
  }

  if (res.status === 429) {
    throw new Error("Bullhorn API rate limit exceeded. Please try again shortly.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bullhorn search error (${res.status}): ${text}`);
  }
  return enrichWithProfileUrls(entity, await res.json());
}

async function queryEntity(
  entity: string,
  where: string,
  fields: string,
  count: number,
  start: number,
  orderBy?: string,
): Promise<unknown> {
  fields = sanitizeFields(fields);
  const params: Record<string, string | number> = { where, fields, count, start };
  if (orderBy !== undefined && orderBy !== "") {
    params.orderBy = orderBy;
  }
  return enrichWithProfileUrls(entity, await bullhornFetch(`query/${entity}`, params));
}

async function getEntity(
  entity: string,
  id: number,
  fields: string,
): Promise<unknown> {
  return enrichWithProfileUrls(
    entity,
    await bullhornFetch(`entity/${entity}/${id}`, { fields: sanitizeFields(fields) }),
  );
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses a date filter to epoch milliseconds with an explicit UTC contract.
 * Accepts "YYYY-MM-DD" (treated as UTC midnight) or an ISO 8601 date-time; a
 * date-time without a timezone designator is interpreted as UTC. Loose,
 * non-ISO strings are rejected so the documented contract holds regardless of
 * the server's local timezone.
 */
function toEpochMillis(value: string, label: string): number {
  const v = value.trim();
  let normalized: string;
  if (DATE_ONLY_RE.test(v)) {
    normalized = `${v}T00:00:00.000Z`;
  } else if (DATE_TIME_RE.test(v)) {
    const withT = v.replace(" ", "T");
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(withT);
    normalized = hasZone ? withT : `${withT}Z`;
  } else {
    throw new Error(
      `Invalid ${label} "${value}". Use "YYYY-MM-DD" or an ISO 8601 timestamp such as "2026-05-01T14:30:00Z".`,
    );
  }
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) {
    throw new Error(
      `Invalid ${label} "${value}". Use "YYYY-MM-DD" or an ISO 8601 timestamp such as "2026-05-01T14:30:00Z".`,
    );
  }
  return ms;
}

/** Parses an optional start/end date range, enforcing start < end when both are given. */
function parseDateRange(
  start?: string,
  end?: string,
): { startMs?: number; endMs?: number } {
  const startMs = start !== undefined ? toEpochMillis(start, "dateAddedStart") : undefined;
  const endMs = end !== undefined ? toEpochMillis(end, "dateAddedEnd") : undefined;
  if (startMs !== undefined && endMs !== undefined && endMs <= startMs) {
    throw new Error(
      `dateAddedEnd ("${end}") must be after dateAddedStart ("${start}").`,
    );
  }
  return { startMs, endMs };
}

/**
 * Builds numeric dateAdded conditions for a /query `where` clause. Bullhorn
 * stores dates as epoch milliseconds, so date filtering is done with numeric
 * comparisons. Start is inclusive (>=), end is exclusive (<).
 */
function queryDateConditions(
  field: string,
  start?: string,
  end?: string,
): string[] {
  const { startMs, endMs } = parseDateRange(start, end);
  const c: string[] = [];
  if (startMs !== undefined) c.push(`${field} >= ${startMs}`);
  if (endMs !== undefined) c.push(`${field} < ${endMs}`);
  return c;
}

/**
 * Builds a Lucene date-range clause for a /search query. Lucene ranges are
 * inclusive on both ends, so the exclusive end is emulated by subtracting 1ms.
 */
function searchDateClause(
  field: string,
  start?: string,
  end?: string,
): string | null {
  if (start === undefined && end === undefined) return null;
  const { startMs, endMs } = parseDateRange(start, end);
  const lo = startMs !== undefined ? String(startMs) : "*";
  const hi = endMs !== undefined ? String(endMs - 1) : "*";
  return `${field}:[${lo} TO ${hi}]`;
}

export async function searchCandidates(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,mobile,status,occupation,primarySkills,address,dateAvailable,dateLastModified,owner,dateAdded";
  return searchEntity("Candidate", args.query, fields, args.count ?? 20, args.start ?? 0);
}

export async function searchJobs(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,dateEnd,address,publicDescription";
  return searchEntity("JobOrder", args.query, fields, args.count ?? 20, args.start ?? 0);
}

export async function searchCompanies(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,name,phone,address,status,numEmployees,dateAdded";
  return searchEntity(
    "ClientCorporation",
    args.query,
    fields,
    args.count ?? 20,
    args.start ?? 0,
  );
}

export async function searchContacts(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,clientCorporation,status,owner,dateAdded";
  return searchEntity(
    "ClientContact",
    args.query,
    fields,
    args.count ?? 20,
    args.start ?? 0,
  );
}

export async function getCandidate(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,mobile,status,occupation,primarySkills,secondarySkills,educations,workHistories,address,salary,dateAvailable,dateLastModified,owner,dateAdded,source,description";
  return getEntity("Candidate", args.id, fields);
}

export async function getJob(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,dateEnd,address,publicDescription,skills,educationDegree,yearsRequired,startDate";
  return getEntity("JobOrder", args.id, fields);
}

export async function getCompany(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,name,phone,fax,address,status,numEmployees,revenue,dateAdded";
  return getEntity("ClientCorporation", args.id, fields);
}

export async function getContact(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,mobile,clientCorporation,status,owner,dateAdded,description";
  return getEntity("ClientContact", args.id, fields);
}

export async function listSubmissionsForJob(args: {
  jobId: number;
  dateAddedStart?: string;
  dateAddedEnd?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions = [`jobOrder.id=${args.jobId}`];
  conditions.push(
    ...queryDateConditions("dateAdded", args.dateAddedStart, args.dateAddedEnd),
  );
  const fields =
    args.fields ??
    "id,candidate,jobOrder,status,dateAdded,sendingUser,salary,payRate";
  return queryEntity(
    "JobSubmission",
    conditions.join(" AND "),
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "-dateAdded",
  );
}

export async function listPlacements(args: {
  candidateId?: number;
  jobId?: number;
  dateAddedStart?: string;
  dateAddedEnd?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.candidateId) conditions.push(`candidate.id=${args.candidateId}`);
  if (args.jobId) conditions.push(`jobOrder.id=${args.jobId}`);
  conditions.push(
    ...queryDateConditions("dateAdded", args.dateAddedStart, args.dateAddedEnd),
  );
  if (conditions.length === 0) {
    conditions.push("id IS NOT NULL");
  }
  const where = conditions.join(" AND ");
  const fields =
    args.fields ??
    "id,candidate,jobOrder,status,dateAdded,dateBegin,dateEnd,salary,payRate,clientBillRate";
  return queryEntity("Placement", where, fields, args.count ?? 50, args.start ?? 0, "-dateAdded");
}

export async function getNotes(args: {
  candidateId?: number;
  jobId?: number;
  dateAddedStart?: string;
  dateAddedEnd?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.candidateId) conditions.push(`candidates.id:${args.candidateId}`);
  if (args.jobId) conditions.push(`jobOrder.id:${args.jobId}`);
  const dateClause = searchDateClause(
    "dateAdded",
    args.dateAddedStart,
    args.dateAddedEnd,
  );
  if (dateClause) conditions.push(dateClause);
  const query =
    conditions.length > 0 ? conditions.join(" AND ") : "id:[1 TO *]";
  const fields =
    args.fields ??
    "id,action,comments,commentingPerson,candidates,jobOrder,dateAdded";
  // Note is an indexed entity in Bullhorn — it must be read via /search (Lucene),
  // not /query.
  return searchEntity("Note", query, fields, args.count ?? 50, args.start ?? 0);
}

// ---------------------------------------------------------------------------
// Generic read-any-entity layer
// ---------------------------------------------------------------------------

type EntityRoute = "search" | "query" | "both";

interface CatalogEntry {
  /** Exact Bullhorn entity name used in the REST path. */
  canonical: string;
  /** Which read endpoints this entity supports. */
  route: EntityRoute;
  /** Default field list used when the caller does not specify fields. */
  defaultFields: string;
}

/**
 * Allow-list of readable Bullhorn entities. Restricting generic reads to this
 * catalog (rather than accepting arbitrary entity names) prevents REST path
 * abuse and accidental exposure of internal/sensitive entities, and lets us
 * route to the correct endpoint (/search vs /query) with sensible defaults.
 */
const ENTITY_CATALOG: Record<string, CatalogEntry> = {
  candidate: {
    canonical: "Candidate",
    route: "both",
    defaultFields:
      "id,firstName,lastName,email,phone,mobile,status,occupation,address,dateAvailable,dateLastModified,owner,dateAdded",
  },
  clientcontact: {
    canonical: "ClientContact",
    route: "both",
    defaultFields:
      "id,firstName,lastName,email,phone,clientCorporation,status,owner,dateAdded",
  },
  clientcorporation: {
    canonical: "ClientCorporation",
    route: "both",
    defaultFields: "id,name,phone,status,numEmployees,owner,dateAdded",
  },
  joborder: {
    canonical: "JobOrder",
    route: "both",
    defaultFields:
      "id,title,status,type,clientCorporation,owner,dateAdded,isOpen,numOpenings",
  },
  jobsubmission: {
    canonical: "JobSubmission",
    route: "both",
    defaultFields:
      "id,candidate,jobOrder,status,dateAdded,sendingUser,salary,payRate",
  },
  placement: {
    canonical: "Placement",
    route: "both",
    defaultFields:
      "id,candidate,jobOrder,status,dateAdded,dateBegin,dateEnd,salary,payRate",
  },
  note: {
    canonical: "Note",
    route: "search",
    defaultFields:
      "id,action,comments,commentingPerson,candidates,jobOrder,dateAdded",
  },
  lead: {
    canonical: "Lead",
    route: "both",
    defaultFields:
      "id,firstName,lastName,companyName,status,owner,dateAdded,email,phone",
  },
  opportunity: {
    canonical: "Opportunity",
    route: "both",
    defaultFields:
      "id,title,status,clientCorporation,owner,dateAdded,dealValue",
  },
  appointment: {
    canonical: "Appointment",
    route: "query",
    defaultFields: "id,subject,type,dateBegin,dateEnd,location,owner,dateAdded",
  },
  task: {
    canonical: "Task",
    route: "query",
    defaultFields:
      "id,subject,type,dateAdded,dateBegin,dateEnd,dateCompleted,isCompleted,owner,priority",
  },
  corporateuser: {
    canonical: "CorporateUser",
    route: "query",
    defaultFields:
      "id,firstName,lastName,name,email,username,phone,occupation,isDeleted",
  },
  tearsheet: {
    canonical: "Tearsheet",
    route: "query",
    defaultFields: "id,name,description,owner,dateAdded",
  },
  sendout: {
    canonical: "Sendout",
    route: "query",
    defaultFields: "id,candidate,jobOrder,clientContact,user,dateAdded",
  },
};

const ENTITY_ALIASES: Record<string, string> = {
  company: "clientcorporation",
  companies: "clientcorporation",
  client: "clientcorporation",
  corporation: "clientcorporation",
  contact: "clientcontact",
  contacts: "clientcontact",
  job: "joborder",
  jobs: "joborder",
  joborders: "joborder",
  submission: "jobsubmission",
  submissions: "jobsubmission",
  user: "corporateuser",
  users: "corporateuser",
  recruiter: "corporateuser",
  recruiters: "corporateuser",
  appointments: "appointment",
  tasks: "task",
  leads: "lead",
  opportunities: "opportunity",
  placements: "placement",
  candidates: "candidate",
  notes: "note",
  tearsheets: "tearsheet",
  sendouts: "sendout",
};

/** Canonical names of every entity the generic read tools accept. */
export const SUPPORTED_ENTITIES: string[] = Object.values(ENTITY_CATALOG)
  .map((e) => e.canonical)
  .sort();

function resolveEntity(entityType: string): CatalogEntry {
  const key = entityType.trim().toLowerCase();
  const canonicalKey = ENTITY_ALIASES[key] ?? key;
  const entry = ENTITY_CATALOG[canonicalKey];
  if (!entry) {
    throw new Error(
      `Unknown or unsupported entityType "${entityType}". Supported entities: ${SUPPORTED_ENTITIES.join(
        ", ",
      )}.`,
    );
  }
  return entry;
}

/** Generic full-text (/search) read over any indexed catalog entity. */
export async function searchAnyEntity(args: {
  entityType: string;
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const entry = resolveEntity(args.entityType);
  if (entry.route === "query") {
    throw new Error(
      `Entity "${entry.canonical}" is not full-text searchable. Use query_entity with a 'where' clause instead.`,
    );
  }
  const fields = args.fields ?? entry.defaultFields;
  return searchEntity(
    entry.canonical,
    args.query,
    fields,
    args.count ?? 20,
    args.start ?? 0,
  );
}

/** Generic structured (/query) read over any query-capable catalog entity. */
export async function queryAnyEntity(args: {
  entityType: string;
  where: string;
  fields?: string;
  count?: number;
  start?: number;
  orderBy?: string;
}) {
  const entry = resolveEntity(args.entityType);
  if (entry.route === "search") {
    throw new Error(
      `Entity "${entry.canonical}" must be read with search_entity (Lucene 'query'), not query_entity.`,
    );
  }
  const fields = args.fields ?? entry.defaultFields;
  return queryEntity(
    entry.canonical,
    args.where,
    fields,
    args.count ?? 20,
    args.start ?? 0,
    args.orderBy,
  );
}

/** Generic get-by-id over any catalog entity. */
export async function getAnyEntity(args: {
  entityType: string;
  id: number;
  fields?: string;
}) {
  const entry = resolveEntity(args.entityType);
  const fields = args.fields ?? entry.defaultFields;
  return getEntity(entry.canonical, args.id, fields);
}

/** Returns a compact field catalog for an entity via Bullhorn /meta. */
export async function describeEntity(args: { entityType: string }) {
  const entry = resolveEntity(args.entityType);
  const meta = (await bullhornFetch(`meta/${entry.canonical}`, {
    fields: "*",
    meta: "basic",
  })) as {
    entity?: string;
    label?: string;
    fields?: Array<Record<string, unknown>>;
  };
  const fields = Array.isArray(meta.fields)
    ? meta.fields
        .filter((f) => typeof f.name === "string" && !isSensitiveField(f.name as string))
        .map((f) => {
        const associated = f.associatedEntity as { entity?: string } | undefined;
        return {
          name: f.name,
          type: f.type,
          dataType: f.dataType,
          ...(f.optionsType ? { optionsType: f.optionsType } : {}),
          ...(associated?.entity ? { associatedEntity: associated.entity } : {}),
        };
      })
    : [];
  return {
    entity: meta.entity ?? entry.canonical,
    label: meta.label,
    fieldCount: fields.length,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Curated high-value read tools
// ---------------------------------------------------------------------------

/** Doubles single quotes so a user value is safe inside a /query string literal. */
function escapeQueryValue(value: string): string {
  return value.replace(/'/g, "''");
}

/** Job submissions for a candidate (which jobs they were submitted to). */
export async function listSubmissionsForCandidate(args: {
  candidateId: number;
  dateAddedStart?: string;
  dateAddedEnd?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions = [`candidate.id=${args.candidateId}`];
  conditions.push(
    ...queryDateConditions("dateAdded", args.dateAddedStart, args.dateAddedEnd),
  );
  const fields =
    args.fields ??
    "id,candidate,jobOrder,status,dateAdded,sendingUser,salary,payRate";
  return queryEntity(
    "JobSubmission",
    conditions.join(" AND "),
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "-dateAdded",
  );
}

/** Appointments/meetings, filtered by owner and/or scheduled-time window. */
export async function listAppointments(args: {
  ownerId?: number;
  startAfter?: string;
  startBefore?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.ownerId) conditions.push(`owner.id=${args.ownerId}`);
  conditions.push(
    ...queryDateConditions("dateBegin", args.startAfter, args.startBefore),
  );
  if (conditions.length === 0) conditions.push("id IS NOT NULL");
  const fields =
    args.fields ?? "id,subject,type,dateBegin,dateEnd,location,owner,dateAdded";
  return queryEntity(
    "Appointment",
    conditions.join(" AND "),
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "dateBegin",
  );
}

/** Tasks, filtered by owner, due-date window, and/or completion status. */
export async function listTasks(args: {
  ownerId?: number;
  dueStart?: string;
  dueEnd?: string;
  isCompleted?: boolean;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.ownerId) conditions.push(`owner.id=${args.ownerId}`);
  if (args.isCompleted !== undefined) {
    conditions.push(`isCompleted=${args.isCompleted ? "true" : "false"}`);
  }
  // Bullhorn Task has no dueDate field; dateBegin is the task's scheduled date.
  conditions.push(...queryDateConditions("dateBegin", args.dueStart, args.dueEnd));
  if (conditions.length === 0) conditions.push("id IS NOT NULL");
  const fields =
    args.fields ??
    "id,subject,type,dateAdded,dateBegin,dateEnd,dateCompleted,isCompleted,owner,priority";
  return queryEntity(
    "Task",
    conditions.join(" AND "),
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "dateBegin",
  );
}

/** Lucene search over CRM leads (requires Lead & Opportunity tracking enabled). */
export async function searchLeads(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,companyName,status,owner,dateAdded,email,phone";
  return searchEntity("Lead", args.query, fields, args.count ?? 20, args.start ?? 0);
}

/** Lucene search over CRM opportunities (requires Lead & Opportunity tracking). */
export async function searchOpportunities(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,title,status,clientCorporation,owner,dateAdded,dealValue";
  return searchEntity(
    "Opportunity",
    args.query,
    fields,
    args.count ?? 20,
    args.start ?? 0,
  );
}

/** Finds internal Bullhorn users (recruiters) by name and/or email. */
export async function findUsers(args: {
  name?: string;
  email?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.name) {
    const n = escapeQueryValue(args.name.trim());
    conditions.push(
      `(firstName LIKE '%${n}%' OR lastName LIKE '%${n}%' OR name LIKE '%${n}%')`,
    );
  }
  if (args.email) {
    const e = escapeQueryValue(args.email.trim());
    conditions.push(`email LIKE '%${e}%'`);
  }
  if (conditions.length === 0) conditions.push("id IS NOT NULL");
  const fields =
    args.fields ??
    "id,firstName,lastName,name,email,username,phone,occupation,isDeleted";
  return queryEntity(
    "CorporateUser",
    conditions.join(" AND "),
    fields,
    args.count ?? 20,
    args.start ?? 0,
    "lastName",
  );
}
