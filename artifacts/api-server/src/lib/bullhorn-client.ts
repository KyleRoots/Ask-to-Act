import { getSession, invalidateSession, currentFirmContextId } from "./bullhorn-auth.js";
import { resolveDeptField } from "./firm-config.js";
import { logger } from "./logger.js";
import { cacheGet, cacheSet } from "./cache.js";
import { classifySubmissionStage } from "./submission-status.js";
// pdf-parse and mammoth are loaded via dynamic import inside the extraction
// helper — avoids CJS/ESM default-export interop issues at module startup.

const MAX_RETRIES = 1;
const RATE_LIMIT_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns the number of ms to wait before retry attempt n (1-indexed, exponential). */
function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt - 1), 8000); // 1s, 2s, 4s, 8s cap
}

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
  rlRetries = RATE_LIMIT_RETRIES,
): Promise<unknown> {
  // Cache key excludes the rotating BhRestToken; same path+params => same read.
  // Prefixed with the firm context so one tenant's cached read can never be
  // served to another.
  const cacheKey = `${currentFirmContextId() ?? "no-firm"}:fetch:${path}:${JSON.stringify(
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

  const res = await fetch(url.toString(), { redirect: "follow" });

  if (res.status === 401 && retries > 0) {
    logger.warn("Bullhorn: 401 received, re-authenticating");
    await invalidateSession();
    return bullhornFetch(path, params, retries - 1, rlRetries);
  }

  if (res.status === 429) {
    if (rlRetries > 0) {
      const attempt = RATE_LIMIT_RETRIES - rlRetries + 1;
      const delay = backoffMs(attempt);
      logger.warn({ attempt, delay }, "Bullhorn: read rate limit hit — backing off");
      await sleep(delay);
      return bullhornFetch(path, params, retries, rlRetries - 1);
    }
    throw new Error(
      "Bullhorn API rate limit exceeded after multiple retries. Wait 60 seconds and try again.",
    );
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
 * a deep link to open them is useful. Pure junction/log entities (Note, Task,
 * Appointment, Sendout, etc.) are excluded; Placement and JobSubmission are
 * included because recruiters navigate to them directly.
 */
const UI_LINKABLE_ENTITIES = new Set<string>([
  "Candidate",
  "ClientContact",
  "ClientCorporation",
  "JobOrder",
  "JobSubmission",
  "Lead",
  "Opportunity",
  "Placement",
]);

/**
 * Guarantees the record `id` is fetched for linkable entities so a deep link can
 * always be injected. enrichWithProfileUrls only adds `bullhornUrl` to records
 * that carry a numeric `id`; when the AI supplies its own `fields` and omits
 * `id`, Bullhorn returns no id and the link is silently dropped (the "links work
 * most of the time but sometimes don't" symptom). For linkable entities we
 * prepend `id` when the top-level field list doesn't already request it. A
 * parentheses-aware scan ensures nested sub-selections like `owner(id,name)` are
 * NOT mistaken for a top-level `id`. `*` (which already returns id) is left
 * untouched. No-op for non-linkable entities.
 */
export function ensureLinkableIdField(entity: string, fields: string): string {
  if (!UI_LINKABLE_ENTITIES.has(entity)) return fields;
  const topLevel: string[] = [];
  let depth = 0;
  let token = "";
  for (const ch of fields) {
    if (ch === "(") {
      depth++;
      token += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      token += ch;
    } else if (ch === "," && depth === 0) {
      topLevel.push(token);
      token = "";
    } else {
      token += ch;
    }
  }
  if (token) topLevel.push(token);
  const names = topLevel.map((t) => t.trim().split("(")[0].trim().toLowerCase());
  if (names.includes("*") || names.includes("id")) return fields;
  return `id,${fields}`;
}

// Cache the swimlane-derived host keyed by the restUrl it was derived from, so a
// cluster migration/failover that changes restUrl on re-auth recomputes the host.
// Keyed by restUrl (a Map) so multiple firms on different swimlanes don't thrash
// a single shared memo.
const memoDerivedUiBase = new Map<string, string | null>();

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
  const memo = memoDerivedUiBase.get(restUrl);
  if (memo !== undefined) return memo;
  let base: string | null = null;
  try {
    const host = new URL(restUrl).hostname;
    const m = /^rest(\d+)\.bullhornstaffing\.com$/i.exec(host);
    base = m ? `https://cls${m[1]}.bullhornstaffing.com` : null;
  } catch {
    base = null;
  }
  memoDerivedUiBase.set(restUrl, base);
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
  fields = ensureLinkableIdField(entity, sanitizeFields(fields));
  // Enforce metric definitions on the SEARCH path too, so a freelanced raw
  // isOpen:true returns the correct universe of records (jobs exclude Archived;
  // opportunities exclude Closed-Won/Closed-Lost/Converted) — not just on count.
  const guard = applyMetricDefinitionGuard(entity, query);
  query = guard.query;
  query = normalizeSearchDateRanges(query, entity);
  query = anchorPureNegationQuery(query, entity);

  // Cache the raw Bullhorn JSON (post-processing below mutates a fresh clone each
  // call, so cached entries stay pristine). Key excludes the rotating BhRestToken.
  const cacheKey = `${currentFirmContextId() ?? "no-firm"}:search:${entity}:${query}:${fields}:${count}:${start}`;
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
  fields = ensureLinkableIdField(entity, sanitizeFields(fields));
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
  const resolvedFields = ensureLinkableIdField(entity, sanitizeFields(fields));
  return redactCandidateDescriptions(
    entity,
    await enrichWithProfileUrls(
      entity,
      await bullhornFetch(`entity/${entity}/${id}`, { fields: resolvedFields }),
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

// A single job's publicDescription is raw HTML and can be very large; left
// untouched it can push a get_job response past ChatGPT's client-side tool-output
// size cap, which silently DROPS the whole result (the assistant narrates this as
// "blocked by the connector safety layer"). Strip the HTML and cap the length so a
// single job fetch always stays small, regardless of which AI drives.
const MAX_JOB_DESCRIPTION_CHARS = 12000;

export function sanitizeJobRecord(result: unknown): unknown {
  const wrapped =
    result && typeof result === "object" && "data" in (result as object)
      ? (result as { data?: unknown }).data
      : result;
  if (!wrapped || typeof wrapped !== "object" || Array.isArray(wrapped)) return result;
  const job = wrapped as Record<string, unknown>;
  const raw = job.publicDescription;
  if (typeof raw === "string" && raw.length > 0) {
    let text = /<[a-z!/][^>]*>/i.test(raw) ? stripHtml(raw) : raw;
    if (text.length > MAX_JOB_DESCRIPTION_CHARS) {
      text =
        text.slice(0, MAX_JOB_DESCRIPTION_CHARS) +
        "\n…[description truncated — open the job in Bullhorn for the full text]";
    }
    job.publicDescription = text;
  }
  return result;
}

export async function getJob(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,dateEnd,address,publicDescription,skills,educationDegree,yearsRequired,startDate,correlatedCustomText1,customText2";
  const result = await getEntity("JobOrder", args.id, fields);
  return sanitizeJobRecord(result);
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
  const result = await queryEntity(
    "JobSubmission",
    conditions.join(" AND "),
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "-dateAdded",
  );
  return tagSubmissionStages(await enrichWithProfileUrls("JobSubmission", result));
}

/**
 * Tag each JobSubmission row with a derived `stage` ("response" | "submission")
 * so the AI never conflates inbound applicants (the Bullhorn "Response" bucket)
 * with recruiter-actioned submissions. Returns the same envelope, enriched.
 */
function tagSubmissionStages(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const obj = json as Record<string, unknown>;
  const rows = Array.isArray(obj.data) ? (obj.data as Array<Record<string, unknown>>) : [];
  let responses = 0;
  let submissions = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const status = typeof row.status === "string" ? row.status : undefined;
    const stage = classifySubmissionStage(status);
    row.stage = stage;
    if (stage === "response") responses++;
    else submissions++;
  }
  obj.stageSummary = {
    responses,
    submissions,
    note:
      "`stage` distinguishes inbound applicants ('response': New Lead / Online Applicant) " +
      "from recruiter-actioned submissions ('submission': Internally Submitted, Client " +
      "Submission, and later pipeline stages). Only 'submission' rows are real submissions.",
  };
  return json;
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
  return enrichWithProfileUrls("Placement", result);
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

/**
 * Identifies binary formats we can extract text from server-side.
 * Pass `buf` when available (enables magic-byte PDF detection on top of MIME/name).
 * Returns "pdf" | "docx" | null.
 */
function isSupportedBinaryFormat(
  contentType: string | undefined,
  name: string | undefined,
  buf?: Buffer,
): "pdf" | "docx" | null {
  const ct = (contentType ?? "").toLowerCase();
  const n = (name ?? "").toLowerCase();
  // PDF: MIME type, file extension, or magic bytes (%PDF)
  if (
    ct.includes("pdf") ||
    n.endsWith(".pdf") ||
    (buf && buf.subarray(0, 4).toString("latin1").startsWith("%PDF"))
  ) {
    return "pdf";
  }
  // DOCX (Office Open XML): MIME type or .docx extension only.
  // Legacy .doc (OLE binary) is NOT supported by mammoth; leave it as metadata.
  if (ct.includes("officedocument.wordprocessingml") || n.endsWith(".docx")) {
    return "docx";
  }
  return null;
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
    // Attempt server-side extraction for supported binary formats (PDF / DOCX).
    const fmt = isSupportedBinaryFormat(meta.contentType, meta.name, buf);
    if (fmt) {
      try {
        let raw = "";
        if (fmt === "pdf") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pdfMod = (await import("pdf-parse/node")) as any;
          const pdfParseFn = pdfMod.default ?? pdfMod;
          const parsed = await pdfParseFn(buf);
          raw = (parsed as { text?: string }).text ?? "";
        } else {
          const { extractRawText } = await import("mammoth");
          const result = await extractRawText({ buffer: buf });
          raw = result.value ?? "";
        }
        const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
        if (normalized.length > 0) {
          let text = redactResumeText(normalized);
          const cap = clampChars(args.maxChars);
          const truncated = text.length > cap;
          if (truncated) text = text.slice(0, cap);
          return {
            ...meta,
            sizeBytes: buf.length,
            textAvailable: true,
            extractedFrom: fmt,
            truncated,
            charsReturned: text.length,
            text,
          };
        }
      } catch (err) {
        logger.warn(
          { err, fileId: args.fileId, candidateId: args.candidateId, fmt },
          "Binary résumé extraction failed — falling back to metadata",
        );
      }
    }
    // Fallback: unsupported binary or extraction produced no text.
    return {
      ...meta,
      sizeBytes: buf.length,
      textAvailable: false,
      message:
        `This attachment is a binary file (${meta.contentType ?? "unknown type"}) ` +
        `with no extractable text${fmt ? " (extraction attempted but returned empty)" : ""}. ` +
        `Open it in Bullhorn to view, or call get_candidate_resume / get_candidate — ` +
        `the candidate record often stores the parsed résumé text.`,
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

  // Download and extract the chosen attachment when its format is textual OR
  // when it is a PDF/DOCX that we can now extract server-side.
  // Pure binary formats (images, old .doc, etc.) are still skipped to avoid
  // wasting bandwidth — their metadata is surfaced below.
  let resumeAttachmentText:
    | Awaited<ReturnType<typeof readCandidateAttachment>>
    | null = null;
  if (
    resume?.id !== undefined &&
    (isTextualContentType(resume.contentType, resume.name) ||
      isSupportedBinaryFormat(resume.contentType, resume.name) !== null)
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

  let groupBy = args.groupBy.trim();
  // Semantic alias: `internalDepartment` resolves to THIS firm's Internal
  // Department field (Myticas -> correlatedCustomText1 on JobOrder/Placement,
  // customText1 on Opportunity, etc.) so callers can group by department without
  // knowing the per-firm opaque custom-field name.
  if (groupBy === "internalDepartment") {
    const resolved = await resolveDeptField(currentFirmContextId(), entry.canonical);
    if (!resolved) {
      throw new Error(
        `No "Internal Department" field is configured for ${entry.canonical} on this firm. ` +
          `Run config discovery, or pass the explicit custom field name as groupBy.`,
      );
    }
    groupBy = resolved;
  }
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
  const result = await queryEntity(
    "JobSubmission",
    conditions.join(" AND "),
    fields,
    args.count ?? 50,
    args.start ?? 0,
    "-dateAdded",
  );
  return enrichWithProfileUrls("JobSubmission", result);
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
  rlRetries = RATE_LIMIT_RETRIES,
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

  if (res.status === 429) {
    if (rlRetries > 0) {
      const attempt = RATE_LIMIT_RETRIES - rlRetries + 1;
      const delay = backoffMs(attempt);
      logger.warn({ attempt, delay }, "Bullhorn: write rate limit hit — backing off");
      await sleep(delay);
      return writeFetch(session, method, path, body, rlRetries - 1);
    }
    throw new Error(
      "Bullhorn API rate limit exceeded after multiple retries. Wait 60 seconds and try again.",
    );
  }

  if (!res.ok) {
    const text = await res.text();
    throw formatBullhornError("write", res.status, text);
  }

  return res.json();
}

/**
 * Checks whether a JobSubmission already exists for this candidate+job pair.
 * Throws a descriptive error if a duplicate is found — prevents dirty data.
 * Uses the write session (per-user) so the check runs against the same
 * Bullhorn instance as the subsequent write.
 *
 * Non-fatal: if the check itself fails (e.g. unexpected API error), we log
 * a warning and allow the write to proceed rather than blocking on a check
 * failure. The error message from Bullhorn on a true duplicate is a safe
 * fallback.
 */
async function checkExistingSubmission(
  session: BullhornWriteSession,
  candidateId: number,
  jobOrderId: number,
): Promise<void> {
  try {
    const url = new URL("query/JobSubmission", session.restUrl);
    url.searchParams.set("BhRestToken", session.BhRestToken);
    url.searchParams.set(
      "where",
      `candidate.id=${candidateId} AND jobOrder.id=${jobOrderId} AND isDeleted=false`,
    );
    url.searchParams.set("fields", "id,status,dateAdded");
    url.searchParams.set("count", "1");

    const res = await fetch(url.toString());
    if (!res.ok) return; // allow write to proceed if check fails

    const data = (await res.json()) as {
      data?: Array<{ id: number; status: string }>;
    };
    if (data.data && data.data.length > 0) {
      const existing = data.data[0];
      throw new Error(
        `Duplicate submission blocked: candidate ${candidateId} is already submitted to job ${jobOrderId} ` +
          `(existing submission ID: ${existing.id}, status: "${existing.status}"). ` +
          `Use list_submissions_for_job to view all submissions for this job, ` +
          `or use update_submission_status if you need to change the status of the existing one.`,
      );
    }
  } catch (err) {
    // Re-throw duplicate errors; swallow unexpected check failures.
    if (err instanceof Error && err.message.startsWith("Duplicate submission blocked")) {
      throw err;
    }
    logger.warn({ err }, "Bullhorn: duplicate-check query failed — proceeding with write");
  }
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
 * Updates arbitrary fields on a Candidate (contact info, owner, status, custom
 * fields, etc.). Validates a `status` value against the live picklist when
 * present. Bullhorn enforces the session user's edit permissions on the record.
 */
export async function updateCandidate(
  session: BullhornWriteSession,
  candidateId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; candidateId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the candidate.");
  }
  if (typeof fields.status === "string") {
    await assertPicklistValue("Candidate", "status", fields.status);
  }
  await validateWriteFields("Candidate", fields, { mode: "update" });
  await updateEntityRecord(session, "Candidate", candidateId, fields);
  return { updated: true, candidateId };
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
  await assertPicklistValue("JobSubmission", "status", args.status);
  await checkExistingSubmission(session, args.candidateId, args.jobOrderId);
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

export interface BulkSubmissionInput {
  candidateId: number;
  jobOrderId: number;
}

export interface BulkSubmissionResult {
  candidateId: number;
  jobOrderId: number;
  submissionId?: number;
  error?: string;
}

/**
 * Submits multiple candidates to one or more job orders in a single call.
 * Runs all writes in parallel (Promise.allSettled) so partial failures don't
 * block the rest. Returns a per-item result list so the AI can report exactly
 * which submissions succeeded and which failed.
 *
 * sendingUserId is resolved once from the session and reused for every item.
 * Cap: max 20 submissions per call to stay well within Bullhorn rate limits.
 */
export async function bulkCreateSubmissions(
  session: BullhornWriteSession,
  args: {
    submissions: BulkSubmissionInput[];
    status: string;
  },
): Promise<{
  results: BulkSubmissionResult[];
  succeeded: number;
  failed: number;
  total: number;
}> {
  if (args.submissions.length === 0) {
    throw new Error("submissions array is empty — nothing to submit.");
  }
  if (args.submissions.length > 20) {
    throw new Error(
      `Too many submissions in one call (${args.submissions.length}). Max is 20. Split into multiple calls.`,
    );
  }

  // Validate the shared status once (instance-specific picklist) so an invalid
  // value (e.g. a pipeline-stage label like "Client Submission") is rejected
  // with the real option list before any record is written.
  await assertPicklistValue("JobSubmission", "status", args.status);

  const sendingUserId = await getSessionUserId(session);

  const settled = await Promise.allSettled(
    args.submissions.map(async (item) => {
      // Duplicate check runs per-item so bulk reports which pairs conflict.
      await checkExistingSubmission(session, item.candidateId, item.jobOrderId);
      const body = {
        candidate: { id: item.candidateId },
        jobOrder: { id: item.jobOrderId },
        status: args.status,
        sendingUser: { id: sendingUserId },
      };
      const data = (await writeFetch(session, "PUT", "entity/JobSubmission", body)) as {
        changedEntityId?: number;
      };
      return { ...item, submissionId: data.changedEntityId ?? 0 };
    }),
  );

  const results: BulkSubmissionResult[] = settled.map((r, i) => {
    const item = args.submissions[i];
    if (r.status === "fulfilled") {
      return { candidateId: item.candidateId, jobOrderId: item.jobOrderId, submissionId: r.value.submissionId };
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return { candidateId: item.candidateId, jobOrderId: item.jobOrderId, error: msg };
    }
  });

  const succeeded = results.filter((r) => r.submissionId !== undefined).length;
  return { results, succeeded, failed: results.length - succeeded, total: results.length };
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

// ═══════════════════════════════════════════════════════════════════════════
// Write-back surface (Task 50)
//
// Every function below takes an explicit per-user `session` and routes through
// `writeFetch` (or `fileFetch` for multipart), so Bullhorn enforces the calling
// recruiter's own ACLs and 403s surface as BullhornPermissionError. Cross-cutting
// safety — pre-flight field validation, picklist validation, and generalized
// duplicate prevention — is shared by all create/update helpers.
// ═══════════════════════════════════════════════════════════════════════════

/** A blocked write because an equivalent record already exists. */
export class BullhornDuplicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BullhornDuplicateError";
  }
}

/** Field-level pre-flight validation failure (bad field name or missing required). */
export class BullhornFieldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BullhornFieldValidationError";
  }
}

interface WriteFieldMeta {
  name: string;
  required: boolean;
  readOnly: boolean;
  type?: string;
  dataType?: string;
  associatedEntity?: string;
}

// System-managed fields Bullhorn populates itself; never flag these as "missing
// required" even when meta marks them required.
const SYSTEM_MANAGED_FIELDS = new Set(
  ["id", "dateadded", "datelastmodified", "datelastcomment", "migrateguid", "isdeleted"].map(
    (s) => s.toLowerCase(),
  ),
);

/**
 * Loads a field-name -> metadata map for an entity from Bullhorn `meta`. Uses
 * the shared service session (field configuration is firm-wide, not per-user);
 * field-level WRITE permission is still enforced by Bullhorn under the user's
 * own session at write time. Results are cached by `bullhornFetch`.
 */
async function getEntityFieldMeta(entity: string): Promise<Map<string, WriteFieldMeta>> {
  const meta = (await bullhornFetch(`meta/${entity}`, {
    fields: "*",
    meta: "basic",
  })) as { fields?: Array<Record<string, unknown>> };
  const map = new Map<string, WriteFieldMeta>();
  for (const f of meta.fields ?? []) {
    if (typeof f.name !== "string") continue;
    map.set((f.name as string).toLowerCase(), {
      name: f.name as string,
      required: f.required === true,
      readOnly: f.readOnly === true,
      type: typeof f.type === "string" ? (f.type as string) : undefined,
      dataType: typeof f.dataType === "string" ? (f.dataType as string) : undefined,
      associatedEntity: (f.associatedEntity as { entity?: string } | undefined)?.entity,
    });
  }
  return map;
}

/** Truncates a long comma-joined list for error messages. */
function truncateList(items: string[], max = 40): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, … (+${items.length - max} more — use describe_entity)`;
}

/**
 * Pre-flight validation of a write body against an entity's live field schema.
 *
 * - Unknown field names are rejected with the list of valid fields (prevents
 *   raw Bullhorn 400s like "invalid field" and tells the AI exactly what to fix).
 * - On create, fields Bullhorn marks `required` (and not readOnly/system-managed)
 *   that are absent are rejected with a clear message.
 *
 * Fails OPEN: if the meta lookup itself fails we log and let the write proceed,
 * so a transient meta error never blocks a legitimate write — Bullhorn remains
 * the final authority.
 */
export async function validateWriteFields(
  entityType: string,
  body: Record<string, unknown>,
  opts: { mode: "create" | "update" } = { mode: "create" },
): Promise<void> {
  // Soft-deletion must go through the dedicated delete/restore tools (which
  // carry destructive annotations and their own confirmation copy) — never
  // through an open create/update `fields` map. Checked BEFORE the meta
  // lookup so the rejection is deterministic even when meta is unavailable.
  const deletedKey = Object.keys(body).find((k) => k.toLowerCase() === "isdeleted");
  if (deletedKey !== undefined) {
    throw new BullhornFieldValidationError(
      `"${deletedKey}" cannot be set through a generic ${opts.mode} — deleting or restoring a record is a separate, destructive action. ` +
        `Use the delete_entity tool to soft-delete a record (or restore_entity to un-delete it) after confirming with the user.`,
    );
  }
  // Accept the dotted address notation some AI clients emit (e.g.
  // `address.countryName`) by folding it into the nested composite BEFORE
  // validation, so the write proceeds via the normal address pipeline.
  foldDottedAddressKeys(body);
  const entry = resolveEntity(entityType);
  let fieldMap: Map<string, WriteFieldMeta>;
  try {
    fieldMap = await getEntityFieldMeta(entry.canonical);
  } catch (err) {
    logger.warn(
      { err, entity: entry.canonical },
      "Bullhorn: field meta lookup failed — skipping pre-flight validation (failing open)",
    );
    return;
  }
  if (fieldMap.size === 0) return;

  const unknown = Object.keys(body).filter(
    (k) => k.toLowerCase() !== "id" && !fieldMap.has(k.toLowerCase()),
  );
  if (unknown.length > 0) {
    const valid = [...fieldMap.values()].map((f) => f.name).sort();
    throw new BullhornFieldValidationError(
      `Invalid field${unknown.length > 1 ? "s" : ""} for ${entry.canonical}: ${unknown.join(", ")}. ` +
        `Use describe_entity("${entry.canonical}") to find the correct field name(s). ` +
        `Valid fields include: ${truncateList(valid)}.`,
    );
  }

  if (opts.mode === "create") {
    const provided = new Set(Object.keys(body).map((k) => k.toLowerCase()));
    const missing = [...fieldMap.values()]
      .filter(
        (f) =>
          f.required &&
          !f.readOnly &&
          !SYSTEM_MANAGED_FIELDS.has(f.name.toLowerCase()) &&
          !provided.has(f.name.toLowerCase()),
      )
      .map((f) => f.name);
    if (missing.length > 0) {
      throw new BullhornFieldValidationError(
        `Missing required field${missing.length > 1 ? "s" : ""} for ${entry.canonical}: ${missing.join(", ")}. ` +
          `Provide ${missing.length > 1 ? "these values" : "this value"} before creating the record ` +
          `(use describe_entity("${entry.canonical}") and list_field_options for valid values).`,
      );
    }
  }
}

/**
 * Validates a value against a picklist field's configured options for THIS
 * instance. Throws BullhornFieldValidationError listing the valid options when
 * the value is not allowed. Fails OPEN when the field is not a picklist or the
 * options cannot be loaded (Bullhorn remains the final authority).
 */
export async function assertPicklistValue(
  entityType: string,
  fieldName: string,
  value: string,
): Promise<void> {
  let result: Awaited<ReturnType<typeof listFieldOptions>>;
  try {
    result = await listFieldOptions({ entityType, fieldName });
  } catch {
    return; // not a picklist, or options unavailable — let Bullhorn validate
  }
  const field = result.fields.find(
    (f) => f.name.toLowerCase() === fieldName.toLowerCase(),
  );
  if (!field || field.options.length === 0) return;
  const ok = field.options.some(
    (o) => o.value === value || o.label === value,
  );
  if (!ok) {
    const opts = field.options.map((o) => o.value).join(", ");
    throw new BullhornFieldValidationError(
      `"${value}" is not a valid ${fieldName} for ${result.entity}. Valid options: ${opts}. ` +
        `Call list_field_options("${result.entity}", "${fieldName}") and ask the user to pick one.`,
    );
  }
}

/**
 * Generalized pre-write duplicate guard. Runs a scoped /query (under the user
 * session) and throws BullhornDuplicateError — including the existing record's
 * ID so the AI can update instead of creating a dirty duplicate. Non-fatal: an
 * unexpected check failure is logged and the write is allowed to proceed.
 */
async function checkDuplicate(
  session: BullhornWriteSession,
  entity: string,
  where: string,
  describe: string,
  hint: string,
): Promise<void> {
  try {
    const url = new URL(`query/${entity}`, session.restUrl);
    url.searchParams.set("BhRestToken", session.BhRestToken);
    url.searchParams.set("where", where);
    url.searchParams.set("fields", "id");
    url.searchParams.set("count", "1");
    const res = await fetch(url.toString());
    if (!res.ok) return;
    const data = (await res.json()) as { data?: Array<{ id: number }> };
    if (data.data && data.data.length > 0) {
      throw new BullhornDuplicateError(
        `Duplicate ${entity} blocked: ${describe} already exists (existing ID: ${data.data[0].id}). ${hint}`,
      );
    }
  } catch (err) {
    if (err instanceof BullhornDuplicateError) throw err;
    logger.warn({ err, entity }, "Bullhorn: duplicate-check query failed — proceeding with write");
  }
}

/** Doubles single quotes for safe inclusion in a /query where literal. */
function q(value: string): string {
  return value.replace(/'/g, "''");
}

// Per-firm cache of Bullhorn's country name -> numeric countryID map, keyed by
// firm context so interleaved multi-tenant traffic never thrashes a single
// entry (and one firm's map can never be served to another). The list is
// firm-wide and stable; bullhornFetch also caches the underlying read.
const countryIdMapByFirm = new Map<string, Map<string, number>>();

/**
 * Loads Bullhorn's country list (`options/Country`) as a lowercased
 * name -> countryID map. Bullhorn stores a location's country as a numeric
 * `countryID` (a reference into this list), NOT as a name/code, so any name a
 * user supplies must be translated before a write.
 */
async function getCountryIdMap(): Promise<Map<string, number>> {
  const firm = currentFirmContextId() ?? "no-firm";
  const cached = countryIdMapByFirm.get(firm);
  if (cached) return cached;
  const data = (await bullhornFetch("options/Country", { count: 300 })) as {
    data?: Array<{ value?: unknown; label?: unknown }>;
  };
  const map = new Map<string, number>();
  for (const o of data.data ?? []) {
    const id = Number(o.value);
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (Number.isFinite(id) && label) map.set(label.toLowerCase(), id);
  }
  countryIdMapByFirm.set(firm, map);
  return map;
}

// Sub-field names that identify a Bullhorn ADDRESS composite by shape. Entities
// can carry several address composites (e.g. Candidate `address` +
// `secondaryAddress`, ClientCorporation `address` + `billingAddress`); we detect
// them by shape so every one is handled uniformly without hard-coding field
// names per entity. Association refs like `{ id }` have no address sub-field and
// are therefore never mistaken for an address.
const ADDRESS_SHAPE_KEYS = new Set([
  "countryname",
  "country",
  "countrycode",
  "countryid",
  "address1",
  "address2",
  "city",
  "state",
  "zip",
]);

/**
 * Some AI clients (notably ChatGPT) refuse to emit a nested address composite
 * and instead FLATTEN it into dotted top-level keys, e.g.
 * `{ "address.countryName": "Egypt", "address.city": "Cairo" }`. Bullhorn has no
 * such fields, so validation would reject them outright. This folds any
 * `<composite>.<subfield>` key whose subfield is a known address sub-field back
 * into the nested object Bullhorn expects: `{ address: { countryName, city } }`.
 *
 * Keyed on the SUBFIELD being an address sub-field (not the prefix), so it is
 * self-limiting: non-address dotted keys (e.g. `clientCorporation.id`) are left
 * untouched, and if the folded prefix is not actually a valid field for the
 * entity, validateWriteFields still rejects it afterward. Mutates `body` in
 * place; runs before validation so both the nested and dotted notations work.
 */
export function foldDottedAddressKeys(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    const dot = key.indexOf(".");
    if (dot <= 0 || dot === key.length - 1) continue;
    const sub = key.slice(dot + 1);
    if (!ADDRESS_SHAPE_KEYS.has(sub.toLowerCase())) continue;
    const prefix = key.slice(0, dot);
    const existing = body[prefix];
    const target: Record<string, unknown> =
      existing && typeof existing === "object" && !Array.isArray(existing)
        ? (existing as Record<string, unknown>)
        : {};
    target[sub] = body[key];
    body[prefix] = target;
    delete body[key];
  }
}

/** True when a value looks like a Bullhorn address composite (object of address sub-fields). */
function isAddressLikeObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.keys(v as Record<string, unknown>).some((k) =>
    ADDRESS_SHAPE_KEYS.has(k.toLowerCase()),
  );
}

/**
 * Returns [fieldName, addressObject] pairs for every address-shaped composite
 * value in a write body. Used both for collection and for keyed merge.
 */
function collectAddressEntries(
  body: Record<string, unknown>,
): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [k, v] of Object.entries(body)) {
    if (isAddressLikeObject(v)) out.push([k, v as Record<string, unknown>]);
  }
  return out;
}

/** Collects every address-shaped composite object present in a write body. */
function collectAddressObjects(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return collectAddressEntries(body).map(([, v]) => v);
}

/** True when a single address object still needs a country-name -> countryID lookup. */
function oneAddressNeedsCountryLookup(a: Record<string, unknown>): boolean {
  if (a.countryID != null && a.countryID !== "") return false;
  const raw = a.countryName ?? a.country ?? a.countryCode;
  return typeof raw === "string" && raw.trim() !== "";
}

/**
 * True when ANY address composite in the body needs a country-name lookup, so
 * the (cached) country map is fetched only when a translation is actually due.
 */
function addressNeedsCountryLookup(body: Record<string, unknown>): boolean {
  return collectAddressObjects(body).some(oneAddressNeedsCountryLookup);
}

/**
 * Translates/normalizes the country on a SINGLE address object in place: a name
 * via `countryName`/`country`/`countryCode` becomes the numeric `countryID`
 * Bullhorn requires, a string id is coerced to a number, and the read-only text
 * aliases are stripped so Bullhorn never rejects them as invalid address fields.
 * Throws BullhornFieldValidationError when a supplied country name is unknown.
 */
function resolveOneAddressCountry(
  a: Record<string, unknown>,
  countryMap: Map<string, number>,
): void {
  if (a.countryID != null && a.countryID !== "") {
    // Normalize a numeric id supplied as a string ("70" -> 70).
    if (typeof a.countryID === "string" && /^\d+$/.test(a.countryID.trim())) {
      a.countryID = Number(a.countryID.trim());
    }
  } else {
    const raw = a.countryName ?? a.country ?? a.countryCode;
    if (typeof raw === "string" && raw.trim()) {
      const id = countryMap.get(raw.trim().toLowerCase());
      if (id === undefined) {
        throw new BullhornFieldValidationError(
          `"${raw.trim()}" is not a recognized Bullhorn country name. ` +
            `Provide the country's full name exactly as Bullhorn spells it (e.g. "Egypt", "United States", "United Kingdom"), ` +
            `or pass a numeric countryID.`,
        );
      }
      a.countryID = id;
    }
  }

  delete a.countryName;
  delete a.country;
  delete a.countryCode;
}

