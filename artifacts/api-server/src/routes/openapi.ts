import { Router, type IRouter, type Request, type Response } from "express";
import { getBaseUrl } from "../lib/getBaseUrl.js";

/**
 * Public, unauthenticated discovery surface for ChatGPT Custom GPT Actions
 * (and any OpenAPI-importing tool). The document itself is non-sensitive — it
 * only DESCRIBES the read-only /api/v1 reporting endpoints; every operation it
 * lists is still gated by bearerAuth at call time. ChatGPT fetches this schema
 * during GPT setup without a token, so it must live outside the auth gate.
 */
const router: IRouter = Router();

function actionsSpec(baseUrl: string) {
  const reportResult = {
    type: "object",
    description: "Report or count payload. The exact shape varies by endpoint.",
    additionalProperties: true,
  };
  const dateParam = (name: string, desc: string) => ({
    name,
    in: "query",
    required: false,
    description: desc,
    schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-01-01" },
  });
  const okReport = {
    "200": {
      description: "Result",
      content: { "application/json": { schema: reportResult } },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "AskToAct Bullhorn Reporting",
      version: "1.0.0",
      description:
        "Read-only staffing analytics from your Bullhorn ATS: scorecards, " +
        "placements, open jobs, sales pipeline, job aging, recruiter " +
        "leaderboards, and ad-hoc record counts. All endpoints are read-only.",
    },
    servers: [{ url: `${baseUrl}/api/v1`, description: "AskToAct API (read-only reporting)" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/reports": {
        get: {
          operationId: "listReports",
          summary: "List available reports",
          description: "Returns the catalog of pre-built reports and their parameters.",
          responses: okReport,
        },
      },
      "/reports/staffing-scorecard": {
        get: {
          operationId: "getStaffingScorecard",
          summary: "Staffing scorecard",
          description:
            "Year-to-date staffing scorecard by department: confirmed placements " +
            "(Contract / Contract-to-Hire / Direct Hire), open jobs, active " +
            "opportunities, and a demand-vs-delivery ratio.",
          parameters: [
            {
              name: "year",
              in: "query",
              required: false,
              description: "Calendar year; defaults to the current year.",
              schema: { type: "integer", minimum: 2000, maximum: 2100 },
            },
          ],
          responses: okReport,
        },
      },
      "/reports/placements": {
        get: {
          operationId: "getPlacementsReport",
          summary: "Placements report",
          description: "Confirmed placements over a period, by department and employment type.",
          parameters: [
            dateParam("startDate", "Inclusive start date (YYYY-MM-DD). Defaults to start of current year."),
            dateParam("endDate", "Inclusive end date (YYYY-MM-DD). Defaults to today."),
            {
              name: "status",
              in: "query",
              required: false,
              description: "'confirmed' (default) or 'all'.",
              schema: { type: "string", enum: ["confirmed", "all"] },
            },
          ],
          responses: okReport,
        },
      },
      "/reports/open-jobs": {
        get: {
          operationId: "getOpenJobsReport",
          summary: "Open jobs / demand report",
          description: "Current open requisitions by department and by employment type.",
          responses: okReport,
        },
      },
      "/reports/sales-pipeline": {
        get: {
          operationId: "getSalesPipelineReport",
          summary: "Sales pipeline report",
          description: "Active sales opportunities by department and by stage.",
          responses: okReport,
        },
      },
      "/reports/job-aging": {
        get: {
          operationId: "getJobAgingReport",
          summary: "Job aging report",
          description: "Open requisitions bucketed by age, with stale (>90 days) reqs by department.",
          responses: okReport,
        },
      },
      "/reports/recruiter-leaderboard": {
        get: {
          operationId: "getRecruiterLeaderboard",
          summary: "Recruiter leaderboard",
          description:
            "Recruiters ranked by confirmed placements over a period, with submission activity.",
          parameters: [
            dateParam("startDate", "Inclusive start date (YYYY-MM-DD). Defaults to start of current year."),
            dateParam("endDate", "Inclusive end date (YYYY-MM-DD). Defaults to today."),
          ],
          responses: okReport,
        },
      },
      "/reports/scout-qualified-by-department": {
        get: {
          operationId: "getScoutQualifiedByDepartment",
          summary: "Scout Screen qualified by department",
          description:
            "Screening/Scout notes by Internal Department — natural-language ready. Resolves nicknames " +
            "(STSI→STS-STSI). For 'list N most recent' pass limit=N (server auto-pages open jobs, ranks by note date, ONE call). " +
            "Do not fan out date windows. incomplete = partial list / lower bound.",
          parameters: [
            {
              name: "department",
              in: "query",
              required: true,
              description:
                'Internal Department or nickname (JobOrder.correlatedCustomText1), e.g. "STS-STSI", "STSI", "MYT-Ottawa".',
              schema: { type: "string" },
            },
            {
              name: "noteAction",
              in: "query",
              required: false,
              description: "Note.action to match (default: Scout Screen - Qualified).",
              schema: { type: "string" },
            },
            {
              name: "openJobsOnly",
              in: "query",
              required: false,
              description: "If true (default), only open jobs in the department.",
              schema: { type: "boolean" },
            },
            {
              name: "applicantPool",
              in: "query",
              required: false,
              description: "'responses' (default) or 'all' JobSubmissions on those jobs.",
              schema: { type: "string", enum: ["responses", "all"] },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description:
                "For 'N most recent' / 'list N' — set to N. Server ranks by latest matching note date.",
              schema: { type: "integer", minimum: 1, maximum: 50 },
            },
            {
              name: "mode",
              in: "query",
              required: false,
              description:
                "'bounded' (default) for list/most-recent. 'exhaustive' for submission-date lookback counts only.",
              schema: { type: "string", enum: ["bounded", "exhaustive"] },
            },
            {
              name: "maxJobs",
              in: "query",
              required: false,
              description: "Optional. Server auto-pages; do not ask the user for this.",
              schema: { type: "integer", minimum: 1, maximum: 200 },
            },
            {
              name: "maxCandidatesToScan",
              in: "query",
              required: false,
              description: "Optional per job-page applicant cap. Do not ask the user for this.",
              schema: { type: "integer", minimum: 1, maximum: 400 },
            },
            dateParam("dateAddedStart", "Optional JobSubmission dateAdded start (YYYY-MM-DD), UTC inclusive."),
            dateParam("dateAddedEnd", "Optional JobSubmission dateAdded end (YYYY-MM-DD), UTC exclusive."),
          ],
          responses: okReport,
        },
      },
      "/count": {
        post: {
          operationId: "countEntities",
          summary: "Count Bullhorn records",
          description:
            "Exact count for a Lucene query, optionally broken down by a field. " +
            "Read-only; returns totals without the underlying records.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["entityType"],
                  properties: {
                    entityType: {
                      type: "string",
                      description:
                        "Searchable entity: Candidate, ClientContact, ClientCorporation, " +
                        "JobOrder, JobSubmission, Placement, Lead, or Opportunity. Note is not supported.",
                    },
                    query: {
                      type: "string",
                      description: "Lucene query string. Omit to count all records of the entity.",
                    },
                    groupBy: {
                      type: "string",
                      description: "Field to break the count down by (e.g. status, correlatedCustomText1).",
                    },
                    groupValues: {
                      type: "array",
                      items: { type: "string" },
                      description: "Known values for groupBy, for an exact (non-sampled) breakdown.",
                    },
                  },
                },
              },
            },
          },
          responses: okReport,
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}

