---
name: GTM pricing recommendation 2026
description: Founding vs list pricing, connector build fees, proposal language, and sales floors for staffing firms.
---

# GTM pricing · finalized July 2026

Canonical constants live in `lib/gtm/src/messaging.ts` (`@workspace/gtm`). Exec-summary and pitch-deck import from there.

## Context
- **List MRR:** $499 platform + $29/active seat/month + $299/additional live connector
- **Founding MRR:** $399/mo flat · ≤10 active seats · 1 connector · month-to-month
- **Pilots:** Myticas + STSI — complimentary, production, not paying yet
- **COGS:** Near-zero variable (customer pays AI; Railway + Supabase scale cheaply)
- **Bullhorn:** connector live today · self-serve · no build fee
- **Other ATS:** one-time connector build, then standard MRR

## What target customers already pay
| Layer | Typical cost |
|---|---|
| Bullhorn ATS | ~$99–$165/user/mo |
| ChatGPT Team / Claude / Gemini | ~$25–$30/user/mo |
| **Stack without AskToAct** | **~$124–$195/user/mo** with no bridge |

## Copy-paste tax (ROI anchor)
- 6h/week × $60/hr burdened = **~$1,560/seat/mo**
- 10-seat desk = **~$15,600/mo** vs AskToAct list **$789/mo** (~20×) or founding **$399/mo** (~40×)

---

## Recurring pricing (public / Stripe target)

| Component | Price | Notes |
|-----------|-------|-------|
| Platform | **$499/mo** | Admin, audit logs, 1 live ATS connector included |
| Platform (annual) | **$4,990/yr** | ~2 months free vs monthly |
| Active seat | **$29/mo** | Billed only when seat uses bridge that month |
| Additional connector | **$299/mo** | Per extra *live* system beyond the first |
| Founding flat | **$399/mo** | ≤10 active seats · 1 connector · post-pilot cohort |
| White-glove Bullhorn | **$3,500** one-time | Optional; self-serve Bullhorn is free |

**Do not go below $299/mo total MRR** for any firm — signals hobby-tier infrastructure.

---

## Bullhorn onboarding — no connection fee

**Rule:** A new customer on a **different Bullhorn instance** pays **platform + active-seat MRR only**. There is **no** per-instance connection fee, setup fee, or build fee.

| Situation | Charge |
|-----------|--------|
| New Bullhorn firm (any instance) | **Included** in $499 platform / $399 founding |
| Self-serve enrollment | **$0** — ~30 minutes, live today |
| Complex mapping / training (optional) | **$3,500** white-glove one-time |
| Second system at same firm (e.g. + Salesforce) | **$299/mo** additional live connector |
| ATS we have not built yet (Greenhouse, etc.) | **$7,500–$15,000** one-time build, then MRR |

**Why:** The Bullhorn adapter already exists. A new firm is tenant provisioning (firm config, field map, OAuth enrollment), not a new engineering project. Revenue is the subscription — not a gate before they connect.

**Sales line:**
> "Bullhorn is live. Your instance connects on subscription — no connection fee. If you want us in the room for setup, white-glove is optional at $3,500."

**Do not** create a separate "Bullhorn connection fee" product line — it conflicts with "1 connector included" and the founding $399 conversion story.

---

## New ATS connector build (one-time) — proposal playbook

**When it applies:** prospect's ATS is **not Bullhorn**. Bullhorn firms never see this line item.

### Tier card (quote after 30-min scoping call)

| Tier | Price | ATS examples | Timeline |
|------|-------|--------------|----------|
| **Standard** | **$7,500** | Greenhouse, Lever, Ashby | 4–6 weeks |
| **Advanced** | **$12,500** | Vincere, Avionte, JobAdder | 6–8 weeks |
| **Enterprise** | **$15,000+** | Workday, custom / on-prem | Scoped SOW |

### What the build fee includes (selling points)

Frame this as **"production recruiting infrastructure,"** not "API wiring."

1. **Official ATS integration** — REST/API adapter on connect.asktoact.ai, not screen-scraping or unauthorized relay
2. **Permission bridge** — every write runs under the recruiter's own ATS identity (same moat as Bullhorn)
3. **Custom field mapping** — discovery + validation for *their* instance (status quirks, office fields, workflow stages)
4. **Recruiting tool surface** — read + write actions aligned to staffing workflows (search, submittals, notes, reports)
5. **Golden regression suite** — locked headline metrics verified across ChatGPT, Claude, and Gemini before go-live
6. **Multi-tenant deployment** — firm isolation, admin dashboard, enrollment, usage analytics
7. **30-day post-launch window** — accuracy tuning and recruiter feedback incorporated

**Recurring starts at go-live:** $499 platform + $29/active seat (or founding $399 if in cohort). Build fee does **not** replace MRR — it funds the adapter; MRR funds the highway.

### How to justify the range in a proposal

