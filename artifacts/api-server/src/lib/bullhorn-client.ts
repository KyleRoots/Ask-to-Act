import { getSession, invalidateSession } from "./bullhorn-auth.js";
import { logger } from "./logger.js";
import { cacheGet, cacheSet } from "./cache.js";

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
  // Cache key excludes the rotating BhRestToken; same path+params => same read.
  const cacheKey = `fetch:${path}:${JSON.stringify(
    Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
  )}`;
  const cached = cacheGet<unknown>(cacheKey);
  if (cached !== undefined) return cached;

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

  const json = await res.json();
  cacheSet(cacheKey, json);
  return json;
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
  logger.info(
    { entity, clauseCount: clauses.length },
    "Bullhorn search: anchoring all-negative query so it is not silently empty",
  );
  return `id:[1 TO *] AND ${trimmed}`;
}

/**
 * Bullhorn's Lucene /search SILENTLY IGNORES a date range expressed in epoch
 * milliseconds (e.g. `dateAdded:[1767225600000 TO *]`) — it returns EVERY record
 * instead of erroring, so "placements this year" comes back as the full history
 * (2775 instead of 123). /search dates must be in Bullhorn's own `yyyyMMdd` /
 * `yyyyMMddHHmmss` format. LLM clients reach for epoch ms because that is what the
 * /query (SQL-like) path uses, so we transparently rewrite epoch bounds inside
 * date-field range clauses to yyyyMMddHHmmss (UTC). Bounds already in Bullhorn date
 * format (8 or 14 digits) and non-date numeric ranges (`id:[1 TO *]`,
 * `salary:[50000 TO 100000]`) are left untouched. Only genuine date fields are
 * converted, detected on the LEAF segment of the field path (the part after the last
 * dot) so association ids like `candidate.id` are NOT mistaken for dates just because
 * the path contains the letters "date" — only leaves like `dateAdded`/`dateBegin` or
 * `customDate1`/`correlatedCustomDate1`, with a 10-digit (epoch s) or 13-digit
 * (epoch ms) bound, are rewritten.
 */
function normalizeSearchDateRanges(query: string, entity: string): string {
  let rewrote = false;
  const out = query.replace(
    /([A-Za-z_][\w.]*):\[\s*(\*|\d+)\s+TO\s+(\*|\d+)\s*\]/gi,
    (full: string, field: string, lo: string, hi: string) => {
      const dot = field.lastIndexOf(".");
      const leaf = dot >= 0 ? field.slice(dot + 1) : field;
      const isDateField =
        /^date/i.test(leaf) || /^(?:correlated)?customDate\d+$/i.test(leaf);
      if (!isDateField) return full;
      const conv = (b: string): string => {
        if (b === "*" || b.length === 8 || b.length === 14) return b; // * or Bullhorn date format
        let ms: number | null = null;
        if (b.length === 13) ms = Number(b); // epoch milliseconds
        else if (b.length === 10) ms = Number(b) * 1000; // epoch seconds
        if (ms === null || !Number.isFinite(ms)) return b;
        const d = new Date(ms);
        const p = (n: number) => String(n).padStart(2, "0");
        rewrote = true;
        return (
          `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
          `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
        );
      };
      return `${field}:[${conv(lo)} TO ${conv(hi)}]`;
    },
  );
  if (rewrote) {
    logger.info({ entity }, "Bullhorn search: rewrote epoch date range to yyyyMMddHHmmss");
  }
  return out;
}

