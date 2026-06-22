/**
 * Golden-answer regression harness (connector-side).
 *
 * Purpose: turn "do we FEEL robust?" into "are all checks green?" — the stop
 * signal. It calls the connector's finished-answer report tools + count_entity
 * exactly as a host model would, and asserts the things that must hold.
 *
 * It deliberately does NOT hard-code volatile totals (e.g. "398 open jobs"),
 * because the underlying ATS data is LIVE and drifts daily — pinning a moving
 * number produces false failures. Instead it asserts:
 *
 *   1. INVARIANTS      — structural truths independent of the data values
 *                        (by-department + unmapped == total; buckets == total; …).
 *   2. CROSS-TOOL      — the SAME metric returned by every tool that reports it
 *                        must be identical (open jobs via count_entity ==
 *                        open_jobs_report == staffing_scorecard == job_aging).
 *                        This is the core "consistent across models" guarantee:
 *                        whichever tool a model picks, the number is the same.
 *   3. SNAPSHOT (drift)— today's live totals are compared to a blessed snapshot
 *                        file; a change is a WARNING, not a failure (re-bless
 *                        with `--bless` when the change is real).
 *
 * Run:  pnpm --filter @workspace/api-server run golden          (check)
 *       pnpm --filter @workspace/api-server run golden --bless  (re-baseline)
 *       pnpm --filter @workspace/api-server run golden --strict (drift => fail)
 *
 * Read-only: only ever calls read tools against Bullhorn.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  staffingScorecard,
  placementsReport,
  openJobsReport,
  salesPipelineReport,
  jobAgingReport,
  recruiterLeaderboard,
} from "../lib/reports.js";
import { countEntity } from "../lib/bullhorn-client.js";

// ---------------------------------------------------------------------------
// tiny assertion kernel (no test framework — output IS a scoreboard)
// ---------------------------------------------------------------------------
type Kind = "INVARIANT" | "CROSS-TOOL";
type Check = { kind: Kind; name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(kind: Kind, name: string, ok: boolean, detail: string) {
  checks.push({ kind, name, ok, detail });
}
/** Assert two numbers are equal (exact — these are counts, not floats). */
function eq(kind: Kind, name: string, a: number, b: number, ctx = "") {
  record(kind, name, a === b, `${a} ${a === b ? "==" : "!="} ${b}${ctx ? ` (${ctx})` : ""}`);
}
function truthy(kind: Kind, name: string, ok: boolean, detail: string) {
  record(kind, name, ok, detail);
}

// Loose accessors — report fns return `unknown`; read defensively.
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

// ---------------------------------------------------------------------------
// snapshot (drift detection)
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAP_PATH = join(HERE, "golden.snapshot.json");
type Snapshot = Record<string, number>;
const live: Snapshot = {};

