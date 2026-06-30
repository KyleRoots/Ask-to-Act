/** Shared GTM copy. Keep pitch deck and exec-summary aligned manually for now. */

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

/** Stripe list prices (wired in billing today). */
export const LIST_PRICING = {
  platform: 499,
  perActiveSeat: 29,
  additionalConnector: 299,
  whiteGloveSetup: 3500,
} as const;

/**
 * Recommended founding-customer conversion offer after free pilot.
 * Validate against Myticas + STSI feedback before changing Stripe.
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
