import { getSession, invalidateSession } from "./bullhorn-auth.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 1;

/**
 * Turns a raw Bullhorn error body into a concise, ACTIONABLE message so an LLM client
 * can self-correct in one step instead of retrying blindly. Blind retry loops are
 * what trip ChatGPT's outbound safety blocks, so a clear "here's what to fix" message
 * is safer than echoing Bullhorn's raw 400. The most common recoverable mistake is
 * requesting a field that doesn't exist on the entity (e.g. reusing one entity's
 * custom field on another), which Bullhorn reports as "Invalid field 'X'".
 */
function formatBullhornError(kind: string, status: number, body: string): Error {
  // Bullhorn returns JSON like {"errorMessage":"...","errorMessageKey":"..."}; parse it
  // first so matching is robust, then fall back to the raw text.
  let errMsg = body;
  let errKey = "";
  try {
    const parsed = JSON.parse(body) as { errorMessage?: string; errorMessageKey?: string };
    if (parsed && typeof parsed === "object") {
      errMsg = parsed.errorMessage ?? body;
      errKey = parsed.errorMessageKey ?? "";
    }
  } catch {
    // body was not JSON; keep raw text
  }

  const invalid = errMsg.match(/Invalid field '([^']+)'/i);
  if (invalid) {
    return new Error(
      `Invalid field "${invalid[1]}" for this entity. Remove it or replace it, then retry. ` +
        `Custom fields differ per entity (e.g. "Internal Department" is correlatedCustomText1 on ` +
        `JobOrder/Placement but customText1 on Opportunity) — call describe_entity to list the ` +
        `valid fields for this entity.`,
    );
  }
  if (/badSearchQuery|Bad Query/i.test(`${errKey} ${errMsg}`)) {
    const what = kind === "search" ? "search query (Lucene)" : "query request";
    return new Error(
      `Malformed Bullhorn ${what} (${status}): likely unbalanced quotes/brackets or invalid ` +
        `syntax. Fix the syntax and retry.`,
    );
  }
  const capped = errMsg.length > 300 ? `${errMsg.slice(0, 300)}…[truncated]` : errMsg;
  return new Error(`Bullhorn ${kind} error (${status}): ${capped}`);
}

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
    throw formatBullhornError("API", res.status, text);
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
 * Cleans a comma-separated fields list before it is sent to Bullhorn:
 *  - drops credential-like fields (defense-in-depth, so a caller can never
 *    request/exfiltrate a field such as `password`), and
 *  - drops `bullhornUrl`, a server-injected deep-link pseudo-field that is added
 *    to responses AFTER the fetch (see enrichWithProfileUrls). It is not a real
 *    Bullhorn field, so forwarding it returns a 400 "Invalid field" — which makes
 *    the AI client waste a whole retry round-trip. Callers may safely include it
 *    (the tool descriptions advertise it); we strip it here and add it back later.
 * Falls back to "id" if nothing safe remains.
 */
function sanitizeFields(fields: string): string {
  const kept = fields
    .split(",")
    .map((f) => f.trim())
    .filter(
      (f) =>
        f.length > 0 &&
        !isSensitiveField(f) &&
        f.toLowerCase() !== "bullhornurl",
    );
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

/**
 * SSN-redacts the `description` (parsed résumé text) of every Candidate record
 * in a Bullhorn response, mutating in place. Covers (a) top-level Candidate
 * reads and (b) candidate data returned as a `candidate` / `candidates`
 * association on ANY entity (e.g. `JobSubmission.candidate(...,description)`),
 * at any reasonable depth. Other entities' own `description` (job/company/note
 * text) is intentionally left untouched. Defence-in-depth so résumé PII is
 * masked even when a caller requests `description` directly; full, length-capped
 * résumé text is served only by the dedicated get_candidate_resume tool.
 *
 * When `opts.capDescription` is set (list/search paths), each résumé `description`
 * is additionally truncated to a short preview so multi-record payloads stay
 * within MCP client response-size limits. Single-record reads leave it uncapped.
 */
function redactCandidateDescriptions(
  entity: string,
  json: unknown,
  opts: { capDescription?: boolean } = {},
): unknown {
  if (!json || typeof json !== "object") return json;
  const cap = opts.capDescription === true;
  const redactDesc = (rec: unknown) => {
    if (rec && typeof rec === "object" && !Array.isArray(rec)) {
      const r = rec as Record<string, unknown>;
      if (typeof r.description === "string") {
        let d = redactResumeText(r.description);
        if (cap && d.length > MAX_LIST_DESC_CHARS) {
          d = d.slice(0, MAX_LIST_DESC_CHARS) + LIST_DESC_TRUNCATION_MARKER;
        }
        r.description = d;
      }
    }
  };
  // A candidate association value may be a bare to-one object, an array, or a
  // `{ data }` / `{ total, data }` envelope.
  const redactCandidateAssoc = (val: unknown) => {
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) {
      val.forEach(redactDesc);
      return;
    }
    const o = val as Record<string, unknown>;
    if ("data" in o) {
      const d = o.data;
      if (Array.isArray(d)) d.forEach(redactDesc);
      else redactDesc(d);
    } else {
      redactDesc(o);
    }
  };
  // Walks the response for `candidate`/`candidates` associations at any depth
  // and redacts the résumé text inside them. Depth-bounded as a safety net;
  // re-redaction is idempotent so overlapping passes are harmless.
  const scan = (node: unknown, depth: number) => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) scan(n, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "candidate" || k === "candidates") redactCandidateAssoc(v);
      scan(v, depth + 1);
    }
  };
  // Top-level Candidate records' own résumé text.
  if (entity === "Candidate") {
    const obj = json as Record<string, unknown>;
    if ("data" in obj) {
      const data = obj.data;
      if (Array.isArray(data)) data.forEach(redactDesc);
      else redactDesc(data);
    } else {
      redactDesc(obj);
    }
  }
  // Nested candidate associations on any entity.
  scan(json, 0);
  return json;
}

