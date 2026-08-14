---
name: Compliance & legislative readiness
description: Product + counsel backlog to become, stay, and scale compliant as a Bullhorn connector/processor — not legal advice.
---

# Compliance & legislative readiness

**Status:** Active backlog (started 2026-08-13)  
**Owner (program):** Kyle / Product · **Legal conclusions:** Counsel  
**Audience:** Eng, Product, Counsel  
**Not legal advice.** This is an internal product/ops checklist. Jurisdiction-specific conclusions, contract language, and “are we compliant?” answers belong to counsel.

## Purpose

Build a durable **Become → Stay → Scale** program so AskToAct can answer enterprise and regional privacy/AI-employment questions honestly: what we control in the connector, what the customer’s AI host and Bullhorn policies own, and what counsel must paper.

Agree with starting sooner rather than later — with caveats:

- Do **not** wait for counsel on every eng item (inventory, copy accuracy, confirm gates, audit design can start now).
- Do **wait** for counsel on DPA text, SCCs/transfer mechanisms, and any public claim of legal compliance or certification.
- Prefer **accurate underclaim** (“decision support; human decides”) over marketing overclaim (“no bias / no influence / GDPR-compliant”).

## Non-goals

- Replacing counsel or issuing legal opinions.
- Claiming SOC 2 / ISO / AI Act certification that does not exist.
- Making AskToAct the hire/no-hire decision-maker (we are a connector + ranked shortlist engine).
- Solving host-model behavior (ChatGPT/Claude/Gemini tool-choice and narration stay outside our boundary — see [connector-strategy.md](./connector-strategy.md)).

## Mental model (scoring & hiring — for customers)

| Layer | Owns | Does not own |
|-------|------|----------------|
| **AskToAct connector** | Deterministic search → hard criteria → **server-side** `scoreCandidate` / `rankCandidates` → ranked shortlist + evidence | Hire / no-hire; host narration |
| **Host AI (BYO)** | Interpretation, recommendation wording, which tools to call | Authoritative ATS permissions |
| **Human recruiter** | Decision to act; review before write | — |
| **Bullhorn** | System of record + user entitlements | — |

Code anchors: [`search-ranking.ts`](../../artifacts/api-server/src/lib/search-ranking.ts) (`scoreCandidate`), [`matching.ts`](../../artifacts/api-server/src/lib/matching.ts) (`match_candidates_for_job`), [candidate-matching.md](./candidate-matching.md), [candidate-search-quality.md](./candidate-search-quality.md).

Safe public claim: **AskToAct does not make hire/no-hire decisions.**  
Unsafe: “does not influence hiring” / “introduces no bias” (ranking and host AI shape attention).

---

## Phases

### Become (near-term — paper + honesty)

Ship the minimum enterprise-ready **processor posture**: accurate Privacy/Terms, DPA draft path, named subprocessors, retention/DSAR runbooks, retire overclaiming marketing language, document ranking fairness.

### Stay (ongoing — operate)

Keep controls live: confirm gates on hire-sensitive writes, audit that matches customer expectations, privacy copy vs actual retention (`email_send_logs`, note snapshots), firm suspend/offboard drills, counsel review cadence when regs change.

### Scale (enterprise / multi-region)

Residency/transfer options, SOC 2 (or equivalent) if buyers require attestation, richer immutable audit, optional fairness reviews of scoring weights, customer playbooks for host-AI policy.

---

## Checklist (owners)

Legend: **Counsel** · **Product** · **Eng** · Status = `done` | `partial` | `gap` | `n/a`

### A. Contracts & public legal copy

