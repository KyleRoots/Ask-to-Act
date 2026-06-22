/**
 * One-off anchor collector for the read-only SEARCH/RETRIEVAL validation batch.
 * Pulls fresh live counts + a couple of sample records to ground the ChatGPT
 * test suite. Read-only. Run: LOG_LEVEL=silent tsx src/golden/anchors.ts
 */
import {
  countEntity,
  searchCandidates,
  searchJobs,
  searchOpportunities,
  listCandidateAttachments,
} from "../lib/bullhorn-client.js";

const out: Record<string, unknown> = {};
async function step(name: string, fn: () => Promise<unknown>) {
  try {
    out[name] = await fn();
  } catch (e) {
    out[name] = { ERROR: e instanceof Error ? e.message : String(e) };
  }
}

// --- Counts (anchors) -------------------------------------------------------
await step("candidates_total", () => countEntity({ entityType: "Candidate" }));
await step("candidates_nonArchived", () =>
  countEntity({ entityType: "Candidate", query: "NOT status:Archive" }));
await step("candidates_javaText", () =>
  countEntity({
    entityType: "Candidate",
    query:
      "(skillSet:Java OR description:Java OR comments:Java OR occupation:Java)",
  }));
await step("candidates_secretClearanceText", () =>
  countEntity({
    entityType: "Candidate",
    query:
      '(description:"Secret clearance" OR comments:"Secret clearance" OR skillSet:"Secret clearance")',
  }));
await step("candidates_status_breakdown", () =>
  countEntity({ entityType: "Candidate", groupBy: "status" }));

await step("openJobs_total", () =>
  countEntity({ entityType: "JobOrder", query: "isOpen:true AND NOT status:Archive AND isDeleted:false" }));
await step("openJobs_byDept", () =>
  countEntity({
    entityType: "JobOrder",
    query: "isOpen:true AND NOT status:Archive AND isDeleted:false",
    groupBy: "correlatedCustomText1",
  }));
await step("openJobs_developerTitle", () =>
  countEntity({
    entityType: "JobOrder",
    query: 'isOpen:true AND NOT status:Archive AND isDeleted:false AND title:Developer',
  }));

await step("companies_total", () => countEntity({ entityType: "ClientCorporation" }));
await step("companies_statusActive", () =>
  countEntity({ entityType: "ClientCorporation", query: "status:Active" }));
await step("contacts_total", () => countEntity({ entityType: "ClientContact" }));

await step("opps_active", () => countEntity({ entityType: "Opportunity", query: "isOpen:true" }));
await step("opps_status_breakdown", () =>
  countEntity({ entityType: "Opportunity", groupBy: "status" }));

await step("submissions_total", () => countEntity({ entityType: "JobSubmission" }));

// --- Sample records for matching / notes / verification traps ---------------
await step("sample_open_jobs", () =>
  searchJobs({
    query: "isOpen:true AND NOT status:Archive AND isDeleted:false",
    count: 5,
    fields: "id,title,clientCorporation,correlatedCustomText1,status,isOpen",
  }));
await step("sample_clearance_candidates", () =>
  searchCandidates({
    keywords: [["Secret clearance", "Top Secret", "TS/SCI", "security clearance"]],
    count: 5,
    fields: "id,firstName,lastName,occupation,skillSet,status",
  }));
await step("sample_java_candidates", () =>
  searchCandidates({
    keywords: ["Java"],
    count: 3,
    fields: "id,firstName,lastName,occupation,skillSet,status",
  }));
await step("sample_active_opps", () =>
  searchOpportunities({
    query: "isOpen:true",
    count: 3,
    fields: "id,title,clientCorporation,status,customText1",
  }));

console.log(JSON.stringify(out, null, 2));