/**
 * Pure transform: resolves user-friendly country input into the numeric
 * `countryID` Bullhorn requires on write, for EVERY address composite present
 * in the body (address, secondaryAddress, billingAddress, …), using a
 * pre-fetched name -> id map.
 *
 * No-op when the body carries no address composite. Mutates addresses in place.
 * Throws BullhornFieldValidationError when a supplied country name is unknown.
 */
export function applyCountryIdToAddress(
  body: Record<string, unknown>,
  countryMap: Map<string, number>,
): void {
  for (const a of collectAddressObjects(body)) {
    resolveOneAddressCountry(a, countryMap);
  }
}

/**
 * Async wrapper: fetches the country map only when a name lookup is actually
 * needed, then applies the pure transform. Used at the central write choke
 * points so every address-bearing create/update gets country translation.
 */
async function resolveAddressCountryId(body: Record<string, unknown>): Promise<void> {
  const map = addressNeedsCountryLookup(body)
    ? await getCountryIdMap()
    : new Map<string, number>();
  applyCountryIdToAddress(body, map);
}

/** PUT a new entity record; returns its new Bullhorn ID. */
async function createEntityRecord(
  session: BullhornWriteSession,
  entity: string,
  body: Record<string, unknown>,
): Promise<number> {
  await resolveAddressCountryId(body);
  const data = (await writeFetch(session, "PUT", `entity/${entity}`, body)) as {
    changedEntityId?: number;
  };
  return data.changedEntityId ?? 0;
}

