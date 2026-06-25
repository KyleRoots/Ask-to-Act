import { describe, it, expect } from "vitest";
import {
  isResponseStatus,
  isTrueSubmission,
  classifySubmissionStage,
} from "./submission-status.js";

describe("submission-status classification", () => {
  it("treats inbound applicant statuses as Response, not submissions", () => {
    for (const s of ["New Lead", "Online Applicant", "new lead", "  ONLINE APPLICANT  "]) {
      expect(isResponseStatus(s)).toBe(true);
      expect(isTrueSubmission(s)).toBe(false);
      expect(classifySubmissionStage(s)).toBe("response");
    }
  });

  it("treats recruiter-actioned statuses as true submissions", () => {
    for (const s of [
      "Internally Submitted",
      "Client Submission",
      "Pipeline",
      "Candidate Interested",
      "Offer Extended",
      "Offer Accepted",
      "Onboarding",
      "Client Rejected",
      "Interview No Show",
    ]) {
      expect(isTrueSubmission(s)).toBe(true);
      expect(isResponseStatus(s)).toBe(false);
      expect(classifySubmissionStage(s)).toBe("submission");
    }
  });

  it("defaults unknown/blank status to submission (conservative for the exclusion guard)", () => {
    for (const s of ["", "   ", undefined, null, "Some Future Status"]) {
      expect(isTrueSubmission(s)).toBe(true);
      expect(classifySubmissionStage(s)).toBe("submission");
    }
  });
});
