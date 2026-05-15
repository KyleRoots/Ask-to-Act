import { getSession, invalidateSession } from "./bullhorn-auth.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 1;

async function bullhornFetch(
  path: string,
  params: Record<string, string | number>,
  retries = MAX_RETRIES,
): Promise<unknown> {
  const session = await getSession();
  const url = new URL(path, session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  let res = await fetch(url.toString(), {
    redirect: "follow",
  });

  if (res.status === 401 && retries > 0) {
    logger.warn("Bullhorn: 401 received, re-authenticating");
    await invalidateSession();
    return bullhornFetch(path, params, retries - 1);
  }

  if (res.status === 429) {
    throw new Error("Bullhorn API rate limit exceeded. Please try again shortly.");
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bullhorn API error (${res.status}): ${text}`);
  }

  return res.json();
}

async function searchEntity(
  entity: string,
  query: string,
  fields: string,
  count: number,
  start: number,
): Promise<unknown> {
  const session = await getSession();
  const url = new URL(`search/${entity}`, session.restUrl);
  url.searchParams.set("BhRestToken", session.BhRestToken);
  url.searchParams.set("query", query);
  url.searchParams.set("fields", fields);
  url.searchParams.set("count", String(count));
  url.searchParams.set("start", String(start));

  let res = await fetch(url.toString(), { redirect: "follow" });

  if (res.status === 401) {
    logger.warn("Bullhorn: 401 on search, re-authenticating");
    await invalidateSession();
    const session2 = await getSession();
    const url2 = new URL(`search/${entity}`, session2.restUrl);
    url2.searchParams.set("BhRestToken", session2.BhRestToken);
    url2.searchParams.set("query", query);
    url2.searchParams.set("fields", fields);
    url2.searchParams.set("count", String(count));
    url2.searchParams.set("start", String(start));
    res = await fetch(url2.toString(), { redirect: "follow" });
  }

  if (res.status === 429) {
    throw new Error("Bullhorn API rate limit exceeded. Please try again shortly.");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bullhorn search error (${res.status}): ${text}`);
  }
  return res.json();
}

async function queryEntity(
  entity: string,
  where: string,
  fields: string,
  count: number,
  start: number,
): Promise<unknown> {
  return bullhornFetch(`query/${entity}`, {
    where,
    fields,
    count,
    start,
    orderBy: "-dateAdded",
  });
}

async function getEntity(
  entity: string,
  id: number,
  fields: string,
): Promise<unknown> {
  return bullhornFetch(`entity/${entity}/${id}`, { fields });
}

export async function searchCandidates(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,status,occupation,primarySkills,address,dateAvailable,owner,dateAdded";
  return searchEntity("Candidate", args.query, fields, args.count ?? 20, args.start ?? 0);
}

export async function searchJobs(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,expiryDate,address,publicDescription";
  return searchEntity("JobOrder", args.query, fields, args.count ?? 20, args.start ?? 0);
}

export async function searchCompanies(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,name,phone,address,status,numStaff,industry,owner,dateAdded";
  return searchEntity(
    "ClientCorporation",
    args.query,
    fields,
    args.count ?? 20,
    args.start ?? 0,
  );
}

export async function searchContacts(args: {
  query: string;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,title,clientCorporation,status,owner,dateAdded";
  return searchEntity(
    "ClientContact",
    args.query,
    fields,
    args.count ?? 20,
    args.start ?? 0,
  );
}

export async function getCandidate(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,status,occupation,primarySkills,secondarySkills,educations,workHistory,address,salary,dateAvailable,owner,dateAdded,source,description";
  return getEntity("Candidate", args.id, fields);
}

export async function getJob(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,title,status,type,clientCorporation,owner,dateAdded,salary,employmentType,numOpenings,isOpen,expiryDate,address,publicDescription,skills,educationDegree,yearsRequired,startDate";
  return getEntity("JobOrder", args.id, fields);
}

export async function getCompany(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,name,phone,fax,address,status,numStaff,industry,revenue,description,owner,dateAdded,contacts";
  return getEntity("ClientCorporation", args.id, fields);
}

export async function getContact(args: { id: number; fields?: string }) {
  const fields =
    args.fields ??
    "id,firstName,lastName,email,phone,mobile,title,clientCorporation,status,owner,dateAdded,description";
  return getEntity("ClientContact", args.id, fields);
}

export async function listSubmissionsForJob(args: {
  jobId: number;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const fields =
    args.fields ??
    "id,candidate,jobOrder,status,dateAdded,sendingUser,salary,payRate";
  return queryEntity(
    "JobSubmission",
    `jobOrder.id=${args.jobId}`,
    fields,
    args.count ?? 50,
    args.start ?? 0,
  );
}

export async function listPlacements(args: {
  candidateId?: number;
  jobId?: number;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.candidateId) conditions.push(`candidate.id=${args.candidateId}`);
  if (args.jobId) conditions.push(`jobOrder.id=${args.jobId}`);
  if (conditions.length === 0) {
    conditions.push("id IS NOT NULL");
  }
  const where = conditions.join(" AND ");
  const fields =
    args.fields ??
    "id,candidate,jobOrder,status,dateAdded,dateBegin,dateEnd,salary,payRate,clientBillRate";
  return queryEntity("Placement", where, fields, args.count ?? 50, args.start ?? 0);
}

export async function getNotes(args: {
  candidateId?: number;
  jobId?: number;
  fields?: string;
  count?: number;
  start?: number;
}) {
  const conditions: string[] = [];
  if (args.candidateId) conditions.push(`candidates.id=${args.candidateId}`);
  if (args.jobId) conditions.push(`jobOrder.id=${args.jobId}`);
  if (conditions.length === 0) {
    conditions.push("id IS NOT NULL");
  }
  const where = conditions.join(" AND ");
  const fields =
    args.fields ??
    "id,action,body,commentingPerson,candidates,jobOrder,dateAdded";
  return queryEntity("Note", where, fields, args.count ?? 50, args.start ?? 0);
}