/**
 * For each address composite present in `body`, fetches the record's current
 * address from Bullhorn and merges it in as a baseline so the POST receives
 * a COMPLETE address object.
 *
 * Bullhorn rejects partial address composites (e.g. just `{ countryID }`) with
 * a 500 "error persisting an entity" — it requires all sub-fields (address1,
 * city, state, zip, countryID) to be present together on write.
 *
 * Merge logic: current values are the baseline; caller's values are the
 * overlay. If the caller supplied a country NAME key (countryName/country/
 * countryCode), the inherited `countryID` from the current record is removed
 * so that `resolveAddressCountryId` (called next) performs a fresh name→id
 * lookup rather than keeping the old country.
 *
 * Fails open: if the fetch fails we log a warning and let the partial body
 * pass through (Bullhorn will validate and return its own error).
 */
async function mergeCurrentAddresses(
  session: BullhornWriteSession,
  entity: string,
  id: number,
  body: Record<string, unknown>,
): Promise<void> {
  const entries = collectAddressEntries(body);
  if (entries.length === 0) return;

  const fields = entries.map(([k]) => k).join(",");
  try {
    const url = new URL(`entity/${entity}/${id}`, session.restUrl);
    url.searchParams.set("BhRestToken", session.BhRestToken);
    url.searchParams.set("fields", fields);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Bullhorn GET status ${res.status}`);
    const json = (await res.json()) as { data?: Record<string, unknown> };
    const current = json.data ?? {};
    for (const [key, newAddr] of entries) {
      const currentAddr = current[key];
      if (!currentAddr || typeof currentAddr !== "object" || Array.isArray(currentAddr)) continue;
      const merged: Record<string, unknown> = {
        ...(currentAddr as Record<string, unknown>),
        ...newAddr,
      };
      // If the caller specified a country by NAME, clear the inherited countryID
      // so the name→id resolver produces a fresh lookup instead of keeping the
      // old country's id.
      if (newAddr.countryName != null || newAddr.country != null || newAddr.countryCode != null) {
        delete merged.countryID;
      }
      body[key] = merged;
    }
  } catch (err) {
    logger.warn(
      { err, entity, id, fields },
      "Bullhorn: failed to pre-fetch address for merge — sending caller-supplied address as-is",
    );
  }
}

/** POST an update to an existing entity record. */
async function updateEntityRecord(
  session: BullhornWriteSession,
  entity: string,
  id: number,
  body: Record<string, unknown>,
): Promise<void> {
  // Merge current address sub-fields before resolving country so Bullhorn
  // receives a complete composite (partial address = 500 persistence error).
  await mergeCurrentAddresses(session, entity, id, body);
  await resolveAddressCountryId(body);
  await writeFetch(session, "POST", `entity/${entity}/${id}`, body);
}

/** Maps an optional numeric association id to a Bullhorn `{ id }` reference. */
function assoc(id: number | undefined): { id: number } | undefined {
  return id === undefined ? undefined : { id };
}

/** Drops undefined values so they are never sent in a write body. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ── Pipeline transitions ──────────────────────────────────────────────────

/**
 * Advances a JobSubmission to a new pipeline status. Validates the requested
 * status against the instance's configured JobSubmission status options before
 * writing so an invalid stage is rejected with the real option list.
 */
export async function updateSubmissionStatus(
  session: BullhornWriteSession,
  submissionId: number,
  status: string,
): Promise<{ updated: true; submissionId: number; status: string }> {
  await assertPicklistValue("JobSubmission", "status", status);
  await updateEntityRecord(session, "JobSubmission", submissionId, { status });
  return { updated: true, submissionId, status };
}

// ── JobOrder create / update ──────────────────────────────────────────────

export async function createJobOrder(
  session: BullhornWriteSession,
  args: {
    title: string;
    clientCorporationId: number;
    clientContactId?: number;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ jobOrderId: number; title: string }> {
  const ownerId = await getSessionUserId(session);
  const body = compact({
    title: args.title,
    clientCorporation: assoc(args.clientCorporationId),
    clientContact: assoc(args.clientContactId),
    owner: assoc(ownerId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("JobOrder", body, { mode: "create" });
  const jobOrderId = await createEntityRecord(session, "JobOrder", body);
  return { jobOrderId, title: args.title };
}

export async function updateJobOrder(
  session: BullhornWriteSession,
  jobOrderId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; jobOrderId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the job order.");
  }
  await validateWriteFields("JobOrder", fields, { mode: "update" });
  await updateEntityRecord(session, "JobOrder", jobOrderId, fields);
  return { updated: true, jobOrderId };
}

// ── ClientCorporation (company) create / update ───────────────────────────

export async function createCompany(
  session: BullhornWriteSession,
  args: { name: string; additionalFields?: Record<string, unknown> },
): Promise<{ companyId: number; name: string }> {
  await checkDuplicate(
    session,
    "ClientCorporation",
    `name='${q(args.name)}'`,
    `a company named "${args.name}"`,
    "Use search_entity to find it, or update_company to edit the existing record.",
  );
  const body = compact({ name: args.name, ...(args.additionalFields ?? {}) });
  await validateWriteFields("ClientCorporation", body, { mode: "create" });
  const companyId = await createEntityRecord(session, "ClientCorporation", body);
  return { companyId, name: args.name };
}

export async function updateCompany(
  session: BullhornWriteSession,
  companyId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; companyId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the company.");
  }
  await validateWriteFields("ClientCorporation", fields, { mode: "update" });
  await updateEntityRecord(session, "ClientCorporation", companyId, fields);
  return { updated: true, companyId };
}

// ── ClientContact create / update ─────────────────────────────────────────

export async function createContact(
  session: BullhornWriteSession,
  args: {
    firstName: string;
    lastName: string;
    clientCorporationId: number;
    email?: string;
    phone?: string;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ contactId: number; name: string }> {
  await checkDuplicate(
    session,
    "ClientContact",
    `firstName='${q(args.firstName)}' AND lastName='${q(args.lastName)}' AND clientCorporation.id=${args.clientCorporationId} AND isDeleted=false`,
    `a contact "${args.firstName} ${args.lastName}" at company ${args.clientCorporationId}`,
    "Use search_entity to find them, or update_contact to edit the existing record.",
  );
  const body = compact({
    firstName: args.firstName,
    lastName: args.lastName,
    clientCorporation: assoc(args.clientCorporationId),
    email: args.email,
    phone: args.phone,
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("ClientContact", body, { mode: "create" });
  const contactId = await createEntityRecord(session, "ClientContact", body);
  return { contactId, name: `${args.firstName} ${args.lastName}` };
}

export async function updateContact(
  session: BullhornWriteSession,
  contactId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; contactId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the contact.");
  }
  await validateWriteFields("ClientContact", fields, { mode: "update" });
  await updateEntityRecord(session, "ClientContact", contactId, fields);
  return { updated: true, contactId };
}

// ── Lead (sales prospect) create / update ─────────────────────────────────

/**
 * Creates a Lead (a sales/BD prospect). This instance flags several fields as
 * required (e.g. status, leadSource, comments, and a custom field such as
 * customText1, plus assignedTo); callers should use describe_entity("Lead") and
 * list_field_options to discover required fields and valid picklist values for
 * this firm. owner + assignedTo default to the calling user.
 */
export async function createLead(
  session: BullhornWriteSession,
  args: {
    firstName?: string;
    lastName?: string;
    companyName?: string;
    email?: string;
    phone?: string;
    comments?: string;
    status?: string;
    leadSource?: string;
    clientCorporationId?: number;
    assignedToUserIds?: number[];
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ leadId: number }> {
  const ownerId = await getSessionUserId(session);
  if (args.status) await assertPicklistValue("Lead", "status", args.status);
  if (args.leadSource) await assertPicklistValue("Lead", "leadSource", args.leadSource);
  const assignedIds =
    args.assignedToUserIds && args.assignedToUserIds.length > 0
      ? args.assignedToUserIds
      : [ownerId];
  const body = compact({
    firstName: args.firstName,
    lastName: args.lastName,
    companyName: args.companyName,
    email: args.email,
    phone: args.phone,
    comments: args.comments,
    status: args.status,
    leadSource: args.leadSource,
    owner: assoc(ownerId),
    assignedTo: assignedIds.map((id) => ({ id })),
    clientCorporation: assoc(args.clientCorporationId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Lead", body, { mode: "create" });
  const leadId = await createEntityRecord(session, "Lead", body);
  return { leadId };
}

export async function updateLead(
  session: BullhornWriteSession,
  leadId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; leadId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the lead.");
  }
  if (typeof fields.status === "string") {
    await assertPicklistValue("Lead", "status", fields.status);
  }
  await validateWriteFields("Lead", fields, { mode: "update" });
  await updateEntityRecord(session, "Lead", leadId, fields);
  return { updated: true, leadId };
}

// ── Opportunity (sales deal) create / update ──────────────────────────────

/**
 * Creates an Opportunity (a sales deal). Required: title, clientCorporationId,
 * clientContactId, plus status/type and possibly a custom field (e.g.
 * customText1) per firm config — callers should use describe_entity and
 * list_field_options to discover required fields and valid values. owner
 * defaults to the calling user.
 */
export async function createOpportunity(
  session: BullhornWriteSession,
  args: {
    title: string;
    clientCorporationId: number;
    clientContactId: number;
    status?: string;
    type?: string;
    assignedToUserIds?: number[];
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ opportunityId: number; title: string }> {
  const ownerId = await getSessionUserId(session);
  if (args.status) await assertPicklistValue("Opportunity", "status", args.status);
  if (args.type) await assertPicklistValue("Opportunity", "type", args.type);
  const body = compact({
    title: args.title,
    clientCorporation: assoc(args.clientCorporationId),
    clientContact: assoc(args.clientContactId),
    status: args.status,
    type: args.type,
    owner: assoc(ownerId),
    assignedUsers: args.assignedToUserIds?.map((id) => ({ id })),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Opportunity", body, { mode: "create" });
  const opportunityId = await createEntityRecord(session, "Opportunity", body);
  return { opportunityId, title: args.title };
}

export async function updateOpportunity(
  session: BullhornWriteSession,
  opportunityId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; opportunityId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the opportunity.");
  }
  if (typeof fields.status === "string") {
    await assertPicklistValue("Opportunity", "status", fields.status);
  }
  await validateWriteFields("Opportunity", fields, { mode: "update" });
  await updateEntityRecord(session, "Opportunity", opportunityId, fields);
  return { updated: true, opportunityId };
}

// ── Task / Appointment update ─────────────────────────────────────────────

export async function updateTask(
  session: BullhornWriteSession,
  taskId: number,
  args: {
    subject?: string;
    dateBegin?: string;
    dateEnd?: string;
    type?: string;
    priority?: number;
    isCompleted?: boolean;
    notificationMinutes?: number;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ updated: true; taskId: number }> {
  const body = compact({
    subject: args.subject,
    dateBegin: args.dateBegin ? toEpochMillis(args.dateBegin, "dateBegin") : undefined,
    dateEnd: args.dateEnd ? toEpochMillis(args.dateEnd, "dateEnd") : undefined,
    type: args.type,
    priority: args.priority,
    isCompleted: args.isCompleted,
    notificationMinutes: args.notificationMinutes,
    ...(args.additionalFields ?? {}),
  });
  if (Object.keys(body).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the task.");
  }
  await validateWriteFields("Task", body, { mode: "update" });
  await updateEntityRecord(session, "Task", taskId, body);
  return { updated: true, taskId };
}

export async function updateAppointment(
  session: BullhornWriteSession,
  appointmentId: number,
  args: {
    subject?: string;
    dateBegin?: string;
    dateEnd?: string;
    location?: string;
    type?: string;
    description?: string;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ updated: true; appointmentId: number }> {
  const body = compact({
    subject: args.subject,
    dateBegin: args.dateBegin ? toEpochMillis(args.dateBegin, "dateBegin") : undefined,
    dateEnd: args.dateEnd ? toEpochMillis(args.dateEnd, "dateEnd") : undefined,
    location: args.location,
    type: args.type,
    description: args.description,
    ...(args.additionalFields ?? {}),
  });
  if (Object.keys(body).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the appointment.");
  }
  await validateWriteFields("Appointment", body, { mode: "update" });
  await updateEntityRecord(session, "Appointment", appointmentId, body);
  return { updated: true, appointmentId };
}

// ── Task / Appointment create ─────────────────────────────────────────────

export async function createTask(
  session: BullhornWriteSession,
  args: {
    subject: string;
    dateBegin?: string;
    dateEnd?: string;
    type?: string;
    priority?: number;
    ownerId?: number;
    candidateId?: number;
    jobOrderId?: number;
    clientContactId?: number;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ taskId: number; subject: string }> {
  const ownerId = args.ownerId ?? (await getSessionUserId(session));
  const body = compact({
    subject: args.subject,
    dateBegin: args.dateBegin ? toEpochMillis(args.dateBegin, "dateBegin") : undefined,
    dateEnd: args.dateEnd ? toEpochMillis(args.dateEnd, "dateEnd") : undefined,
    type: args.type,
    priority: args.priority,
    owner: assoc(ownerId),
    candidate: assoc(args.candidateId),
    jobOrder: assoc(args.jobOrderId),
    clientContact: assoc(args.clientContactId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Task", body, { mode: "create" });
  const taskId = await createEntityRecord(session, "Task", body);
  return { taskId, subject: args.subject };
}

/**
 * "Notify" specific Bullhorn users about something (e.g. a new sendout or
 * placement) by assigning them a Task + optional reminder.
 *
 * WHY a Task: Bullhorn's in-app notification feed (the bell) is powered by a
 * private internal API (`UserMessage` / `bhInternalApi`) that Bullhorn does NOT
 * expose to ANY API integration — the live API returns 403 "feature not
 * enabled". The genuine, supported way to push an actionable alert to specific
 * users via the API is a Task on their list. The first user becomes the task
 * owner and the rest are added as `secondaryOwners` (to-many association), so it
 * lands on every named user's task list. We never silently fake the bell feed.
 */
export async function notifyUsers(
  session: BullhornWriteSession,
  args: {
    userIds: number[];
    message: string;
    details?: string;
    dueDate?: string;
    reminderMinutesBefore?: number;
    type?: string;
    priority?: number;
    candidateId?: number;
    jobOrderId?: number;
    clientContactId?: number;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{
  taskId: number;
  subject: string;
  notifiedUsers: Array<{ id: number; name?: string }>;
  secondaryOwnersAdded: number[];
  warning?: string;
  mechanism: string;
}> {
  const ids = Array.from(new Set(args.userIds)).filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  if (ids.length === 0) {
    throw new BullhornFieldValidationError(
      "notify_users requires at least one valid Bullhorn user ID in userIds.",
    );
  }

  // Validate the targets are real, active users — fail loudly rather than
  // silently assigning to a deleted/nonexistent user. Query the specific IDs
  // (not a capped directory page) so this stays correct for large firms.
  const lookup = await queryEntity(
    "CorporateUser",
    `id IN (${ids.join(",")}) AND isDeleted=false`,
    "id,name",
    ids.length,
    0,
    "id",
  );
  const rows = (lookup as { data?: Array<Record<string, unknown>> }).data ?? [];
  const byId = new Map<number, Record<string, unknown>>();
  for (const u of rows) {
    if (typeof u.id === "number") byId.set(u.id, u);
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new BullhornFieldValidationError(
      `These userIds are not active Bullhorn users: ${missing.join(", ")}. ` +
        `Use find_users to look up the correct IDs.`,
    );
  }
  const notifiedUsers = ids.map((id) => ({
    id,
    name: (byId.get(id)?.name as string | undefined) ?? undefined,
  }));

  const [ownerId, ...secondaryIds] = ids;
  const body = compact({
    subject: args.message,
    description: args.details,
    dateBegin: args.dueDate ? toEpochMillis(args.dueDate, "dueDate") : Date.now(),
    notificationMinutes:
      typeof args.reminderMinutesBefore === "number"
        ? args.reminderMinutesBefore
        : undefined,
    type: args.type,
    priority: args.priority,
    owner: assoc(ownerId),
    candidate: assoc(args.candidateId),
    jobOrder: assoc(args.jobOrderId),
    clientContact: assoc(args.clientContactId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Task", body, { mode: "create" });
  const taskId = await createEntityRecord(session, "Task", body);

  // Additional recipients become secondaryOwners via the to-many association
  // endpoint (bodyless POST), so the task appears on every named user's list.
  // Non-atomic: the Task already exists, so on association failure we return a
  // partial result (with taskId + a warning) rather than throwing and hiding
  // the fact that the task was created.
  let secondaryOwnersAdded: number[] = [];
  let warning: string | undefined;
  if (secondaryIds.length > 0) {
    try {
      await writeFetch(
        session,
        "POST",
        `entity/Task/${taskId}/secondaryOwners/${secondaryIds.join(",")}`,
        undefined,
      );
      secondaryOwnersAdded = secondaryIds;
    } catch (err) {
      warning =
        `Task ${taskId} was created and assigned to user ${ownerId}, but adding the ` +
        `additional recipients (${secondaryIds.join(", ")}) failed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Re-run notify_users for those users, or add them as secondary owners in Bullhorn.`;
    }
  }

  return {
    taskId,
    subject: args.message,
    notifiedUsers,
    secondaryOwnersAdded,
    ...(warning ? { warning } : {}),
    mechanism:
      "Bullhorn Task assigned to the named users (owner + secondaryOwners)" +
      (typeof args.reminderMinutesBefore === "number" ? " with a reminder" : "") +
      ". Bullhorn's in-app notification feed is not API-accessible; this Task is the supported alert mechanism.",
  };
}

export async function createAppointment(
  session: BullhornWriteSession,
  args: {
    subject: string;
    dateBegin: string;
    dateEnd: string;
    location?: string;
    type?: string;
    description?: string;
    ownerId?: number;
    candidateId?: number;
    jobOrderId?: number;
    clientContactId?: number;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ appointmentId: number; subject: string }> {
  const ownerId = args.ownerId ?? (await getSessionUserId(session));
  const body = compact({
    subject: args.subject,
    dateBegin: toEpochMillis(args.dateBegin, "dateBegin"),
    dateEnd: toEpochMillis(args.dateEnd, "dateEnd"),
    location: args.location,
    type: args.type,
    description: args.description,
    owner: assoc(ownerId),
    candidate: assoc(args.candidateId),
    jobOrder: assoc(args.jobOrderId),
    clientContact: assoc(args.clientContactId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Appointment", body, { mode: "create" });
  const appointmentId = await createEntityRecord(session, "Appointment", body);
  return { appointmentId, subject: args.subject };
}

// ── Tearsheet create + membership ─────────────────────────────────────────

export async function createTearsheet(
  session: BullhornWriteSession,
  args: { name: string; description?: string; additionalFields?: Record<string, unknown> },
): Promise<{ tearsheetId: number; name: string }> {
  const ownerId = await getSessionUserId(session);
  await checkDuplicate(
    session,
    "Tearsheet",
    `name='${q(args.name)}' AND owner.id=${ownerId} AND isDeleted=false`,
    `a tearsheet named "${args.name}" owned by you`,
    "Use the existing tearsheet, or pick a different name.",
  );
  const body = compact({
    name: args.name,
    description: args.description,
    owner: assoc(ownerId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Tearsheet", body, { mode: "create" });
  const tearsheetId = await createEntityRecord(session, "Tearsheet", body);
  return { tearsheetId, name: args.name };
}

/**
 * Adds candidates to a tearsheet via the to-many association endpoint
 * (POST entity/Tearsheet/{id}/candidates/{ids}). Association writes carry no body.
 */
export async function addCandidatesToTearsheet(
  session: BullhornWriteSession,
  tearsheetId: number,
  candidateIds: number[],
): Promise<{ tearsheetId: number; added: number[] }> {
  if (candidateIds.length === 0) {
    throw new BullhornFieldValidationError("No candidateIds provided to add to the tearsheet.");
  }
  await writeFetch(
    session,
    "POST",
    `entity/Tearsheet/${tearsheetId}/candidates/${candidateIds.join(",")}`,
    undefined,
  );
  return { tearsheetId, added: candidateIds };
}

export async function removeCandidatesFromTearsheet(
  session: BullhornWriteSession,
  tearsheetId: number,
  candidateIds: number[],
): Promise<{ tearsheetId: number; removed: number[] }> {
  if (candidateIds.length === 0) {
    throw new BullhornFieldValidationError("No candidateIds provided to remove from the tearsheet.");
  }
  await writeFetch(
    session,
    "DELETE",
    `entity/Tearsheet/${tearsheetId}/candidates/${candidateIds.join(",")}`,
    undefined,
  );
  return { tearsheetId, removed: candidateIds };
}

// ── Placement create / update (sensitive) ─────────────────────────────────

export async function createPlacement(
  session: BullhornWriteSession,
  args: {
    candidateId: number;
    jobOrderId: number;
    dateBegin?: string;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{ placementId: number; candidateId: number; jobOrderId: number }> {
  await checkDuplicate(
    session,
    "Placement",
    `candidate.id=${args.candidateId} AND jobOrder.id=${args.jobOrderId} AND isDeleted=false`,
    `a placement for candidate ${args.candidateId} on job ${args.jobOrderId}`,
    "Use update_placement to change the existing placement instead of creating a duplicate.",
  );
  const body = compact({
    candidate: assoc(args.candidateId),
    jobOrder: assoc(args.jobOrderId),
    dateBegin: args.dateBegin ? toEpochMillis(args.dateBegin, "dateBegin") : undefined,
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Placement", body, { mode: "create" });
  const placementId = await createEntityRecord(session, "Placement", body);
  return { placementId, candidateId: args.candidateId, jobOrderId: args.jobOrderId };
}

export async function updatePlacement(
  session: BullhornWriteSession,
  placementId: number,
  fields: Record<string, unknown>,
): Promise<{ updated: true; placementId: number }> {
  if (Object.keys(fields).length === 0) {
    throw new BullhornFieldValidationError("No fields provided to update on the placement.");
  }
  await validateWriteFields("Placement", fields, { mode: "update" });
  await updateEntityRecord(session, "Placement", placementId, fields);
  return { updated: true, placementId };
}

// ── Soft delete / restore ─────────────────────────────────────────────────
//
// Bullhorn "deletion" is a soft delete: `POST entity/{Entity}/{id}` with
// `{ isDeleted: true }`. The record disappears from normal searches (our read
// tools already filter `isDeleted:false`) but remains in the database and can
// be restored. Hard `DELETE entity/...` is intentionally NOT implemented.
// Placement is excluded: its lifecycle is billing-sensitive and status-driven,
// so it is archived/cancelled via a status change instead (see
// archiveOrCancelPlacement below).

/** Canonical entity names the dedicated delete/restore tools accept. */
export const SOFT_DELETABLE_ENTITIES = [
  "Candidate",
  "ClientContact",
  "ClientCorporation",
  "JobOrder",
  "JobSubmission",
  "Lead",
  "Opportunity",
] as const;

const SOFT_DELETABLE_SET = new Set<string>(SOFT_DELETABLE_ENTITIES);

async function setEntityDeleted(
  session: BullhornWriteSession,
  entityType: string,
  id: number,
  isDeleted: boolean,
): Promise<{ entity: string; id: number; isDeleted: boolean; action: string }> {
  const entry = resolveEntity(entityType);
  if (!SOFT_DELETABLE_SET.has(entry.canonical)) {
    const hint =
      entry.canonical === "Placement"
        ? "Placements are billing-sensitive and are never soft-deleted — cancel or archive the placement with a status change instead (use archive_placement)."
        : `Only these entities can be soft-deleted: ${SOFT_DELETABLE_ENTITIES.join(", ")}.`;
    throw new BullhornFieldValidationError(
      `Soft-delete is not supported for ${entry.canonical}. ${hint}`,
    );
  }
  // Deliberately bypasses validateWriteFields (which rejects isDeleted on the
  // generic paths) — this is THE sanctioned soft-delete path. Bullhorn enforces
  // the caller's own delete ACL under their session; a 403 surfaces as
  // BullhornPermissionError -> permission_denied.
  await writeFetch(session, "POST", `entity/${entry.canonical}/${id}`, {
    isDeleted,
  });
  return {
    entity: entry.canonical,
    id,
    isDeleted,
    action: isDeleted ? "soft_deleted" : "restored",
  };
}

/**
 * Soft-deletes a record (`isDeleted: true`). The record is hidden from normal
 * searches but NOT permanently destroyed; restoreEntity can bring it back.
 */
export async function softDeleteEntity(
  session: BullhornWriteSession,
  entityType: string,
  id: number,
): Promise<{ entity: string; id: number; isDeleted: boolean; action: string }> {
  return setEntityDeleted(session, entityType, id, true);
}

/** Restores a previously soft-deleted record (`isDeleted: false`). */
export async function restoreEntity(
  session: BullhornWriteSession,
  entityType: string,
  id: number,
): Promise<{ entity: string; id: number; isDeleted: boolean; action: string }> {
  return setEntityDeleted(session, entityType, id, false);
}

/**
 * Archives or cancels a Placement by changing its status to a value from this
 * firm's configured Placement status picklist (e.g. "Terminated", "Falloff").
 * Placements are never soft-deleted: they drive billing/payroll, and this
 * instance documents Placement `isDeleted` as unreliable on search paths.
 */
export async function archiveOrCancelPlacement(
  session: BullhornWriteSession,
  placementId: number,
  status: string,
): Promise<{ placementId: number; status: string; action: string }> {
  const trimmed = status.trim();
  if (trimmed === "") {
    throw new BullhornFieldValidationError(
      'A target status is required to archive/cancel a placement. Call list_field_options("Placement", "status") and ask the user to pick the cancel/archive value.',
    );
  }
  await assertPicklistValue("Placement", "status", trimmed);
  await writeFetch(session, "POST", `entity/Placement/${placementId}`, {
    status: trimmed,
  });
  return { placementId, status: trimmed, action: "status_changed" };
}

// ── Sendout (Client Submission) create ────────────────────────────────────
//
// A Sendout is Bullhorn's record of submitting a candidate TO THE CLIENT — the
// "Client Submission" pipeline stage. It is a DIFFERENT entity from a
// JobSubmission (which carries the internal pipeline status). Created via
// PUT entity/Sendout. This REST create records the submission ONLY; it does NOT
// send any email to the client (Bullhorn's email-out is a separate composer
// action). The `email` field would merely store an address, so it is
// intentionally never set here to avoid implying an email was sent.

/** Reads a job's primary client contact + company to default a Sendout's recipients. */
async function getJobOrderClientRefs(
  session: BullhornWriteSession,
  jobOrderId: number,
): Promise<{ clientContactId?: number; clientCorporationId?: number }> {
  try {
    const url = new URL(`entity/JobOrder/${jobOrderId}`, session.restUrl);
    url.searchParams.set("BhRestToken", session.BhRestToken);
    url.searchParams.set("fields", "id,clientContact(id),clientCorporation(id)");
    const res = await fetch(url.toString());
    if (!res.ok) return {};
    const data = (await res.json()) as {
      data?: { clientContact?: { id?: number }; clientCorporation?: { id?: number } };
    };
    return {
      clientContactId: data.data?.clientContact?.id,
      clientCorporationId: data.data?.clientCorporation?.id,
    };
  } catch (err) {
    logger.warn({ err, jobOrderId }, "Bullhorn: failed to resolve job client refs for Sendout");
    return {};
  }
}

/**
 * Rejects a jobSubmissionId that belongs to a different candidate or job than
 * the Sendout being created (prevents silently cross-linking records). Fails
 * OPEN on read errors — Bullhorn stays the final authority — but throws on a
 * confirmed mismatch.
 */
async function assertSubmissionMatchesCandidateJob(
  session: BullhornWriteSession,
  jobSubmissionId: number,
  candidateId: number,
  jobOrderId: number,
): Promise<void> {
  try {
    const url = new URL(`entity/JobSubmission/${jobSubmissionId}`, session.restUrl);
    url.searchParams.set("BhRestToken", session.BhRestToken);
    url.searchParams.set("fields", "id,candidate(id),jobOrder(id)");
    const res = await fetch(url.toString());
    if (!res.ok) return;
    const data = (await res.json()) as {
      data?: { candidate?: { id?: number }; jobOrder?: { id?: number } };
    };
    const subCandidateId = data.data?.candidate?.id;
    const subJobOrderId = data.data?.jobOrder?.id;
    if (
      (subCandidateId !== undefined && subCandidateId !== candidateId) ||
      (subJobOrderId !== undefined && subJobOrderId !== jobOrderId)
    ) {
      throw new BullhornFieldValidationError(
        `jobSubmissionId ${jobSubmissionId} belongs to candidate ${subCandidateId}/job ${subJobOrderId}, ` +
          `not candidate ${candidateId}/job ${jobOrderId}. Link the matching JobSubmission or omit jobSubmissionId.`,
      );
    }
  } catch (err) {
    if (err instanceof BullhornFieldValidationError) throw err;
    logger.warn(
      { err, jobSubmissionId },
      "Bullhorn: failed to verify jobSubmission match for Sendout — proceeding",
    );
  }
}

export async function createSendout(
  session: BullhornWriteSession,
  args: {
    candidateId: number;
    jobOrderId: number;
    clientContactId?: number;
    clientCorporationId?: number;
    jobSubmissionId?: number;
    additionalFields?: Record<string, unknown>;
  },
): Promise<{
  sendoutId: number;
  candidateId: number;
  jobOrderId: number;
  clientContactId: number;
  clientCorporationId: number;
  jobSubmissionId?: number;
}> {
  // Default the recipient contact + company to the job's own hiring contact /
  // client company when not specified — what a recruiter does by default when
  // sending a candidate out on a job.
  let clientContactId = args.clientContactId;
  let clientCorporationId = args.clientCorporationId;
  if (clientContactId === undefined || clientCorporationId === undefined) {
    const refs = await getJobOrderClientRefs(session, args.jobOrderId);
    clientContactId = clientContactId ?? refs.clientContactId;
    clientCorporationId = clientCorporationId ?? refs.clientCorporationId;
  }
  if (clientContactId === undefined) {
    throw new BullhornFieldValidationError(
      `Cannot create a client submission (Sendout): no client contact was provided and job ${args.jobOrderId} has no client contact on file. ` +
        `Provide clientContactId — the client-side person the candidate is being submitted to.`,
    );
  }
  if (clientCorporationId === undefined) {
    throw new BullhornFieldValidationError(
      `Cannot create a client submission (Sendout): no client company could be resolved. Provide clientCorporationId — the client company the candidate is being submitted to.`,
    );
  }
  if (args.jobSubmissionId !== undefined) {
    await assertSubmissionMatchesCandidateJob(
      session,
      args.jobSubmissionId,
      args.candidateId,
      args.jobOrderId,
    );
  }
  await checkDuplicate(
    session,
    "Sendout",
    `candidate.id=${args.candidateId} AND jobOrder.id=${args.jobOrderId} AND isDeleted=false`,
    `a client submission (Sendout) for candidate ${args.candidateId} on job ${args.jobOrderId}`,
    "The candidate has already been submitted to the client for this job. Review the existing client submission instead of creating a duplicate.",
  );
  const userId = await getSessionUserId(session);
  const body = compact({
    candidate: assoc(args.candidateId),
    jobOrder: assoc(args.jobOrderId),
    clientContact: assoc(clientContactId),
    clientCorporation: assoc(clientCorporationId),
    jobSubmission: assoc(args.jobSubmissionId),
    user: assoc(userId),
    ...(args.additionalFields ?? {}),
  });
  await validateWriteFields("Sendout", body, { mode: "create" });
  const sendoutId = await createEntityRecord(session, "Sendout", body);
  return {
    sendoutId,
    candidateId: args.candidateId,
    jobOrderId: args.jobOrderId,
    clientContactId,
    clientCorporationId,
    jobSubmissionId: args.jobSubmissionId,
  };
}

// ── Files API: résumé / file upload + candidate-from-résumé ───────────────
//
// Distinct from the JSON entity/ door: file operations are multipart, and the
// resume parser is a non-entity endpoint. fileFetch mirrors writeFetch's 403 →
// permission, 429 → backoff, and error-formatting contract for these paths.

// Bullhorn's resume parser requires the `format` value in UPPERCASE (TEXT, HTML,
// PDF, DOC, DOCX, RTF, ODT). Sending a lowercase value (e.g. "docx") is accepted
// as multipart but then fails parsing with 422 "Error occurred while parsing
// resume", so the canonical Bullhorn enum casing is used here.
const RESUME_FORMATS: Record<string, string> = {
  pdf: "PDF",
  doc: "DOC",
  docx: "DOCX",
  rtf: "RTF",
  txt: "TEXT",
  text: "TEXT",
  html: "HTML",
  htm: "HTML",
  odt: "ODT",
};

/** Infers Bullhorn's `format` value from a filename extension. */
function resumeFormatFromName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const fmt = RESUME_FORMATS[ext];
  if (!fmt) {
    throw new BullhornFieldValidationError(
      `Unsupported résumé file type ".${ext}". Supported: ${Object.keys(RESUME_FORMATS).join(", ")}.`,
    );
  }
  return fmt;
}

/**
 * Decodes a base64 file payload to bytes, tolerating a leading data-URI prefix
 * (e.g. `data:application/...;base64,XXXX`) that some clients (ChatGPT included)
 * prepend. Sending that prefix verbatim corrupts the decoded bytes and makes
 * Bullhorn reject/mis-parse the file, so it is stripped first. Throws a clear
 * validation error on empty/garbage input rather than handing Bullhorn an empty
 * upload.
 */
function decodeFileBase64(base64: string, label = "File"): Buffer {
  const stripped = base64.replace(/^data:[^;,]*;base64,/i, "").trim();
  const bytes = Buffer.from(stripped, "base64");
  if (bytes.length === 0) {
    throw new BullhornFieldValidationError(
      `${label} content is empty — provide base64-encoded file bytes.`,
    );
  }
  return bytes;
}

async function fileFetch(
  session: BullhornWriteSession,
  method: "PUT" | "POST",
  path: string,
  init: { body: FormData | Uint8Array; contentType?: string },
  rlRetries = RATE_LIMIT_RETRIES,
): Promise<unknown> {
  const url = new URL(path, session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);

  const headers: Record<string, string> = {};
  if (init.contentType) headers["Content-Type"] = init.contentType;

  const res = await fetch(url.toString(), { method, headers, body: init.body });

  if (res.status === 403) {
    const action = `${method} ${path.split("/").slice(0, 2).join("/")}`;
    throw new BullhornPermissionError(action);
  }
  if (res.status === 429) {
    if (rlRetries > 0) {
      const attempt = RATE_LIMIT_RETRIES - rlRetries + 1;
      await sleep(backoffMs(attempt));
      return fileFetch(session, method, path, init, rlRetries - 1);
    }
    throw new Error(
      "Bullhorn API rate limit exceeded after multiple retries. Wait 60 seconds and try again.",
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw formatBullhornError("file", res.status, text);
  }
  return res.json();
}

/**
 * Uploads a file (e.g. a résumé) and attaches it to an existing Bullhorn record
 * via the multipart Files API (PUT file/{Entity}/{id}). `fileContentBase64` is
 * the file bytes base64-encoded.
 */
export async function uploadFileToRecord(
  session: BullhornWriteSession,
  args: {
    entityType: string;
    entityId: number;
    fileName: string;
    fileContentBase64: string;
    contentType?: string;
    fileType?: string;
    description?: string;
  },
): Promise<{ fileId: number; entityType: string; entityId: number }> {
  const entry = resolveEntity(args.entityType);
  const bytes = decodeFileBase64(args.fileContentBase64, "File");
  const blob = new Blob([new Uint8Array(bytes)], {
    type: args.contentType ?? "application/octet-stream",
  });
  const form = new FormData();
  form.append("file", blob, args.fileName);

  const path = `file/${entry.canonical}/${args.entityId}`;
  const url = new URL(path, session.restUrl);
  url.searchParams.set("externalID", `asktoact-${Date.now()}`);
  url.searchParams.set("fileType", args.fileType ?? "SAMPLE");
  if (args.description) url.searchParams.set("description", args.description);

  // FormData sets its own multipart boundary; do NOT set Content-Type.
  const data = (await fileFetch(
    session,
    "PUT",
    `${path}${url.search}`,
    { body: form },
  )) as { fileId?: number };
  return { fileId: data.fileId ?? 0, entityType: entry.canonical, entityId: args.entityId };
}

/**
 * Creates a new Candidate from a résumé file. Parses the résumé with Bullhorn's
 * resume/parseToCandidate (does not persist), merges the parsed scalar fields
 * with any caller overrides, validates, creates the Candidate, then attaches the
 * original résumé file to the new record. `overrideFields` wins over parsed data.
 */
export async function createCandidateFromResume(
  session: BullhornWriteSession,
  args: {
    fileName: string;
    fileContentBase64: string;
    contentType?: string;
    overrideFields?: Record<string, unknown>;
  },
): Promise<{ candidateId: number; fileId?: number; parsedName?: string }> {
  const format = resumeFormatFromName(args.fileName);
  const bytes = decodeFileBase64(args.fileContentBase64, "Résumé");

  // 1. Parse (non-persisting). Returns { candidate, skillList, ... }.
  // Bullhorn's parseToCandidate endpoint requires multipart/form-data — sending
  // raw binary with application/octet-stream returns a 500 "Bad File Uploaded".
  const parseBlob = new Blob([new Uint8Array(bytes)], {
    type: args.contentType ?? "application/octet-stream",
  });
  const parseForm = new FormData();
  parseForm.append("resume", parseBlob, args.fileName);
  const parsed = (await fileFetch(
    session,
    "POST",
    `resume/parseToCandidate?format=${encodeURIComponent(format)}&populateDescription=text`,
    { body: parseForm },
  )) as { candidate?: Record<string, unknown> };

  const parsedCandidate = parsed.candidate ?? {};

  // 2. Take only safe scalar fields from the parse; overrides win.
  const PARSE_SCALAR_FIELDS = [
    "firstName",
    "lastName",
    "name",
    "email",
    "email2",
    "phone",
    "mobile",
    "occupation",
    "companyName",
    "description",
    "skillSet",
    "address",
  ];
  const fromParse: Record<string, unknown> = {};
  for (const key of PARSE_SCALAR_FIELDS) {
    if (parsedCandidate[key] !== undefined && parsedCandidate[key] !== null) {
      fromParse[key] = parsedCandidate[key];
    }
  }

  const body = compact({ ...fromParse, ...(args.overrideFields ?? {}) });
  if (!body.name && (body.firstName || body.lastName)) {
    body.name = `${body.firstName ?? ""} ${body.lastName ?? ""}`.trim();
  }

  await validateWriteFields("Candidate", body, { mode: "create" });
  const candidateId = await createEntityRecord(session, "Candidate", body);

  // 3. Attach the original résumé file to the new candidate (best-effort).
  let fileId: number | undefined;
  try {
    const uploaded = await uploadFileToRecord(session, {
      entityType: "Candidate",
      entityId: candidateId,
      fileName: args.fileName,
      fileContentBase64: args.fileContentBase64,
      contentType: args.contentType,
      fileType: "Resume",
      description: "Résumé (auto-attached on creation)",
    });
    fileId = uploaded.fileId;
  } catch (err) {
    logger.warn(
      { err, candidateId },
      "Bullhorn: candidate created but résumé file attachment failed",
    );
  }

  return {
    candidateId,
    fileId,
    parsedName: typeof body.name === "string" ? body.name : undefined,
  };
}
