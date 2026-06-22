---
name: Connector-vs-owned-agent strategy & determinism ceiling
description: Why AskToAct leans connector-first (BYO AI), what the connector can/can't guarantee, and the finished-answer-tool lever toward model-agnostic consistency.
---

# Market signal (the anchor)
- Multiple internal anonymous user surveys: users OVERWHELMINGLY prefer "bring your own AI"
  (their own ChatGPT/Claude/Gemini) + a connector giving full end-to-end ATS capability INSIDE
  their existing AI — NOT a separate Myticas-hosted chat app. Strong pull toward connector-first.

# What the connector CAN vs CANNOT guarantee
- CAN: deterministic, correct DATA. Tools (locked metrics + report tools) return identical correct
  numbers (398 / by-office 239·99·47·12·1 ; stale 108, STS-STSI 78) on EVERY call regardless of
  which host model asks. This part is solved.
- CANNOT: force the host model to CALL the right tool or stop editorializing. The variance lives in
  the host model's tool-selection/reasoning, which is OUTSIDE the connector boundary.
  **A robust integration is necessary but NOT sufficient for consistent output — capability ≠ discipline.**
- Proven in testing: flagship models (GPT medium) misread STANDARD Bullhorn data NOT from lack of
  capability but because Bullhorn's schema is idiosyncratic (office=correlatedCustomText1, isOpen vs
  status, decoy owner accounts named like offices) and models default to a general pattern
  (page records + aggregate) instead of calling the specialized report tools.

# The lever toward model-agnostic determinism (fits connector + zero-API-cost thesis)
- Shift from "model composes the answer from data" → "tool returns the FINISHED, phrased answer; the
  model just relays it." The more the answer is pre-composed server-side, the smaller the
  GPT-vs-Claude variance — with NO API cost to us (the host model still pays).
- Supporting guardrails: fewer/sharper tools; raw record-list tools should refuse/redirect to
  count_entity / report tools on "how many / by-X" intent; partial-page guards (never rank or pick
  "worst/most" from a truncated list — the #5 failure mode).
- Realistic ceiling: the top ~20-30 high-value questions can reach near-deterministic via
  finished-answer tools; arbitrary long-tail ad-hoc questions will always carry host-model variance.

# Monetization lean (NO final decision as of 2026-06)
- Connector = flat "unlimited", BYO AI, ~zero COGS (host model pays), high margin, distribution/reach.
- Owned agent (possible later tier) = usage/seat-priced premium; REQUIRED for safe WRITE/automation;
  API cost incurred ONLY for that paid tier, funded by those customers.
- Speed: prompt-to-output latency is largely the host model's responsibility and fairly deflectable —
  BUT only if the output is correct. Slow+wrong still lands on Myticas's brand.
