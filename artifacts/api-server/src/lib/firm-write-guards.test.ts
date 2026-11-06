import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheGet, cacheSet, invalidateFirmReadCache, responseCache } from "./cache.js";
import {
  applyNullClears,
  buildCandidateDuplicateLuceneQueries,
  phoneNeedles,
  BullhornFieldValidationError,
  createCandidateFromResume,
  createJobOrder,
  findLikelyCandidateDuplicates,
  isJobOrderPersistError,
  missingJobContactMessage,
  type BullhornWriteSession,
} from "./bullhorn-client.js";

const session: BullhornWriteSession = {
  BhRestToken: "tok",
  restUrl: "https://rest.example/rest-services/abc/",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateFirmReadCache("firm-a", [2958889, 3344979]);
  invalidateFirmReadCache("firm-b", [2958889]);
});

describe("write-path read cache", () => {
  it("drops the entity read, its notes, and the get_entity response for that id only", () => {
    const entityKey = "firm-a:fetch:entity/Candidate/2958889:[[\"fields\",\"id,occupation\"]]";
    const notesKey = "firm-a:fetch:entity/Candidate/2958889/notes:[[\"count\",50]]";
    const otherId = "firm-a:fetch:entity/Candidate/2958890:[[\"fields\",\"id\"]]";
    const otherFirm = "firm-b:fetch:entity/Candidate/2958889:[[\"fields\",\"id\"]]";
    cacheSet(entityKey, { data: { occupation: "old" } });
    cacheSet(notesKey, { data: [] });
    cacheSet(otherId, { data: { id: 2958890 } });
    cacheSet(otherFirm, { data: { occupation: "other firm" } });
    responseCache.set(
      'firm-a:get_entity:{"entityType":"Candidate","id":2958889}',
      "stale occupation",
    );
    responseCache.set(
      'firm-a:get_entity:{"entityType":"Candidate","id":2958890}',
      "other candidate",
    );

    invalidateFirmReadCache("firm-a", [2958889]);

    expect(cacheGet(entityKey)).toBeUndefined();
    expect(cacheGet(notesKey)).toBeUndefined();
    expect(cacheGet(otherId)).toEqual({ data: { id: 2958890 } });
    expect(cacheGet(otherFirm)).toEqual({ data: { occupation: "other firm" } });
    expect(responseCache.get('firm-a:get_entity:{"entityType":"Candidate","id":2958889}')).toBeUndefined();
    expect(responseCache.get('firm-a:get_entity:{"entityType":"Candidate","id":2958890}')).toBe("other candidate");
  });
});

describe("null clears a text field", () => {
  it("turns null into an empty string for a string field", () => {
    const body: Record<string, unknown> = { occupation: null, status: "Active" };
    applyNullClears("Candidate", body, new Map([
      ["occupation", { type: "SCALAR", dataType: "String" }],
    ]));
    expect(body).toEqual({ occupation: "", status: "Active" });
  });

  it("rejects null for a non-text field and writes nothing", () => {
    const body: Record<string, unknown> = { owner: null };
    expect(() =>
      applyNullClears("Candidate", body, new Map([
        ["owner", { type: "TO_ONE", dataType: "Integer" }],
      ])),
    ).toThrow(BullhornFieldValidationError);
    expect(body.owner).toBeNull();
  });
});

