/**
 * Report library — pre-built, server-computed analytics for the Bullhorn MCP
 * server. Each report runs its underlying Bullhorn queries in parallel and
 * returns ONE compact result (a table + short summary), so the AI makes a single
 * fast call instead of orchestrating ~20 round-trips. These are STRICTLY
 * READ-ONLY. The generic ad-hoc tools (count_entity, search_*) remain for
 * anything not covered here.
 *
 * Key data constraints (probed live against this instance):
 * - count_entity groupBy CANNOT use nested fields (owner.id / sendingUser.name);
 *   so recruiter aggregation is done by FETCHING placements (small set) and
 *   aggregating by owner in code.
 * - JobSubmission is high-volume (tens of thousands/yr) — always COUNT, never fetch.
 * - Departments are a stable, configured set for this instance (below); they are
 *   passed as exact groupValues. Records outside the set roll up to
 *   "otherOrUnmapped" so a new department never silently disappears.
 */
import { countEntity, listPlacements } from "./bullhorn-client.js";

/** Configured Internal Departments (office/branch) for this instance. */
export const DEPARTMENTS = [
  "STS-STSI",
  "MYT-Ottawa",
  "MYT-Chicago",
  "MYT-Clover",
  "MYT-Ohio",
] as const;

/** Locked, instance-specific definitions (see tool descriptions / memory). */
const OPEN_JOBS_QUERY = "isOpen:true AND NOT status:Archive AND isDeleted:false";
const ACTIVE_OPPS_QUERY =
  'NOT status:"Closed-Won" AND NOT status:"Closed-Lost" AND NOT status:Converted AND isDeleted:false';
const CONFIRMED_PLACEMENT_STATUSES = new Set(["Approved", "Completed", "Ended"]);

const DEPT_DEFINITIONS = {
  openJobs: "isOpen:true AND NOT status:Archive AND isDeleted:false (includes on-hold/filled/placed; Archived AND soft-deleted excluded)",
  placementsMade: "Placement status Approved, Completed, or Ended (excludes Canceled, Archive, and pending Submitted; Placement search already excludes soft-deleted, so no isDeleted filter)",
  activeOpportunities: "Opportunity NOT in Closed-Won, Closed-Lost, or Converted, AND not soft-deleted (isDeleted:false)",
} as const;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type CountResult = {
  total: number;
  mode?: string;
  groups?: Array<{ value: string; count: number | null }>;
  groupsComplete?: boolean;
};

type PlacementRow = {
  id: number;
  status?: string;
  employmentType?: string;
  correlatedCustomText1?: string;
  owner?: { id: number; name?: string; firstName?: string; lastName?: string };
};

/** Run `fn` over `items` with bounded concurrency (keeps us under the REST rate limit). */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Exact total for a query (no records). */
async function countTotal(entityType: string, query: string): Promise<number> {
  const r = (await countEntity({ entityType, query })) as CountResult;
  return r.total ?? 0;
}

/** Exact per-department breakdown using the configured department list as groupValues. */
async function groupedCountByDept(
  entityType: string,
  query: string,
  deptField: string,
): Promise<{ total: number; byDept: Record<string, number>; otherOrUnmapped: number; complete: boolean }> {
  const r = (await countEntity({
    entityType,
    query,
    groupBy: deptField,
    groupValues: [...DEPARTMENTS],
  })) as CountResult;
  const byDept: Record<string, number> = {};
  for (const d of DEPARTMENTS) byDept[d] = 0;
  let sum = 0;
  for (const g of r.groups ?? []) {
    const c = g.count ?? 0;
    if (g.value in byDept) byDept[g.value] = c;
    sum += c;
  }
  return {
    total: r.total ?? 0,
    byDept,
    otherOrUnmapped: Math.max(0, (r.total ?? 0) - sum),
    complete: r.groupsComplete !== false,
  };
}

/** Exact per-value breakdown for a small field (e.g. employmentType, status) via auto-discovery. */
async function groupedCount(
  entityType: string,
  query: string,
  groupBy: string,
  groupValues?: string[],
): Promise<{ total: number; byValue: Array<{ value: string; count: number }>; otherOrUnmapped: number; complete: boolean }> {
  const r = (await countEntity({
    entityType,
    query,
    groupBy,
    ...(groupValues ? { groupValues } : {}),
  })) as CountResult;
  const byValue = (r.groups ?? []).map((g) => ({ value: g.value, count: g.count ?? 0 }));
  const sum = byValue.reduce((a, b) => a + b.count, 0);
  return {
    total: r.total ?? 0,
    byValue,
    otherOrUnmapped: groupValues ? Math.max(0, (r.total ?? 0) - sum) : 0,
    complete: r.groupsComplete !== false,
  };
}