async function searchEntity(
  entity: string,
  query: string,
  fields: string,
  count: number,
  start: number,
): Promise<unknown> {
  fields = sanitizeFields(fields);
  // Enforce metric definitions on the SEARCH path too, so a freelanced raw
  // isOpen:true returns the correct universe of records (jobs exclude Archived;
  // opportunities exclude Closed-Won/Closed-Lost/Converted) — not just on count.
  const guard = applyMetricDefinitionGuard(entity, query);
  query = guard.query;
  query = normalizeSearchDateRanges(query, entity);
  query = anchorPureNegationQuery(query, entity);

  // Cache the raw Bullhorn JSON (post-processing below mutates a fresh clone each
  // call, so cached entries stay pristine). Key excludes the rotating BhRestToken.
  const cacheKey = `search:${entity}:${query}:${fields}:${count}:${start}`;
  let raw = cacheGet<unknown>(cacheKey);
  if (raw === undefined) {
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
    raw = await res.json();
    cacheSet(cacheKey, raw);
  }

  const processed = redactCandidateDescriptions(
    entity,
    await enrichWithProfileUrls(entity, raw),
    { capDescription: true },
  );
  // Surface the same locked-definition note the count path returns, so an AI browsing
  // records via search/list tools sees WHY the universe is what it is (e.g. "open jobs =
  // isOpen AND NOT Archive AND isDeleted:false") and reports the locked number instead of
  // re-tallying records itself (slow, and caps out). Only attach to object responses.
  if (
    guard.appliedDefinition &&
    processed &&
    typeof processed === "object" &&
    !Array.isArray(processed)
  ) {
    return { ...(processed as Record<string, unknown>), appliedDefinition: guard.appliedDefinition };
  }
  return processed;
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
  const result = await queryEntity(
    "Placement",
    where,
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "-dateAdded",
  );

  // A broad placements list (no candidate/job filter) is the pattern AI clients
  // misuse to ANSWER "how many placements this year" — they read the all-status
  // `total` (123) when the official figure is CONFIRMED only (98). This list has no
  // status filter, so always surface the confirmed count + a note so the AI reports
  // the locked number instead of the inflated all-status total.
  if (!args.candidateId && !args.jobId && result && typeof result === "object") {
    const dateClause = searchDateClause("dateAdded", args.dateAddedStart, args.dateAddedEnd);
    const confirmedQuery = dateClause
      ? `${dateClause} AND ${CONFIRMED_PLACEMENT_CLAUSE}`
      : CONFIRMED_PLACEMENT_CLAUSE;
    const confirmedPlacements = await searchTotal("Placement", confirmedQuery);
    const r = result as Record<string, unknown>;
    r.confirmedPlacements = confirmedPlacements;
    r.note =
      `This list (and its all-status 'total') includes ALL placement statuses (pending Submitted, Canceled, Archive). ` +
      `"Placements made / this year" officially means CONFIRMED only = ${CONFIRMED_PLACEMENT_CLAUSE} → ` +
      `report confirmedPlacements (${confirmedPlacements}), or call the placements_report tool. ` +
      `Use the all-status total only if the user explicitly asked for all/pending/canceled placements.`;
  }
  return result;
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

const MAX_GROUP_VALUES = 50;
const GROUP_DISCOVERY_SAMPLE = 500;
const GROUP_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Reads Bullhorn's authoritative total match count for a Lucene query, no records. */
async function searchTotal(entity: string, query: string): Promise<number> {
  const res = (await searchEntity(entity, query, "id", 1, 0)) as { total?: number };
  return typeof res.total === "number" ? res.total : 0;
}

/**
 * Enforces the LOCKED "open jobs" definition server-side so the count cannot drift.
 * The official metric is `isOpen:true AND NOT status:Archive` (the open flag alone
 * still counts Archived requisitions — that is the 513-vs-414 drift we observed live).
 * AI clients routinely query a raw `isOpen:true`; when they do (for JobOrder) without
 * addressing the status, we transparently append the Archive exclusion and report the
 * applied definition so the answer always matches the curated open_jobs report.
 * If the caller already mentions `status`/`Archive`, we leave their query untouched.
 */
// ── Single source of truth for status-based metric definitions ──────────────────
// The SAME status sets are rendered to BOTH Lucene (/search, count_entity) and
// SQL-where (/query, query_entity) below, so the two query paths can never drift.
const OPP_CLOSED_STATUSES = ["Closed-Won", "Closed-Lost", "Converted"] as const;
const PLACEMENT_CONFIRMED_STATUSES = ["Approved", "Completed", "Ended"] as const;
const JOBORDER_ARCHIVE_STATUS = "Archive";

/** Lucene status term: quote values with non-alphanumerics (e.g. "Closed-Won") so a
 *  hyphen isn't parsed as an operator; bare alphanumerics (Converted) stay unquoted. */
function luceneStatusTerm(v: string): string {
  return /^[A-Za-z0-9]+$/.test(v) ? v : `"${v}"`;
}
/** SQL-where string literal: single-quoted, with embedded quotes doubled. */
function sqlStatusValue(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

// Standalone "active opportunities" definition (the official active-pipeline set).
// Used both to EXTEND an isOpen:true query (guard) and as a SELF-CONTAINED query
// (annotation), so the two enforcement paths never drift.
const ACTIVE_OPPS_STATUS_CLAUSE = OPP_CLOSED_STATUSES.map(
  (s) => `NOT status:${luceneStatusTerm(s)}`,
).join(" AND ");
export const ACTIVE_OPPS_DEFINITION = `${ACTIVE_OPPS_STATUS_CLAUSE} AND isDeleted:false`;

// SQL-where equivalents for the /query path (query_entity).
const OPP_ACTIVE_STATUS_WHERE = OPP_CLOSED_STATUSES.map(
  (s) => `status<>${sqlStatusValue(s)}`,
).join(" AND ");
const JOBORDER_ARCHIVE_WHERE = `status<>${sqlStatusValue(JOBORDER_ARCHIVE_STATUS)}`;
const CONFIRMED_PLACEMENT_WHERE = `(${PLACEMENT_CONFIRMED_STATUSES.map(
  (s) => `status=${sqlStatusValue(s)}`,
).join(" OR ")})`;

/**
 * AND-append a locking clause onto a caller's base query. If the base has a top-level
 * `OR`, it is wrapped in parens FIRST: Lucene binds `AND` tighter than `OR`, so a raw
 * `status:New OR status:Qualified AND isDeleted:false` parses as
 * `status:New OR (status:Qualified AND isDeleted:false)` — the lock applies to only the
 * last OR branch and soft-deleted/non-confirmed rows leak on that phrasing. We always
 * append a POSITIVE lock (isDeleted:false or a parenthesized status group), so the
 * combined query is never a bare all-negative set and needs no id-anchor here.
 */
function andLockClause(base: string, addition: string): string {
  const wrapped = /\bOR\b/i.test(base) ? `(${base})` : base;
  return `${wrapped} AND ${addition}`;
}

/**
 * Bounded-concurrency map preserving input order. Used to fan out many independent
 * read-only counts (e.g. per-group breakdowns) so a wide groupBy resolves in
 * O(N/limit) round-trips instead of O(N) sequential ones, while staying well under
 * Bullhorn's REST rate limit (120 req / 60s).
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) || 1 },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

// Max concurrent per-group count requests in a single grouped count_entity call.
// 5 keeps a 50-group breakdown to ~10 sequential waves, comfortably under the
// 120/60s REST limit even with other in-flight reads.
const GROUP_COUNT_CONCURRENCY = 5;

function applyMetricDefinitionGuard(
  entity: string,
  query: string,
): { query: string; appliedDefinition?: string } {
  // Open jobs: soft-deleted records are operational-truth-excluded from EVERY JobOrder
  // read (not just isOpen:true), so any phrasing or per-group breakdown reconciles to the
  // locked universe. The Archived-requisition exclusion is specific to the open-jobs
  // metric, so it is only added for the isOpen:true intent without an explicit status.
  if (entity === "JobOrder") {
    const isOpenIntent =
      /\bisOpen\s*:\s*true\b/i.test(query) && !/\bstatus\s*:/i.test(query);
    const additions: string[] = [];
    if (isOpenIntent)
      additions.push(`NOT status:${luceneStatusTerm(JOBORDER_ARCHIVE_STATUS)}`);
    // Respect an explicit isDeleted (power-user opt-in to deleted records).
    if (!/\bisDeleted\s*:/i.test(query)) additions.push("isDeleted:false");
    if (additions.length === 0) return { query };
    return {
      query: andLockClause(query, additions.join(" AND ")),
      appliedDefinition: isOpenIntent
        ? "open jobs = isOpen:true AND NOT status:Archive AND isDeleted:false (Archived requisitions AND soft-deleted records excluded to match the official open-jobs metric = 398; on-hold/filled/placed still included)"
        : "soft-deleted job records are excluded (operational truth); pass isDeleted:true to include them.",
    };
  }
  // Active opportunities: soft-deleted records are operational-truth-excluded from EVERY
  // Opportunity read, so alternate "open"/"still open" phrasings and per-group breakdowns
  // reconcile to the locked 23 (e.g. the New status group is 4, not the deleted-inclusive
  // 5). The full active-pipeline definition (exclude Closed-Won/Closed-Lost/Converted) is
  // additionally applied for the isOpen:true intent without an explicit status.
  if (entity === "Opportunity") {
    const hasExplicitDeleted = /\bisDeleted\s*:/i.test(query);
    const isOpenIntent =
      /\bisOpen\s*:\s*true\b/i.test(query) && !/\bstatus\s*:/i.test(query);
    if (isOpenIntent) {
      // Add the active status exclusions; add isDeleted:false only if the caller did not
      // already pin isDeleted (so a power-user `isOpen:true AND isDeleted:true` is honored,
      // not zeroed by a contradictory isDeleted:false).
      const clause = hasExplicitDeleted
        ? ACTIVE_OPPS_STATUS_CLAUSE
        : ACTIVE_OPPS_DEFINITION;
      return {
        query: andLockClause(query, clause),
        appliedDefinition: hasExplicitDeleted
          ? 'active opportunities = isOpen:true AND NOT status:"Closed-Won" AND NOT status:"Closed-Lost" AND NOT status:Converted (the official active-pipeline metric = 23; your explicit isDeleted is honored, so soft-deleted records are NOT excluded here — drop isDeleted to get the canonical 23).'
          : 'active opportunities = isOpen:true AND NOT status:"Closed-Won" AND NOT status:"Closed-Lost" AND NOT status:Converted AND isDeleted:false (the official active-pipeline metric = 23; soft-deleted and closed/converted are already excluded — do NOT subtract further).',
      };
    }
    if (!hasExplicitDeleted) {
      return {
        query: andLockClause(query, "isDeleted:false"),
        appliedDefinition:
          "soft-deleted opportunities are excluded (operational truth); pass isDeleted:true to include them.",
      };
    }
    return { query };
  }
  // Placement: two corrections. (1) `isDeleted` is NOT searchable on Placement (any value
  // returns 0) and Placement search already excludes soft-deleted, so strip any supplied
  // isDeleted clause. (2) "Placements made" means CONFIRMED only — when the caller pins no
  // status, lock the base to confirmed so totals AND per-group breakdowns match the
  // official metric (YTD 98 / all-time 2650), instead of the all-status 123/2775. A power
  // user wanting pending/canceled/all passes an explicit status filter to override.
  if (entity === "Placement") {
    let q = query;
    if (/\bisDeleted\s*:/i.test(q)) {
      q = q
        .replace(/\s*\b(?:AND|OR)\b\s*isDeleted\s*:\s*(?:true|false|0|1)\b/gi, "")
        .replace(/\bisDeleted\s*:\s*(?:true|false|0|1)\b\s*\b(?:AND|OR)\b\s*/gi, "")
        .replace(/\bisDeleted\s*:\s*(?:true|false|0|1)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!q) q = "id:[1 TO *]";
    }
    if (!/\bstatus\s*:/i.test(q)) {
      const base =
        q === "id:[1 TO *]"
          ? CONFIRMED_PLACEMENT_CLAUSE
          : andLockClause(q, CONFIRMED_PLACEMENT_CLAUSE);
      return {
        query: base,
        appliedDefinition:
          `placements made = confirmed only ${CONFIRMED_PLACEMENT_CLAUSE} (the official metric: YTD 98 / all-time 2650; pending Submitted, Canceled and Archive are excluded). Pass an explicit status filter to include them.`,
      };
    }
    if (q !== query) {
      return {
        query: q,
        appliedDefinition:
          "isDeleted is not searchable on Placement (it returns 0 for any value), so that filter was removed — Placement search already excludes soft-deleted records.",
      };
    }
    return { query: q };
  }
  return { query };
}