| Item | Owner | Status | Notes / links |
|------|-------|--------|---------------|
| Published Privacy Policy | Product + Eng | **partial** | Live at [`/privacy`](https://connect.asktoact.ai/privacy) — source [`legal.ts`](../../artifacts/api-server/src/routes/legal.ts). Categories of providers only; transient ATS claim needs reconciliation with durable logs (see §C). |
| Published Terms of Service | Product + Eng | **partial** | Live at [`/terms`](https://connect.asktoact.ai/terms) — same file. Processor-ish “on your behalf” language; no formal DPA. |
| Data Processing Agreement (DPA) template | Counsel | **gap** | Not in repo. Roles: customer = controller of ATS data; AskToAct = processor for connector processing; AI host = customer’s chosen third party. |
| Named subprocessors + change notice | Counsel + Product | **gap** | Privacy §5 lists **categories** (Bullhorn, payment, IdP, email, hosting, AI host) — not named vendors. |
| Transfer / SCC / residency narrative | Counsel + Eng | **gap** | Ops stack is US-hosted today (e.g. Supabase/Neon region notes in [backup-restore-drill.md](./backup-restore-drill.md)). No customer residency choice. |
| Jurisdiction schedule (GDPR / PIPEDA / CCPA / emerging AI employment) | Counsel | **gap** | Privacy §8: rights “depending on where you live” only. |
| SOC 2 / attestation language accuracy | Product + Eng | **gap** | Portal footer: “SOC2-ready” ([`App.tsx`](../../artifacts/portal/src/App.tsx)) — **not** an attestation. Replace until a report exists. |

### B. Product controls (already useful)

| Item | Owner | Status | Notes / links |
|------|-------|--------|---------------|
| Per-user Bullhorn OAuth on writes | Eng | **done** | [bullhorn-write-phase.md](./bullhorn-write-phase.md) |
| Firm-scoped runtime / tenant isolation | Eng | **partial** | [firm-lifecycle-status.md](./firm-lifecycle-status.md); [threat_model.md](../../threat_model.md); continue hardening |
| Firm suspend / archive cuts tools | Eng | **done** | Fail-closed in `requireBullhornFirm` |
| Bulk email confirmToken | Eng | **done** | `send-email-to-records.ts` — dryRun + confirmToken |
| Hire-sensitive write confirm gates (placement, status, etc.) | Eng + Product | **partial** | Mostly **prompt discipline** in MCP tool text; only email has server `confirmToken`. Gap: server-enforced confirm for placement / critical status if counsel wants it. |
| Matching transparency (pass/fail/unknown + evidence) | Eng | **done** | `eligibleMatches` / `needsVerification` + `resumeEvidence` |
| SSN / sensitive redaction on résumé paths | Eng | **partial** | Redaction at read chokepoints; keep inventory current |
| Disconnect / revoke paths | Product | **partial** | Described in Privacy §8; ensure ops runbook exists |

### C. Retention, snapshots, audit vs privacy copy

| Item | Owner | Status | Notes / links |
|------|-------|--------|---------------|
| Retention schedule with SLAs | Counsel + Product + Eng | **gap** | Privacy: “reasonable period” — need concrete TTLs per table. |
| Privacy copy vs `email_send_logs` | Product + Eng | **gap** | Table stores recipient email, subject, body preview/hash, status — durable audit ledger ([schema](../../lib/db/src/schema/email-send-logs.ts)). Privacy currently stresses transient ATS content; **reconcile copy** with what we retain for send audit. |
| Privacy copy vs note snapshots | Product + Eng | **gap** | Firm-scoped note snapshot for Scout when Lucene empty — [scout-note-snapshot-design.md](./scout-note-snapshot-design.md). Not “request-duration only.” Document purpose, retention, deletion. |
| `tool_usage` vs “full audit trail” | Product + Eng | **partial** | Monthly aggregates ([tool-usage schema](../../lib/db/src/schema/tool-usage.ts)) — marketing “audit trail” must not imply immutable per-field history. |
| Richer per-action audit (enterprise) | Eng + Product | **gap** | Design if buyers demand who/what/when per write with retention. |
| DSAR / export / deletion runbooks | Eng + Product + Counsel | **gap** | Today: contact email. Need firm/user offboard + export checklist. |

### D. Ranking, bias, host-AI guidance

| Item | Owner | Status | Notes / links |
|------|-------|--------|---------------|
| Document ranking signals & weights | Eng + Product | **partial** | Signals live in `search-ranking.ts` (`W.*`); publish customer-facing “how ranking works” (decision support, not hiring algorithm certification). |
| Bias / fairness documentation | Product + Counsel | **gap** | Honest: we score/rank; host may re-rank/narrate; human decides. Optional eng review of proxy signals (location, status, recency). |
| Customer guidance on host AI | Product | **gap** | One-pager: BYO AI processes ATS data under *their* policy; ask recruiters to verify before act; treat shortlists as assistive. Cross-link Privacy §4. |
| Completeness language in product | Eng | **done** | Partial status → “highest-ranked among N evaluated” ([candidate-matching.md](./candidate-matching.md)) |

### E. Scale / enterprise

| Item | Owner | Status | Notes / links |
|------|-------|--------|---------------|
| SOC 2 Type I/II program | Counsel + Eng | **gap** | Start when a buyer requires attestation; until then accurate language only. |
| Multi-region / residency SKUs | Eng + Product | **gap** | Architecture decision after counsel transfer analysis. |
| Golden harness across models (consistency ≠ fairness) | Eng | **partial** | [connector-strategy.md](./connector-strategy.md) — do not confuse cross-model green with bias clearance. |

---

## Current status vs gaps (executive)

**Have today**

- Live Privacy + Terms on connect.asktoact.ai.
- Strong connector controls: per-user writes, firm suspend, email confirmToken, matching evidence buckets.
- Transparent server-side ranking with reasons/scores returned to the host.

**Gaps blocking “mature processor” sales narrative**

1. No DPA / named subprocessors / transfer story.
2. Privacy “transient ATS” vs durable `email_send_logs` + note snapshots.
3. “SOC2-ready” marketing without attestation.
4. Hire-sensitive writes without server confirm (except email).
5. DSAR/export/deletion = email only; no retention SLA table.
6. No customer-facing ranking/bias + host-AI guidance pack.

---

## Near-term first work items (start without waiting for counsel on everything)

These are ordered for eng/product velocity. Counsel can parallelize DPA independently.

1. **Privacy/Terms accuracy pass (Eng + Product)** — Inventory durable stores (`email_send_logs`, note snapshot tables, `tool_usage`, OAuth tokens, report_jobs). Draft Privacy §2/§6 edits so retention claims match reality. Counsel reviews before publish.
2. **Retire or qualify “SOC2-ready” (Product + Eng)** — Change portal footer (and any deck copy) to language that does not imply certification (e.g. “security-minded” / omit until report exists).
3. **Ranking & hiring decision-support brief (Product + Eng)** — 1–2 page internal/customer note: server scores via `scoreCandidate`; host may narrate; human decides; what we will / won’t claim. Cite matching memory docs.
4. **Hire-sensitive confirm design spike (Eng)** — Proposal to extend `confirmToken`-style gates (or equivalent) to `create_placement` and high-risk status updates; estimate UX cost vs enterprise need. Implement only after Product prioritizes.
5. **DSAR / offboard runbook v0 (Eng + Product)** — Checklist: suspend firm, revoke tokens, delete/export user rows, email_send_logs retention, note-snapshot purge. Counsel later maps to legal timelines.
6. **Named subprocessors draft list (Product)** — Internal spreadsheet of actual vendors (Clerk, Stripe, Railway, Supabase/Neon, SendGrid, Microsoft Graph for mail, OpenAI/Anthropic/etc. as customer-chosen). Counsel turns into public schedule + DPA exhibit.

---

## Cross-links

| Resource | Path |
|----------|------|
| Privacy / Terms routes | `artifacts/api-server/src/routes/legal.ts` → `/privacy`, `/terms` |
| Matching ownership | [candidate-matching.md](./candidate-matching.md), [candidate-search-quality.md](./candidate-search-quality.md) |
| Connector boundary | [connector-strategy.md](./connector-strategy.md) |
| Firm offboard | [firm-lifecycle-status.md](./firm-lifecycle-status.md) |
| Note snapshot retention surface | [scout-note-snapshot-design.md](./scout-note-snapshot-design.md) |
| Backup / region ops | [backup-restore-drill.md](./backup-restore-drill.md) |
| Threat model | [`threat_model.md`](../../threat_model.md) |
| Prior counsel-ready framing | Parent chat 2026-08-13 (Kyle Q on regional + bias) |

---

## Cadence

- **Weekly (Product):** tick near-term items; no silent “compliant” claims in sales decks.
- **Monthly (Eng):** confirm privacy copy still matches schema (new tables = update this checklist).
- **Counsel:** DPA/subprocessors/transfers on their clock; eng does not invent legal text.

## Changelog

| Date | Change |
|------|--------|
| 2026-08-13 | Project opened; Become/Stay/Scale checklist seeded from product investigation. |
