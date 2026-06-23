import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  searchCandidates,
  searchJobs,
  searchCompanies,
  searchContacts,
  getCandidate,
  getJob,
  getCompany,
  getContact,
  listSubmissionsForJob,
  listPlacements,
  getNotes,
  searchAnyEntity,
  queryAnyEntity,
  getAnyEntity,
  countEntity,
  describeEntity,
  listSubmissionsForCandidate,
  listAppointments,
  listTasks,
  searchLeads,
  searchOpportunities,
  findUsers,
  listCandidateAttachments,
  readCandidateAttachment,
  getCandidateResume,
  addNote,
  updateCandidateStatus,
  createJobSubmission,
  bulkCreateSubmissions,
  BullhornPermissionError,
  listFieldOptions,
  SUPPORTED_ENTITIES,
} from "./bullhorn-client.js";
import { getUserSession } from "./bullhorn-auth.js";
import { sendSupportEmail } from "./emailService.js";
import type { CallerIdentity } from "../middlewares/bearer-auth.js";
import { trackSeatActivity, trackToolUsage } from "./seat-activity.js";
import { logger } from "./logger.js";
import { responseCache, stableKey } from "./cache.js";
import {
  staffingScorecard,
  placementsReport,
  openJobsReport,
  salesPipelineReport,
  jobAgingReport,
  recruiterLeaderboard,
  listReports,
} from "./reports.js";

// Serialize compactly (no pretty-print indentation). The consumer is an LLM, not
// a human, so whitespace is pure overhead — and multi-record reads are large
// enough that the ~30% saved by dropping indentation keeps responses under the
// ChatGPT/OpenAI client's tool-output size limit (oversized results are silently
// dropped by the client, which the assistant reports as "blocked by the safety
// layer"). To shrink further, callers should scope `fields` and/or page via `count`/`start`.
function formatResult(data: unknown): string {
  return JSON.stringify(data);
}

// Records-per-call cap for browse/list tools. Over-sized requests are quietly
// trimmed to this (never rejected) so any AI — including weaker models — never
// hits a hard error mid-answer. Internal/report callers bypass the MCP schema
// entirely, so their (larger) paging counts are unaffected.
const FETCH_CAP = 50;
function capFetch(v: number | undefined): number | undefined {
  return typeof v === "number" ? Math.min(v, FETCH_CAP) : v;
}

// When a browse/list page comes back with fewer records than the total pool,
// inject a `_truncatedNote` so the model never mistakes a partial page for a
// complete or ranked list. Two forms:
//   - AT HARD CAP (data.length === FETCH_CAP && total > cap): classic truncation
//     note telling the model to use count_entity for totals.
//   - PARTIAL SAMPLE (data.length < total, below cap): tells the model these are
//     a relevance-ranked sample, NOT the globally "top N", and that the rest of
//     the pool was not evaluated — suppresses superlative labelling ("top 5").
// Guard: keying on a `data` ARRAY excludes count-only and single-entity results;
// `data.length >= total` passes naturally-complete pages through without a note.
// Bullhorn /search and /query always return `total`, so this never false-negates.
function annotateIfTruncated(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.data)) return result;
  if (typeof r.total !== "number" || r.data.length >= r.total) return result;
  const atHardCap = r.data.length === FETCH_CAP;
  const note = atHardCap
    ? `Returned the per-call maximum of ${FETCH_CAP} records — this is a PARTIAL page, NOT a complete total (Bullhorn reports ${r.total} matches). For any count/total/by-department number use count_entity or a report tool; to read more records, call again with a higher 'start'.`
    : `Showing ${r.data.length} of ${r.total} total matches — this is a relevance-ranked SAMPLE, not the globally "top ${r.data.length}". The other ${r.total - (r.data as unknown[]).length} matching records were not returned and were NOT evaluated. Do NOT call these results "top N", "most qualified", or any superlative. To find the best fit, narrow your search criteria; use count_entity to size the full pool.`;
  return { ...r, _truncatedNote: note };
}

function withLogging<T>(
  toolName: string,
  params: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  logger.info({ tool: toolName, params: sanitizeParams(params) }, "MCP tool invoked");
  return fn().then(
    (result) => {
      logger.info(
        { tool: toolName, durationMs: Date.now() - start, statusCode: 200, status: "ok" },
        "MCP tool succeeded",
      );
      return result;
    },
    (err: unknown) => {
      const statusCode =
        err instanceof Error && err.message.includes("429") ? 429
        : err instanceof Error && err.message.includes("401") ? 401
        : 500;
      logger.error(
        { tool: toolName, durationMs: Date.now() - start, statusCode, status: "error", err },
        "MCP tool failed",
      );
      throw err;
    },
  );
}

/**
 * Runs a read tool with a short-TTL response cache layered over logging. The
 * cache key is the tool name plus a deterministic encoding of ALL arguments
 * (including `fields`), so two calls only share a cached result when they would
 * return identical data. Only successful results are cached; errors propagate
 * uncached so transient failures are not sticky.
 */