describe("résumé and job duplicate guards", () => {
  it("returns an existing candidate instead of creating a second one", async () => {
    const urls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      urls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("parseToCandidate")) {
        return json({
          candidate: {
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            phone: "(613) 555-0100",
            address: { city: "Ottawa" },
          },
        });
      }
      const parsed = new URL(String(url));
      if (parsed.pathname.includes("query/Candidate")) {
        throw new Error(`Candidate lookup must use /search, not ${parsed.pathname}`);
      }
      if (parsed.pathname.includes("search/Candidate")) {
        const query = parsed.searchParams.get("query") ?? "";
        if (query.startsWith('email:"ada@example.com"')) {
          return json({
            data: [{
              id: 3344979,
              name: "Ada Lovelace",
              dateLastModified: 1700000000000,
              owner: { firstName: "Quinn", lastName: "Recruiter" },
            }],
          });
        }
        return json({ data: [] });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    }));

    const result = await createCandidateFromResume(session, {
      fileName: "ada.pdf",
      fileBytes: Buffer.from("resume-bytes"),
    });

    expect(result).toMatchObject({
      created: false,
      matches: [{
        id: 3344979,
        name: "Ada Lovelace",
        owner: "Quinn Recruiter",
        dateLastModified: 1700000000000,
        matchedOn: ["email"],
      }],
    });
    if (!result.created) {
      expect(result.matches[0]?.bullhornUrl).toContain("entity=Candidate");
      expect(result.matches[0]?.bullhornUrl).toContain("id=3344979");
    }
    expect(urls.some((call) => call.method === "PUT")).toBe(false);
    expect(urls.some((call) => call.url.includes("query/Candidate"))).toBe(false);
    expect(urls.some((call) => call.url.includes("search/Candidate"))).toBe(true);
  });

  it("adds the last 10 digits when a phone number includes a country code", () => {
    expect(phoneNeedles(["+1 (613) 555-0100"])).toEqual([
      "+1 (613) 555-0100",
      "16135550100",
      "6135550100",
    ]);
    expect(phoneNeedles(["16135550100"])).toEqual([
      "16135550100",
      "6135550100",
    ]);
    expect(phoneNeedles(["(613) 555-0100"])).toEqual([
      "(613) 555-0100",
      "6135550100",
    ]);
    expect(phoneNeedles(["555-0100"])).toEqual(["555-0100"]);
  });

  it("builds the sample résumé Lucene clauses the architect can run live", () => {
    expect(buildCandidateDuplicateLuceneQueries({
      email: "ada.lovelace+lab@example.com",
      phone: "(613) 555-0100",
      firstName: "Ada",
      lastName: "Lovelace",
      city: "Ottawa",
    }).map((clause) => clause.query)).toEqual([
      'email:"ada.lovelace\\+lab@example.com" AND isDeleted:0',
      '(phone:"\\(613\\) 555\\-0100" OR mobile:"\\(613\\) 555\\-0100") AND isDeleted:0',
      '(phone:"6135550100" OR mobile:"6135550100") AND isDeleted:0',
      'firstName:"Ada" AND lastName:"Lovelace" AND address.city:"Ottawa" AND isDeleted:0',
    ]);
  });

  it("looks up candidates with /search and escapes Lucene special characters", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toContain("/search/Candidate");
      expect(parsed.pathname).not.toContain("query/Candidate");
      queries.push(parsed.searchParams.get("query") ?? "");
      return json({ data: [] });
    }));

    const identity = {
      email: "ada+smith@example.com",
      phone: "(613) 555-0100",
      firstName: "Ann(e)",
      lastName: 'O"Brien',
      city: "St. Louis",
    };
    const built = buildCandidateDuplicateLuceneQueries(identity);
    expect(built.map((clause) => clause.query)).toEqual([
      'email:"ada\\+smith@example.com" AND isDeleted:0',
      '(phone:"\\(613\\) 555\\-0100" OR mobile:"\\(613\\) 555\\-0100") AND isDeleted:0',
      '(phone:"6135550100" OR mobile:"6135550100") AND isDeleted:0',
      'firstName:"Ann\\(e\\)" AND lastName:"O\\"Brien" AND address.city:"St. Louis" AND isDeleted:0',
    ]);

    const matches = await findLikelyCandidateDuplicates(session, identity);
    expect(matches).toEqual([]);
    expect(queries).toEqual(built.map((clause) => clause.query));
  });

  it("does not search when the caller already confirmed a duplicate candidate", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("parseToCandidate")) {
        return json({ candidate: { email: "ada@example.com", firstName: "Ada", lastName: "Lovelace" } });
      }
      throw new Error(`unexpected ${url}`);
    }));

    await expect(createCandidateFromResume(session, {
      fileName: "ada.pdf",
      fileBytes: Buffer.from("resume-bytes"),
      allowDuplicate: true,
    })).rejects.toThrow();
    expect(urls.some((url) => url.includes("query/Candidate"))).toBe(false);
    expect(urls.some((url) => url.includes("search/Candidate"))).toBe(false);
  });

  it("returns an open job with the same title at the same client instead of creating", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const decoded = decodeURIComponent(String(url));
      expect(decoded).toContain("query/JobOrder");
      expect(decoded).toContain("title='Analyst'");
      expect(decoded).toContain("clientCorporation.id=42");
      return json({
        data: [{
          id: 9001,
          title: "Analyst",
          status: "Accepting Candidates",
          dateLastModified: 1700000000001,
          owner: { firstName: "Sam", lastName: "Lee" },
        }],
      });
    }));

    const result = await createJobOrder(session, {
      title: "Analyst",
      clientCorporationId: 42,
    });
    expect(result).toMatchObject({
      created: false,
      possibleDuplicateJobs: [{
        id: 9001,
        title: "Analyst",
        owner: "Sam Lee",
        status: "Accepting Candidates",
      }],
    });
  });

  it("explains a JobOrder persist failure by listing the client's contacts", () => {
    const err = new Error("Bullhorn write error (400): error persisting an entity of type: JobOrder");
    expect(isJobOrderPersistError(err)).toBe(true);
    const message = missingJobContactMessage(42, [{
      id: 77,
      name: "Pat Client",
      email: "pat@client.example",
      occupation: "Hiring Manager",
    }]);
    expect(message).toContain("clientContactId");
    expect(message).toContain("Pat Client (id 77)");
    expect(message).toContain("pat@client.example");
    expect(message).not.toMatch(/\b398\b/);
  });
});

describe("shared staffing text", () => {
  it("does not publish Myticas headcounts or example people", () => {
    const client = readFileSync(new URL("./bullhorn-client.ts", import.meta.url), "utf8");
    const mcp = readFileSync(new URL("./mcp-server.ts", import.meta.url), "utf8");
    for (const src of [client, mcp]) {
      expect(src).not.toContain("= 398");
      expect(src).not.toContain("metric = 23");
      expect(src).not.toContain("2650");
      expect(src).not.toContain("YTD 98");
      expect(src).not.toContain("FANUC");
      expect(src).not.toContain("Joseph Arbolera");
    }
  });
});