// ── SQL-where guard (the /query path, exposed as query_entity) ───────────────────
// query_entity speaks Bullhorn's SQL-like `where` syntax (isOpen=true, status<>'X',
// status IN (...), isDeleted=false, AND/OR) — NOT Lucene — so it cannot reuse the
// guard above. This mirror enforces the SAME locked universe on /query, because the
// /query path otherwise returns soft-deleted/archived/non-confirmed records (live
// proof: a raw `isOpen=true` Opportunity query returned 2 soft-deleted rows). Without
// this, an AI that browses or self-counts query_entity records drifts off the locked
// numbers (24 vs 23, 19 vs 18).
// These detect a predicate on the ENTITY'S OWN field only. The leading `(?<![\w.])`
// rejects dotted association fields (clientCorporation.status, candidate.isDeleted,
// jobOrder.isOpen): `\b` alone matches right after a dot, which would let e.g.
// `isOpen=true AND clientCorporation.status='Active'` masquerade as an explicit
// status and bypass the status lock, or let `candidate.isDeleted=...` suppress the
// entity soft-delete guard.
const WHERE_ISDELETED_PRED_RE =
  /(?<![\w.])isDeleted\s*(?:=|<>|!=)\s*(?:true|false|0|1)\b/i;
const WHERE_ISOPEN_TRUE_RE = /(?<![\w.])isOpen\s*=\s*(?:true|1)\b/i;
const WHERE_STATUS_PRED_RE =
  /(?<![\w.])status\s*(?:=|<>|!=)|(?<![\w.])status\s+(?:in|like)\b/i;

