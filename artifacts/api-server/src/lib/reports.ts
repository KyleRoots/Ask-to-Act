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
 * - Departments are resolved per firm: Myticas falls back to the hardcoded
 *   DEPARTMENTS list (byte-identical); other firms auto-discover live values.
 */
import { countEntity, listPlacements, ACTIVE_OPPS_DEFINITION } from "./bullhorn-client.js";
import { currentFirmContextId } from "./bullhorn-auth.js";
import { resolveDeptField, getFirmFieldMap } from "./firm-config.js";

/**
 * Myticas' configured Internal Departments — used as the fallback groupValues list
 * for any firm that has no discovered firm_config row yet (keeps Myticas byte-identical
 * and degrades gracefully for a not-yet-onboarded second firm).
 */
export const DEPARTMENTS = [
  "STS-STSI",
  "MYT-Ottawa",
  "MYT-Chicago",
  "MYT-Clover",
  "MYT-Ohio",
] as const;

/** Locked, instance-specific definitions (see tool descriptions / memory). */
const OPEN_JOBS_QUERY = "isOpen:true AND NOT status:Archive AND isDeleted:false";
// Single source of truth: the active-opportunity predicate is owned by bullhorn-client
// (the SAME constant the count_entity guard/annotation use), so this report and the
// ad-hoc count path can never drift apart — previously this was a second hand-kept copy.
const ACTIVE_OPPS_QUERY = ACTIVE_OPPS_DEFINITION;
const CONFIRMED_PLACEMENT_STATUSES = new Set(["Approved", "Completed", "Ended"]);

/** Below this many submissions, a conversion rate is statistically volatile and flagged lowVolume. */
const MIN_SUBMISSIONS_FOR_RELIABLE_RATE = 10;

/** Locked definition for the submission-to-placement conversion metric. */
const CONVERSION_DEFINITION =
  "Per SUBMITTING recruiter (JobSubmission.sendingUser — the person who actually submitted the candidate, NOT the placement owner): " +
  "conversionRate = confirmed placements credited to their submissions ÷ their submissions in the period. " +
  "Bounded 0–100% (capped — a placement whose submission predates the period can otherwise exceed 100%, flagged cappedAt100). " +
  `Recruiters with fewer than ${MIN_SUBMISSIONS_FOR_RELIABLE_RATE} submissions are flagged lowVolume because a tiny denominator makes the rate unreliable.`;

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

type Person = { id: number; name?: string; firstName?: string; lastName?: string };

