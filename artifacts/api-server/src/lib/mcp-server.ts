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
  SUPPORTED_ENTITIES,
} from "./bullhorn-client.js";
import { logger } from "./logger.js";
import { responseCache, stableKey } from "./cache.js";

function formatResult(data: unknown): string {
  return JSON.stringify(data, null, 2);
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
  const result = await withLogging(toolName, args, fn);
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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "bullhorn-mcp",
    version: "1.0.0",
  });

  // This MCP server is STRICTLY READ-ONLY. Advertise that to clients via tool
  // annotations so hosts (e.g. ChatGPT) do not classify these reads as
  // write/destructive/open-world actions and gate or block them. The `tool`
  // helper attaches these hints to every tool registration below.
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
        .max(100)
        .optional()
        .describe("Number of results to return (default: 20, max: 100)"),
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
          "Comma-separated list of fields to return (uses sensible defaults if omitted). Do NOT include `description` here — in search results résumé text is returned only as a short preview, and requesting full résumés for many candidates makes the client drop the result; use get_candidate_resume for a candidate's full résumé text.",
        ),
    },
    async ({ query, keywords, count, start, fields }) =>
      runTool("search_candidates", { query, keywords, count, start, fields }, () =>
        searchCandidates({ query, keywords, count, start, fields }),
      ),
  );

  tool(
    "search_jobs",
    "Search for job orders in Bullhorn ATS using a Lucene query. Returns matching job records, each with a `bullhornUrl` deep link to open the job in Bullhorn. IMPORTANT: in this instance each job's \"Internal Department\" (the owning office/branch, e.g. \"MYT-Ottawa\" or \"MYT-Chicago\") is stored in the field `correlatedCustomText1`, which is populated on virtually all jobs — use that field (NOT `categories`, which is mostly empty) to group, filter, or report jobs by internal department. You can filter on it directly, e.g. query `isOpen:true AND correlatedCustomText1:\"MYT-Ottawa\"`. To count or group jobs, request a high `count` (up to 500); if the response's `total` is larger than the number of records returned, page with `start` to fetch the remainder before finalizing any counts.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string, e.g. 'status:Open AND title:\"Software Engineer\"' or 'isOpen:true'",
        ),
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 20, max: 500). For grouping/aggregation across all jobs, set this high to avoid paging."),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      runTool("search_jobs", { query, count, start, fields }, () =>
        searchJobs({ query, count, start, fields }),
      ),
  );

  tool(
    "search_companies",
    "Search for client companies (ClientCorporation) in Bullhorn ATS using a Lucene query. Each record includes a `bullhornUrl` deep link to open the company directly in Bullhorn.",
    {
      query: z
        .string()
        .describe("Lucene query string, e.g. 'name:\"Acme*\"' or 'status:Active'"),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      runTool("search_companies", { query, count, start, fields }, () =>
        searchCompanies({ query, count, start, fields }),
      ),
  );

  tool(
    "search_contacts",
    "Search for client contacts in Bullhorn ATS using a Lucene query. Each record includes a `bullhornUrl` deep link to open the contact directly in Bullhorn.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string, e.g. 'lastName:\"Smith\" AND status:Active'",
        ),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      runTool("search_contacts", { query, count, start, fields }, () =>
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
      runTool("get_candidate", { id, fields }, () =>
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
      runTool("get_job", { id, fields }, () =>
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
      runTool("get_company", { id, fields }, () =>
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
      runTool("get_contact", { id, fields }, () =>
        getContact({ id, fields }),
      ),
  );

  tool(
    "list_submissions_for_job",
    "List candidate submissions (applications) for a specific job order, optionally restricted to a dateAdded range. Results are in `data`; `count` is how many were returned. If `count` equals your requested limit there may be more — raise `count` (max 500) or page with `start`.",
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
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 50, max: 500)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ jobId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      runTool(
        "list_submissions_for_job",
        { jobId, dateAddedStart, dateAddedEnd, count, start, fields },
        () =>
          listSubmissionsForJob({ jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      ),
  );

  tool(
    "list_placements",
    "List placements, optionally filtered by candidate ID, job order ID, and/or a dateAdded range. To answer time-scoped questions (e.g. 'placements added in May 2026'), pass dateAddedStart/dateAddedEnd with a high `count` to retrieve them all in one call instead of paging. Results are in `data`; `count` is how many were returned. If `count` equals your requested limit there may be more — raise `count` (max 500) or page with `start`.",
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
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 50, max: 500)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      runTool(
        "list_placements",
        { candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields },
        () =>
          listPlacements({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      ),
  );

  tool(
    "get_notes",
    "Retrieve notes and activity log entries for a candidate or job order, optionally within a dateAdded range. Provide at least one of candidateId or jobId. Results are in `data`; `total` is the full match count. Raise `count` (max 500) or page with `start` for more.",
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
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 50, max: 500)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      runTool(
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
    `Full-text search (Lucene) over ANY indexed Bullhorn entity — a flexible fallback for read coverage when no dedicated tool fits. Prefer the dedicated tools (search_candidates, search_jobs, search_companies, search_contacts) when they apply. Searchable entities: Candidate, ClientContact, ClientCorporation, JobOrder, JobSubmission, Placement, Note, Lead, Opportunity. For query-only entities (Appointment, Task, CorporateUser, Sendout, Tearsheet) use query_entity instead. Use describe_entity to discover valid field names. For Candidate, ClientContact, ClientCorporation, JobOrder, Lead, and Opportunity, each returned record includes a \`bullhornUrl\` deep link to open it directly in Bullhorn.`,
    {
      entityType: z.string().describe(entityTypeDescribe),
      query: z
        .string()
        .describe("Lucene query string, e.g. 'status:Active AND city:\"Chicago\"'"),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20, max: 100)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return (sensible defaults if omitted)"),
    },
    async ({ entityType, query, count, start, fields }) =>
      runTool(
        "search_entity",
        { entityType, query, count, start, fields },
        () => searchAnyEntity({ entityType, query, count, start, fields }),
      ),
  );

  tool(
    "query_entity",
    `Structured query (SQL-like 'where') over ANY query-capable Bullhorn entity. Use this for query-only entities (Appointment, Task, CorporateUser, Sendout, Tearsheet) and for precise field equality/range filters on any query-capable entity. The Note entity is search-only — use search_entity for it. Bullhorn stores dates as epoch milliseconds, so date filters use numeric comparisons, e.g. where: "status='Placed' AND dateAdded >= 1746057600000". Use describe_entity first to discover valid field names. 'orderBy' is optional (e.g. '-dateAdded' for newest first). For Candidate, ClientContact, ClientCorporation, JobOrder, Lead, and Opportunity, each returned record includes a \`bullhornUrl\` deep link to open it directly in Bullhorn.`,
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
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20, max: 100)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return (sensible defaults if omitted)"),
    },
    async ({ entityType, where, orderBy, count, start, fields }) =>
      runTool(
        "query_entity",
        { entityType, where, orderBy, count, start, fields },
        () => queryAnyEntity({ entityType, where, orderBy, count, start, fields }),
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
      runTool("get_entity", { entityType, id, fields }, () =>
        getAnyEntity({ entityType, id, fields }),
      ),
  );

  tool(
    "describe_entity",
    "List the available fields (name + type) for a Bullhorn entity. Use this to discover valid field names before building a query_entity 'where' clause or requesting specific fields.",
    {
      entityType: z.string().describe(entityTypeDescribe),
    },
    async ({ entityType }) =>
      runTool("describe_entity", { entityType }, () =>
        describeEntity({ entityType }),
      ),
  );

  // -------------------------------------------------------------------------
  // Curated high-value read tools
  // -------------------------------------------------------------------------

  tool(
    "list_submissions_for_candidate",
    "List the job submissions (applications) for a specific candidate — i.e. which jobs a candidate has been submitted to — optionally within a dateAdded range. Results are in `data`; `count` is how many were returned. If `count` equals your requested limit there may be more — raise `count` (max 500) or page with `start`.",
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
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 50, max: 500)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ candidateId, dateAddedStart, dateAddedEnd, count, start, fields }) =>
      runTool(
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
    "List appointments/meetings, optionally for a specific owner (recruiter) and/or within a scheduled-time window (filters on the appointment's dateBegin). Use find_users to resolve a recruiter name to an ownerId. Results are in `data`; raise `count` (max 500) or page with `start` for more.",
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
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 50, max: 500)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ ownerId, startAfter, startBefore, count, start, fields }) =>
      runTool(
        "list_appointments",
        { ownerId, startAfter, startBefore, count, start, fields },
        () => listAppointments({ ownerId, startAfter, startBefore, count, start, fields }),
      ),
  );

  tool(
    "list_tasks",
    "List tasks, optionally for a specific owner (recruiter), filtered by a scheduled-date window (filters on the task's dateBegin) and/or completion status. Use find_users to resolve a recruiter name to an ownerId. Results are in `data`; raise `count` (max 500) or page with `start` for more.",
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
      count: z.number().int().min(1).max(500).optional().describe("Number of results (default: 50, max: 500)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ ownerId, dueStart, dueEnd, isCompleted, count, start, fields }) =>
      runTool(
        "list_tasks",
        { ownerId, dueStart, dueEnd, isCompleted, count, start, fields },
        () => listTasks({ ownerId, dueStart, dueEnd, isCompleted, count, start, fields }),
      ),
  );

  tool(
    "search_leads",
    "Search Bullhorn CRM leads (sales prospects) with a Lucene query. Each record includes a `bullhornUrl` deep link to open the lead directly in Bullhorn. Note: requires Lead & Opportunity tracking to be enabled in the Bullhorn instance; if it is not, this will return a Bullhorn error.",
    {
      query: z.string().describe("Lucene query string, e.g. 'status:Active AND companyName:\"Acme*\"'"),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20, max: 100)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      runTool("search_leads", { query, count, start, fields }, () =>
        searchLeads({ query, count, start, fields }),
      ),
  );

  tool(
    "search_opportunities",
    "Search Bullhorn CRM opportunities (sales deals) with a Lucene query. Each record includes a `bullhornUrl` deep link to open the opportunity directly in Bullhorn. Note: requires Lead & Opportunity tracking to be enabled in the Bullhorn instance; if it is not, this will return a Bullhorn error.",
    {
      query: z.string().describe("Lucene query string, e.g. 'status:Open AND title:\"Managed Services\"'"),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20, max: 100)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      runTool("search_opportunities", { query, count, start, fields }, () =>
        searchOpportunities({ query, count, start, fields }),
      ),
  );

  tool(
    "find_users",
    "Find internal Bullhorn users (recruiters / CorporateUser) by name and/or email — useful for resolving a recruiter to their user ID for ownerId filters on other tools. Omit all filters to list users.",
    {
      name: z.string().optional().describe("Partial first/last/full name to match"),
      email: z.string().optional().describe("Partial email to match"),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20, max: 100)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ name, email, count, start, fields }) =>
      runTool("find_users", { name, email, count, start, fields }, () =>
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
      runTool("list_candidate_attachments", { candidateId }, () =>
        listCandidateAttachments({ candidateId }),
      ),
  );

  tool(
    "read_candidate_attachment",
    "Read the text of one candidate attachment by candidate ID + file id (get the file id from list_candidate_attachments). Returns extracted text for textual formats (plain text, HTML, RTF). Binary formats such as PDF or Word cannot be text-extracted server-side — for those the tool returns the file metadata and an explanation instead of fabricating text. Returned text is SSN-redacted and length-capped (raise `maxChars` up to 100000 for long documents).",
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
      runTool("read_candidate_attachment", { candidateId, fileId, maxChars }, () =>
        readCandidateAttachment({ candidateId, fileId, maxChars }),
      ),
  );

  tool(
    "get_candidate_resume",
    "Read a candidate's résumé in one call, in either of TWO modes. (1) VERIFY mode — PREFERRED for confirming a specific clearance phrase, skill, or keyword on your shortlist: pass `highlight` with the terms you are verifying (e.g. `highlight=[\"Secret clearance\",\"Federal Government Secret\",\"Java\"]`). The tool then returns only the short QUOTE(S) around each match in `excerpts` (each entry is `{ terms, quote }`, and one quote may cover several terms), plus `matchedTerms` (confirmed present WITH a quote), `foundButNotQuoted` (present but the quote was trimmed by size caps), and `termsNotFound` (absent) so you can see at a glance which terms actually appear in the résumé. This keeps the result small and low on personal data, which makes the client far less likely to withhold it, and it hands you the exact 'quote where it appears' to cite. (2) FULL mode — omit `highlight` to get the complete résumé text in `resumeText` (length-capped; raise `maxChars` up to 100000 for long résumés). In both modes `resumeTextSource` indicates whether text came from a résumé file attachment or the parsed text on the candidate record, and `resumeAttachment` + the full attachment list are included. If the résumé is only a binary file (PDF/Word) with no extractable text, the tool falls back to the parsed record text when available; otherwise it returns no text and the attachment metadata shows what to open in Bullhorn. Text is SSN-redacted.",
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
      runTool("get_candidate_resume", { candidateId, maxChars, highlight }, () =>
        getCandidateResume({ candidateId, maxChars, highlight }),
      ),
  );

  return server;
}
