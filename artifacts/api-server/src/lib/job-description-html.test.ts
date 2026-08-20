import { describe, it, expect } from "vitest";
import {
  applyFormattedJobDescriptions,
  companyAddressForJob,
  formatJobDescriptionHtml,
  normalizeJobOnSite,
  repairJobDescriptionHtml,
} from "./job-description-html.js";

describe("formatJobDescriptionHtml", () => {
  it("turns markdown-ish JD text into paragraphs, headings, and closed list items", () => {
    const html = formatJobDescriptionHtml(`
Role Overview
We need a systems engineer.

Main Responsibilities
- Project Coordination: Align teams.
- Risk Management: Mitigate risks.

Education and Experience Required
- Bachelor's degree
- Minimum of 5 years of relevant experience
`);
    expect(html).toContain("<h3>Role Overview</h3>");
    expect(html).toContain("<p>We need a systems engineer.</p>");
    expect(html).toContain("<h3>Main Responsibilities</h3>");
    expect(html).toMatch(/<ul>[\s\S]*<li>Project Coordination: Align teams\.<\/li>/);
    expect(html).toMatch(/<li>Risk Management: Mitigate risks\.<\/li>/);
    expect(html).toContain("</ul>");
    expect(html).not.toMatch(/<li>[^<]*<li>/);
  });

  it("escapes HTML in plain text input", () => {
    const html = formatJobDescriptionHtml("Need <script>alert(1)</script> skills");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("repairs unclosed li tags in existing HTML", () => {
    const broken = `<ul>
	<li><strong>A:</strong> one
	<li><strong>B:</strong> two
</ul>`;
    const fixed = repairJobDescriptionHtml(broken);
    expect(fixed).toMatch(/<li><strong>A:<\/strong> one<\/li>/);
    expect(fixed).toMatch(/<li><strong>B:<\/strong> two<\/li>/);
  });
});

describe("applyFormattedJobDescriptions", () => {
  it("mirrors a single description into publicDescription", () => {
    const fields: Record<string, unknown> = {
      description: "Hello\n\n- Item one",
    };
    applyFormattedJobDescriptions(fields);
    expect(fields.description).toEqual(fields.publicDescription);
    expect(String(fields.description)).toContain("<li>Item one</li>");
  });

  it("formats both fields when both are provided", () => {
    const fields: Record<string, unknown> = {
      description: "Internal note",
      publicDescription: "Public\n- Bullet",
    };
    applyFormattedJobDescriptions(fields);
    expect(fields.description).toContain("<p>Internal note</p>");
    expect(fields.publicDescription).toContain("<li>Bullet</li>");
  });
});

describe("normalizeJobOnSite", () => {
  it("maps remote / onsite aliases to picklist values", () => {
    expect(normalizeJobOnSite("remote")).toBe("Remote");
    expect(normalizeJobOnSite("Onsite")).toBe("On-Site");
    expect(normalizeJobOnSite("on-site")).toBe("On-Site");
    expect(normalizeJobOnSite(["Hybrid"])).toBe("Hybrid");
    expect(normalizeJobOnSite("fully remote WFH")).toBe("Remote");
  });
});

describe("companyAddressForJob", () => {
  it("copies company address fields without inventing a country", () => {
    expect(
      companyAddressForJob({
        address1: "160 Elgin Street Suite 2100",
        city: "Ottawa",
        state: "Ontario",
        zip: "K2P 2P7",
        countryID: 2216,
        countryName: "Canada",
      }),
    ).toEqual({
      address1: "160 Elgin Street Suite 2100",
      city: "Ottawa",
      state: "Ontario",
      zip: "K2P 2P7",
      countryID: 2216,
    });
  });

  it("returns null for empty or country-only stubs", () => {
    expect(companyAddressForJob({})).toBeNull();
    expect(companyAddressForJob(null)).toBeNull();
  });
});