/**
 * AND-append a SQL-where lock onto a caller's base. If the base has a top-level `OR`,
 * it is wrapped in parens first: SQL (like Lucene) binds `AND` tighter than `OR`, so
 * `status='New' OR status='Qualified' AND isDeleted=false` would otherwise lock only
 * the last branch and leak soft-deleted rows on the first.
 */
function andWhereClause(base: string, addition: string): string {
  const b = base.trim();
  if (b === "") return addition;
  const wrapped = /\bOR\b/i.test(b) ? `(${b})` : b;
  return `${wrapped} AND ${addition}`;
}

function applyMetricDefinitionGuardWhere(
  entity: string,
  where: string,
): { where: string; appliedDefinition?: string } {
  const w = (where ?? "").trim();
  if (entity === "JobOrder") {
    const hasExplicitDeleted = WHERE_ISDELETED_PRED_RE.test(w);
    const isOpenIntent =
      WHERE_ISOPEN_TRUE_RE.test(w) && !WHERE_STATUS_PRED_RE.test(w);
    const additions: string[] = [];
    if (isOpenIntent) additions.push(JOBORDER_ARCHIVE_WHERE);
    if (!hasExplicitDeleted) additions.push("isDeleted=false");
    if (additions.length === 0) return { where: w };
    let appliedDefinition: string;
    if (isOpenIntent) {
      appliedDefinition = hasExplicitDeleted
        ? `open jobs = isOpen=true AND ${JOBORDER_ARCHIVE_WHERE} (Archived requisitions excluded; your explicit isDeleted is honored — drop it to match the locked open-jobs metric = 398). query_entity returns at most a page of records — use count_entity for the total.`
        : `open jobs = isOpen=true AND ${JOBORDER_ARCHIVE_WHERE} AND isDeleted=false (Archived requisitions AND soft-deleted records excluded to match the locked open-jobs metric = 398). query_entity returns at most a page of records — use count_entity for the total.`;
    } else {
      appliedDefinition =
        "soft-deleted job records are excluded (operational truth); pass isDeleted=true to include them.";
    }
    return {
      where: andWhereClause(w, additions.join(" AND ")),
      appliedDefinition,
    };
  }
  if (entity === "Opportunity") {
    const hasExplicitDeleted = WHERE_ISDELETED_PRED_RE.test(w);
    const isOpenIntent =
      WHERE_ISOPEN_TRUE_RE.test(w) && !WHERE_STATUS_PRED_RE.test(w);
    if (isOpenIntent) {
      const clause = hasExplicitDeleted
        ? OPP_ACTIVE_STATUS_WHERE
        : `${OPP_ACTIVE_STATUS_WHERE} AND isDeleted=false`;
      return {
        where: andWhereClause(w, clause),
        appliedDefinition: hasExplicitDeleted
          ? `active opportunities = isOpen=true AND ${OPP_ACTIVE_STATUS_WHERE} (the locked active-pipeline metric = 23; your explicit isDeleted is honored — drop it to get the canonical 23). Use count_entity for the total.`
          : `active opportunities = isOpen=true AND ${OPP_ACTIVE_STATUS_WHERE} AND isDeleted=false (the locked active-pipeline metric = 23; soft-deleted and closed/converted are already excluded — do NOT subtract further). Use count_entity for the total.`,
      };
    }
    if (!hasExplicitDeleted) {
      return {
        where: andWhereClause(w, "isDeleted=false"),
        appliedDefinition:
          "soft-deleted opportunities are excluded (operational truth); pass isDeleted=true to include them.",
      };
    }
    return { where: w };
  }
  if (entity === "Placement") {
    // isDeleted does not exist on Placement (any reference errors) and Placement /query
    // already excludes soft-deleted, so strip an AND-joined isDeleted predicate. If it
    // is OR-joined we refuse rather than silently broaden the result set.
    let q = w;
    let strippedDeleted = false;
    // Only the entity's OWN isDeleted is invalid on Placement; a dotted association
    // field (candidate.isDeleted, jobOrder.isDeleted) IS valid and must be left alone,
    // hence the `(?<![\w.])` guard on every isDeleted match here.
    if (/(?<![\w.])isDeleted\b/i.test(q)) {
      // Strip AND-joined isDeleted predicates first (safe — narrows nothing real
      // since the field doesn't exist on Placement).
      const afterAnd = q
        .replace(
          /\s*\bAND\b\s*(?<![\w.])isDeleted\s*(?:=|<>|!=)\s*(?:true|false|0|1)\b/gi,
          "",
        )
        .replace(
          /(?<![\w.])isDeleted\s*(?:=|<>|!=)\s*(?:true|false|0|1)\b\s*\bAND\b\s*/gi,
          "",
        )
        .replace(/\s+/g, " ")
        .trim();
      if (/(?<![\w.])isDeleted\b/i.test(afterAnd)) {
        // Survived the AND-strip → isDeleted is OR-joined or standalone.
        if (/\bOR\b/i.test(afterAnd)) {
          // OR-joined: silently stripping it would BROADEN the result set
          // (status='Approved' OR isDeleted=false → all statuses). Refuse instead.
          throw new Error(
            "isDeleted is not filterable on Placement (the field does not exist there, and Placement already excludes soft-deleted records). Remove the isDeleted condition and retry.",
          );
        }
        // Standalone predicate (no AND/OR): safe to drop entirely.
        q = afterAnd
          .replace(/(?<![\w.])isDeleted\s*(?:=|<>|!=)\s*(?:true|false|0|1)\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
      } else {
        q = afterAnd;
      }
      strippedDeleted = q !== w;
      if (q === "") q = "id>0";
    }
    const hasStatus = WHERE_STATUS_PRED_RE.test(q);
    if (!hasStatus) {
      const base =
        q === "" || q === "id>0"
          ? CONFIRMED_PLACEMENT_WHERE
          : andWhereClause(q, CONFIRMED_PLACEMENT_WHERE);
      return {
        where: base,
        appliedDefinition: `placements made = confirmed only ${CONFIRMED_PLACEMENT_WHERE} (the official metric: YTD 98 / all-time 2650; pending Submitted, Canceled and Archive are excluded). Pass an explicit status filter to include them. Use count_entity for the total.`,
      };
    }
    if (strippedDeleted) {
      return {
        where: q,
        appliedDefinition:
          "isDeleted is not filterable on Placement, so that condition was removed — Placement already excludes soft-deleted records.",
      };
    }
    return { where: q };
  }
  return { where: w };
}

/**
 * Confirmed-placement statuses for this instance. "Placements made / this year" means
 * CONFIRMED only; Submitted (pending), Canceled, and Archive are NOT real placements
 * (counting all statuses gives the 123-vs-98 drift we observed live).
 */
const CONFIRMED_PLACEMENT_CLAUSE = `(${PLACEMENT_CONFIRMED_STATUSES.map(
  (s) => `status:${luceneStatusTerm(s)}`,
).join(" OR ")})`;

/**
 * For a Placement count with NO status filter, the raw `total` includes pending/
 * canceled/archived rows. Rather than silently change the number the caller asked for,
 * we ALSO compute the confirmed-only total and attach a note, so the AI reports the
 * official figure (98) instead of the all-status figure (123). No-op once the caller
 * already constrains status.
 */
async function placementConfirmedAnnotation(
  entity: string,
  query: string,
): Promise<{ confirmedTotal: number; note: string } | undefined> {
  if (entity !== "Placement") return undefined;
  if (/\bstatus\s*:/i.test(query)) return undefined;
  const confirmedTotal = await searchTotal(
    entity,
    `(${query}) AND ${CONFIRMED_PLACEMENT_CLAUSE}`,
  );
  return {
    confirmedTotal,
    note:
      `'total' counts ALL placement statuses (including pending Submitted, Canceled, and Archive). ` +
      `"Placements made / this year" officially means CONFIRMED placements only = ` +
      `${CONFIRMED_PLACEMENT_CLAUSE} → report confirmedTotal (${confirmedTotal}), ` +
      `or call the placements_report tool. Only use 'total' if the user explicitly asked for all/pending/canceled placements.`,
  };
}

/**
 * Active-opportunity guard for the freelancing failure mode: the model often
 * approximates "active / pipeline opportunities" by enumerating a SUBSET of open
 * statuses (e.g. `status:Open OR status:Qualifying`), which silently UNDERCOUNTS
 * (5 instead of the official 24 — it misses Qualified/New). For any Opportunity
 * count whose query is NOT already the canonical active definition, we compute the
 * official active total and attach a note so the model reports the locked figure
 * for active/pipeline asks. No-op when the query already IS the active definition
 * (e.g. the guard rewrote isOpen:true, or the report tool ran it), so legitimate
 * single-status drilldowns ("how many Qualified?") still answer their own number —
 * the note is conditional guidance, mirroring placementConfirmedAnnotation.
 */
async function opportunityActiveAnnotation(
  entity: string,
  query: string,
): Promise<{ activeOpportunitiesTotal: number; note: string } | undefined> {
  if (entity !== "Opportunity") return undefined;
  // Already the FULL canonical active definition (guard-applied or caller-supplied) — no
  // drift. Must include the soft-delete exclusion too: a query with only the 3 Closed-*
  // exclusions (no isDeleted:false) still returns the deleted-inclusive 24, so it is NOT
  // canonical and must still be annotated with the official 23.
  if (
    /Closed-Won/i.test(query) &&
    /Closed-Lost/i.test(query) &&
    /Converted/i.test(query) &&
    /\bisDeleted\s*:\s*false\b/i.test(query)
  ) {
    return undefined;
  }
  const activeOpportunitiesTotal = await searchTotal(entity, ACTIVE_OPPS_DEFINITION);
  return {
    activeOpportunitiesTotal,
    note:
      `"active" / "open" / "in the pipeline" opportunities officially means ` +
      `${ACTIVE_OPPS_DEFINITION} = ${activeOpportunitiesTotal}. Do NOT approximate it by ` +
      `listing a subset of statuses (e.g. status:Open OR status:Qualifying) — that UNDERCOUNTS ` +
      `(it drops Qualified/New). Report activeOpportunitiesTotal (${activeOpportunitiesTotal}) ` +
      `for active/pipeline asks, or call the sales_pipeline_report tool. Only report this ` +
      `query's 'total' if the user explicitly asked for these specific status(es).`,
  };
}

/**
 * Counts Bullhorn records for a query WITHOUT returning the records — and optionally
 * breaks the count down by a field (e.g. Internal Department). This exists because LLM
 * clients otherwise try to build scorecards by fetching records and counting them
 * client-side, which silently truncates at the per-call record cap (so "414 open jobs"
 * gets reported as "100" or "51+"). Here we run /search with count=1 and read its
 * authoritative `total`, returning tiny exact payloads.
 *
 * Grouping: prefer caller-supplied `groupValues` (exact). If only `groupBy` is given,
 * distinct values are discovered from a capped sample, which can MISS values when the
 * match set is larger than the sample — then groupsComplete is false and the caller
 * should pass groupValues explicitly.
 */
export async function countEntity(args: {
  entityType: string;
  query?: string;
  groupBy?: string;
  groupValues?: string[];
}): Promise<unknown> {
  const entry = resolveEntity(args.entityType);
  if (entry.route === "query") {
    throw new Error(
      `count_entity supports only full-text searchable entities (Candidate, ClientContact, ` +
        `ClientCorporation, JobOrder, JobSubmission, Placement, Lead, Opportunity, Note). ` +
        `"${entry.canonical}" is query-only — use query_entity instead.`,
    );
  }
  const baseRaw = (args.query ?? "").trim();
  const baseInput = baseRaw === "" ? "id:[1 TO *]" : baseRaw;
  // Lock metric definitions so a raw isOpen:true cannot drift (jobs 513 -> 414;
  // opportunities 34 -> 24).
  const guard = applyMetricDefinitionGuard(entry.canonical, baseInput);
  const base = guard.query;
  // The headline total and the two entity-gated annotations are independent reads —
  // fan them out in parallel instead of three sequential round-trips. The annotation
  // helpers return undefined for non-matching entities, so this adds no extra calls.
  const [total, placementAnnotation, opportunityAnnotation] = await Promise.all([
    searchTotal(entry.canonical, base),
    // Surface the confirmed-only placement figure (98) alongside an all-status total (123).
    placementConfirmedAnnotation(entry.canonical, base),
    opportunityActiveAnnotation(entry.canonical, base),
  ]);

  if (!args.groupBy) {
    return {
      entityType: entry.canonical,
      query: base,
      total,
      mode: "count_only",
      ...(guard.appliedDefinition ? { appliedDefinition: guard.appliedDefinition } : {}),
      ...(placementAnnotation ?? {}),
      ...(opportunityAnnotation ?? {}),
    };
  }

  const groupBy = args.groupBy.trim();
  if (!GROUP_FIELD_NAME_RE.test(groupBy)) {
    throw new Error(
      `Invalid groupBy field "${args.groupBy}". Use a single field name, e.g. "correlatedCustomText1".`,
    );
  }
  if (isSensitiveField(groupBy)) {
    throw new Error(`Field "${groupBy}" cannot be used for grouping.`);
  }

  let values = (args.groupValues ?? [])
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);
  let groupsComplete = true;
  let discoveredFromSample = false;
  let sampleSize: number | undefined;

  if (values.length === 0) {
    const sample = (await searchEntity(
      entry.canonical,
      base,
      groupBy,
      GROUP_DISCOVERY_SAMPLE,
      0,
    )) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(sample.data) ? sample.data : [];
    const distinct = new Set<string>();
    for (const row of rows) {
      const v = row?.[groupBy];
      if (typeof v === "string" && v.trim() !== "") distinct.add(v.trim());
    }
    values = [...distinct];
    sampleSize = rows.length;
    discoveredFromSample = true;
    groupsComplete = total <= rows.length;
  }

  if (values.length > MAX_GROUP_VALUES) {
    values = values.slice(0, MAX_GROUP_VALUES);
    groupsComplete = false;
  }

  // Build each group's query by AND-ing the base with the value clause. The base must
  // keep working when combined: an all-negative base (e.g. active-opportunities) returns
  // 0 if parenthesized, so anchor it FLAT (id:[1 TO *] AND NOT ...) and append flat. Only
  // parenthesize when the base has a top-level OR, where flat-appending would change
  // precedence (a pure-negation+OR base is the known unsupported case and stays 0).
  const hasTopLevelOr = /\bOR\b/i.test(base);
  const flatBase = anchorPureNegationQuery(base, entry.canonical);
  // One tiny /search per value, fanned out with bounded concurrency to stay well under
  // the rate limit; a single bad value yields a per-group error instead of failing the
  // whole batch.
  const groups: Array<{ value: string; count: number | null; error?: string }> =
    await mapWithLimit(
      values,
      GROUP_COUNT_CONCURRENCY,
      async (value): Promise<{ value: string; count: number | null; error?: string }> => {
        const clause = `${groupBy}:"${escapeLucenePhrase(value)}"`;
        const q = hasTopLevelOr ? `(${base}) AND ${clause}` : `${flatBase} AND ${clause}`;
        try {
          return { value, count: await searchTotal(entry.canonical, q) };
        } catch (e) {
          return { value, count: null, error: (e as Error).message.slice(0, 160) };
        }
      },
    );
  groups.sort((a, b) => (b.count ?? -1) - (a.count ?? -1));

  return {
    entityType: entry.canonical,
    query: base,
    total,
    mode: "count_by_group",
    groupBy,
    groups,
    groupsComplete,
    ...(discoveredFromSample ? { discoveredFromSample, sampleSize } : {}),
    ...(guard.appliedDefinition ? { appliedDefinition: guard.appliedDefinition } : {}),
    ...(placementAnnotation ?? {}),
    ...(opportunityAnnotation ?? {}),
  };
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
  // Enforce the locked operational universe on the raw /query tool. This guard lives
  // HERE (not in low-level queryEntity) so the curated list/report functions —
  // listPlacements et al, which already apply their own deliberate locking/notes —
  // keep their behavior; only AI-authored query_entity calls are guarded.
  const guarded = applyMetricDefinitionGuardWhere(entry.canonical, args.where);
  const result = await queryEntity(
    entry.canonical,
    guarded.where,
    fields,
    args.count ?? 20,
    args.start ?? 0,
    args.orderBy,
  );
  if (
    guarded.appliedDefinition &&
    result &&
    typeof result === "object" &&
    !Array.isArray(result)
  ) {
    return {
      ...(result as Record<string, unknown>),
      appliedDefinition: guarded.appliedDefinition,
    };
  }
  return result;
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

/**
 * Returns the valid dropdown options for one or all picklist fields on an
 * entity — e.g. the valid "action" values for Note, or "status" for Candidate.
 * Queries Bullhorn's /meta endpoint which always reflects the live configured
 * values for this specific Bullhorn instance.
 *
 * When fieldName is provided, returns only that field's options (or an error
 * if the field isn't a picklist). When omitted, returns all picklist fields
 * and their options so the AI can show a complete menu in one call.
 */
export async function listFieldOptions(args: {
  entityType: string;
  fieldName?: string;
}): Promise<{
  entity: string;
  fields: Array<{ name: string; label?: string; options: Array<{ value: string; label: string }> }>;
}> {
  const entry = resolveEntity(args.entityType);
  const meta = (await bullhornFetch(`meta/${entry.canonical}`, {
    fields: "*",
    meta: "basic",
  })) as {
    entity?: string;
    fields?: Array<Record<string, unknown>>;
  };

  const allFields = Array.isArray(meta.fields) ? meta.fields : [];
  const picklistFields = allFields.filter(
    (f) =>
      Array.isArray(f.options) &&
      (f.options as unknown[]).length > 0 &&
      typeof f.name === "string" &&
      !isSensitiveField(f.name as string),
  );

  let targetFields = picklistFields;
  if (args.fieldName) {
    const lower = args.fieldName.toLowerCase();
    const match = picklistFields.find(
      (f) =>
        (f.name as string).toLowerCase() === lower ||
        (typeof f.label === "string" && f.label.toLowerCase() === lower),
    );
    if (!match) {
      const allNames = picklistFields.map((f) => f.name as string).join(", ");
      throw new Error(
        `Field "${args.fieldName}" is not a picklist on ${entry.canonical}, or it has no configured options. ` +
          `Picklist fields on this entity: ${allNames || "(none found)"}`,
      );
    }
    targetFields = [match];
  }

  return {
    entity: (meta.entity as string | undefined) ?? entry.canonical,
    fields: targetFields.map((f) => ({
      name: f.name as string,
      ...(typeof f.label === "string" && f.label ? { label: f.label } : {}),
      options: (f.options as Array<{ value?: unknown; label?: unknown }>).map((o) => ({
        value: String(o.value ?? ""),
        label: String(o.label ?? o.value ?? ""),
      })),
    })),
  };
}

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

// ── Write helpers ────────────────────────────────────────────────────────────
//
// Write operations take an explicit `session` parameter (the calling user's own
// Bullhorn session) rather than calling getSession(). This ensures writes always
// run under the recruiter's own credentials so Bullhorn enforces their permission
// gates — never the shared service-account session.

export interface BullhornWriteSession {
  BhRestToken: string;
  restUrl: string;
}

export class BullhornPermissionError extends Error {
  constructor(action: string) {
    super(
      `You don't have permission to ${action} in Bullhorn. ` +
        `Contact your Bullhorn administrator if you believe this is incorrect.`,
    );
    this.name = "BullhornPermissionError";
  }
}

async function writeFetch(
  session: BullhornWriteSession,
  method: "PUT" | "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<unknown> {
  const url = new URL(path, session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);

  const res = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    const action = `${method} ${path.split("/").slice(0, 2).join("/")}`;
    throw new BullhornPermissionError(action);
  }

  if (!res.ok) {
    const text = await res.text();
    throw formatBullhornError("write", res.status, text);
  }

  return res.json();
}

