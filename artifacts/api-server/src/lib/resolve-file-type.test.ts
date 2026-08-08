import { describe, expect, it } from "vitest";
import {
  DEFAULT_CANDIDATE_FILE_TYPES,
  closestFileTypeOption,
  resolveBullhornFileType,
} from "./resolve-file-type.js";

const MYTICAS = [...DEFAULT_CANDIDATE_FILE_TYPES];

describe("resolveBullhornFileType", () => {
  it("maps Security Briefing Form → Screening (not Other)", () => {
    expect(
      resolveBullhornFileType({
        fileName: "96616470-MORAN__Kristopher_-_Security_Briefing_Form(5).pdf",
        description: "Security Briefing Form",
        availableTypes: MYTICAS,
      }),
    ).toBe("Screening");
  });

  it("maps resume filenames → Resume", () => {
    expect(
      resolveBullhornFileType({
        fileName: "Jane_Doe_Resume.pdf",
        availableTypes: MYTICAS,
      }),
    ).toBe("Resume");
    expect(
      resolveBullhornFileType({
        fileName: "cv_john_smith.docx",
        description: "Candidate CV",
        availableTypes: MYTICAS,
      }),
    ).toBe("Resume");
  });

  it("maps formatted resume wording → Formatted Resume", () => {
    expect(
      resolveBullhornFileType({
        fileName: "formatted_resume_jane.pdf",
        availableTypes: MYTICAS,
      }),
    ).toBe("Formatted Resume");
  });

  it("maps I-9 / payroll / onboarding / training / unemployment", () => {
    expect(
      resolveBullhornFileType({ fileName: "i9_form.pdf", availableTypes: MYTICAS }),
    ).toBe("I-9");
    expect(
      resolveBullhornFileType({
        fileName: "payroll_direct_deposit.pdf",
        availableTypes: MYTICAS,
      }),
    ).toBe("Payroll/HR");
    expect(
      resolveBullhornFileType({
        description: "Onboarding checklist",
        availableTypes: MYTICAS,
      }),
    ).toBe("Onboarding");
    expect(
      resolveBullhornFileType({
        fileName: "safety_training_cert.pdf",
        availableTypes: MYTICAS,
      }),
    ).toBe("Training");
    expect(
      resolveBullhornFileType({
        fileName: "unemployment_claim.pdf",
        availableTypes: MYTICAS,
      }),
    ).toBe("Unemployment");
  });

  it("lets explicit fileType win (closest-matched to firm options)", () => {
    expect(
      resolveBullhornFileType({
        fileName: "Security_Briefing_Form.pdf",
        description: "Security Briefing Form",
        fileType: "Resume",
        availableTypes: MYTICAS,
      }),
    ).toBe("Resume");
    expect(
      resolveBullhornFileType({
        fileName: "doc.pdf",
        fileType: "screening",
        availableTypes: MYTICAS,
      }),
    ).toBe("Screening");
  });

  it("closest-matches against firm-specific option labels", () => {
    const firm = ["Résumé", "Screen Docs", "Other Docs"];
    expect(
      resolveBullhornFileType({
        fileName: "security_briefing.pdf",
        availableTypes: firm,
      }),
    ).toBe("Screen Docs");
    expect(
      resolveBullhornFileType({
        fileName: "jane_resume.pdf",
        availableTypes: firm,
      }),
    ).toBe("Résumé");
  });

  it("falls back to Other when no hint matches", () => {
    expect(
      resolveBullhornFileType({
        fileName: "random_scan_001.pdf",
        availableTypes: MYTICAS,
      }),
    ).toBe("Other");
  });

  it("defaults to Myticas allowlist when availableTypes omitted", () => {
    expect(
      resolveBullhornFileType({
        fileName: "Security_Briefing_Form.pdf",
      }),
    ).toBe("Screening");
  });

  it("passes through unknown explicit types when no close option exists", () => {
    expect(
      resolveBullhornFileType({
        fileType: "CustomFirmType",
        availableTypes: MYTICAS,
      }),
    ).toBe("CustomFirmType");
  });
});

describe("closestFileTypeOption", () => {
  it("prefers exact case-insensitive matches", () => {
    expect(closestFileTypeOption("screening", MYTICAS)).toBe("Screening");
    expect(closestFileTypeOption("PAYROLL/HR", MYTICAS)).toBe("Payroll/HR");
  });
});