function loadSnapshot(): Snapshot | null {
  if (!existsSync(SNAP_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAP_PATH, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const bless = process.argv.includes("--bless");
  const strict = process.argv.includes("--strict");

  // Call every finished-answer tool once (parallel), exactly as a model would.
  const [scorecard, openJobs, pipeline, aging, placements, leaderboard, countOpen, countOpps] = await Promise.all([
    staffingScorecard({}).then(obj),
    openJobsReport().then(obj),
    salesPipelineReport().then(obj),
    jobAgingReport().then(obj),
    placementsReport({}).then(obj),
    recruiterLeaderboard({}).then(obj),
    countEntity({ entityType: "JobOrder", query: "isOpen:true" }).then(obj),
    countEntity({ entityType: "Opportunity", query: "isOpen:true" }).then(obj),
  ]);

  // ---- open_jobs_report ----------------------------------------------------
  {
    const total = num(obj(openJobs.totals).openJobs);
    const rows = arr(openJobs.rows).map((r) => num(obj(r).openJobs));
    const unmapped = num(obj(openJobs.otherOrUnmapped).department);
    eq("INVARIANT", "open_jobs: byDept + unmapped == total", sum(rows) + unmapped, total);
    truthy("INVARIANT", "open_jobs: not flagged incomplete", openJobs.incomplete !== true, `incomplete=${openJobs.incomplete}`);
    truthy("INVARIANT", "open_jobs: rows sorted desc", isDesc(rows), `[${rows.join(",")}]`);
    live.openJobs = total;
  }

  // ---- count_entity agrees with the report (THE headline cross-tool check) -
  {
    const viaCount = num(countOpen.total);
    const viaReport = num(obj(openJobs.totals).openJobs);
    eq("CROSS-TOOL", "open jobs: count_entity == open_jobs_report", viaCount, viaReport);
  }

  // ---- staffing_scorecard --------------------------------------------------
  {
    const scTotals = obj(scorecard.totals);
    eq("CROSS-TOOL", "open jobs: staffing_scorecard == open_jobs_report", num(scTotals.openJobs), num(obj(openJobs.totals).openJobs));
    eq("CROSS-TOOL", "active opps: staffing_scorecard == sales_pipeline", num(scTotals.activeOpportunities), num(obj(pipeline.totals).activeOpportunities));
    // Per-row type split must reconcile to the row total.
    let rowsOk = true;
    for (const r0 of arr(scorecard.rows)) {
      const r = obj(r0);
      const split = num(r.contractPlacements) + num(r.contractToHirePlacements) + num(r.directHirePlacements);
      if (split !== num(r.totalPlacements)) rowsOk = false;
    }
    truthy("INVARIANT", "scorecard: per-dept type split == dept total", rowsOk, "sum(contract,c2h,direct) == totalPlacements per row");
  }

  // ---- job_aging_report ----------------------------------------------------
  {
    const total = num(obj(aging.totals).openJobs);
    const stale = num(obj(aging.totals).staleOver90Days);
    const buckets = new Map(arr(aging.rows).map((r) => [String(obj(r).ageBucket), num(obj(r).count)]));
    const bucketSum = sum([...buckets.values()]);
    eq("INVARIANT", "job_aging: buckets sum == open jobs total", bucketSum, total);
    eq("INVARIANT", "job_aging: stale>90 == (91-180)+(180+)", stale, num(buckets.get("91-180 days")) + num(buckets.get("180+ days")));
    eq("CROSS-TOOL", "open jobs: job_aging == open_jobs_report", total, num(obj(openJobs.totals).openJobs));
    const staleByDept = sum(arr(aging.staleByDepartment).map((r) => num(obj(r).staleOpenJobs)));
    truthy("INVARIANT", "job_aging: sum(staleByDept) <= stale>90", staleByDept <= stale, `${staleByDept} <= ${stale}`);
    live.staleOver90 = stale;
  }

  // ---- placements_report (YTD confirmed) -----------------------------------
  {
    const totals = obj(placements.totals);
    const total = num(totals.total);
    const byType = obj(totals.byType);
    const typeSum = num(byType.contract) + num(byType.contractToHire) + num(byType.directHire) + num(byType.other);
    eq("INVARIANT", "placements: byType sum == total", typeSum, total);
    const rowSum = sum(arr(placements.rows).map((r) => num(obj(r).total)));
    eq("INVARIANT", "placements: byDept + unmapped == total", rowSum + num(placements.otherOrUnmapped), total);
    live.confirmedPlacementsYTD = total;
  }

  // ---- sales_pipeline_report ----------------------------------------------
  {
    const total = num(obj(pipeline.totals).activeOpportunities);
    const rowSum = sum(arr(pipeline.rows).map((r) => num(obj(r).activeOpportunities)));
    const unmapped = num(obj(pipeline.otherOrUnmapped).department);
    eq("INVARIANT", "pipeline: byDept + unmapped == total", rowSum + unmapped, total);
    eq("CROSS-TOOL", "active opps: count_entity(isOpen:true) == sales_pipeline", num(countOpps.total), total);
    live.activeOpportunities = total;
  }

  // ---- recruiter_leaderboard ----------------------------------------------
  {
    const totals = obj(leaderboard.totals);
    const rowSum = sum(arr(leaderboard.rows).map((r) => num(obj(r).placements)));
    eq("INVARIANT", "leaderboard: sum(rows.placements) == total", rowSum, num(totals.placements));
    // Leaderboard placements (YTD confirmed) must equal the placements report's YTD confirmed total.
    eq("CROSS-TOOL", "confirmed placements YTD: leaderboard == placements_report", num(totals.placements), num(obj(placements.totals).total));
  }

  report(loadSnapshot(), bless, strict);
}

function isDesc(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[i - 1]) return false;
  return true;
}

function report(prev: Snapshot | null, bless: boolean, strict: boolean) {
  const pass = checks.filter((c) => c.ok);
  const fail = checks.filter((c) => !c.ok);

  console.log("\n  GOLDEN HARNESS — connector-side\n  " + "=".repeat(50));
  for (const kind of ["CROSS-TOOL", "INVARIANT"] as const) {
    console.log(`\n  [${kind}]`);
    for (const c of checks.filter((x) => x.kind === kind)) {
      console.log(`   ${c.ok ? "✓" : "✗"} ${c.name}\n       ${c.detail}`);
    }
  }

  // Snapshot / drift section
  console.log("\n  [SNAPSHOT / DRIFT]");
  const driftLines: string[] = [];
  for (const k of Object.keys(live).sort()) {
    const now = live[k];
    const was = prev?.[k];
    if (was === undefined) driftLines.push(`   ➕ ${k}: ${now} (new baseline)`);
    else if (was !== now) driftLines.push(`   ⚠ ${k}: ${was} → ${now} (drift ${now - was >= 0 ? "+" : ""}${now - was})`);
    else driftLines.push(`   ✓ ${k}: ${now} (unchanged)`);
  }
  console.log(driftLines.join("\n"));
  const drifted = prev ? Object.keys(live).some((k) => prev[k] !== undefined && prev[k] !== live[k]) : false;

  if (bless || !prev) {
    writeFileSync(SNAP_PATH, JSON.stringify(live, null, 2) + "\n");
    console.log(`\n  → snapshot ${prev ? "re-blessed" : "created"} at golden.snapshot.json`);
  }

  console.log("\n  " + "=".repeat(50));
  console.log(`  ${pass.length}/${checks.length} checks green${fail.length ? `  —  ${fail.length} FAILED` : ""}`);
  if (drifted) console.log(`  drift detected vs snapshot${strict ? " (strict: failing)" : " (warning)"}`);
  console.log("");

  const failed = fail.length > 0 || (strict && drifted);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\n  HARNESS ERROR (could not reach connector / Bullhorn):\n  ", err?.message ?? err, "\n");
  process.exit(2);
});