/** Fetch ALL placements in a date range, paging until exhausted (handles >500). */
async function fetchAllPlacements(opts: {
  dateAddedStart?: string;
  dateAddedEnd?: string;
}): Promise<PlacementRow[]> {
  const fields = "id,status,employmentType,correlatedCustomText1,owner(id,name,firstName,lastName)";
  const pageSize = 500;
  const all: PlacementRow[] = [];
  for (let page = 0, start = 0; page < 40; page++, start += pageSize) {
    const res = (await listPlacements({ ...opts, count: pageSize, start, fields })) as {
      data?: PlacementRow[];
    };
    const rows = res.data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

function employmentColumn(t?: string): "contract" | "contractToHire" | "directHire" | "other" {
  const s = (t ?? "").trim().toLowerCase();
  if (s === "contract") return "contract";
  if (s === "contract to hire" || s === "contract-to-hire" || s === "c2h") return "contractToHire";
  if (s === "direct hire" || s === "direct-hire" || s === "permanent") return "directHire";
  return "other";
}

function recruiterName(o: PlacementRow["owner"]): string {
  if (!o) return "Unassigned";
  return o.name || `${o.firstName ?? ""} ${o.lastName ?? ""}`.trim() || `#${o.id}`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Resolve a {year} or {startDate,endDate} into a ms range + date strings + label. */
function resolveRange(args: { year?: number; startDate?: string; endDate?: string }): {
  startMs: number;
  endMs: number;
  startStr: string;
  endStr: string;
  label: string;
} {
  if (args.startDate || args.endDate) {
    const startMs = args.startDate ? Date.parse(`${args.startDate}T00:00:00Z`) : Date.UTC(2000, 0, 1);
    // endDate is inclusive of that calendar day.
    const endMs = args.endDate ? Date.parse(`${args.endDate}T00:00:00Z`) + DAY_MS : Date.now();
    return {
      startMs,
      endMs,
      startStr: isoDate(startMs),
      endStr: isoDate(endMs),
      label: `${isoDate(startMs)} to ${args.endDate ?? isoDate(endMs)}`,
    };
  }
  const now = Date.now();
  const year = args.year ?? new Date().getUTCFullYear();
  const isCurrent = year === new Date().getUTCFullYear();
  const startMs = Date.UTC(year, 0, 1);
  // Current year: cap at "today" so a YTD report never reaches into future-dated
  // records. Past years span the full calendar year.
  const endMs = isCurrent ? now : Date.UTC(year + 1, 0, 1);
  return {
    startMs,
    endMs,
    startStr: `${year}-01-01`,
    endStr: isCurrent ? isoDate(now + DAY_MS) : `${year + 1}-01-01`,
    label: isCurrent ? `${year} YTD (through ${isoDate(now)})` : `${year} full year`,
  };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** 1. Staffing Scorecard — placements (by type), open jobs, active pipeline by department. */
export async function staffingScorecard(args: { year?: number }): Promise<unknown> {
  const range = resolveRange({ year: args.year });
  const [placements, openJobs, opps] = await Promise.all([
    fetchAllPlacements({ dateAddedStart: range.startStr, dateAddedEnd: range.endStr }),
    groupedCountByDept("JobOrder", OPEN_JOBS_QUERY, "correlatedCustomText1"),
    groupedCountByDept("Opportunity", ACTIVE_OPPS_QUERY, "customText1"),
  ]);

  const agg: Record<
    string,
    { contract: number; contractToHire: number; directHire: number; other: number; total: number }
  > = {};
  for (const d of DEPARTMENTS) agg[d] = { contract: 0, contractToHire: 0, directHire: 0, other: 0, total: 0 };
  let confirmedTotal = 0;
  let placementsOther = 0;
  for (const p of placements) {
    if (!CONFIRMED_PLACEMENT_STATUSES.has(p.status ?? "")) continue;
    confirmedTotal++;
    const dept = p.correlatedCustomText1 ?? "";
    if (dept in agg) {
      agg[dept][employmentColumn(p.employmentType)]++;
      agg[dept].total++;
    } else {
      placementsOther++;
    }
  }

  const rows = DEPARTMENTS.map((d) => {
    const pl = agg[d];
    const oj = openJobs.byDept[d];
    const op = opps.byDept[d];
    return {
      department: d,
      contractPlacements: pl.contract,
      contractToHirePlacements: pl.contractToHire,
      directHirePlacements: pl.directHire,
      totalPlacements: pl.total,
      openJobs: oj,
      activeOpportunities: op,
      demandVsDelivery: pl.total > 0 ? Number((oj / pl.total).toFixed(2)) : null,
    };
  });
  // Rank by demand-to-delivery ratio (highest unfilled demand first); depts with
  // open jobs but no placements (ratio N/A) are flagged and listed after.
  rows.sort((a, b) => {
    if (a.demandVsDelivery === null && b.demandVsDelivery === null) return b.openJobs - a.openJobs;
    if (a.demandVsDelivery === null) return 1;
    if (b.demandVsDelivery === null) return -1;
    return b.demandVsDelivery - a.demandVsDelivery;
  });
  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));

  const top = ranked.find((r) => r.demandVsDelivery !== null);
  const naDepts = ranked.filter((r) => r.demandVsDelivery === null && r.openJobs > 0).map((r) => r.department);
  const summaryParts: string[] = [];
  if (top) {
    summaryParts.push(
      `${top.department} has the largest measurable unfilled demand: ${top.openJobs} open jobs vs ${top.totalPlacements} confirmed placements (${top.demandVsDelivery}x).`,
    );
  }
  if (naDepts.length) {
    summaryParts.push(
      `${naDepts.join(", ")} ${naDepts.length === 1 ? "has" : "have"} open jobs but no confirmed ${range.label.split(" ")[0]} placements, so the ratio is N/A.`,
    );
  }

  return {
    report: "staffing_scorecard",
    period: range.label,
    generatedAt: new Date().toISOString(),
    summary: summaryParts.join(" "),
    columns: [
      "rank",
      "department",
      "contractPlacements",
      "contractToHirePlacements",
      "directHirePlacements",
      "totalPlacements",
      "openJobs",
      "activeOpportunities",
      "demandVsDelivery",
    ],
    rows: ranked,
    totals: {
      totalPlacements: confirmedTotal,
      openJobs: openJobs.total,
      activeOpportunities: opps.total,
    },
    otherOrUnmapped: {
      placements: placementsOther,
      openJobs: openJobs.otherOrUnmapped,
      activeOpportunities: opps.otherOrUnmapped,
    },
    definitions: DEPT_DEFINITIONS,
    departmentsSource: "configured",
    notes: [
      "demandVsDelivery = openJobs / totalPlacements (higher = more unfilled demand).",
      "otherOrUnmapped counts records whose department is blank or outside the configured list.",
    ],
    incomplete: !openJobs.complete || !opps.complete,
  };
}

/** 2. Placements Report — confirmed placements over a period, by department & employment type. */
export async function placementsReport(args: {
  startDate?: string;
  endDate?: string;
  status?: "confirmed" | "all";
}): Promise<unknown> {
  const range = resolveRange({ startDate: args.startDate, endDate: args.endDate, year: undefined });
  const mode = args.status ?? "confirmed";
  const placements = await fetchAllPlacements({ dateAddedStart: range.startStr, dateAddedEnd: range.endStr });

  const agg: Record<
    string,
    { contract: number; contractToHire: number; directHire: number; other: number; total: number }
  > = {};
  for (const d of DEPARTMENTS) agg[d] = { contract: 0, contractToHire: 0, directHire: 0, other: 0, total: 0 };
  const byStatus: Record<string, number> = {};
  const byTypeGlobal = { contract: 0, contractToHire: 0, directHire: 0, other: 0 };
  let total = 0;
  let other = 0;
  for (const p of placements) {
    const st = p.status ?? "Unknown";
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (mode === "confirmed" && !CONFIRMED_PLACEMENT_STATUSES.has(st)) continue;
    total++;
    byTypeGlobal[employmentColumn(p.employmentType)]++;
    const dept = p.correlatedCustomText1 ?? "";
    if (dept in agg) {
      agg[dept][employmentColumn(p.employmentType)]++;
      agg[dept].total++;
    } else {
      other++;
    }
  }

  const rows = DEPARTMENTS.map((d) => ({
    department: d,
    contract: agg[d].contract,
    contractToHire: agg[d].contractToHire,
    directHire: agg[d].directHire,
    total: agg[d].total,
  })).sort((a, b) => b.total - a.total);

  return {
    report: "placements_report",
    period: range.label,
    generatedAt: new Date().toISOString(),
    statusFilter: mode === "confirmed" ? "confirmed (Approved/Completed/Ended)" : "all statuses",
    columns: ["department", "contract", "contractToHire", "directHire", "total"],
    rows,
    totals: { total, byType: byTypeGlobal },
    byStatus,
    otherOrUnmapped: other,
    definitions: { placementsMade: DEPT_DEFINITIONS.placementsMade },
    departmentsSource: "configured",
    summary: `${total} ${mode === "confirmed" ? "confirmed " : ""}placements in ${range.label}.`,
  };
}

/** 3. Open Jobs / Demand Report — current open requisitions by department and employment type. */
export async function openJobsReport(): Promise<unknown> {
  const [byDept, byType] = await Promise.all([
    groupedCountByDept("JobOrder", OPEN_JOBS_QUERY, "correlatedCustomText1"),
    groupedCount("JobOrder", OPEN_JOBS_QUERY, "employmentType", ["Contract", "Contract to Hire", "Direct Hire"]),
  ]);
  const rows = DEPARTMENTS.map((d) => ({ department: d, openJobs: byDept.byDept[d] })).sort(
    (a, b) => b.openJobs - a.openJobs,
  );
  return {
    report: "open_jobs_report",
    generatedAt: new Date().toISOString(),
    columns: ["department", "openJobs"],
    rows,
    byEmploymentType: byType.byValue,
    totals: { openJobs: byDept.total },
    otherOrUnmapped: { department: byDept.otherOrUnmapped, employmentType: byType.otherOrUnmapped },
    definitions: { openJobs: DEPT_DEFINITIONS.openJobs },
    departmentsSource: "configured",
    summary: `${byDept.total} open jobs total; ${rows[0]?.department} leads with ${rows[0]?.openJobs}.`,
    incomplete: !byDept.complete,
  };
}

/** 4. Sales Pipeline Report — active opportunities by department and stage. */
export async function salesPipelineReport(): Promise<unknown> {
  const [byDept, byStage] = await Promise.all([
    groupedCountByDept("Opportunity", ACTIVE_OPPS_QUERY, "customText1"),
    groupedCount("Opportunity", ACTIVE_OPPS_QUERY, "status"),
  ]);
  const rows = DEPARTMENTS.map((d) => ({ department: d, activeOpportunities: byDept.byDept[d] })).sort(
    (a, b) => b.activeOpportunities - a.activeOpportunities,
  );
  return {
    report: "sales_pipeline_report",
    generatedAt: new Date().toISOString(),
    columns: ["department", "activeOpportunities"],
    rows,
    byStage: byStage.byValue,
    totals: { activeOpportunities: byDept.total },
    otherOrUnmapped: { department: byDept.otherOrUnmapped },
    definitions: { activeOpportunities: DEPT_DEFINITIONS.activeOpportunities },
    departmentsSource: "configured",
    summary: `${byDept.total} active opportunities; ${rows[0]?.department} leads with ${rows[0]?.activeOpportunities}.`,
    incomplete: !byDept.complete,
  };
}

/** 5. Job Aging Report — open requisitions bucketed by how long they have been open. */
export async function jobAgingReport(): Promise<unknown> {
  const now = Date.now();
  const c30 = now - 30 * DAY_MS;
  const c90 = now - 90 * DAY_MS;
  const c180 = now - 180 * DAY_MS;
  // Cumulative "added on/before cutoff" counts, then derive non-overlapping buckets by subtraction.
  const [total, gt30, gt90, gt180, staleByDept] = await Promise.all([
    countTotal("JobOrder", OPEN_JOBS_QUERY),
    countTotal("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c30}]`),
    countTotal("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c90}]`),
    countTotal("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c180}]`),
    groupedCountByDept("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c90}]`, "correlatedCustomText1"),
  ]);
  const buckets = [
    { ageBucket: "0-30 days", count: total - gt30 },
    { ageBucket: "31-90 days", count: gt30 - gt90 },
    { ageBucket: "91-180 days", count: gt90 - gt180 },
    { ageBucket: "180+ days", count: gt180 },
  ];
  const staleRows = DEPARTMENTS.map((d) => ({ department: d, staleOpenJobs: staleByDept.byDept[d] })).sort(
    (a, b) => b.staleOpenJobs - a.staleOpenJobs,
  );
  return {
    report: "job_aging_report",
    generatedAt: new Date().toISOString(),
    columns: ["ageBucket", "count"],
    rows: buckets,
    staleByDepartment: staleRows,
    totals: { openJobs: total, staleOver90Days: gt90 },
    definitions: { openJobs: DEPT_DEFINITIONS.openJobs, staleOpenJobs: "open jobs added more than 90 days ago" },
    departmentsSource: "configured",
    summary: `${total} open jobs; ${gt90} have been open >90 days (${gt180} >180 days).`,
  };
}

/** 6. Recruiter Activity / Leaderboard — placements (delivery) and submissions (activity) per recruiter. */
export async function recruiterLeaderboard(args: {
  startDate?: string;
  endDate?: string;
}): Promise<unknown> {
  const range = resolveRange({ startDate: args.startDate, endDate: args.endDate, year: undefined });
  const placements = await fetchAllPlacements({ dateAddedStart: range.startStr, dateAddedEnd: range.endStr });

  const byRec = new Map<number, { id: number; name: string; placements: number }>();
  for (const p of placements) {
    if (!CONFIRMED_PLACEMENT_STATUSES.has(p.status ?? "")) continue;
    const o = p.owner;
    if (!o) continue;
    const e = byRec.get(o.id) ?? { id: o.id, name: recruiterName(o), placements: 0 };
    e.placements++;
    byRec.set(o.id, e);
  }
  const recs = [...byRec.values()];
  const submissions = await mapLimit(recs, 4, (r) =>
    countTotal("JobSubmission", `sendingUser.id:${r.id} AND dateAdded:[${range.startMs} TO ${range.endMs}]`),
  );
  const rows = recs
    .map((r, i) => ({ recruiter: r.name, placements: r.placements, submissions: submissions[i] }))
    .sort((a, b) => b.placements - a.placements || b.submissions - a.submissions)
    .map((r, i) => ({ rank: i + 1, ...r }));

  return {
    report: "recruiter_leaderboard",
    period: range.label,
    generatedAt: new Date().toISOString(),
    scope: "placement_owners",
    columns: ["rank", "recruiter", "placements", "submissions"],
    rows,
    totals: {
      recruiters: rows.length,
      placements: rows.reduce((a, r) => a + r.placements, 0),
      submissions: rows.reduce((a, r) => a + r.submissions, 0),
    },
    definitions: { placementsMade: DEPT_DEFINITIONS.placementsMade },
    notes: [
      "Ranked by confirmed placements in the period.",
      "Submission counts are shown for these placement owners only (v1 scope) — recruiters with submissions but no confirmed placements are not listed.",
    ],
    summary: rows.length
      ? `${rows[0].recruiter} leads with ${rows[0].placements} placements in ${range.label}.`
      : `No confirmed placements in ${range.label}.`,
  };
}

/** Catalog of available reports (the "library"), for the list_reports tool. */
export const REPORTS_CATALOG = [
  {
    name: "staffing_scorecard",
    title: "Staffing Scorecard",
    description:
      "YTD staffing scorecard by department: confirmed placements (split by Contract / Contract-to-Hire / Direct Hire), currently open jobs, active sales opportunities, and a demand-vs-delivery ratio.",
    parameters: { year: "optional integer; defaults to the current year" },
  },
  {
    name: "placements_report",
    title: "Placements Report",
    description: "Confirmed placements over any period, broken down by department and employment type.",
    parameters: {
      startDate: "optional YYYY-MM-DD (default: start of current year)",
      endDate: "optional YYYY-MM-DD inclusive (default: today)",
      status: "'confirmed' (default) or 'all'",
    },
  },
  {
    name: "open_jobs_report",
    title: "Open Jobs / Demand Report",
    description: "Current open requisitions by department and by employment type.",
    parameters: {},
  },
  {
    name: "sales_pipeline_report",
    title: "Sales Pipeline Report",
    description: "Active sales opportunities by department and by stage.",
    parameters: {},
  },
  {
    name: "job_aging_report",
    title: "Job Aging Report",
    description: "Open requisitions bucketed by how long they have been open (0-30 / 31-90 / 91-180 / 180+ days), with stale (>90d) reqs by department.",
    parameters: {},
  },
  {
    name: "recruiter_leaderboard",
    title: "Recruiter Activity / Leaderboard",
    description: "Recruiters ranked by confirmed placements over a period, with their submission activity.",
    parameters: {
      startDate: "optional YYYY-MM-DD (default: start of current year)",
      endDate: "optional YYYY-MM-DD inclusive (default: today)",
    },
  },
] as const;

export function listReports(): unknown {
  return {
    report: "list_reports",
    description:
      "Pre-built report library. Call one of these tools by name for a fast, ready-made answer. For anything not covered, use the ad-hoc tools (count_entity, search_*).",
    reports: REPORTS_CATALOG,
  };
}