const GPT_INSTRUCTIONS = `You are AskToAct, an AI assistant connected to your firm's Bullhorn ATS through read-only reporting Actions.

WHAT YOU CAN DO
- Pull live staffing analytics: staffing scorecard, placements, open jobs, sales pipeline, job aging, recruiter leaderboard, and Scout Screen qualified-by-department.
- Run exact record counts for searchable Bullhorn entities (Candidate, JobOrder, Placement, Opportunity, etc.), optionally broken down by a field.
- Scout Screen by department: GET /reports/scout-qualified-by-department?department=STSI&limit=5 (nicknames resolve; limit=N for most recent). Do NOT search Note via Lucene. One call; if incomplete, report as a partial list / lower bound — do not fan out date windows.

HOW TO BEHAVE
- Always call the Actions to fetch live numbers. Never invent, estimate, or rely on prior knowledge for figures that the Actions can return.
- When a user asks "how many", "how is the pipeline", "who placed the most", or anything analytical, map it to the right report or to countEntities.
- Default to the current year / year-to-date when no date range is given, and say so.
- Present results clearly: lead with the headline number, then a short, scannable breakdown. Use tables for departmental or per-recruiter splits.
- These Actions are READ-ONLY. You cannot create, edit, or delete Bullhorn records. If asked to write (add a note, change a status, submit a candidate), explain that writes happen through the AskToAct connector in their AI tool, not through this GPT.

DATA & PRIVACY
- Report aggregate figures and the fields the Actions return. Do not attempt to extract or display candidate personal contact details (email, phone, SSN); the API does not expose them here.
- If an Action returns an error, explain it plainly and suggest the likely fix (e.g. an invalid field name, a malformed date, or a rate limit — wait and retry).

TONE
- Concise, professional, and useful to a busy recruiter or staffing leader. No filler.`;

router.get("/openapi.json", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json(actionsSpec(getBaseUrl()));
});

router.get("/gpt/instructions", (_req: Request, res: Response) => {
  res.set("Cache-Control", "public, max-age=300");
  res.type("text/plain").send(GPT_INSTRUCTIONS);
});

export default router;
