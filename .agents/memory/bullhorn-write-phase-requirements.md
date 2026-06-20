---
name: AskToAct write-phase requirements & product differentiators
description: Durable product constraints for when the Bullhorn/ATS connector gains write (edit/update/create) capability, plus the multi-tenant onboarding approach. Read before designing any write tools or a new-customer onboarding flow.
---

# Write phase: deferred until read-only is fully validated

The connector is intentionally READ-ONLY first. Write/edit/update/create tools are
added only after the read side is confirmed correct in live ChatGPT testing.

# Constraint 1 — Per-user Bullhorn permission fidelity (core differentiator)

When write tools are added, every action MUST be gated by the **calling user's own
Bullhorn permission set**, not a single shared service identity. If a user cannot
edit a given record or field directly in Bullhorn, the AI must NOT be able to do it
on their behalf — it must surface a clear "you don't have permission to do X"
message and stop.

**Why:** this permission mapping is a key selling point and a trust/compliance
requirement — the connector must never let someone bypass their ATS permission gates
through the AI layer. Silent failures or acting as an over-privileged service account
would break the whole value proposition.

**How to apply:** design writes around per-user auth (the user's own Bullhorn
credentials/token + entitlements), detect permission errors from Bullhorn, and
translate them into plain-language "not allowed" responses rather than generic errors.

# Constraint 2 — Front-load full field-mapping discovery per tenant (monetization)

This is a monetized product for many Bullhorn customers (and eventually other ATSs).
For each NEW tenant, capture their full custom-field name -> human-label mapping at
IMPLEMENTATION time, not by stumbling on nuances in production (as happened with the
first tenant, Myticas — e.g. "Internal Department" living under a different custom
field name per entity).

**Why:** scalable onboarding; avoids the ad-hoc discovery pain of the first tenant.

**How to apply:** the `configuredCustomFields` backbone in `describe_entity` (built
from Bullhorn meta `label`s, no hardcoding) is the seed for this. A new-customer
onboarding step should sweep all entities, snapshot the label->field map, and feed it
into defaults/guidance so the connector "taps into everything from day one." Re-run
the sweep periodically since a tenant field remap silently changes the mapping.