**Anchor against alternatives:**
| Alternative | Typical cost | AskToAct |
|-------------|--------------|----------|
| Custom dev shop / SI | $50k–$150k · 3–6 months | $7.5k–$15k · 4–8 weeks |
| Horizontal iPaaS (Zapier, Merge) | Cheap connect, no recruiting semantics | Domain depth + permission bridge + golden metrics |
| Bullhorn-native AI | Captive to stack, no BYO AI | Model-agnostic MCP bridge |
| Internal engineering hire | $120k+/yr + maintenance | Turnkey, maintained by us |

**ROI line for the build:**
> "Your 10-recruiter desk loses ~$15,600/mo to manual AI↔ATS transfer. A $7,500 one-time build pays back in **under two weeks** of recovered productivity — before counting audit trail, error reduction, or governance."

**Why tiered pricing:**
- **Standard ($7,500):** mature public API, documented auth, similar entity model to Bullhorn patterns we've already solved
- **Advanced ($12,500):** non-standard field models, multiple auth flows, or heavier custom-field mapping
- **Enterprise ($15,000+):** compliance review, on-prem gateways, or multi-environment SOW

**Proposal structure (suggested):**
1. Executive summary — copy-paste tax + BYO AI positioning
2. Scope — target ATS, seat count, read vs write requirements
3. Deliverables — bullet list from `CONNECTOR_BUILD_PRICING.deliverables` in messaging.ts
4. Timeline + milestones (discovery → adapter → golden suite green → pilot recruiters → go-live)
5. Investment — tier price + founding or list MRR table
6. Terms — 50% at SOW signature, 50% at go-live (or invoice via Stripe one-time product)

---

## Sales negotiation floors (internal only — not on marketing pages)

| Lever | Floor |
|-------|-------|
| Platform MRR | **$299/mo** (never lower) |
| Per active seat | **$15** hard · **$19** practical |
| Volume seat tiers (keep $499 platform) | 1–10: $29 · 11–25: $24 · 26–50: $19 · 51+: $15 |
| Connector build | Do not discount below **$7,500** without strategic trade (case study, multi-firm referral, prepay annual) |

**Prefer founding flat ($399/10 seats) over cutting per-seat** for small firms.

---

## Gross margin reference (after Stripe + infra)

| Scenario | Revenue | ~Net margin |
|----------|---------|-------------|
| 10 seats · founding | $399/mo | ~88% |
| 10 seats · list | $789/mo | ~91% |
| 25 seats · list | $1,224/mo | ~92% |
| Connector build (standard) | $7,500 one-time | ~90%+ (mostly labor, no AI COGS) |

Variable COGS per active seat: **~$0.10–0.50/mo** even at heavy usage today.

---

## ChatGPT directory

**Do not submit until:** first paid customer, webhook → `firms` billing gate, demo firm for reviewers. Listing is distribution; per-user API key + subscription gate is monetization.

---

## When to update Stripe

1. Create Stripe account (live mode when ready for first invoice)
2. Run `pnpm --filter @workspace/api-server run seed:stripe` — extend seed for full catalog (platform annual, connector add-on, founding coupon, one-time products)
3. Wire webhook → `firms.stripe_subscription_id` / `subscription_status`
4. Convert first pilot at founding $399

## Customer-facing URL
https://connect.asktoact.ai/exec-summary/customer

**Access control (production):** GTM pages are **not public**. Set Railway env vars:
- `GTM_MATERIALS_PASSWORD` — required in production; share with investors/prospects who should view
- `GTM_MATERIALS_USER` — optional (default `asktoact`)
- Without password in production → `/exec-summary` and `/pitch-deck` return **404**
- `GTM_MATERIALS_PUBLIC=true` — emergency bypass only (do not use in prod)

Also: `robots.txt` disallows `/exec-summary` and `/pitch-deck`; HTML carries `noindex`.

**GTM playbook** (this file + `lib/gtm/`) is **repo-only** — never served over HTTP.

---

## 30-day pilot check-in (Myticas, STSI)

Aligned with pitch deck slide **“The Ask”** — not a separate product; it is the conversion gate between complimentary pilot and founding $399/mo.

**When:** ~30 days after recruiters are actively using the connector (or at a calendar date you set at pilot kickoff).

**Who:** Firm admin + 1–2 active recruiters + you.

**Agenda (30–45 min):**

1. **Usage** — active seats, top tools used, any enrollment blockers (portal team-usage / admin dashboard).
2. **Wins** — specific tasks that used to be copy-paste (search, submittals, notes, reports).
3. **Friction** — connector prompts, Bullhorn OAuth, tool consent in ChatGPT, accuracy on their data.
4. **ROI gut-check** — “Roughly how much time per week did this save?” (anchor: 6h/wk = ~$1,560/seat/mo).
5. **Conversion** — offer founding rate: **$399/mo flat, ≤10 active seats, month-to-month**. Walk away if ROI isn’t there.
6. **Next step** — verbal yes → Stripe checkout link; not ready → extend pilot 30 days with one fix commitment.

**Closing line:**
> “The pilot was complimentary. Founding pricing locks in $399/mo before we move to list pricing at $499 + $29/seat. No annual contract — cancel anytime.”

**Do not discuss** connector build fee with Bullhorn pilots — that line applies only to non-Bullhorn prospects.
