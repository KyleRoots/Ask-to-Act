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

# Robustness WITHOUT the guard-wormhole (how to avoid chasing "perfect")
- Rule: **guard a CLASS, not an INSTANCE.** A guard that kills a whole failure class (e.g. "never
  draw rankings/conclusions from a truncated list") is healthy. If a fix only handles ONE phrasing,
  that's the smell — promote it to a finished-answer tool instead of writing guard #5.
- "Not blocked by anything" (user req #1) CONTRADICTS compliance — compliance MEANS sometimes
  blocking. Redefine the target: **zero artificial/accidental blocks from OUR side; the only gate is
  the user's own ATS permissions, which we faithfully enforce.** That gating is the differentiator,
  not a flaw.
- The confidence engine = a **golden-answer regression harness run ACROSS models (GPT/Claude/Gemini)**.
  Turns "do we feel robust?" into "are all N golden checks green across every model?" It also signals
  when to STOP (suite green across models = done; don't chase the asymptote).
- Generalizing to ANY ATS = a **canonical adapter layer**: map each ATS's quirks ONCE (Bullhorn's
  correlatedCustomText1 etc.) into a normalized model; new ATS = one adapter + permission map +
  golden suite. "Any ATS" really means "any ATS with a built + golden-verified adapter" — bounded and
  repeatable, not magic/free.
- Define "done" explicitly: top ~N high-value questions consistent+accurate across all major models at
  target latency + permission gating verified = robust. The long tail is explicitly best-effort/steered.
- Speed = split: connector-side latency is OURS (cache/precompute/finished answers → sub-second);
  host-model reasoning time is theirs (don't chase). Finished answers improve BOTH accuracy and speed.

# Monetization lean (NO final decision as of 2026-06)
- Connector = flat "unlimited", BYO AI, ~zero COGS (host model pays), high margin, distribution/reach.
- Owned agent (possible later tier) = usage/seat-priced premium; REQUIRED for safe WRITE/automation;
  API cost incurred ONLY for that paid tier, funded by those customers.
- Speed: prompt-to-output latency is largely the host model's responsibility and fairly deflectable —
  BUT only if the output is correct. Slow+wrong still lands on Myticas's brand.
