import { describe, it, expect } from "vitest";
import { applyCountryIdToAddress, BullhornFieldValidationError } from "./bullhorn-client.js";
import { addressFieldSchema } from "./mcp-server.js";

// Bullhorn stores a location's country as a numeric `countryID` (a reference
// into its country list), never as a name/code. These tests cover the pure
// transform that turns user-friendly country input into the countryID Bullhorn
// requires on write, given a pre-fetched name -> id map.

const COUNTRY_MAP = new Map<string, number>([
  ["united states", 1],
  ["egypt", 70],
  ["united kingdom", 222],
]);

describe("applyCountryIdToAddress", () => {
  it("resolves a country name to its numeric countryID and strips the name alias", () => {
    const body: Record<string, unknown> = { address: { city: "Cairo", countryName: "Egypt" } };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body.address).toEqual({ city: "Cairo", countryID: 70 });
  });

  it("matches the country name case-insensitively and trims whitespace", () => {
    const body: Record<string, unknown> = { address: { countryName: "  egYPt  " } };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body.address).toEqual({ countryID: 70 });
  });

  it("accepts the `country` and `countryCode` aliases as name input", () => {
    const viaCountry: Record<string, unknown> = { address: { country: "United Kingdom" } };
    applyCountryIdToAddress(viaCountry, COUNTRY_MAP);
    expect(viaCountry.address).toEqual({ countryID: 222 });

    const viaCode: Record<string, unknown> = { address: { countryCode: "United States" } };
    applyCountryIdToAddress(viaCode, COUNTRY_MAP);
    expect(viaCode.address).toEqual({ countryID: 1 });
  });

  it("passes through a numeric countryID and coerces a numeric string id", () => {
    const numeric: Record<string, unknown> = { address: { countryID: 70 } };
    applyCountryIdToAddress(numeric, COUNTRY_MAP);
    expect(numeric.address).toEqual({ countryID: 70 });

    const stringId: Record<string, unknown> = { address: { countryID: "70" } };
    applyCountryIdToAddress(stringId, COUNTRY_MAP);
    expect(stringId.address).toEqual({ countryID: 70 });
  });

  it("prefers an explicit numeric countryID over a name and still drops the name alias", () => {
    const body: Record<string, unknown> = { address: { countryID: 1, countryName: "Egypt" } };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body.address).toEqual({ countryID: 1 });
  });

  it("throws a helpful error for an unknown country name", () => {
    const body: Record<string, unknown> = { address: { countryName: "Wakanda" } };
    expect(() => applyCountryIdToAddress(body, COUNTRY_MAP)).toThrow(BullhornFieldValidationError);
    expect(() => applyCountryIdToAddress(body, COUNTRY_MAP)).toThrow(/not a recognized Bullhorn country name/i);
  });

  it("is a no-op when there is no address object", () => {
    const body: Record<string, unknown> = { status: "Accepting Candidates" };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body).toEqual({ status: "Accepting Candidates" });
  });

  it("resolves secondaryAddress and billingAddress (any address composite, not just `address`)", () => {
    const candidate: Record<string, unknown> = {
      firstName: "Sam",
      secondaryAddress: { city: "Cairo", countryName: "Egypt" },
    };
    applyCountryIdToAddress(candidate, COUNTRY_MAP);
    expect(candidate.secondaryAddress).toEqual({ city: "Cairo", countryID: 70 });

    const company: Record<string, unknown> = {
      name: "Acme",
      billingAddress: { countryName: "United Kingdom" },
    };
    applyCountryIdToAddress(company, COUNTRY_MAP);
    expect(company.billingAddress).toEqual({ countryID: 222 });
  });

  it("resolves multiple address composites in a single body", () => {
    const body: Record<string, unknown> = {
      address: { countryName: "Egypt" },
      secondaryAddress: { countryName: "United States" },
    };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body.address).toEqual({ countryID: 70 });
    expect(body.secondaryAddress).toEqual({ countryID: 1 });
  });

  it("never mistakes an association ref ({ id }) for an address", () => {
    const body: Record<string, unknown> = {
      clientCorporation: { id: 16172 },
      owner: { id: 99 },
    };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body).toEqual({ clientCorporation: { id: 16172 }, owner: { id: 99 } });
  });

  it("leaves non-country address sub-fields untouched", () => {
    const body: Record<string, unknown> = {
      address: { address1: "1 St", city: "Cairo", state: "Cairo", zip: "11511", countryName: "Egypt" },
    };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body.address).toEqual({
      address1: "1 St",
      city: "Cairo",
      state: "Cairo",
      zip: "11511",
      countryID: 70,
    });
  });
});

// Regression: the typed `address` parameter on the update tools must KEEP every
// country alias the resolver accepts. Zod strips undeclared keys by default, so
// a missing alias silently drops the AI's input before the name→countryID
// lookup runs — the address collapses to {} and the write becomes a "200
// success but country never changed" no-op. These tests pin the schema boundary.
describe("addressFieldSchema (MCP tool-arg validation)", () => {
  const schema = addressFieldSchema.unwrap();

  it.each(["countryName", "country", "countryCode"])(
    "preserves the `%s` country alias through validation (does not strip it)",
    (key) => {
      const parsed = schema.parse({ city: "Cairo", [key]: "Egypt" });
      expect(parsed).toEqual({ city: "Cairo", [key]: "Egypt" });
    },
  );

  it("preserves a numeric countryID", () => {
    expect(schema.parse({ countryID: 70 })).toEqual({ countryID: 70 });
  });

  it("preserves the standard address sub-fields together", () => {
    const input = {
      address1: "1 St",
      address2: "Apt 2",
      city: "Cairo",
      state: "Cairo",
      zip: "11511",
      countryName: "Egypt",
    };
    expect(schema.parse(input)).toEqual(input);
  });

  it("end-to-end: a country alias survives validation AND resolves to countryID", () => {
    // Mirrors the failing ChatGPT flow: AI sends the country via the `countryCode`
    // alias, the value reaches the resolver, and persists as the numeric id.
    const validated = schema.parse({ countryCode: "Egypt" });
    const body: Record<string, unknown> = { address: validated };
    applyCountryIdToAddress(body, COUNTRY_MAP);
    expect(body.address).toEqual({ countryID: 70 });
  });
});