type PlacementRow = {
  id: number;
  status?: string;
  employmentType?: string;
  owner?: Person;
  jobSubmission?: { id: number; sendingUser?: Person };
  [key: string]: unknown;
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

/**
 * Resolves the department VALUE list for a given firm + entity + field.
 * Returns both the list and a `source` flag so callers can preserve
 * byte-identical output metadata for Myticas:
 * - "configured" → Myticas fallback (hardcoded DEPARTMENTS); caller should
 *   emit `departmentsSource: "configured"` to keep Myticas output identical.
 * - "per-firm" → auto-discovered live values from Bullhorn; caller uses
 *   `departmentsSource: "per-firm"`.
 */
async function resolveDeptNames(
  firmId: string | null,
  entityType: string,
  deptField: string,
): Promise<{ departments: readonly string[]; source: "configured" | "per-firm" }> {
  if (firmId) {
    const map = await getFirmFieldMap(firmId);
    if (map) {
      // 1. Fast path: values were cached at discovery time — zero extra Bullhorn call.
      const cached = map.deptValues?.[entityType];
      if (cached && cached.length > 0) {
        return { departments: cached, source: "per-firm" };
      }

      // 2. Slow path: firm has a config row but dept values weren't cached yet
      //    (e.g. older discovery run before this feature). Fetch live and return.
      try {
        const r = (await countEntity({
          entityType,
          query: "isDeleted:false",
          groupBy: deptField,
        })) as CountResult;
        const values = (r.groups ?? [])
          .map((g) => g.value)
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .sort();
        if (values.length > 0) return { departments: values, source: "per-firm" };
      } catch {
        // Fall through to Myticas fallback
      }
    }
  }
  // Myticas / no config row / discovery returned empty → use hardcoded list.
  return { departments: DEPARTMENTS, source: "configured" };
}

/**
 * Exact per-department breakdown using a supplied department list as groupValues.
 * Records outside the list roll up to "otherOrUnmapped" so a new department never
 * silently disappears.
 */
async function groupedCountByDept(
  entityType: string,
  query: string,
  deptField: string,
  departments: readonly string[],
): Promise<{ total: number; byDept: Record<string, number>; otherOrUnmapped: number; complete: boolean }> {
  const r = (await countEntity({
    entityType,
    query,
    groupBy: deptField,
    groupValues: [...departments],
  })) as CountResult;
  const byDept: Record<string, number> = {};
  for (const d of departments) byDept[d] = 0;
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
  fields?: string;
  deptField?: string;
}): Promise<PlacementRow[]> {
  const deptField = opts.deptField ?? "correlatedCustomText1";
  const fields =
    opts.fields ?? `id,status,employmentType,${deptField},owner(id,name,firstName,lastName)`;
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
  const firmId = currentFirmContextId();
  // Resolve the per-firm Internal Department field (Myticas -> identical literals).
  const jobDeptField = (await resolveDeptField(firmId, "JobOrder")) ?? "correlatedCustomText1";
  const oppDeptField = (await resolveDeptField(firmId, "Opportunity")) ?? "customText1";
  const placementDeptField = (await resolveDeptField(firmId, "Placement")) ?? "correlatedCustomText1";

  // Resolve department name lists per firm (Myticas falls back to hardcoded DEPARTMENTS).
  const [jobDeptResult, oppDeptResult, placementsRaw] = await Promise.all([
    resolveDeptNames(firmId, "JobOrder", jobDeptField),
    resolveDeptNames(firmId, "Opportunity", oppDeptField),
    fetchAllPlacements({
      dateAddedStart: range.startStr,
      dateAddedEnd: range.endStr,
      deptField: placementDeptField,
    }),
  ]);

  // Use the same dept list for display rows — prefer job dept names as the canonical
  // set; merge in any opp-only names so no dept is silently dropped.
  const deptSet = new Set<string>([...jobDeptResult.departments, ...oppDeptResult.departments]);
  const departments = [...deptSet].sort();
  // "configured" only when BOTH sources fell back to the hardcoded list (Myticas).
  const deptSource = jobDeptResult.source === "configured" && oppDeptResult.source === "configured"
    ? "configured"
    : "per-firm";

  const [openJobs, opps] = await Promise.all([
    groupedCountByDept("JobOrder", OPEN_JOBS_QUERY, jobDeptField, departments),
    groupedCountByDept("Opportunity", ACTIVE_OPPS_QUERY, oppDeptField, departments),
  ]);

  const agg: Record<
    string,
    { contract: number; contractToHire: number; directHire: number; other: number; total: number }
  > = {};
  for (const d of departments) agg[d] = { contract: 0, contractToHire: 0, directHire: 0, other: 0, total: 0 };
  let confirmedTotal = 0;
  let placementsOther = 0;
  for (const p of placementsRaw) {
    if (!CONFIRMED_PLACEMENT_STATUSES.has(p.status ?? "")) continue;
    confirmedTotal++;
    const dept = (p[placementDeptField] as string | undefined) ?? "";
    if (dept in agg) {
      agg[dept][employmentColumn(p.employmentType)]++;
      agg[dept].total++;
    } else {
      placementsOther++;
    }
  }

  const rows = departments.map((d) => {
    const pl = agg[d];
    const oj = openJobs.byDept[d] ?? 0;
    const op = opps.byDept[d] ?? 0;
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
    departmentsSource: deptSource,
    notes: [
      "demandVsDelivery = openJobs / totalPlacements (higher = more unfilled demand).",
      `otherOrUnmapped counts records whose department is blank or outside the ${deptSource === "configured" ? "configured" : "resolved"} list.`,
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
  const firmId = currentFirmContextId();
  const placementDeptField = (await resolveDeptField(firmId, "Placement")) ?? "correlatedCustomText1";

  const [placements, placementDeptResult] = await Promise.all([
    fetchAllPlacements({
      dateAddedStart: range.startStr,
      dateAddedEnd: range.endStr,
      deptField: placementDeptField,
    }),
    resolveDeptNames(firmId, "Placement", placementDeptField),
  ]);
  const { departments, source: deptSource } = placementDeptResult;

  const agg: Record<
    string,
    { contract: number; contractToHire: number; directHire: number; other: number; total: number }
  > = {};
  for (const d of departments) agg[d] = { contract: 0, contractToHire: 0, directHire: 0, other: 0, total: 0 };
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
    const dept = (p[placementDeptField] as string | undefined) ?? "";
    if (dept in agg) {
      agg[dept][employmentColumn(p.employmentType)]++;
      agg[dept].total++;
    } else {
      other++;
    }
  }

  const rows = departments
    .map((d) => ({
      department: d,
      contract: agg[d].contract,
      contractToHire: agg[d].contractToHire,
      directHire: agg[d].directHire,
      total: agg[d].total,
    }))
    .sort((a, b) => b.total - a.total);

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
    departmentsSource: deptSource,
    summary: `${total} ${mode === "confirmed" ? "confirmed " : ""}placements in ${range.label}.`,
  };
}

/** 3. Open Jobs / Demand Report — current open requisitions by department and employment type. */
export async function openJobsReport(): Promise<unknown> {
  const firmId = currentFirmContextId();
  const jobDeptField = (await resolveDeptField(firmId, "JobOrder")) ?? "correlatedCustomText1";
  const { departments, source: deptSource } = await resolveDeptNames(firmId, "JobOrder", jobDeptField);

  const [byDept, byType] = await Promise.all([
    groupedCountByDept("JobOrder", OPEN_JOBS_QUERY, jobDeptField, departments),
    groupedCount("JobOrder", OPEN_JOBS_QUERY, "employmentType", ["Contract", "Contract to Hire", "Direct Hire"]),
  ]);
  const rows = departments
    .map((d) => ({ department: d, openJobs: byDept.byDept[d] ?? 0 }))
    .sort((a, b) => b.openJobs - a.openJobs);
  return {
    report: "open_jobs_report",
    generatedAt: new Date().toISOString(),
    columns: ["department", "openJobs"],
    rows,
    byEmploymentType: byType.byValue,
    totals: { openJobs: byDept.total },
    otherOrUnmapped: { department: byDept.otherOrUnmapped, employmentType: byType.otherOrUnmapped },
    definitions: { openJobs: DEPT_DEFINITIONS.openJobs },
    departmentsSource: deptSource,
    summary: `${byDept.total} open jobs total; ${rows[0]?.department} leads with ${rows[0]?.openJobs}.`,
    incomplete: !byDept.complete,
  };
}

/** 4. Sales Pipeline Report — active opportunities by department and stage. */
export async function salesPipelineReport(): Promise<unknown> {
  const firmId = currentFirmContextId();
  const oppDeptField = (await resolveDeptField(firmId, "Opportunity")) ?? "customText1";
  const { departments, source: deptSource } = await resolveDeptNames(firmId, "Opportunity", oppDeptField);

  const [byDept, byStage] = await Promise.all([
    groupedCountByDept("Opportunity", ACTIVE_OPPS_QUERY, oppDeptField, departments),
    groupedCount("Opportunity", ACTIVE_OPPS_QUERY, "status"),
  ]);
  const rows = departments
    .map((d) => ({ department: d, activeOpportunities: byDept.byDept[d] ?? 0 }))
    .sort((a, b) => b.activeOpportunities - a.activeOpportunities);
  return {
    report: "sales_pipeline_report",
    generatedAt: new Date().toISOString(),
    columns: ["department", "activeOpportunities"],
    rows,
    byStage: byStage.byValue,
    totals: { activeOpportunities: byDept.total },
    otherOrUnmapped: { department: byDept.otherOrUnmapped },
    definitions: { activeOpportunities: DEPT_DEFINITIONS.activeOpportunities },
    departmentsSource: deptSource,
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
  const firmId = currentFirmContextId();
  const jobDeptField = (await resolveDeptField(firmId, "JobOrder")) ?? "correlatedCustomText1";
  const { departments, source: deptSource } = await resolveDeptNames(firmId, "JobOrder", jobDeptField);

  // Cumulative "added on/before cutoff" counts, then derive non-overlapping buckets by subtraction.
  const [total, gt30, gt90, gt180, staleByDept] = await Promise.all([
    countTotal("JobOrder", OPEN_JOBS_QUERY),
    countTotal("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c30}]`),
    countTotal("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c90}]`),
    countTotal("JobOrder", `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c180}]`),
    groupedCountByDept(
      "JobOrder",
      `${OPEN_JOBS_QUERY} AND dateAdded:[* TO ${c90}]`,
      jobDeptField,
      departments,
    ),
  ]);
  const buckets = [
    { ageBucket: "0-30 days", count: total - gt30 },
    { ageBucket: "31-90 days", count: gt30 - gt90 },
    { ageBucket: "91-180 days", count: gt90 - gt180 },
    { ageBucket: "180+ days", count: gt180 },
  ];
  const staleRows = departments
    .map((d) => ({ department: d, staleOpenJobs: staleByDept.byDept[d] ?? 0 }))
    .sort((a, b) => b.staleOpenJobs - a.staleOpenJobs);
  return {
    report: "job_aging_report",
    generatedAt: new Date().toISOString(),
    columns: ["ageBucket", "count"],
    rows: buckets,
    staleByDepartment: staleRows,
    totals: { openJobs: total, staleOver90Days: gt90 },
    definitions: { openJobs: DEPT_DEFINITIONS.openJobs, staleOpenJobs: "open jobs added more than 90 days ago" },
    departmentsSource: deptSource,
    summary: `${total} open jobs; ${gt90} have been open >90 days (${gt180} >180 days).`,
  };
}

/**
 * 6. Recruiter Submission-to-Placement Conversion Leaderboard.
 *
 * Conversion is credited to the recruiter who SUBMITTED the candidate
 * (JobSubmission.sendingUser), NOT the placement owner. Those two are frequently
 * different people on this instance (a sourcer submits; an account manager owns the
 * resulting placement), which previously produced impossible rates (e.g. 7 placements
 * over 1 submission = 700%). Anchoring both numerator and denominator on the submitter
 * keeps every rate bounded and meaningful.
 */
export async function recruiterLeaderboard(args: {
  startDate?: string;
  endDate?: string;
}): Promise<unknown> {
  const range = resolveRange({ startDate: args.startDate, endDate: args.endDate, year: undefined });
  // Numerator (placements) and denominator (submissions) MUST cover the exact same
  // window or the rate is inconsistent. The submission count below uses the epoch
  // instants [startMs, endMs]; mirror them here as ISO timestamps so the placement
  // query resolves to the identical bounds (dateAdded >= startMs AND < endMs). Passing
  // the day-only range.startStr/endStr would drop "today" from placements while keeping
  // it in submissions (endMs = now), systematically depressing current-period rates.
  const placements = await fetchAllPlacements({
    dateAddedStart: new Date(range.startMs).toISOString(),
    dateAddedEnd: new Date(range.endMs).toISOString(),
    fields: "id,status,dateAdded,jobSubmission(id,sendingUser(id,name,firstName,lastName))",
  });

  // Numerator: confirmed placements credited to the submitting recruiter.
  const byRec = new Map<number, { id: number; name: string; placements: number }>();
  let unattributedPlacements = 0;
  for (const p of placements) {
    if (!CONFIRMED_PLACEMENT_STATUSES.has(p.status ?? "")) continue;
    const sender = p.jobSubmission?.sendingUser;
    if (!sender?.id) {
      unattributedPlacements++;
      continue;
    }
    const e = byRec.get(sender.id) ?? { id: sender.id, name: recruiterName(sender), placements: 0 };
    e.placements++;
    byRec.set(sender.id, e);
  }

  // Denominator: each recruiter's own submissions in the period.
  const recs = [...byRec.values()];
  const submissions = await mapLimit(recs, 4, (r) =>
    countTotal("JobSubmission", `sendingUser.id:${r.id} AND dateAdded:[${range.startMs} TO ${range.endMs}]`),
  );

  const rows = recs.map((r, i) => {
    const subs = submissions[i];
    const rawRate = subs > 0 ? r.placements / subs : null;
    const cappedAt100 = rawRate !== null && rawRate > 1;
    const conversionRate = rawRate === null ? null : Number((Math.min(rawRate, 1) * 100).toFixed(1));
    return {
      recruiter: r.name,
      submissions: subs,
      placementsFromSubmissions: r.placements,
      conversionRate,
      lowVolume: subs < MIN_SUBMISSIONS_FOR_RELIABLE_RATE,
      ...(cappedAt100 ? { cappedAt100: true } : {}),
    };
  });

  // Trustworthy ordering: reliable denominators first (ranked by conversion, then
  // volume); low-volume / no-submission recruiters listed after so a 1/1 = 100% fluke
  // never tops the board.
  rows.sort((a, b) => {
    const aReliable = !a.lowVolume && a.conversionRate !== null;
    const bReliable = !b.lowVolume && b.conversionRate !== null;
    if (aReliable !== bReliable) return aReliable ? -1 : 1;
    return (b.conversionRate ?? -1) - (a.conversionRate ?? -1) || b.submissions - a.submissions;
  });
  const ranked = rows.map((r, i) => ({ rank: i + 1, ...r }));
  const leader = ranked.find((r) => !r.lowVolume && r.conversionRate !== null);

  return {
    report: "recruiter_leaderboard",
    period: range.label,
    generatedAt: new Date().toISOString(),
    scope: "submitting_recruiter",
    columns: ["rank", "recruiter", "submissions", "placementsFromSubmissions", "conversionRate", "lowVolume"],
    rows: ranked,
    totals: {
      recruiters: ranked.length,
      submissions: ranked.reduce((a, r) => a + r.submissions, 0),
      placementsFromSubmissions: ranked.reduce((a, r) => a + r.placementsFromSubmissions, 0),
      unattributedPlacements,
    },
    definitions: { conversionRate: CONVERSION_DEFINITION, placementsMade: DEPT_DEFINITIONS.placementsMade },
    notes: [
      "Conversion credits the recruiter who SUBMITTED the candidate (JobSubmission.sendingUser), NOT the placement owner — they differ often on this instance, which previously caused impossible >100% rates.",
      `Reliable rows are listed first; lowVolume = fewer than ${MIN_SUBMISSIONS_FOR_RELIABLE_RATE} submissions (rate is volatile and should not be ranked at face value).`,
      "conversionRate is capped at 100%; a placement whose submission predates the period can otherwise exceed it (flagged cappedAt100).",
      "v1 lists only recruiters whose submissions produced at least one confirmed placement in the period; unattributedPlacements counts confirmed placements with no submission sender.",
    ],
    summary: leader
      ? `${leader.recruiter} leads with a ${leader.conversionRate}% submission-to-placement conversion (${leader.placementsFromSubmissions}/${leader.submissions}) in ${range.label}.`
      : ranked.length
        ? `No recruiter met the ${MIN_SUBMISSIONS_FOR_RELIABLE_RATE}-submission reliability threshold in ${range.label}; only low-volume rows available.`
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
    title: "Recruiter Submission-to-Placement Conversion",
    description:
      "Recruiters ranked by submission-to-placement conversion over a period. Conversion credits the recruiter who SUBMITTED the candidate (not the placement owner), so rates are trustworthy and bounded 0–100%; low-volume recruiters (<10 submissions) are flagged and ranked below reliable ones.",
    parameters: {
      startDate: "optional YYYY-MM-DD (default: start of current year)",
      endDate: "optional YYYY-MM-DD inclusive (default: today)",
    },
  },
  {
    name: "scout_dept_report",
    title: "Scout Screen Qualified by Department",
    description:
      "Unique candidates with a Scout Screen note (default action 'Scout Screen - Qualified') among inbound applicants to jobs in an Internal Department (correlatedCustomText1). mode=bounded (default) = one capped pass — if incomplete, report as lower bound and STOP (do not fan out date windows). mode=exhaustive = one call with server-side date partitioning. MCP: scout_dept_report. REST: GET /v1/reports/scout-qualified-by-department.",
    parameters: {
      department: "required Internal Department, e.g. STS-STSI or MYT-Ottawa",
      noteAction: "optional; default 'Scout Screen - Qualified'",
      openJobsOnly: "optional boolean; default true",
      applicantPool: "'responses' (default) or 'all' JobSubmission rows on those jobs",
      mode: "'bounded' (default) or 'exhaustive'",
      maxJobs: "optional cap (bounded default 25/max 100; exhaustive default/max 300)",
      maxCandidatesToScan: "optional cap per pass/window (default 100 bounded / 400 exhaustive, max 400)",
      dateAddedStart: "optional YYYY-MM-DD",
      dateAddedEnd: "optional YYYY-MM-DD exclusive",
    },
  },
] as const;

export function listReports(): unknown {
  return {
    report: "list_reports",
    description:
      "Pre-built report library. For Scout Screen / qualified-by-department counts use scout_dept_report (MCP) or GET /v1/reports/scout-qualified-by-department — do NOT use Note Lucene search; if incomplete, report lower bound (do not fan out date windows unless mode=exhaustive). For anything else, use count_entity or search_*.",
    reports: REPORTS_CATALOG,
    note:
      "Note entity Lucene search returns 0 on this Bullhorn instance; use get_notes per candidate or scout_dept_report for Scout workflows.",
  };
}