async function runTool(
  toolName: string,
  args: Record<string, unknown>,
  fn: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const key = `${toolName}:${stableKey(args)}`;
  const cached = responseCache.get(key);
  if (cached !== undefined) {
    logger.info({ tool: toolName, cache: "hit" }, "MCP tool cache hit");
    return { content: [{ type: "text", text: cached }] };
  }
  const result = annotateIfTruncated(await withLogging(toolName, args, fn));
  const text = formatResult(result);
  responseCache.set(key, text);
  return { content: [{ type: "text", text }] };
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;

function redactString(value: string): string {
  return value
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(PHONE_RE, "[PHONE]");
}

function sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") {
      const truncated = v.length > 500 ? v.slice(0, 500) + "…" : v;
      out[k] = redactString(truncated);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createMcpServer(caller?: CallerIdentity): McpServer {
  const server = new McpServer({
    name: "bullhorn-mcp",
    version: "1.0.0",
  });

  const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const tool = <Args extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: Args,
    cb: ToolCallback<Args>,
  ) => server["tool"](name, description, schema, READ_ONLY_ANNOTATIONS, cb);

  const WRITE_ANNOTATIONS: ToolAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
  const writeTool = <Args extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: Args,
    cb: ToolCallback<Args>,
  ) => server["tool"](name, description, schema, WRITE_ANNOTATIONS, cb);

  /**
   * Resolves the calling user's Bullhorn session for write operations.
   * Throws a plain-English error if the caller is not an enrolled user.
   */
  async function resolveWriteSession() {
    if (!caller || caller.kind !== "user") {
      throw new Error(
        "Write operations require a personal Bullhorn account. " +
          "Configure your AI connector with your personal API key (not the shared read-only token) " +
          "and complete enrollment at /api/auth/user/enroll?id=<your-user-id>. " +
          "Contact your administrator to set up your account.",
      );
    }
    return getUserSession(caller.userId);
  }

  /** Runs a write tool: logs, executes, returns result. Writes are never cached. */
  async function runWriteTool(
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    try {
      const result = await withLogging(toolName, args, fn);
      track(toolName, false);
      return { content: [{ type: "text", text: formatResult(result) }] };
    } catch (err) {
      if (err instanceof BullhornPermissionError) {
        track(toolName, true);
        return {
          content: [
            {
              type: "text",
              text: formatResult({
                error: "permission_denied",
                message: err.message,
              }),
            },
          ],
        };
      }
      track(toolName, true);
      throw err;
    }
  }

  /**
   * Fire-and-forget: increments this month's active-seat count for the caller
   * AND the per-tool usage aggregate (for accountability analytics).
   */
  function track(toolName: string, isError: boolean) {
    if (caller?.kind === "user") {
      trackSeatActivity(caller.userId).catch(() => {});
      trackToolUsage(caller.userId, toolName, isError).catch(() => {});
    }
  }

  /**
   * Read-tool runner with caller-aware usage tracking.
   * Replaces the module-level `runTool` for all calls inside createMcpServer
   * so the caller identity (captured in closure) is available for billing.
   */
  function rt(
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<unknown>,
  ) {
    return runTool(toolName, args, fn).then(
      (result) => {
        track(toolName, false);
        return result;
      },
      (err) => {
        track(toolName, true);
        throw err;
      },
    );
  }

  tool(
    "search_candidates",
    "Search for candidates in Bullhorn ATS. PREFERRED for any skills/résumé/clearance text search: use the `keywords` argument — the server then searches ALL of a candidate's searchable text fields at once (`description` = full parsed RÉSUMÉ text, `skillSet` = skills list, `comments` = recruiter notes, `occupation` = title) so you can never miss a field, and it safely handles quoting/escaping. Each `keywords` entry is a REQUIRED concept (AND-ed); a plain string is one phrase and an inner array is a synonym/OR group — e.g. `keywords=[[\"Top Secret\",\"TS/SCI\",\"security clearance\"]]` (any of those) or `keywords=[\"Java\",\"AWS\"]` (both required). Use the `query` argument for STRUCTURED filters only (status, willRelocate, desiredLocations, dates); `keywords` and `query` are AND-ed together. If you instead hand-write free text into `query`, you must field-qualify every term across all text fields yourself (bare keywords are rejected by Bullhorn), e.g. `(skillSet:Kubernetes OR description:Kubernetes OR comments:Kubernetes OR occupation:Kubernetes)`. Combine must-have criteria with AND, use OR within a criterion for recall, quote multi-word terms to keep them together (e.g. `skillSet:\"Spring Boot\"`; Bullhorn matching is relevance-ranked, not strict exact-phrase, so confirm the top hits on the shortlist), and field-qualify EVERY term — bare keywords are rejected by Bullhorn. Results are relevance-ranked. Years-of-experience and skill recency are NOT reliable as query filters (the structured `experience` field is usually empty) — to judge those, open the shortlist with get_candidate (work history with dates) and get_candidate_resume (full résumé text). IMPORTANT — search the résumé via the QUERY (e.g. `description:Kubernetes`), but do NOT add `description` to the returned `fields`: in search results résumé text is truncated to a short preview to keep responses small, and pulling full résumés for many candidates at once makes the client drop the whole result. To CONFIRM a clearance phrase or skill on your shortlist, call get_candidate_resume with `highlight=[...the terms you're checking...]` — it returns just the short quote(s) where each term appears (smaller, and less likely to be withheld by the client) plus which terms were/weren't found. To read a candidate's FULL résumé, call get_candidate_resume WITHOUT `highlight` on your shortlist (~5 candidates). STATUS NOTE — to find 'active' / current / workable candidates, do NOT filter on `status:\"Active\"`: in this Bullhorn the workable pool is dominated by 'Online Applicant' and 'New Lead', with 'Active' only a minority and 'Archive' the main inactive bucket observed. Express 'active' as `AND NOT status:Archive` (keeps the full workable pool); only restrict to a specific status like `status:Active` when the user explicitly asks for that exact status. For stronger asks like 'available' / 'contactable' / 'submit-ready', do NOT assume every non-archived candidate is actionable — verify on your shortlist using recent placements (list_placements), submissions (list_submissions_for_candidate), and notes (get_notes). Returns key fields including `skillSet`; each record includes a `bullhornUrl` deep link — render the candidate's name as that link.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Raw Lucene for STRUCTURED filters (status, willRelocate, desiredLocations, dates), e.g. 'willRelocate:true AND NOT status:Archive'. Field-qualify every term — bare keywords are rejected by Bullhorn. For free-text skills/résumé/clearance search, prefer the `keywords` argument (it searches all text fields for you). For 'active'/workable candidates exclude archived records with `AND NOT status:Archive` rather than `status:\"Active\"` (most workable candidates here are 'Online Applicant'/'New Lead', not 'Active'). Optional if `keywords` is provided.",
        ),
      keywords: z
        .array(z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe(
          "Preferred way to search a candidate's résumé/skills/notes text. For every term the server searches `description` (parsed résumé), `skillSet`, `comments`, and `occupation`, so you never miss a field. Each entry is a REQUIRED concept (AND-ed); a plain string is one phrase, an inner array is a synonym group (OR-ed). Multi-word terms are matched as phrases. Examples: `[[\"Top Secret\",\"TS/SCI\"]]` (any of these), `[\"Java\",\"AWS\"]` (both required), `[[\"Reliability Status\",\"Enhanced Reliability\",\"Secret clearance\"]]`. Combine with `query` for structured filters (AND-ed). Optional if `query` is provided.",
        ),
      count: z
        .number()
        .int()
        .min(1)
        .optional()
        .transform(capFetch)
        .describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Offset for pagination (default: 0)"),
      fields: z
        .string()
        .optional()
        .describe(
          "Comma-separated list of fields to return (uses sensible defaults if omitted). Candidate location is nested in the `address` field (already in defaults) — do NOT request `city` or `state` as standalone fields (they are invalid for Candidate and will error). To filter by location, use the `query` argument instead (e.g., `address.city:Ottawa` or `address.state:Illinois`). Do NOT include `description` here — in search results résumé text is returned only as a short preview, and requesting full résumés for many candidates makes the client drop the result; use get_candidate_resume for a candidate's full résumé text.",
        ),
    },
    async ({ query, keywords, count, start, fields }) =>
      rt("search_candidates", { query, keywords, count, start, fields }, () =>
        searchCandidates({ query, keywords, count, start, fields }),
      ),
  );

  tool(
    "search_jobs",
    "Search for job orders in Bullhorn ATS using a Lucene query. Returns matching job records, each with a `bullhornUrl` deep link to open the job in Bullhorn. IMPORTANT: in this instance each job's \"Internal Department\" (the owning office/branch, e.g. \"MYT-Ottawa\" or \"MYT-Chicago\") is stored in the field `correlatedCustomText1`, which is populated on virtually all jobs — use that field (NOT `categories`, which is mostly empty) to group, filter, or report jobs by internal department. You can filter on it directly, e.g. query `isOpen:true AND correlatedCustomText1:\"MYT-Ottawa\"`. IMPORTANT — do NOT use this tool to COUNT or TOTAL jobs (e.g. \"how many open jobs\", \"open jobs by department\"): fetching records here caps at a few hundred and silently UNDERCOUNTS, and large result pages can be dropped by the client. For ANY count / total / by-department number, use the `count_entity` tool instead — it returns exact totals from Bullhorn in a tiny payload (set groupBy:`correlatedCustomText1` for a per-department breakdown). CONVENTION for this instance: \"open jobs\" means EXACTLY `isOpen:true AND NOT status:Archive AND isDeleted:false` (this still INCLUDES on-hold, filled, and placed roles — only Archived AND soft-deleted records are excluded); do NOT add extra status exclusions (Filled/Placed/Lost/Canceled/Declined/etc.) unless the user explicitly asks. Status values are exact-spelling and case-sensitive (this data uses `Canceled` with ONE l, and `Archive`, NOT \"Cancelled\"/\"Archived\"); a misspelled status is silently ignored rather than erroring, so when unsure, discover the valid values with count_entity grouped by `status`. CRITICAL — a job's office / branch / location / region is the Internal Department field `correlatedCustomText1` ONLY: do NOT infer office from the job's OWNER or houseOwner (this instance has owner/user accounts NAMED after offices, e.g. \"MYT-Ottawa House\", that are NOT the office field and will badly undercount — e.g. returning 1 job instead of the true 99), and ignore the empty `branch`/`address`/`categories` fields. For ANY open-jobs-by-office count use count_entity with groupBy:`correlatedCustomText1`, or the open_jobs_report / job_aging_report tools. Likewise NEVER rank, pick a superlative (most/fewest/largest/oldest/top/worst), or name a by-office winner from a returned record page — a page is a truncated sample and will mislead; use count_entity or the report tools for any ranking or superlative.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string, e.g. 'isOpen:true AND title:\"Software Engineer\"'. NOTE: this instance has NO JobOrder status literally named \"Open\" (real statuses include \"Accepting Candidates\", \"Hold - Client Hold\", \"Filled\"); for open jobs use the boolean flag 'isOpen:true', NOT 'status:Open' (which always returns 0).",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 job records per call — NOT a total). Do NOT use to count/total/aggregate jobs — use count_entity (set groupBy:correlatedCustomText1 for a per-department breakdown) or the open_jobs report tool, which return exact totals in a tiny payload. Page with 'start' for more records."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      rt("search_jobs", { query, count, start, fields }, () =>
        searchJobs({ query, count, start, fields }),
      ),
  );

  tool(
    "search_companies",
    "Search for client companies (ClientCorporation) in Bullhorn ATS using a Lucene query. For any 'how many companies' total or by-group breakdown use count_entity — do NOT count or rank from a returned record page (it is a truncated sample). Each record includes a `bullhornUrl` deep link to open the company directly in Bullhorn.",
    {
      query: z
        .string()
        .describe("Lucene query string, e.g. 'name:\"Acme*\"' or 'status:Active'"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      rt("search_companies", { query, count, start, fields }, () =>
        searchCompanies({ query, count, start, fields }),
      ),
  );

  tool(
    "search_contacts",
    "Search for client contacts (ClientContact) in Bullhorn ATS using a Lucene query. This instance stores each contact's \"Internal Department\" (owning office/branch, e.g. \"MYT-Ottawa\") in field customText1 — use it to filter/group contacts by department. For any 'how many contacts' total or by-group breakdown use count_entity — do NOT count or rank from a returned record page (it is a truncated sample). Each record includes a `bullhornUrl` deep link to open the contact directly in Bullhorn.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string, e.g. 'lastName:\"Smith\" AND status:Active'",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      rt("search_contacts", { query, count, start, fields }, () =>
        searchContacts({ query, count, start, fields }),
      ),
  );

  tool(
    "get_candidate",
    "Fetch the full record for a specific candidate by their Bullhorn ID, including skills (`skillSet`, primary/secondary skills), work history with dates, and education — useful for judging years of experience and skill recency. For the candidate's full parsed RÉSUMÉ text, use get_candidate_resume (SSN-redacted and length-capped). The record includes a `bullhornUrl` deep link to open the candidate directly in Bullhorn.",
    {
      id: z.number().int().positive().describe("Bullhorn candidate ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) =>
      rt("get_candidate", { id, fields }, () =>
        getCandidate({ id, fields }),
      ),
  );

  tool(
    "get_job",
    "Fetch the full record for a specific job order by its Bullhorn ID. The record includes a `bullhornUrl` deep link to open the job directly in Bullhorn.",
    {
      id: z.number().int().positive().describe("Bullhorn job order ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) =>
      rt("get_job", { id, fields }, () =>
        getJob({ id, fields }),
      ),
  );

  tool(
    "get_company",
    "Fetch the full record for a specific client company by its Bullhorn ID. The record includes a `bullhornUrl` deep link to open the company directly in Bullhorn.",
    {
      id: z.number().int().positive().describe("Bullhorn client corporation ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) =>
      rt("get_company", { id, fields }, () =>
        getCompany({ id, fields }),
      ),
  );

  tool(
    "get_contact",
    "Fetch the full record for a specific client contact by their Bullhorn ID. The record includes a `bullhornUrl` deep link to open the contact directly in Bullhorn.",
    {
      id: z.number().int().positive().describe("Bullhorn client contact ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) =>
      rt("get_contact", { id, fields }, () =>
        getContact({ id, fields }),
      ),
  );

  tool(
    "list_submissions_for_job",
    "List candidate submissions (applications) for a specific job order, optionally restricted to a dateAdded range. Results are in `data`; `count` is how many were returned. If `count` equals your requested limit there may be more — raise `count` (max 50) or page with `start`.",
    {
      jobId: z.number().int().positive().describe("Bullhorn job order ID"),
      dateAddedStart: z
        .string()
        .optional()
        .describe(
          "Only include submissions added on/after this date (inclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC. E.g. '2026-05-01'.",
        ),
      dateAddedEnd: z
        .string()
        .optional()
        .describe(
          "Only include submissions added before this date (exclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC. E.g. '2026-06-01' covers all of May.",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 50; the server returns AT MOST 50 per call — NOT a total). For ANY count/total/by-group number use count_entity or the report tools; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ jobId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      rt(
        "list_submissions_for_job",
        { jobId, dateAddedStart, dateAddedEnd, count, start, fields },
        () =>
          listSubmissionsForJob({ jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      ),
  );

  tool(
    "list_placements",
    "List placements, optionally filtered by candidate ID, job order ID, and/or a dateAdded range. This instance stores each placement's \"Internal Department\" (office/branch) in field correlatedCustomText1. To answer time-scoped questions (e.g. 'placements added in May 2026'), pass dateAddedStart/dateAddedEnd; this tool is for viewing specific records only (page with `start` if needed). Results are in `data`; `count` is how many were returned. If `count` equals your requested limit there may be more — raise `count` (max 50) or page with `start`. To COUNT/total placements (e.g. 'how many placements in 2026', 'placements by department'), do NOT add them up from this list — use `count_entity` for an exact, fast total. CONVENTION for this instance: \"placements made\" / \"placements so far\" means CONFIRMED placements only — filter `status:Approved OR status:Completed OR status:Ended` (i.e. exclude Canceled, Archive, AND pending Submitted) unless the user explicitly asks for all/pending/canceled placements. Do NOT rank offices/recruiters or pick a 'most/fewest/top' from this record page — it is a truncated sample; use count_entity or the report tools (placements_report, recruiter_leaderboard) for any total, ranking, or by-group breakdown.",
    {
      candidateId: z.number().int().positive().optional().describe("Filter by candidate Bullhorn ID"),
      jobId: z.number().int().positive().optional().describe("Filter by job order Bullhorn ID"),
      dateAddedStart: z
        .string()
        .optional()
        .describe(
          "Only include placements added on/after this date (inclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC. E.g. '2026-05-01'.",
        ),
      dateAddedEnd: z
        .string()
        .optional()
        .describe(
          "Only include placements added before this date (exclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC. E.g. '2026-06-01' covers all of May.",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 50; the server returns AT MOST 50 per call — NOT a total). For ANY count/total/by-group number use count_entity or the report tools; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      rt(
        "list_placements",
        { candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields },
        () =>
          listPlacements({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      ),
  );

  tool(
    "get_notes",
    "Retrieve notes and activity log entries for a candidate or job order, optionally within a dateAdded range. Provide at least one of candidateId or jobId. Results are in `data`; `total` is the full match count. Raise `count` (max 50) or page with `start` for more.",
    {
      candidateId: z.number().int().positive().optional().describe("Bullhorn candidate ID"),
      jobId: z.number().int().positive().optional().describe("Bullhorn job order ID"),
      dateAddedStart: z
        .string()
        .optional()
        .describe(
          "Only include notes added on/after this date (inclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      dateAddedEnd: z
        .string()
        .optional()
        .describe(
          "Only include notes added before this date (exclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 50; the server returns AT MOST 50 per call — NOT a total). For ANY count/total/by-group number use count_entity or the report tools; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      rt(
        "get_notes",
        { candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields },
        () =>
          getNotes({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      ),
  );

  // -------------------------------------------------------------------------
  // Generic read-any-entity tools (flexible fallbacks for full read coverage)
  // -------------------------------------------------------------------------

  const entitiesList = SUPPORTED_ENTITIES.join(", ");
  const entityTypeDescribe = `Bullhorn entity type. Supported: ${entitiesList}. Common aliases like 'company', 'job', 'user', 'recruiter' are also accepted.`;

  tool(
    "search_entity",
    `Full-text search (Lucene) over ANY indexed Bullhorn entity — a flexible fallback for read coverage when no dedicated tool fits. Prefer the dedicated tools (search_candidates, search_jobs, search_companies, search_contacts) when they apply. Searchable entities: Candidate, ClientContact, ClientCorporation, JobOrder, JobSubmission, Placement, Note, Lead, Opportunity. For query-only entities (Appointment, Task, CorporateUser, Sendout, Tearsheet) use query_entity instead. Use describe_entity to discover valid field names — its \`configuredCustomFields\` lists this instance's custom fields with their human labels (label -> API field). This instance's "Internal Department" (office/branch, e.g. "MYT-Ottawa") is a custom field whose API name varies by entity: JobOrder & Placement use \`correlatedCustomText1\`; ClientContact, Lead & Opportunity use \`customText1\`; Candidate uses \`customText3\`. The \`categories\` field is mostly empty, so never group by it. Do NOT rank, pick a superlative (most/fewest/top/largest/oldest), or draw a by-group/by-office conclusion from a returned record page — it is a truncated sample; use count_entity or a report tool for any ranking, total, or by-group breakdown. For Candidate, ClientContact, ClientCorporation, JobOrder, Lead, and Opportunity, each returned record includes a \`bullhornUrl\` deep link to open it directly in Bullhorn.`,
    {
      entityType: z.string().describe(entityTypeDescribe),
      query: z
        .string()
        .describe("Lucene query string, e.g. 'status:Active AND city:\"Chicago\"'"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return (sensible defaults if omitted)"),
    },
    async ({ entityType, query, count, start, fields }) =>
      rt(
        "search_entity",
        { entityType, query, count, start, fields },
        () => searchAnyEntity({ entityType, query, count, start, fields }),
      ),
  );

  tool(
    "query_entity",
    `Structured query (SQL-like 'where') over ANY query-capable Bullhorn entity, returning a PAGE of records (NOT a total). For "how many" / totals / by-department breakdowns use count_entity instead — do NOT fetch records here and count them yourself (this page caps out and will undercount). Use this for query-only entities (Appointment, Task, CorporateUser, Sendout, Tearsheet) and for precise field equality/range filters on any query-capable entity. The Note entity is search-only — use search_entity for it. Bullhorn stores dates as epoch milliseconds, so date filters use numeric comparisons, e.g. where: "status='Placed' AND dateAdded >= 1746057600000". Use describe_entity first to discover valid field names — its \`configuredCustomFields\` maps this instance's custom-field labels to API names (e.g. "Internal Department" = \`correlatedCustomText1\` on Placement, \`customText1\` on ClientContact/Lead/Opportunity). 'orderBy' is optional (e.g. '-dateAdded' for newest first). For Candidate, ClientContact, ClientCorporation, JobOrder, Lead, and Opportunity, each returned record includes a \`bullhornUrl\` deep link to open it directly in Bullhorn. The server enforces the SAME locked operational universe here as on count_entity: JobOrder/Opportunity exclude soft-deleted records (and isOpen=true also excludes Archived / Closed-Won/Closed-Lost/Converted) and Placement defaults to confirmed-only (Approved/Completed/Ended); when the where is adjusted, the response carries an \`appliedDefinition\` note. Pass an explicit status / isDeleted filter to override. Do NOT rank, pick a superlative (most/fewest/top/largest/oldest), or draw a by-group/by-office conclusion from this record page — it is a truncated sample; use count_entity or a report tool for any ranking, total, or by-group breakdown.`,
    {
      entityType: z.string().describe(entityTypeDescribe),
      where: z
        .string()
        .describe(
          "SQL-like where clause, e.g. \"candidate.id=123\" or \"status='Open' AND dateAdded >= 1746057600000\"",
        ),
      orderBy: z
        .string()
        .optional()
        .describe("Optional sort field, e.g. '-dateAdded' (descending) or 'lastName'"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return (sensible defaults if omitted)"),
    },
    async ({ entityType, where, orderBy, count, start, fields }) =>
      rt(
        "query_entity",
        { entityType, where, orderBy, count, start, fields },
        () => queryAnyEntity({ entityType, where, orderBy, count, start, fields }),
      ),
  );

  tool(
    "count_entity",
    `Count Bullhorn records for a Lucene query WITHOUT returning the records — and optionally break the count down by a field. USE THIS for "how many" and scorecard / by-department questions instead of fetching records and counting them yourself: record lists cap at 100-500 and will undercount (e.g. report "51+" instead of the true total). Returns exact totals straight from Bullhorn in a tiny payload. Set \`groupBy\` to a field to get a per-value breakdown; for EXACT grouping also pass the known values in \`groupValues\` (e.g. the Internal Department names) — without them, values are auto-discovered from a sample and may be incomplete (groupsComplete:false). "Internal Department" field by entity: JobOrder & Placement = \`correlatedCustomText1\`; Opportunity, ClientContact & Lead = \`customText1\`; Candidate = \`customText3\`. For JobOrder, "open jobs" means EXACTLY \`isOpen:true AND NOT status:Archive AND isDeleted:false\` (the open flag still includes on-hold/filled/placed; Archived AND soft-deleted records are excluded) — do NOT add extra status exclusions (Filled/Placed/Lost/Canceled/Declined/etc.) unless the user explicitly asks. For Placement, "placements made" / "placements so far" means CONFIRMED placements only — count \`(status:Approved OR status:Completed OR status:Ended)\` (i.e. exclude Canceled, Archive, AND pending Submitted) unless the user explicitly asks for all/pending/canceled placements; do NOT add \`isDeleted:false\` to Placement queries — that field is not searchable on Placement and returns 0 (Placement search already excludes soft-deleted). TIME-SCOPING: a bare confirmed-placement count is ALL-TIME; for "this year" / YTD / any period you MUST add a dateAdded range (e.g. \`dateAdded:[<startEpochMs> TO <nowEpochMs>]\`) or use the placements_report tool (which defaults to YTD) — never report the all-time number for a time-scoped question. For Opportunity, "active" / "open" / "in the pipeline" opportunities means EXACTLY \`isOpen:true\` — the server then applies the official exclusion of Closed-Won/Closed-Lost/Converted AND soft-deleted records (isDeleted:false); do NOT approximate "active" by enumerating a subset of statuses (e.g. \`status:Open OR status:Qualifying\`), which UNDERCOUNTS (it drops Qualified/New) — use \`isOpen:true\`, the sales_pipeline_report, or the staffing_scorecard. Status spellings are exact and case-sensitive (\`Canceled\` one l, \`Archive\` not "Archived"); a wrong spelling is silently ignored, so groupBy \`status\` to discover the valid values. Searchable entities only: Candidate, ClientContact, ClientCorporation, JobOrder, JobSubmission, Placement, Lead, Opportunity, Note.`,
    {
      entityType: z.string().describe(entityTypeDescribe),
      query: z
        .string()
        .optional()
        .describe(
          "Lucene query to count (default: all records). E.g. 'isOpen:true AND NOT status:Archive'",
        ),
      groupBy: z
        .string()
        .optional()
        .describe(
          "Optional field to break the count down by, e.g. 'correlatedCustomText1' (Internal Department).",
        ),
      groupValues: z
        .array(z.string())
        .optional()
        .describe(
          "Optional explicit list of groupBy values for EXACT per-group counts (recommended over auto-discovery). Max 50.",
        ),
    },
    async ({ entityType, query, groupBy, groupValues }) =>
      rt(
        "count_entity",
        { entityType, query, groupBy, groupValues },
        () => countEntity({ entityType, query, groupBy, groupValues }),
      ),
  );

  tool(
    "get_entity",
    "Fetch a single record of ANY supported Bullhorn entity by its ID. Use the dedicated get_candidate/get_job/get_company/get_contact tools when they apply. For Candidate, ClientContact, ClientCorporation, JobOrder, Lead, and Opportunity, the record includes a `bullhornUrl` deep link to open it directly in Bullhorn.",
    {
      entityType: z.string().describe(entityTypeDescribe),
      id: z.number().int().positive().describe("Bullhorn record ID"),
      fields: z.string().optional().describe("Comma-separated fields to return (sensible defaults if omitted)"),
    },
    async ({ entityType, id, fields }) =>
      rt("get_entity", { entityType, id, fields }, () =>
        getAnyEntity({ entityType, id, fields }),
      ),
  );

  tool(
    "describe_entity",
    "List the available fields (name + type) for a Bullhorn entity. The response also includes `configuredCustomFields`: this instance's admin-configured custom fields with their human-readable labels (e.g. \"Internal Department\" -> correlatedCustomText1/customText1), so you can map a label you see in Bullhorn to the real API field name. Use this to discover valid field names before building a query_entity 'where' clause or requesting specific fields.",
    {
      entityType: z.string().describe(entityTypeDescribe),
    },
    async ({ entityType }) =>
      rt("describe_entity", { entityType }, () =>
        describeEntity({ entityType }),
      ),
  );

  tool(
    "list_field_options",
    "Returns the EXACT valid dropdown values configured in THIS Bullhorn instance for picklist fields (e.g. Note action types, Candidate status, JobSubmission status). " +
      "ALWAYS call this before any write tool that sets a picklist field — the AI must never guess or invent values. " +
      "If the user gives a value that is not in the returned list, show them the real options and ask them to choose. " +
      "When `fieldName` is provided, returns only that field's options. When omitted, returns ALL picklist fields on the entity so you can present a full menu in one call. " +
      "Common uses: list_field_options(Note, action) before add_note; list_field_options(Candidate, status) before update_candidate_status; list_field_options(JobSubmission, status) before create_job_submission.",
    {
      entityType: z.string().describe(
        "The Bullhorn entity to inspect. Common values: Note, Candidate, JobOrder, JobSubmission, Placement, ClientContact, ClientCorporation, Lead, Opportunity.",
      ),
      fieldName: z.string().optional().describe(
        "Optional: the specific field to get options for (e.g. 'action', 'status'). If omitted, all picklist fields on the entity are returned.",
      ),
    },
    async ({ entityType, fieldName }) =>
      rt("list_field_options", { entityType, fieldName }, () =>
        listFieldOptions({ entityType, fieldName }),
      ),
  );

  // -------------------------------------------------------------------------
  // Curated high-value read tools
  // -------------------------------------------------------------------------

  tool(
    "list_submissions_for_candidate",
    "List the job submissions (applications) for a specific candidate — i.e. which jobs a candidate has been submitted to — optionally within a dateAdded range. Results are in `data`; `count` is how many were returned. If `count` equals your requested limit there may be more — raise `count` (max 50) or page with `start`.",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID"),
      dateAddedStart: z
        .string()
        .optional()
        .describe(
          "Only include submissions added on/after this date (inclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      dateAddedEnd: z
        .string()
        .optional()
        .describe(
          "Only include submissions added before this date (exclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 50; the server returns AT MOST 50 per call — NOT a total). For ANY count/total/by-group number use count_entity or the report tools; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ candidateId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      rt(
        "list_submissions_for_candidate",
        { candidateId, dateAddedStart, dateAddedEnd, count, start, fields },
        () =>
          listSubmissionsForCandidate({
            candidateId,
            dateAddedStart,
            dateAddedEnd,
            count,
            start,
            fields,
          }),
      ),
  );

  tool(
    "list_appointments",
    "List appointments/meetings, optionally for a specific owner (recruiter) and/or within a scheduled-time window (filters on the appointment's dateBegin). Use find_users to resolve a recruiter name to an ownerId. Results are in `data`; raise `count` (max 50) or page with `start` for more.",
    {
      ownerId: z.number().int().positive().optional().describe("Filter to appointments owned by this Bullhorn user ID"),
      startAfter: z
        .string()
        .optional()
        .describe(
          "Only include appointments starting on/after this date (inclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      startBefore: z
        .string()
        .optional()
        .describe(
          "Only include appointments starting before this date (exclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 50; the server returns AT MOST 50 per call — NOT a total). For ANY count/total/by-group number use count_entity or the report tools; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ ownerId, startAfter, startBefore, count, start, fields }) =>
      rt(
        "list_appointments",
        { ownerId, startAfter, startBefore, count, start, fields },
        () => listAppointments({ ownerId, startAfter, startBefore, count, start, fields }),
      ),
  );

  tool(
    "list_tasks",
    "List tasks, optionally for a specific owner (recruiter), filtered by a scheduled-date window (filters on the task's dateBegin) and/or completion status. Use find_users to resolve a recruiter name to an ownerId. Results are in `data`; raise `count` (max 50) or page with `start` for more.",
    {
      ownerId: z.number().int().positive().optional().describe("Filter to tasks owned by this Bullhorn user ID"),
      dueStart: z
        .string()
        .optional()
        .describe(
          "Only include tasks scheduled (dateBegin) on/after this date (inclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      dueEnd: z
        .string()
        .optional()
        .describe(
          "Only include tasks scheduled (dateBegin) before this date (exclusive). Accepts 'YYYY-MM-DD' or an ISO 8601 timestamp, interpreted as UTC.",
        ),
      isCompleted: z.boolean().optional().describe("Filter by completion status (true = completed, false = open)"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 50; the server returns AT MOST 50 per call — NOT a total). For ANY count/total/by-group number use count_entity or the report tools; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ ownerId, dueStart, dueEnd, isCompleted, count, start, fields }) =>
      rt(
        "list_tasks",
        { ownerId, dueStart, dueEnd, isCompleted, count, start, fields },
        () => listTasks({ ownerId, dueStart, dueEnd, isCompleted, count, start, fields }),
      ),
  );

  tool(
    "search_leads",
    "Search Bullhorn CRM leads (sales prospects) with a Lucene query. This instance stores each lead's \"Internal Department\" (office/branch) in field customText1. Each record includes a `bullhornUrl` deep link to open the lead directly in Bullhorn. For any 'how many leads' total or by-group breakdown use count_entity — do NOT count or rank from a returned record page (it is a truncated sample). Note: requires Lead & Opportunity tracking to be enabled in the Bullhorn instance; if it is not, this will return a Bullhorn error.",
    {
      query: z.string().describe("Lucene query string, e.g. 'status:Active AND companyName:\"Acme*\"'"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      rt("search_leads", { query, count, start, fields }, () =>
        searchLeads({ query, count, start, fields }),
      ),
  );

  tool(
    "search_opportunities",
    "Search Bullhorn CRM opportunities (sales deals) with a Lucene query. This instance stores each opportunity's \"Internal Department\" (office/branch) in field customText1. Each record includes a `bullhornUrl` deep link to open the opportunity directly in Bullhorn. To COUNT/total opportunities — including \"how many active / open / in-the-pipeline opportunities\" — do NOT tally records from this list; use count_entity with `isOpen:true` (the server applies the official active exclusion of Closed-Won/Closed-Lost/Converted AND soft-deleted records) or the sales_pipeline_report tool. Do NOT rank offices/stages or pick a 'most/top/largest' from a returned record page — it is a truncated sample; use count_entity or the sales_pipeline_report for any ranking, total, or by-group breakdown. Note: requires Lead & Opportunity tracking to be enabled in the Bullhorn instance; if it is not, this will return a Bullhorn error.",
    {
      query: z.string().describe("Lucene query string, e.g. 'status:Open AND title:\"Managed Services\"'"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      rt("search_opportunities", { query, count, start, fields }, () =>
        searchOpportunities({ query, count, start, fields }),
      ),
  );

  tool(
    "find_users",
    "Find internal Bullhorn users (recruiters / CorporateUser) by name and/or email — useful for resolving a recruiter to their user ID for ownerId filters on other tools. Omit all filters to list users.",
    {
      name: z.string().optional().describe("Partial first/last/full name to match"),
      email: z.string().optional().describe("Partial email to match"),
      count: z.number().int().min(1).optional().transform(capFetch).describe("Records to return per call (default: 20; the server returns AT MOST 50 per call — NOT a total). For ANY count/total use count_entity; page with 'start' for more."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ name, email, count, start, fields }) =>
      rt("find_users", { name, email, count, start, fields }, () =>
        findUsers({ name, email, count, start, fields }),
      ),
  );

  // -------------------------------------------------------------------------
  // Résumé & attachment reading (Bullhorn Files API — strictly read-only)
  // -------------------------------------------------------------------------

  tool(
    "list_candidate_attachments",
    "List the file attachments (résumés, cover letters, etc.) on a candidate's record. Returns metadata only — file id, name, document type (e.g. 'Resume'), content type, and dateAdded — not the file contents. Use read_candidate_attachment with a returned file id to read a specific attachment's text, or get_candidate_resume to jump straight to the résumé.",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID"),
    },
    async ({ candidateId }) =>
      rt("list_candidate_attachments", { candidateId }, () =>
        listCandidateAttachments({ candidateId }),
      ),
  );

  tool(
    "read_candidate_attachment",
    "Read the text of one candidate attachment by candidate ID + file id (get the file id from list_candidate_attachments). Returns extracted text for: plain text, HTML, RTF, PDF (server-side extraction via pdf-parse), and Word .docx (server-side extraction via mammoth). Other binary formats (images, legacy .doc, etc.) return metadata and a clear explanation instead of fabricated text. Returned text is SSN-redacted and length-capped (raise `maxChars` up to 100000 for long documents).",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID"),
      fileId: z.number().int().positive().describe("Attachment file id (from list_candidate_attachments)"),
      maxChars: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe("Maximum characters of text to return (default: 20000, max: 100000)"),
    },
    async ({ candidateId, fileId, maxChars }) =>
      rt("read_candidate_attachment", { candidateId, fileId, maxChars }, () =>
        readCandidateAttachment({ candidateId, fileId, maxChars }),
      ),
  );

  tool(
    "get_candidate_resume",
    "Read a candidate's résumé in one call, in either of TWO modes. (1) VERIFY mode — PREFERRED for confirming a specific clearance phrase, skill, or keyword on your shortlist: pass `highlight` with the terms you are verifying (e.g. `highlight=[\"Secret clearance\",\"Federal Government Secret\",\"Java\"]`). The tool then returns only the short QUOTE(S) around each match in `excerpts` (each entry is `{ terms, quote }`, and one quote may cover several terms), plus `matchedTerms` (confirmed present WITH a quote), `foundButNotQuoted` (present but the quote was trimmed by size caps), and `termsNotFound` (absent) so you can see at a glance which terms actually appear in the résumé. This keeps the result small and low on personal data, which makes the client far less likely to withhold it, and it hands you the exact 'quote where it appears' to cite. (2) FULL mode — omit `highlight` to get the complete résumé text in `resumeText` (length-capped; raise `maxChars` up to 100000 for long résumés). In both modes `resumeTextSource` indicates whether text came from a résumé file attachment or the parsed text on the candidate record, and `resumeAttachment` + the full attachment list are included. PDF and Word (.docx) attachments are now extracted server-side — the tool attempts to read them directly and returns the extracted text. If extraction fails or the file is an unsupported binary (images, legacy .doc, etc.), the tool falls back to the parsed record text on the candidate record (`candidate.description`); if neither is available it returns the attachment metadata with guidance to open in Bullhorn. Text is SSN-redacted.",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID"),
      highlight: z
        .array(z.string())
        .optional()
        .describe(
          "VERIFY mode: terms/phrases to find in the résumé. Returns only short quotes around each match (much smaller and less likely to be withheld by the client) instead of the full text. Quote a multi-word phrase as one string, e.g. [\"Secret clearance\",\"Java\"]. Omit to get the full résumé text.",
        ),
      maxChars: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe("FULL mode only: maximum characters of text to return per source (default: 20000, max: 100000)"),
    },
    async ({ candidateId, maxChars, highlight }) =>
      rt("get_candidate_resume", { candidateId, maxChars, highlight }, () =>
        getCandidateResume({ candidateId, maxChars, highlight }),
      ),
  );

  // -------------------------------------------------------------------------
  // Report library — pre-built, server-computed analytics. Each report runs its
  // Bullhorn queries in parallel and returns ONE compact table + summary, so the
  // AI answers common scorecard-style asks in a single fast call. The ad-hoc
  // tools above remain for anything not covered here.
  // -------------------------------------------------------------------------

  tool(
    "list_reports",
    "List the pre-built REPORTS available in this connector (the report 'library'): their names, what each shows, and parameters. Call this when the user asks 'what reports can you run?' / 'what can you show me?' or to pick a canned analytics report. Each report is a single fast call that returns a finished table. For anything not in the library, use the ad-hoc tools (count_entity, search_*).",
    {},
    async () => rt("list_reports", {}, async () => listReports()),
  );

  tool(
    "staffing_scorecard",
    "PRE-BUILT REPORT (one fast call). Department staffing scorecard for a year: confirmed placements split by Contract / Contract-to-Hire / Direct Hire, currently open jobs, active sales opportunities, and a demand-vs-delivery ratio per department — plus totals and an 'otherOrUnmapped' bucket for records outside the configured departments. Uses this instance's locked definitions (open jobs = isOpen AND NOT Archive AND not soft-deleted; placements made = Approved/Completed/Ended; active opps = NOT Closed-Won/Closed-Lost/Converted AND not soft-deleted). Prefer this over assembling the numbers yourself with count_entity for scorecard / overview asks. Placement counts are year-to-date by dateAdded (when the placement record was added), not by assignment start date.",
    {
      year: z
        .number()
        .int()
        .optional()
        .describe("Calendar year for placements (default: current year, year-to-date)."),
    },
    async ({ year }) => rt("staffing_scorecard", { year }, () => staffingScorecard({ year })),
  );

  tool(
    "placements_report",
    "PRE-BUILT REPORT (one fast call). Confirmed placements over a period, broken down by department and employment type (Contract / Contract-to-Hire / Direct Hire), with totals, a per-status breakdown, and an 'otherOrUnmapped' bucket. 'Confirmed' = status Approved/Completed/Ended by default; pass status:'all' to include every status. The period is measured by when the placement RECORD was added (dateAdded), not the assignment start date.",
    {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD (default: start of current year)."),
      endDate: z.string().optional().describe("End date YYYY-MM-DD, inclusive (default: today)."),
      status: z
        .enum(["confirmed", "all"])
        .optional()
        .describe("'confirmed' (default; Approved/Completed/Ended) or 'all' statuses."),
    },
    async ({ startDate, endDate, status }) =>
      rt("placements_report", { startDate, endDate, status }, () =>
        placementsReport({ startDate, endDate, status }),
      ),
  );

  tool(
    "open_jobs_report",
    "PRE-BUILT REPORT (one fast call). Current demand: open job requisitions by department and by employment type, with the grand total. USE THIS for ANY \"open jobs by office/branch/department/region\" question instead of fetching job records and grouping them yourself — grouping jobs by OWNER is WRONG (the office lives in correlatedCustomText1, NOT the owner; e.g. owner accounts named \"MYT-Ottawa House\" are not the office). Open jobs = isOpen:true AND NOT status:Archive AND isDeleted:false (this instance's locked definition).",
    {},
    async () => rt("open_jobs_report", {}, () => openJobsReport()),
  );

  tool(
    "sales_pipeline_report",
    "PRE-BUILT REPORT (one fast call). Active sales pipeline: open opportunities by department and by stage (status), with the total. Active = NOT Closed-Won / Closed-Lost / Converted AND not soft-deleted (isDeleted:false).",
    {},
    async () => rt("sales_pipeline_report", {}, () => salesPipelineReport()),
  );

  tool(
    "job_aging_report",
    "PRE-BUILT REPORT (one fast call). How long open jobs have been open: counts bucketed by age (0-30 / 31-90 / 91-180 / 180+ days) plus stale (>90 days) open jobs by department. Spotlights aging requisitions. USE THIS for ANY \"stale / aging open jobs\" or \"aging by office\" question — do NOT assemble it from a job-record list or group by owner (office = correlatedCustomText1; the owner is a person/house account, not the office). Open jobs = isOpen:true AND NOT status:Archive AND isDeleted:false.",
    {},
    async () => rt("job_aging_report", {}, () => jobAgingReport()),
  );

  tool(
    "recruiter_leaderboard",
    "PRE-BUILT REPORT (one fast call). Recruiter activity leaderboard: recruiters ranked by CONFIRMED placements (Approved/Completed/Ended) over a period, each with their job-submission count for the same period. Note: this v1 lists only recruiters who made at least one confirmed placement (submissions are shown for those recruiters); recruiters who submitted but have no confirmed placement are not listed.",
    {
      startDate: z.string().optional().describe("Start date YYYY-MM-DD (default: start of current year)."),
      endDate: z.string().optional().describe("End date YYYY-MM-DD, inclusive (default: today)."),
    },
    async ({ startDate, endDate }) =>
      rt("recruiter_leaderboard", { startDate, endDate }, () =>
        recruiterLeaderboard({ startDate, endDate }),
      ),
  );

  // ── Write tools ────────────────────────────────────────────────────────────
  //
  // Write tools run under the CALLING USER's own Bullhorn session so Bullhorn
  // enforces their individual permission gates. The shared read-only service
  // token is rejected with a clear plain-English message. To use write tools:
  //   1. Admin creates a user: POST /api/users
  //   2. User enrolls their Bullhorn account: GET /api/auth/user/enroll?id=<id>
  //   3. Configure the AI connector with the user's personal apiKey
  //
  // Permission errors from Bullhorn (403) are returned as structured JSON with
  // error:"permission_denied" so the AI can explain them in plain English.

  writeTool(
    "add_note",
    "WRITE: Adds a note to a candidate in Bullhorn, visible to all recruiters on the candidate's record. " +
      "Requires a personal Bullhorn account (not the shared read-only token) — the note is created as YOU and respects your Bullhorn write permissions. " +
      "The `action` field is the note type shown in Bullhorn (common values: 'Email', 'Call', 'Meeting', 'Comment', 'LinkedIn Message'). " +
      "Always confirm with the user what note text and action type to use before calling this tool. " +
      "At least one of candidateId, jobOrderId, or placementId must be provided.",
    {
      comments: z.string().min(1).describe("The note body text — the full content of the note as it should appear in Bullhorn."),
      action: z.string().min(1).describe("Note type/category displayed in Bullhorn, e.g. 'Email', 'Call', 'Meeting', 'Comment', 'LinkedIn Message'."),
      candidateId: z.number().int().positive().optional().describe("Bullhorn candidate ID to attach this note to."),
      jobOrderId: z.number().int().positive().optional().describe("Bullhorn job order ID to also associate this note with (optional)."),
      placementId: z.number().int().positive().optional().describe("Bullhorn placement ID to also associate this note with (optional)."),
    },
    async ({ comments, action, candidateId, jobOrderId, placementId }) => {
      if (!candidateId && !jobOrderId && !placementId) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatResult({ error: "validation_error", message: "At least one of candidateId, jobOrderId, or placementId must be provided." }),
            },
          ],
        };
      }
      return runWriteTool("add_note", { comments, action, candidateId, jobOrderId, placementId }, async () => {
        const session = await resolveWriteSession();
        return addNote(session, { comments, action, candidateId, jobOrderId, placementId });
      });
    },
  );

  writeTool(
    "update_candidate_status",
    "WRITE: Updates a candidate's status field in Bullhorn. " +
      "Requires a personal Bullhorn account — the update is performed as YOU and respects your Bullhorn edit permissions. " +
      "Common status values in this instance: 'Active', 'New Lead', 'Online Applicant', 'Placed', 'Archive'. " +
      "ALWAYS confirm the candidateId and new status with the user before calling this tool — status changes are visible to all recruiters. " +
      "Use get_candidate first to verify the current status before changing it.",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID to update."),
      status: z.string().min(1).describe("New status value, e.g. 'Active', 'New Lead', 'Archive'. Must match a valid Bullhorn status exactly (case-sensitive)."),
    },
    async ({ candidateId, status }) =>
      runWriteTool("update_candidate_status", { candidateId, status }, async () => {
        const session = await resolveWriteSession();
        await updateCandidateStatus(session, candidateId, status);
        return { updated: true, candidateId, status };
      }),
  );

  writeTool(
    "bulk_create_submissions",
    "WRITE: Submits multiple candidates to one or more job orders in a single call — use this instead of calling create_job_submission repeatedly. " +
      "Runs all submissions in parallel and returns a per-item result so you can report exactly which succeeded and which failed. " +
      "Max 20 submissions per call; split larger batches. " +
      "Your Bullhorn user ID is auto-derived from your session — no find_users call needed. " +
      "STATUS → BULLHORN PIPELINE BUCKET: 'Internally Submitted' / 'Candidate Interested' → Pipeline (recommended default); 'New Lead' → Response; 'Offer Extended' → Client Submission. " +
      "WORKFLOW: (1) resolve all candidate names to IDs via search, (2) call list_field_options(JobSubmission, status) to confirm status, " +
      "(3) show the user the full list of candidateId+jobOrderId pairs and ask for ONE confirmation before calling this tool, " +
      "(4) call this tool once — do NOT loop create_job_submission for the same batch. " +
      "ALWAYS check list_submissions_for_job first to avoid duplicate submissions.",
    {
      submissions: z
        .array(
          z.object({
            candidateId: z.number().int().positive().describe("Bullhorn candidate ID."),
            jobOrderId: z.number().int().positive().describe("Bullhorn job order ID."),
          }),
        )
        .min(1)
        .max(20)
        .describe("Array of candidate+job pairs to submit. Max 20 per call."),
      status: z
        .string()
        .min(1)
        .describe(
          "Submission status applied to ALL items — must be a valid value from list_field_options(JobSubmission, status). Default: 'Internally Submitted'.",
        ),
    },
    async ({ submissions, status }) =>
      runWriteTool("bulk_create_submissions", { count: submissions.length, status }, async () => {
        const session = await resolveWriteSession();
        return bulkCreateSubmissions(session, { submissions, status });
      }),
  );

  writeTool(
    "create_job_submission",
    "WRITE: Submits a candidate to a job order, creating a JobSubmission record in Bullhorn. " +
      "Requires a personal Bullhorn account — the submission is created as YOU and respects your Bullhorn permissions. " +
      "Your Bullhorn user ID is auto-derived from your session — you do NOT need to call find_users first. " +
      "Call list_field_options(JobSubmission, status) first to confirm valid status values for this instance. " +
      "STATUS → BULLHORN PIPELINE BUCKET mapping: " +
      "'New Lead' / 'Online Applicant' → Response bucket (inbound interest, not yet reviewed); " +
      "'Internally Submitted' / 'Candidate Interested' → Pipeline bucket (recruiter is actively working this candidate); " +
      "'Offer Extended' / 'Offer Accepted' → Client Submission bucket. " +
      "DEFAULT: use 'Internally Submitted' when the recruiter is actively submitting a candidate — this places it in the Pipeline bucket where recruiters expect to see it. " +
      "ALWAYS confirm candidateId, jobOrderId, and status with the user before submitting — this creates a live record in Bullhorn visible to all recruiters. " +
      "Check for existing submissions with list_submissions_for_job first to avoid duplicates.",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID to submit."),
      jobOrderId: z.number().int().positive().describe("Bullhorn job order ID to submit the candidate to."),
      status: z.string().min(1).describe("Submission status — must be a valid value from list_field_options(JobSubmission, status)."),
    },
    async ({ candidateId, jobOrderId, status }) =>
      runWriteTool("create_job_submission", { candidateId, jobOrderId, status }, async () => {
        const session = await resolveWriteSession();
        return createJobSubmission(session, { candidateId, jobOrderId, status });
      }),
  );

  writeTool(
    "create_support_ticket",
    "Sends a support request, bug report, or feature suggestion directly to the AskToAct team. " +
      "Use this when the user mentions a problem with the connector, wants to report a bug, " +
      "request a new feature, or has a question that requires human follow-up from the AskToAct team. " +
      "The team will respond via email — include the user's email in reporter_email so they can be reached. " +
      "Always confirm the subject and description with the user before submitting. " +
      "Do NOT use this for Bullhorn data operations — this is only for AskToAct product support.",
    {
      type: z
        .enum(["bug", "feature", "question"])
        .describe("Type of ticket: 'bug' for errors or unexpected behaviour, 'feature' for enhancement requests, 'question' for general queries."),
      subject: z
        .string()
        .min(3)
        .describe("Short title summarising the issue or request (e.g. 'Candidate search returns wrong results')."),
      description: z
        .string()
        .min(10)
        .describe(
          "Full details — what happened, what was expected, steps to reproduce (for bugs), or the full question/feature idea.",
        ),
      reporter_name: z
        .string()
        .optional()
        .describe("Name of the person submitting the ticket. Use the user's name from the conversation if known."),
      reporter_email: z
        .string()
        .email()
        .optional()
        .describe(
          "Email address for the AskToAct team to reply to. Use the user's email if known from the conversation.",
        ),
    },
    async ({ type, subject, description, reporter_name, reporter_email }) =>
      runWriteTool("create_support_ticket", { type, subject }, async () => {
        const callerLabel =
          caller?.kind === "user"
            ? `User ${caller.userId}`
            : "Unknown connector user";

        await sendSupportEmail({
          type,
          subject,
          message: description,
          userName: reporter_name ?? callerLabel,
          userEmail: reporter_email ?? "noreply@asktoact.ai",
        });

        return {
          submitted: true,
          ticket_type: type,
          subject,
          message:
            "Your support ticket has been sent to the AskToAct team." +
            (reporter_email ? ` They will follow up at ${reporter_email}.` : " Provide your email next time for a direct reply."),
        };
      }),
  );

  return server;
}
