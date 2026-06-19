import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

  server.tool(
    "search_candidates",
    "Search for candidates in Bullhorn ATS using a Lucene query. ACCURACY NOTE — a candidate's skills and experience live in THREE searchable places; search across all of them so you don't miss qualified people: `skillSet` (free-text skills list — the most complete source), `primarySkills.name` (structured skills — often sparse or empty), and `description` (the candidate's full parsed RÉSUMÉ text, which is fully searchable and catches skills, tools, and certifications that appear only in the résumé). Example: `(skillSet:Kubernetes OR description:Kubernetes)`. Combine must-have criteria with AND, use OR within a criterion for recall, quote multi-word terms to keep them together (e.g. `skillSet:\"Spring Boot\"`; Bullhorn matching is relevance-ranked, not strict exact-phrase, so confirm the top hits on the shortlist), and field-qualify EVERY term — bare keywords are rejected by Bullhorn. Results are relevance-ranked. Years-of-experience and skill recency are NOT reliable as query filters (the structured `experience` field is usually empty) — to judge those, open the shortlist with get_candidate (work history with dates) and get_candidate_resume (full résumé text). IMPORTANT — search the résumé via the QUERY (e.g. `description:Kubernetes`), but do NOT add `description` to the returned `fields`: in search results résumé text is truncated to a short preview to keep responses small, and pulling full résumés for many candidates at once makes the client drop the whole result. To read a candidate's FULL résumé, call get_candidate_resume on your shortlist (~5 candidates). Returns key fields including `skillSet`; each record includes a `bullhornUrl` deep link — render the candidate's name as that link.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string. Field-qualify every term (no bare keywords). For skills, search BOTH the skill fields and the résumé text for best recall, e.g. '(skillSet:\"Java\" OR description:\"Java\") AND (skillSet:\"AWS\" OR description:\"AWS\") AND status:\"Active\"'. Use AND for must-haves; quote multi-word skills. Use plain field-qualified terms, not wildcards inside quotes (write 'description:Java', not 'description:\"*Java*\"').",
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
    async ({ query, count, start, fields }) =>
      runTool("search_candidates", { query, count, start, fields }, () =>
        searchCandidates({ query, count, start, fields }),
      ),
  );

  server.tool(
    "search_jobs",
    "Search for job orders in Bullhorn ATS using a Lucene query. Returns matching job records. Each record includes a `bullhornUrl` deep link to open the job directly in Bullhorn.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string, e.g. 'status:Open AND title:\"Software Engineer\"' or 'isOpen:true'",
        ),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) =>
      runTool("search_jobs", { query, count, start, fields }, () =>
        searchJobs({ query, count, start, fields }),
      ),
  );

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "get_candidate_resume",
    "Read a candidate's résumé in one call. Returns the best available résumé text in `resumeText` (with `resumeTextSource` indicating whether it came from a résumé file attachment or the parsed text stored on the candidate record), plus `resumeAttachment` (the chosen résumé file's metadata, if any) and the full attachment list for reference. In most records the résumé is stored as parsed text on the candidate record, so that is what `resumeText` returns. If the résumé is only stored as a binary file (PDF/Word) with no extractable text, `resumeText` falls back to the parsed record text when available; otherwise it is null and the attachment metadata shows what exists to open in Bullhorn. Text is SSN-redacted and length-capped (raise `maxChars` up to 100000 for long résumés).",
    {
      candidateId: z.number().int().positive().describe("Bullhorn candidate ID"),
      maxChars: z
        .number()
        .int()
        .min(1)
        .max(100000)
        .optional()
        .describe("Maximum characters of text to return per source (default: 20000, max: 100000)"),
    },
    async ({ candidateId, maxChars }) =>
      runTool("get_candidate_resume", { candidateId, maxChars }, () =>
        getCandidateResume({ candidateId, maxChars }),
      ),
  );

  return server;
}