/**
 * Adds a Note to a candidate (and optionally a job or placement).
 * Uses PUT /entity/Note — Bullhorn creates the note as the session user.
 * The `action` field is the note category displayed in Bullhorn (e.g. "Email",
 * "Call", "Meeting", "Comment"). A `noteEntity` association links the note to
 * the target record.
 */
export async function addNote(
  session: BullhornWriteSession,
  args: {
    comments: string;
    action: string;
    candidateId?: number;
    jobOrderId?: number;
    placementId?: number;
  },
): Promise<{ noteId: number }> {
  // personReference is the required primary person link on every Bullhorn Note.
  // Without it Bullhorn returns 400 "error persisting an entity of type: Note".
  // noteEntities uses targetEntityID (not person.id) per Bullhorn REST schema.
  if (!args.candidateId && !args.jobOrderId && !args.placementId) {
    throw new Error("At least one of candidateId, jobOrderId, or placementId is required to add a note.");
  }

  const body: Record<string, unknown> = {
    action: args.action,
    comments: args.comments,
  };

  if (args.candidateId) {
    body.personReference = { id: args.candidateId };
    body.noteEntities = [{ targetName: "Candidate", targetEntityID: args.candidateId }];
  }
  if (args.jobOrderId) body.jobOrder = { id: args.jobOrderId };
  if (args.placementId) body.placement = { id: args.placementId };

  const data = (await writeFetch(session, "PUT", "entity/Note", body)) as {
    changedEntityId?: number;
  };
  return { noteId: data.changedEntityId ?? 0 };
}

