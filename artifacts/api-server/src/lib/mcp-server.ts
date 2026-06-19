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
} from "./bullhorn-client.js";
import { logger } from "./logger.js";

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
    "Search for candidates in Bullhorn ATS using a Lucene query. Returns matching candidate records with key fields.",
    {
      query: z
        .string()
        .describe(
          "Lucene query string, e.g. 'primarySkills.name:\"Java\"' or 'status:Active AND address.city:\"Chicago\"'",
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
        .describe("Comma-separated list of fields to return (uses sensible defaults if omitted)"),
    },
    async ({ query, count, start, fields }) => {
      const result = await withLogging("search_candidates", { query, count, start }, () =>
        searchCandidates({ query, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "search_jobs",
    "Search for job orders in Bullhorn ATS using a Lucene query. Returns matching job records.",
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
    async ({ query, count, start, fields }) => {
      const result = await withLogging("search_jobs", { query, count, start }, () =>
        searchJobs({ query, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "search_companies",
    "Search for client companies (ClientCorporation) in Bullhorn ATS using a Lucene query.",
    {
      query: z
        .string()
        .describe("Lucene query string, e.g. 'name:\"Acme*\"' or 'status:Active'"),
      count: z.number().int().min(1).max(100).optional().describe("Number of results (default: 20)"),
      start: z.number().int().min(0).optional().describe("Pagination offset (default: 0)"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ query, count, start, fields }) => {
      const result = await withLogging("search_companies", { query, count, start }, () =>
        searchCompanies({ query, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "search_contacts",
    "Search for client contacts in Bullhorn ATS using a Lucene query.",
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
    async ({ query, count, start, fields }) => {
      const result = await withLogging("search_contacts", { query, count, start }, () =>
        searchContacts({ query, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "get_candidate",
    "Fetch the full record for a specific candidate by their Bullhorn ID.",
    {
      id: z.number().int().positive().describe("Bullhorn candidate ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) => {
      const result = await withLogging("get_candidate", { id }, () =>
        getCandidate({ id, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "get_job",
    "Fetch the full record for a specific job order by its Bullhorn ID.",
    {
      id: z.number().int().positive().describe("Bullhorn job order ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) => {
      const result = await withLogging("get_job", { id }, () =>
        getJob({ id, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "get_company",
    "Fetch the full record for a specific client company by its Bullhorn ID.",
    {
      id: z.number().int().positive().describe("Bullhorn client corporation ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) => {
      const result = await withLogging("get_company", { id }, () =>
        getCompany({ id, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  server.tool(
    "get_contact",
    "Fetch the full record for a specific client contact by their Bullhorn ID.",
    {
      id: z.number().int().positive().describe("Bullhorn client contact ID"),
      fields: z.string().optional().describe("Comma-separated fields to return"),
    },
    async ({ id, fields }) => {
      const result = await withLogging("get_contact", { id }, () =>
        getContact({ id, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
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
    async ({ jobId, dateAddedStart, dateAddedEnd, count, start, fields }) => {
      const result = await withLogging(
        "list_submissions_for_job",
        { jobId, dateAddedStart, dateAddedEnd, count, start },
        () =>
          listSubmissionsForJob({ jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
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
    async ({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }) => {
      const result = await withLogging(
        "list_placements",
        { candidateId, jobId, dateAddedStart, dateAddedEnd, count, start },
        () =>
          listPlacements({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
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
    async ({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }) => {
      const result = await withLogging(
        "get_notes",
        { candidateId, jobId, dateAddedStart, dateAddedEnd, count, start },
        () =>
          getNotes({ candidateId, jobId, dateAddedStart, dateAddedEnd, count, start, fields }),
      );
      return { content: [{ type: "text", text: formatResult(result) }] };
    },
  );

  return server;
}
