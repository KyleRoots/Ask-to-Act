/** Shared GTM / pricing copy for exec-summary, pitch-deck, and sales materials. */

/** Primary AI platforms customers already pay for (use in body copy). */
export const AI_TOOLS_SHORT = "ChatGPT, Claude, or Gemini";

/** Stacking-cost line for ROI / pricing sections. */
export const AI_SUBSCRIPTION_COST_RANGE = "$25–$30/user on ChatGPT, Claude, or Gemini";

export const TOOL_SUMMARY = "62+ recruiting actions (33 read · 29 write)";

export const PILOT_FIRMS = [
  {
    name: "Myticas Consulting",
    note: "Bullhorn ATS · staffing",
  },
  {
    name: "STSI",
    note: "Bullhorn ATS · custom field mappings live",
  },
] as const;

/** Stripe list prices (target catalog; seed script may lag). */
export const LIST_PRICING = {
  platform: 499,
  platformAnnual: 4990,
  perActiveSeat: 29,
  additionalConnector: 299,
  whiteGloveSetup: 3500,
} as const;

/**
 * One-time fee to build a net-new ATS adapter (customer does not use Bullhorn).
 * Bullhorn firms skip this — connector is live and self-serve today.
 */
export const CONNECTOR_BUILD_PRICING = {
  label: "New ATS connector build",
  standard: 7500,
  advanced: 12500,
  enterprise: 15000,
  rangeLabel: "$7,500–$15,000",
  tiers: [
    {
      key: "standard" as const,
      price: 7500,
      atsExamples: "Greenhouse, Lever, Ashby",
      timeline: "4–6 weeks",
    },
    {
      key: "advanced" as const,
      price: 12500,
      atsExamples: "Vincere, Avionte, JobAdder",
      timeline: "6–8 weeks",
    },
    {
      key: "enterprise" as const,
      price: 15000,
      atsExamples: "Workday, custom / on-prem",
      timeline: "Scoped SOW",
    },
  ],
  deliverables: [
    "Production ATS adapter on connect.asktoact.ai (official REST/API integration)",
    "Permission map — every write under the recruiter's own ATS identity",
    "Custom field discovery, mapping, and validation rules for the customer's instance",
    "Recruiting-domain tool surface (read + write) aligned to their workflow",
    "Golden regression suite — locked metrics verified across ChatGPT, Claude, and Gemini",
    "Admin onboarding path + recruiter self-serve enrollment",
    "30-day post-launch support and accuracy tuning window",
  ],
  recurringNote:
    "One-time build fee. Standard MRR ($499 platform + $29/active seat) begins at go-live. Additional live connectors $299/mo each.",
  proposalAnchor:
    "A custom integration shop quotes $50k–$150k and 3–6 months. AskToAct delivers a golden-verified recruiting bridge in weeks on infrastructure already running in production.",
} as const;

export const ONBOARDING = {
  bullhornLive: "Bullhorn connector live today · self-serve enrollment · ~30 minutes",
  bullhornIncluded:
    "Each new Bullhorn firm (any instance) is included in platform MRR — no connection or setup fee. We provision tenant isolation, field mapping, and recruiter enrollment on the adapter already in production.",
  whiteGloveOptional: `Optional white-glove Bullhorn onboarding · $${LIST_PRICING.whiteGloveSetup.toLocaleString()} one-time`,
  additionalConnectorNote:
    "$299/mo applies to a second live system at the same firm (e.g. Bullhorn + Salesforce) — not another Bullhorn customer.",
} as const;

/** Sales rule: when to charge what for connections (canonical). */
export const CONNECTION_PRICING_RULES = {
  bullhornNewFirm: {
    charge: "Included in platform MRR ($499 / $399 founding)",
    summary: "Same ATS we already built — new tenant only, no engineering project.",
  },
  newAtsType: {
    charge: CONNECTOR_BUILD_PRICING.rangeLabel + " one-time, then MRR at go-live",
    summary: "Net-new adapter + golden suite — not included in subscription.",
  },
  secondSystemSameFirm: {
    charge: `$${LIST_PRICING.additionalConnector}/mo per additional live connector`,
    summary: "Second system alongside the first (e.g. ATS + CRM).",
  },
  bullhornHandsOn: {
    charge: `$${LIST_PRICING.whiteGloveSetup.toLocaleString()} optional one-time`,
    summary: "Guided setup when self-serve is not enough — never mandatory.",
  },
} as const;

/**
 * Recommended founding-customer conversion offer after free pilot.
 */
export const FOUNDING_PRICING = {
  label: "Founding customer rate (post-pilot)",
  flatUpTo10Seats: 399,
  includes: "Up to 10 active seats · 1 ATS connector · month-to-month",
  note: "List pricing ($499 platform + $29/active seat) applies after founding cohort fills or end of 2026.",
} as const;

export const ROI_10_SEAT = {
  askToActList: 789,
  askToActFounding: 399,
  productivityLost: 15600,
  hoursPerWeek: 6,
  burdenedHourly: 60,
} as const;

/** Internal sales negotiation floors — not for public marketing pages. */
export const SALES_FLOORS = {
  platformMrr: 299,
  perActiveSeatHard: 15,
  perActiveSeatPractical: 19,
  volumeSeatTiers: [
    { minSeats: 1, maxSeats: 10, perSeat: 29 },
    { minSeats: 11, maxSeats: 25, perSeat: 24 },
    { minSeats: 26, maxSeats: 50, perSeat: 19 },
    { minSeats: 51, maxSeats: null, perSeat: 15 },
  ],
} as const;