/**
 * Updates a candidate's status field.
 * Uses POST /entity/Candidate/{id} — Bullhorn enforces the session user's
 * edit permissions on the record.
 */
export async function updateCandidateStatus(
  session: BullhornWriteSession,
  id: number,
  status: string,
): Promise<void> {
  await writeFetch(session, "POST", `entity/Candidate/${id}`, { status });
}

/**
 * Returns the Bullhorn internal integer user ID for the current session.
 * Calls /settings/userId — a lightweight endpoint that returns the session
 * owner's ID without fetching a full user record.
 */
async function getSessionUserId(session: BullhornWriteSession): Promise<number> {
  const url = new URL("settings/userId", session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Failed to resolve session user ID: ${res.status}`);
  const data = (await res.json()) as { userId?: number };
  if (!data.userId) throw new Error("Bullhorn /settings/userId returned no userId");
  return data.userId;
}

/**
 * Submits a candidate to a job order (creates a JobSubmission).
 * Uses PUT /entity/JobSubmission. sendingUser is auto-derived from the
 * session so the caller never needs to look up their own Bullhorn user ID.
 */
export async function createJobSubmission(
  session: BullhornWriteSession,
  args: {
    candidateId: number;
    jobOrderId: number;
    status: string;
  },
): Promise<{ submissionId: number; sendingUserId: number }> {
  const sendingUserId = await getSessionUserId(session);
  const body = {
    candidate: { id: args.candidateId },
    jobOrder: { id: args.jobOrderId },
    status: args.status,
    sendingUser: { id: sendingUserId },
  };
  const data = (await writeFetch(session, "PUT", "entity/JobSubmission", body)) as {
    changedEntityId?: number;
  };
  return { submissionId: data.changedEntityId ?? 0, sendingUserId };
}

/**
 * Finds internal Bullhorn users (recruiters) by name and/or email.
 *
 * CorporateUser's /query endpoint does not support LIKE on name/firstName/
 * lastName/email fields in this Bullhorn instance — those predicates return
 * a 400 "not a valid field name" error. We work around this by fetching all
 * active users (up to 200) and doing the name/email filtering in JavaScript.
 */
export async function findUsers(args: {
  name?: string;
  email?: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,name,email,username,phone,occupation,isDeleted";

  const raw = await queryEntity(
    "CorporateUser",
    "isDeleted=false",
    fields,
    200,
    0,
    "name",
  );

  let data = (raw as { data?: Array<Record<string, unknown>> }).data ?? [];

  if (args.name) {
    const lower = args.name.toLowerCase();
    data = data.filter(
      (u) =>
        (typeof u.name === "string" && u.name.toLowerCase().includes(lower)) ||
        (typeof u.firstName === "string" &&
          u.firstName.toLowerCase().includes(lower)) ||
        (typeof u.lastName === "string" &&
          u.lastName.toLowerCase().includes(lower)) ||
        (typeof u.username === "string" &&
          u.username.toLowerCase().includes(lower)),
    );
  }

  if (args.email) {
    const lower = args.email.toLowerCase();
    data = data.filter(
      (u) =>
        typeof u.email === "string" && u.email.toLowerCase().includes(lower),
    );
  }

  const start = args.start ?? 0;
  const limit = args.count ?? 20;
  const page = data.slice(start, start + limit);

  return { total: data.length, start, count: page.length, data: page };
}
