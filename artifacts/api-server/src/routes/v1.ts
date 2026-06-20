import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  staffingScorecard,
  placementsReport,
  openJobsReport,
  salesPipelineReport,
  jobAgingReport,
  recruiterLeaderboard,
  listReports,
} from "../lib/reports.js";
import { countEntity } from "../lib/bullhorn-client.js";
import { logger } from "../lib/logger.js";

/**
 * v1 REST surface — a plain-HTTP door into the SAME read-only functions the MCP
 * connector exposes, so non-MCP clients (Gemini, Custom GPT Actions, a web
 * dashboard) can call them. These handlers call the shared business functions
 * directly; there is no duplicated logic and no write access. Mounted behind
 * bearerAuth in routes/index.ts.
 */
const router: IRouter = Router();

type Handler = (req: Request) => Promise<unknown> | unknown;

/**
 * Classify an error message from the shared Bullhorn functions into an HTTP
 * status. Bad input / domain errors (unknown entity, invalid field, malformed
 * query) are the CLIENT's fault -> 400; upstream rate limits -> 429; anything
 * unrecognized returns null so the caller falls back to 500. These messages are
 * the same secret-free strings the MCP tools already surface.
 */
function clientErrorStatus(message: string): number | null {
  const httpMatch = message.match(/error \((\d{3})\)/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    if (status === 429) return 429;
    return status >= 400 && status < 500 ? 400 : null;
  }
  if (/rate limit exceeded/i.test(message)) return 429;
  if (
    /supports only full-text searchable entities/i.test(message) ||
    /invalid groupby field/i.test(message) ||
    /cannot be used for grouping/i.test(message) ||
    /invalid field "/i.test(message) ||
    /malformed bullhorn/i.test(message) ||
    /is query-only/i.test(message) ||
    /unsupported entitytype/i.test(message)
  ) {
    return 400;
  }
  return null;
}

/** Serialize a handler's return value as JSON; map zod/domain errors -> 4xx, else -> 500. */
function handle(name: string, fn: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await fn(req);
      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: "Invalid request", details: err.issues });
        return;
      }
      const message = err instanceof Error ? err.message : "Internal server error";
      const mapped = clientErrorStatus(message);
      if (mapped !== null) {
        res.status(mapped).json({ error: message });
        return;
      }
      logger.error({ err, route: name }, "v1 route error");
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

const yearQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

const dateRangeQuery = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
    .optional(),
});

const placementsQuery = dateRangeQuery.extend({
  status: z.enum(["confirmed", "all"]).optional(),
});

const countBody = z.object({
  entityType: z.string().min(1),
  query: z.string().optional(),
  groupBy: z.string().optional(),
  groupValues: z.array(z.string()).optional(),
});

// --- Report library (read-only) ---
router.get("/reports", handle("list_reports", () => listReports()));

router.get(
  "/reports/staffing-scorecard",
  handle("staffing_scorecard", (req) => staffingScorecard(yearQuery.parse(req.query))),
);

router.get(
  "/reports/placements",
  handle("placements", (req) => placementsReport(placementsQuery.parse(req.query))),
);

router.get("/reports/open-jobs", handle("open_jobs", () => openJobsReport()));

router.get("/reports/sales-pipeline", handle("sales_pipeline", () => salesPipelineReport()));

router.get("/reports/job-aging", handle("job_aging", () => jobAgingReport()));

router.get(
  "/reports/recruiter-leaderboard",
  handle("recruiter_leaderboard", (req) => recruiterLeaderboard(dateRangeQuery.parse(req.query))),
);

// --- Ad-hoc lookups (read-only) ---
router.post("/count", handle("count", (req) => countEntity(countBody.parse(req.body))));

export default router;