/**
 * Bullhorn's Lucene /search returns ZERO matches for a query made up entirely of
 * negations (e.g. `NOT status:"Closed-Won" AND NOT status:"Closed-Lost"`), because
 * there is no positive document set to subtract from. Callers building an
 * "everything except X" filter — LLM clients especially — hit this silently and
 * wrongly conclude the data is unavailable. When every top-level clause is negated,
 * prepend a positive anchor (`id:[1 TO *]`, which matches every record) so the
 * negations apply to the full set. A query that already has a positive clause is
 * left untouched: anchoring it would be a harmless no-op, but we restrict the
 * rewrite to the all-negative case to avoid surprising intended results.
 */
function anchorPureNegationQuery(query: string, entity: string): string {
  const trimmed = query.trim();
  if (trimmed === "") return query;
  const clauses = trimmed
    .split(/\s+(?:AND|OR)\s+/i)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return query;
  const allNegated = clauses.every((c) => /^(?:NOT\b|-)/i.test(c));
  if (!allNegated) return query;
  // Bullhorn's Lucene rejects a *parenthesized* all-negative group (it returns 0
  // just like the bare query), so prepend the anchor FLAT, AND-joined. Skip
  // queries that use a top-level OR between negations: a flat prepend would change
  // operator precedence and could silently mislead, so we leave those untouched.
  if (/\bOR\b/i.test(trimmed)) return query;
  // Log only non-PII metadata: the raw query can contain names/emails/phones, so we
  // record that an anchor was applied and to which entity, never the query text.
  logger.info("Bullhorn search: anchoring all-negative query so it is not silently empty", {
    entity,
    clauseCount: clauses.length,
  });
  return `id:[1 TO *] AND ${trimmed}`;
}

async function searchEntity(
  entity: string,
  query: string,
  fields: string,
  count: number,
  start: number,
): Promise<unknown> {
  fields = sanitizeFields(fields);
  query = anchorPureNegationQuery(query, entity);
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
    throw formatBullhornError("search", res.status, text);
  }
  return redactCandidateDescriptions(
    entity,
    await enrichWithProfileUrls(entity, await res.json()),
    { capDescription: true },
  );
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
  return redactCandidateDescriptions(
    entity,
    await enrichWithProfileUrls(entity, await bullhornFetch(`query/${entity}`, params)),
    { capDescription: true },
  );
}

