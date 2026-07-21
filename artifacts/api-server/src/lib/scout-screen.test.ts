import { describe, it, expect } from "vitest";
import { buildDepartmentJobsQuery } from "./scout-screen.js";

describe("buildDepartmentJobsQuery", () => {
  it("builds open-jobs query for any department string", () => {
    expect(buildDepartmentJobsQuery("STS-STSI", true)).toBe(
      'correlatedCustomText1:"STS-STSI" AND isOpen:true AND NOT status:Archive AND isDeleted:false',
    );
    expect(buildDepartmentJobsQuery("MYT-Ottawa", true)).toBe(
      'correlatedCustomText1:"MYT-Ottawa" AND isOpen:true AND NOT status:Archive AND isDeleted:false',
    );
  });

  it("escapes quotes inside department names", () => {
    expect(buildDepartmentJobsQuery('MYT-"Special"', true)).toContain(
      'correlatedCustomText1:"MYT-\\"Special\\""',
    );
  });

  it("omits open-jobs lock when openJobsOnly is false", () => {
    expect(buildDepartmentJobsQuery("STS-STSI", false)).toBe(
      'correlatedCustomText1:"STS-STSI" AND isDeleted:false',
    );
  });

  it("rejects blank department", () => {
    expect(() => buildDepartmentJobsQuery("  ", true)).toThrow(/department/);
  });
});