async function getEntity(
  entity: string,
  id: number,
  fields: string,
): Promise<unknown> {
  return redactCandidateDescriptions(
    entity,
    await enrichWithProfileUrls(
      entity,
      await bullhornFetch(`entity/${entity}/${id}`, { fields: sanitizeFields(fields) }),
    ),
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

/**
 * Candidate text fields that are reliably full-text searchable in this Bullhorn
 * instance (verified empirically): `description` is the parsed RÉSUMÉ text,
 * `skillSet` the free-text skills list, `comments` recruiter notes, and
 * `occupation` the headline title. primarySkills/secondarySkills/certifications/
 * certificationList/educations/workHistories are empty or not free-text
 * searchable here, so they are intentionally excluded from keyword expansion.
 */
const CANDIDATE_TEXT_SEARCH_FIELDS = [
  "description",
  "skillSet",
  "comments",
  "occupation",
] as const;

const MAX_KEYWORD_GROUPS = 12;
const MAX_TERMS_PER_GROUP = 24;
const MAX_KEYWORD_LEN = 100;

/** Escapes the two characters that are special inside a Lucene quoted phrase. */
function escapeLucenePhrase(term: string): string {
  return term.replace(/[\\"]/g, "\\$&");
}

/**
 * Expands caller-supplied keywords into a safe, field-scoped Lucene fragment that
 * searches ALL of a candidate's text fields at once — so résumé/skills/notes
 * keyword discovery can never miss a field or accidentally emit a bare
 * (fieldless) term, which Bullhorn either rejects (400) or, worse, silently
 * mis-applies. Each top-level entry is a REQUIRED concept (AND-ed); a string is
 * one phrase, an inner array is a synonym group (OR-ed). Every term is quoted as
 * a phrase and OR-ed across CANDIDATE_TEXT_SEARCH_FIELDS.
 *
 * Example: [["Top Secret", "TS/SCI"], "Active"] =>
 *   (description:"Top Secret" OR skillSet:"Top Secret" OR ... OR description:"TS/SCI" OR ...)
 *   AND (description:"Active" OR skillSet:"Active" OR ...)
 *
 * Returns "" when no usable keywords are supplied.
 */
function buildCandidateKeywordQuery(keywords: Array<string | string[]>): string {
  if (!Array.isArray(keywords)) return "";
  const groups: string[] = [];
  for (const entry of keywords.slice(0, MAX_KEYWORD_GROUPS)) {
    const terms = (Array.isArray(entry) ? entry : [entry])
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= MAX_KEYWORD_LEN)
      .slice(0, MAX_TERMS_PER_GROUP);
    if (terms.length === 0) continue;
    const clauses = terms.flatMap((t) => {
      const phrase = `"${escapeLucenePhrase(t)}"`;
      return CANDIDATE_TEXT_SEARCH_FIELDS.map((f) => `${f}:${phrase}`);
    });
    groups.push(`(${clauses.join(" OR ")})`);
  }
  return groups.join(" AND ");
}

/**
 * Combines an optional structured Lucene `query` (status/willRelocate/dates/etc.)
 * with optional `keywords` (résumé/skills text search). At least one must
 * resolve to a non-empty clause; the two are AND-ed so keyword discovery is
 * constrained by the structured filters.
 */
function combineCandidateQuery(
  query: string | undefined,
  keywords: Array<string | string[]> | undefined,
): string {
  const parts: string[] = [];
  const kw = keywords ? buildCandidateKeywordQuery(keywords) : "";
  if (kw) parts.push(kw);
  const q = (query ?? "").trim();
  if (q) parts.push(`(${q})`);
  if (parts.length === 0) {
    throw new Error(
      "search_candidates requires `query` (structured filters) and/or `keywords` (résumé/skills text search).",
    );
  }
  return parts.join(" AND ");
}

export async function searchCandidates(args: {
  query?: string;
  keywords?: Array<string | string[]>;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,mobile,status,occupation,skillSet,primarySkills,address,dateAvailable,dateLastModified,owner,dateAdded";
  const query = combineCandidateQuery(args.query, args.keywords);
  return searchEntity("Candidate", query, fields, args.count ?? 20, args.start ?? 0);
}

export async function searchJobs(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    // `correlatedCustomText1` is this instance's "Internal Department" (office/
    // branch, e.g. "MYT-Ottawa"); included so callers can group/filter by it.
    // `publicDescription` is deliberately omitted from the search default: it is
    // large free text that bloats multi-record payloads (and a high `count` could
    // exceed MCP response-size limits). Request it explicitly, or use get_job.
    // customText2 = "Client Job Title" (the client's own title for the role).
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,dateEnd,address,correlatedCustomText1,customText2";
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
    // customText1 = this instance's "Internal Department" on contacts.
    "id,firstName,lastName,email,phone,clientCorporation,status,owner,dateAdded,customText1";
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
    // customText3 = this instance's "Internal Department" on candidates (sparse).
    "id,firstName,lastName,email,phone,mobile,status,occupation,skillSet,primarySkills(id,name),secondarySkills(id,name),educations(id,degree,major,school),workHistories(id,title,companyName,startDate,endDate),address,salary,dateAvailable,dateLastModified,owner,dateAdded,source,customText3";
  return getEntity("Candidate", args.id, fields);
}

export async function getJob(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,dateEnd,address,publicDescription,skills,educationDegree,yearsRequired,startDate,correlatedCustomText1,customText2";
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
    // customText1 = this instance's "Internal Department" on contacts.
    "id,firstName,lastName,email,phone,mobile,clientCorporation,status,owner,dateAdded,description,customText1";
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
    // correlatedCustomText1 = "Internal Department"; customText29 = "External ID";
    // customDate1 = "Original End Date" (epoch ms); customText2 = "Currency Unit".
    "id,candidate,jobOrder,status,dateAdded,dateBegin,dateEnd,salary,payRate,clientBillRate,correlatedCustomText1,customText29,customDate1,customText2";
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
// File / attachment reading (Bullhorn Files API — strictly READ-ONLY)
// ---------------------------------------------------------------------------
//
// Bullhorn serves candidate documents through a separate Files API:
//   - GET entityFiles/Candidate/{id}        -> list attachment metadata
//   - GET file/Candidate/{id}/{fileId}       -> fetch one file (base64 content)
// These are distinct from the search/query/entity plumbing above. We only ever
// issue GETs here. Many résumés are binary (PDF/Word) with no server-side text
// extraction; we decode and return text only for textual formats and degrade
// gracefully (metadata + explanation) otherwise — never fabricating content.

/** Default / hard cap on characters of extracted attachment text returned. */
const DEFAULT_ATTACHMENT_TEXT_CHARS = 20_000;
const MAX_ATTACHMENT_TEXT_CHARS = 100_000;
/**
 * Cap on the attachment `description` snippet returned as metadata. Bullhorn
 * sometimes stuffs the FULL parsed résumé (including PII) into this field, so it
 * must be redacted + capped like any other returned text rather than passed
 * through raw in attachment listings.
 */
const MAX_ATTACHMENT_DESC_CHARS = 1_000;
/** Hard cap on decoded attachment bytes we will process for text extraction. */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * In multi-record list/search results, a candidate's résumé text (`description`)
 * is capped to a short preview so large result sets stay within MCP client
 * response-size limits. A `count=100` candidate search that returns full résumés
 * is ~2.5 MB (median résumé ~22 k chars), which clients such as ChatGPT silently
 * drop ("blocked by the tool-safety layer"). Full, length-capped résumé text is
 * served only by the dedicated get_candidate_resume tool; single-record reads
 * (get_candidate / get_entity) are not capped.
 */
const MAX_LIST_DESC_CHARS = 600;
const LIST_DESC_TRUNCATION_MARKER =
  " …[résumé preview truncated — call get_candidate_resume for the full text]";

const SSN_RE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g;

/**
 * Masks high-sensitivity PII (US SSNs) from free attachment text. Email and
 * phone are intentionally preserved — they are returned unredacted by the
 * structured read tools too, and contact details are the whole point of a
 * résumé for a recruiter. `ssn` is part of the credential/secret denylist
 * concept already enforced on field names, so we extend it to free text here.
 */
function redactResumeText(text: string): string {
  return text.replace(SSN_RE, "[REDACTED-SSN]");
}

/** Chars of context kept on EACH side of a matched term in an excerpt. */
const EXCERPT_WINDOW_CHARS = 220;
/** Overall caps so excerpt payloads stay small. */
const MAX_TOTAL_EXCERPTS = 10;
const MAX_EXCERPT_TOTAL_CHARS = 4_000;
/** Clamp on a single (possibly merged) excerpt so one long passage can't bloat the result. */
const MAX_SINGLE_EXCERPT_CHARS = 1_200;

/**
 * Builds short quotes ("excerpts") around the FIRST occurrence of each term in
 * `text`. Returned by get_candidate_resume's VERIFY mode INSTEAD of the full
 * résumé, so the payload stays small and low on PII — which makes clients such as
 * ChatGPT far less likely to withhold the result ("blocked by the tool-safety
 * layer"), while still giving the exact "quote where it appears" to cite.
 *
 * Contract (important): a term lands in `matchedTerms` ONLY if it is actually
 * present in a returned quote (verified, not just "found somewhere"). Terms that
 * appear in the text but whose quote was trimmed by the caps go in
 * `foundButNotQuoted` (and set `truncated`); terms absent from the text go in
 * `termsNotFound`. So `matchedTerms` is always backed by citable evidence and
 * the model can never report a skill/clearance as present without a quote.
 *
 * Each excerpt is a ~EXCERPT_WINDOW_CHARS window on either side of a match (with
 * "…" markers when it doesn't reach a text boundary); overlapping windows are
 * merged into one quote that may cover several `terms`. Case-insensitive and
 * phrase-aware (a term may be a multi-word phrase). Pure string work; no network
 * or mutation.
 */
function buildExcerpts(
  text: string,
  terms: string[],
): {
  excerpts: Array<{ terms: string[]; quote: string }>;
  matchedTerms: string[];
  foundButNotQuoted: string[];
  termsNotFound: string[];
  truncated: boolean;
} {
  const cleanTerms = Array.from(
    new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0)),
  );
  const hay = text.toLowerCase();

  // First occurrence of each term (one anchor per term).
  const found: Array<{ term: string; idx: number }> = [];
  const termsNotFound: string[] = [];
  for (const term of cleanTerms) {
    const idx = hay.indexOf(term.toLowerCase());
    if (idx === -1) termsNotFound.push(term);
    else found.push({ term, idx });
  }
  found.sort((a, b) => a.idx - b.idx);

  // Merge overlapping windows (sorted by idx → only need to check the last one).
  type Range = { start: number; end: number; terms: string[] };
  const ranges: Range[] = [];
  let truncated = false;
  for (const { term, idx } of found) {
    const start = Math.max(0, idx - EXCERPT_WINDOW_CHARS);
    const end = Math.min(text.length, idx + term.length + EXCERPT_WINDOW_CHARS);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      if (!last.terms.includes(term)) last.terms.push(term);
    } else if (ranges.length < MAX_TOTAL_EXCERPTS) {
      ranges.push({ start, end, terms: [term] });
    } else {
      truncated = true; // no room to open a new excerpt window
    }
  }

  const excerpts: Array<{ terms: string[]; quote: string }> = [];
  const quoted = new Set<string>();
  let totalChars = 0;
  for (const r of ranges) {
    const start = r.start;
    // Clamp a single (merged) window so one long passage can't bloat the result.
    const end = Math.min(r.end, start + MAX_SINGLE_EXCERPT_CHARS);
    if (end < r.end) truncated = true;
    let quote = text.slice(start, end).trim();
    if (start > 0) quote = "…" + quote;
    if (end < text.length) quote = quote + "…";
    if (totalChars + quote.length > MAX_EXCERPT_TOTAL_CHARS && excerpts.length > 0) {
      truncated = true;
      break;
    }
    // Only credit terms that ACTUALLY appear in the emitted quote (a term anchored
    // past the clamp wouldn't), so matchedTerms is always evidence-backed.
    const ql = quote.toLowerCase();
    const present = r.terms.filter((t) => ql.includes(t.toLowerCase()));
    if (present.length === 0) continue;
    excerpts.push({ terms: present, quote });
    present.forEach((t) => quoted.add(t));
    totalChars += quote.length;
  }

  const matchedTerms = found.map((f) => f.term).filter((t) => quoted.has(t));
  const foundButNotQuoted = found
    .map((f) => f.term)
    .filter((t) => !quoted.has(t));
  if (foundButNotQuoted.length > 0) truncated = true;

  return { excerpts, matchedTerms, foundButNotQuoted, termsNotFound, truncated };
}

/**
 * Sanitizes the attachment `description` returned as metadata. Bullhorn may put
 * the full parsed résumé text here, so apply the same SSN redaction as extracted
 * text and cap it to a short snippet — full text must come from the dedicated
 * read tools (which redact + honour the larger text caps), not from listings.
 */
function sanitizeAttachmentDescription(desc?: string): string | undefined {
  if (!desc) return desc;
  const redacted = redactResumeText(desc);
  return redacted.length > MAX_ATTACHMENT_DESC_CHARS
    ? redacted.slice(0, MAX_ATTACHMENT_DESC_CHARS)
    : redacted;
}

/** Reads the first present key from an object (tolerant of casing differences). */
function pickKey(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

interface AttachmentMeta {
  id?: number;
  name?: string;
  /** Bullhorn document category, e.g. "Resume", "Cover Letter". */
  type?: string;
  contentType?: string;
  fileType?: string;
  contentSubType?: string;
  description?: string;
  dateAdded?: number;
}

function normalizeAttachment(raw: Record<string, unknown>): AttachmentMeta {
  const contentType = asString(pickKey(raw, "contentType", "fileContentType"));
  const contentSubType = asString(pickKey(raw, "contentSubType"));
  // The list endpoint splits the MIME type across contentType ("application")
  // and contentSubType ("pdf" / "vnd.openxmlformats-..."). Recombine into a full
  // "application/pdf" so downstream format detection has the complete type.
  const fullContentType =
    contentType && contentSubType && !contentType.includes("/")
      ? `${contentType}/${contentSubType}`
      : contentType;
  return {
    id: asNumber(pickKey(raw, "id")),
    name: asString(pickKey(raw, "name", "fileName")),
    type: asString(pickKey(raw, "type")),
    contentType: fullContentType,
    fileType: asString(pickKey(raw, "fileType")),
    contentSubType,
    description: sanitizeAttachmentDescription(asString(pickKey(raw, "description"))),
    dateAdded: asNumber(pickKey(raw, "dateAdded")),
  };
}

/**
 * True for formats whose bytes are directly readable as text. Binary container
 * formats (PDF, the ZIP-based Office .docx/.xlsx/.pptx, images, etc.) are
 * excluded FIRST — their MIME strings/names contain text-looking substrings
 * (e.g. "xml" inside "openxmlformats"), which must not be mistaken for text.
 */
function isTextualContentType(contentType?: string, name?: string): boolean {
  const ct = (contentType ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  if (
    /(officedocument|opendocument|msword|ms-excel|ms-powerpoint|pdf|zip|x-rar|7z|gzip|octet-stream|vnd\.|image\/|audio\/|video\/)/.test(
      ct,
    )
  ) {
    return false;
  }
  if (/\.(docx?|xlsx?|pptx?|pdf|zip|rar|7z|gz|png|jpe?g|gif|bmp|tiff?|webp)$/.test(n)) {
    return false;
  }
  if (ct.startsWith("text/")) return true;
  if (/\b(rtf|json|csv|plain|markdown)\b/.test(ct)) return true;
  if (/(application|text)\/(x-)?(html|xhtml|xml)\b/.test(ct)) return true;
  return /\.(txt|text|html?|rtf|csv|md|markdown|xml|json|log)$/.test(n);
}

/** Magic-byte sniff: true when the decoded bytes are clearly a binary file. */
function looksBinaryBuffer(buf: Buffer): boolean {
  const sig = buf.subarray(0, 4).toString("latin1");
  if (sig.startsWith("PK\u0003\u0004")) return true; // zip / docx / xlsx / pptx
  if (sig.startsWith("%PDF")) return true; // pdf
  if (sig.startsWith("\u00D0\u00CF\u0011\u00E0")) return true; // legacy OLE (doc/xls/ppt)
  return buf.subarray(0, 1000).includes(0); // embedded NUL byte → binary
}

/** Crude but dependency-free HTML-to-text: drop tags/entities, collapse space. */
function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clampChars(requested: number | undefined): number {
  const n = requested ?? DEFAULT_ATTACHMENT_TEXT_CHARS;
  if (!Number.isFinite(n)) return DEFAULT_ATTACHMENT_TEXT_CHARS;
  return Math.max(1, Math.min(MAX_ATTACHMENT_TEXT_CHARS, Math.floor(n)));
}

/** Picks the attachment most likely to be the résumé from a metadata list. */
function pickResumeAttachment(attachments: AttachmentMeta[]): AttachmentMeta | null {
  const matches = (a: AttachmentMeta, re: RegExp) =>
    re.test(a.type ?? "") || re.test(a.name ?? "") || re.test(a.description ?? "");
  return (
    attachments.find((a) => matches(a, /resume|résumé|\bcv\b|curriculum/i)) ??
    attachments.find((a) => isTextualContentType(a.contentType, a.name)) ??
    attachments[0] ??
    null
  );
}

/**
 * Lists a candidate's file attachments (metadata only — no content). Read-only.
 */
export async function listCandidateAttachments(args: { candidateId: number }) {
  const raw = (await bullhornFetch(
    `entityFiles/Candidate/${args.candidateId}`,
    {},
  )) as Record<string, unknown>;
  const picked = pickKey(
    raw,
    "EntityFiles",
    "FileAttachments",
    "fileAttachments",
    "data",
  );
  // Be tolerant of the exact envelope shape: accept a bare array, or an object
  // that nests the array under `.data`. Anything else degrades to "no files"
  // rather than throwing.
  const list: unknown[] = Array.isArray(picked)
    ? picked
    : picked && typeof picked === "object" && Array.isArray((picked as Record<string, unknown>).data)
      ? ((picked as Record<string, unknown>).data as unknown[])
      : [];
  const attachments = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map(normalizeAttachment);
  return { candidateId: args.candidateId, count: attachments.length, attachments };
}

/**
 * Fetches a single candidate attachment and returns its extracted text when the
 * format is textual; otherwise returns metadata plus a clear explanation. The
 * returned text is SSN-redacted and capped. Read-only.
 */
export async function readCandidateAttachment(args: {
  candidateId: number;
  fileId: number;
  maxChars?: number;
}) {
  const raw = (await bullhornFetch(
    `file/Candidate/${args.candidateId}/${args.fileId}`,
    {},
  )) as Record<string, unknown>;
  const file = (pickKey(raw, "File", "file") ?? raw) as Record<string, unknown>;

  const meta = {
    id: asNumber(pickKey(file, "id")) ?? args.fileId,
    name: asString(pickKey(file, "name", "fileName")),
    type: asString(pickKey(file, "type")),
    contentType: asString(pickKey(file, "contentType", "fileContentType")),
    fileType: asString(pickKey(file, "fileType")),
    dateAdded: asNumber(pickKey(file, "dateAdded")),
  };

  const base64 = asString(pickKey(file, "fileContent", "content"));
  if (!base64) {
    return {
      ...meta,
      textAvailable: false,
      message:
        "Bullhorn returned no file content for this attachment, so no text could be extracted.",
    };
  }

  // Bound work BEFORE decoding: estimate decoded size from the base64 length and
  // refuse oversized files so a huge attachment can't blow up memory/CPU.
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ...meta,
      sizeBytes: estimatedBytes,
      textAvailable: false,
      message:
        `This attachment is ~${Math.round(estimatedBytes / 1024 / 1024)} MB, which exceeds the ` +
        `${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB processing limit. ` +
        `Open it in Bullhorn to view.`,
    };
  }

  const buf = Buffer.from(base64, "base64");
  if (!isTextualContentType(meta.contentType, meta.name) || looksBinaryBuffer(buf)) {
    return {
      ...meta,
      sizeBytes: buf.length,
      textAvailable: false,
      message:
        `This attachment is a binary file (${meta.contentType ?? "unknown type"}) ` +
        `with no server-side text extraction available. Open it in Bullhorn to view, ` +
        `or call get_candidate_resume / get_candidate — the candidate record often ` +
        `stores the parsed résumé text.`,
    };
  }

  let text = buf.toString("utf8");
  const looksHtml =
    /html/i.test(meta.contentType ?? "") || /<\/?(html|body|div|p|span|table)\b/i.test(text);
  if (looksHtml) text = stripHtml(text);
  text = redactResumeText(text);

  const cap = clampChars(args.maxChars);
  const truncated = text.length > cap;
  if (truncated) text = text.slice(0, cap);

  return {
    ...meta,
    sizeBytes: buf.length,
    textAvailable: true,
    truncated,
    charsReturned: text.length,
    text,
  };
}

/**
 * Convenience résumé reader: pulls the candidate's parsed résumé text from the
 * record `description` (where Bullhorn typically stores it after parsing) and,
 * if a résumé file attachment in a textual format exists, the extracted text
 * from it (preferred over the record text). Binary attachments (PDF/Word) are
 * surfaced as metadata only — they are never downloaded here, since they yield
 * no extractable text. Read-only; all returned text is SSN-redacted and capped.
 */
export async function getCandidateResume(args: {
  candidateId: number;
  maxChars?: number;
  highlight?: string[];
}) {
  const highlightTerms = Array.isArray(args.highlight)
    ? args.highlight
        .map((t) => (typeof t === "string" ? t : ""))
        .filter((t) => t.trim().length > 0)
    : [];
  const highlightActive = highlightTerms.length > 0;

  const cand = (await bullhornFetch(`entity/Candidate/${args.candidateId}`, {
    fields: "id,firstName,lastName,description",
  })) as Record<string, unknown>;
  const candData = (pickKey(cand, "data") ?? cand) as Record<string, unknown>;
  const rawDescription = asString(pickKey(candData, "description"));
  const cap = clampChars(args.maxChars);
  // In VERIFY (excerpt) mode we search the FULL résumé so matches beyond the
  // normal cap aren't missed, but only return short quotes — so the response
  // stays small regardless. In FULL mode we cap as before.
  const searchCap = highlightActive ? MAX_ATTACHMENT_TEXT_CHARS : cap;
  const cleanedDescription =
    rawDescription && rawDescription.trim() !== ""
      ? redactResumeText(stripHtml(rawDescription))
      : null;

  const { attachments } = await listCandidateAttachments({
    candidateId: args.candidateId,
  });
  const resume = pickResumeAttachment(attachments);

  // Only download/decode the chosen attachment when its format is textual.
  // Binary résumés (PDF/Word) yield no extractable text, so fetching them just
  // wastes bandwidth/memory — we still surface their metadata below and fall
  // back to the parsed text on candidate.description.
  let resumeAttachmentText:
    | Awaited<ReturnType<typeof readCandidateAttachment>>
    | null = null;
  if (
    resume?.id !== undefined &&
    isTextualContentType(resume.contentType, resume.name)
  ) {
    resumeAttachmentText = await readCandidateAttachment({
      candidateId: args.candidateId,
      fileId: resume.id,
      maxChars: searchCap,
    });
  }

  const fileText =
    resumeAttachmentText && "text" in resumeAttachmentText
      ? (resumeAttachmentText as { text?: string }).text ?? null
      : null;

  // Best single source for "read the résumé": prefer the attachment's extracted
  // text, falling back to the parsed text on the candidate record.
  const sourceFullText = fileText ?? cleanedDescription;
  const resumeTextSource = fileText
    ? "attachment"
    : cleanedDescription
      ? "candidate.description"
      : "none";

  const candidateName =
    [asString(pickKey(candData, "firstName")), asString(pickKey(candData, "lastName"))]
      .filter(Boolean)
      .join(" ") || undefined;

  // VERIFY mode: return only short quotes around the requested terms.
  if (highlightActive) {
    const { excerpts, matchedTerms, foundButNotQuoted, termsNotFound, truncated } =
      buildExcerpts(sourceFullText ?? "", highlightTerms);
    // Drop the attachments' parsed `description` previews here: VERIFY mode is the
    // privacy-lean path, and those previews can carry résumé text we deliberately
    // aren't returning. Keep the rest of the metadata (name/type/id/dates).
    const stripDescription = <T extends { description?: unknown }>(a: T | null) =>
      a ? (({ description: _drop, ...rest }) => rest)(a) : a;
    return {
      candidateId: args.candidateId,
      candidateName,
      mode: "excerpts" as const,
      resumeTextSource,
      highlightTerms,
      matchedTerms,
      foundButNotQuoted,
      termsNotFound,
      excerpts,
      excerptsTruncated: truncated,
      resumeAttachment: stripDescription(resume ?? null),
      attachmentCount: attachments.length,
      attachments: attachments.map((a) => stripDescription(a)),
      note:
        resumeTextSource === "none"
          ? "No résumé text was found on the candidate record (description) and " +
            "no readable text attachment exists. Any binary attachments are listed " +
            "above — open them in Bullhorn to view."
          : "VERIFY mode: returned short quotes around your `highlight` terms instead " +
            "of the full résumé, to keep the result small and reduce the chance the " +
            "client withholds it. `matchedTerms` are confirmed present WITH a quote; " +
            "`foundButNotQuoted` appear but their quote was trimmed by size caps; " +
            "`termsNotFound` do not appear. For the complete text, call " +
            "get_candidate_resume again WITHOUT `highlight` (optionally raise `maxChars`).",
    };
  }

  // FULL mode (unchanged behaviour): return the capped résumé text.
  const descriptionText = cleanedDescription
    ? cleanedDescription.length > cap
      ? cleanedDescription.slice(0, cap)
      : cleanedDescription
    : null;
  const resumeText = fileText ?? descriptionText;
  return {
    candidateId: args.candidateId,
    candidateName,
    resumeText,
    resumeTextSource,
    // Surface the parsed record text separately only when it isn't already the
    // answer (i.e. the résumé came from a file) so the text isn't sent twice.
    ...(resumeTextSource === "attachment" && descriptionText
      ? { descriptionText }
      : {}),
    resumeAttachment: resume,
    attachmentCount: attachments.length,
    attachments,
    ...(resumeTextSource === "none"
      ? {
          note:
            "No résumé text was found on the candidate record (description) and " +
            "no readable text attachment exists. Any binary attachments are listed " +
            "above — open them in Bullhorn to view.",
        }
      : {}),
  };
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
      "id,firstName,lastName,email,phone,mobile,status,occupation,skillSet,address,dateAvailable,dateLastModified,owner,dateAdded",
  },
  clientcontact: {
    canonical: "ClientContact",
    route: "both",
    // customText1 = this instance's "Internal Department" (owning office/branch).
    defaultFields:
      "id,firstName,lastName,email,phone,clientCorporation,status,owner,dateAdded,customText1",
  },
  clientcorporation: {
    canonical: "ClientCorporation",
    route: "both",
    defaultFields: "id,name,phone,status,numEmployees,owner,dateAdded",
  },
  joborder: {
    canonical: "JobOrder",
    route: "both",
    // correlatedCustomText1 = "Internal Department"; customText2 = "Client Job Title".
    defaultFields:
      "id,title,status,type,clientCorporation,owner,dateAdded,isOpen,numOpenings,correlatedCustomText1,customText2",
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
    // correlatedCustomText1 = "Internal Department"; customText29 = "External ID";
    // customDate1 = "Original End Date" (epoch ms); customText2 = "Currency Unit".
    defaultFields:
      "id,candidate,jobOrder,status,dateAdded,dateBegin,dateEnd,salary,payRate,correlatedCustomText1,customText29,customDate1,customText2",
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
    // customText1 = "Internal Department"; customText20 = "External ID".
    defaultFields:
      "id,firstName,lastName,companyName,status,owner,dateAdded,email,phone,customText1,customText20",
  },
  opportunity: {
    canonical: "Opportunity",
    route: "both",
    // customText1 = "Internal Department".
    defaultFields:
      "id,title,status,clientCorporation,owner,dateAdded,dealValue,customText1",
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

/**
 * True when a field is a tenant-CONFIGURED custom field: an opaque custom field
 * name (customText3, correlatedCustomText1, customInt1, ...) that an admin has
 * given a real human label (e.g. "Internal Department"), as opposed to an
 * unconfigured slot whose label is still Bullhorn's generic default ("Custom Text
 * Block 10", "Custom Encrypted Text 1", "Custom 10", "Custom Object1s"). Lets us
 * surface the label -> API-field mapping without hardcoding any tenant field name.
 */
function isConfiguredCustomField(name: unknown, label: unknown): boolean {
  if (typeof name !== "string" || typeof label !== "string") return false;
  if (!/^(custom|correlatedCustom)/i.test(name)) return false;
  const trimmed = label.trim();
  if (!trimmed || trimmed.toLowerCase() === name.toLowerCase()) return false;
  const DEFAULT_LABEL_PATTERNS = [
    /^(custom\s*)?(text\s*block|encrypted\s*text|bill\s*rate|pay\s*rate|text|int|integer|float|date|object|number)\s*\d+$/i,
    /^custom\s*object\s*\d+\s*s$/i,
    /^custom\s*\d+$/i,
  ];
  return !DEFAULT_LABEL_PATTERNS.some((re) => re.test(trimmed));
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
          // The human-readable UI label (e.g. "Internal Department" for the
          // opaque `correlatedCustomText1`) so callers can map labels they see
          // in Bullhorn to the real API field names used in queries/fields.
          ...(typeof f.label === "string" && f.label ? { label: f.label } : {}),
          type: f.type,
          dataType: f.dataType,
          ...(f.optionsType ? { optionsType: f.optionsType } : {}),
          ...(associated?.entity ? { associatedEntity: associated.entity } : {}),
        };
      })
    : [];
  const configuredCustomFields = fields.filter((f) =>
    isConfiguredCustomField(f.name, f.label),
  );
  return {
    entity: meta.entity ?? entry.canonical,
    label: meta.label,
    fieldCount: fields.length,
    // Admin-configured custom fields (opaque API name + human label), surfaced so
    // callers can map a Bullhorn UI label to the real field without scanning all
    // 100-300 fields. Subset of `fields`.
    configuredCustomFields,
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
    // customText1 = "Internal Department"; customText20 = "External ID".
    "id,firstName,lastName,companyName,status,owner,dateAdded,email,phone,customText1,customText20";
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
    // customText1 = "Internal Department".
    "id,title,status,clientCorporation,owner,dateAdded,dealValue,customText1";
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
