---
name: Per-firm custom-field resolver (Internal Department)
description: How AskToAct resolves Bullhorn custom-field API names per firm, and why the Myticas service firm keeps NO config row.
---

Bullhorn custom fields ("Internal Department") map to different opaque API names
per tenant. The read path resolves them per firm instead of hardcoding Myticas'.

**Design**
- `firm_config` table (firm_id PK, field_map jsonb) holds a DISCOVERED map per firm.
- `resolveDeptField(firmId, entity)` returns the firm's discovered field, else a
  per-entity Myticas fallback, else null. The fallback is applied **per entity**
  (`resolved ?? MYTICAS_DEPT_FIELDS[entity]`), so a partial/missing discovery
  still degrades safely entity-by-entity.
- A field name read back from persisted JSON is re-validated against a safe
  field-name regex before being used in any query (defense against tampered config).
- Discovery detects the field by the entity's configured-custom-field **label**
  (normalized "internal department", then controlled synonyms only when exactly
  one field carries that label — never guess when ambiguous).
- The `internalDepartment` groupBy on count_entity is a semantic alias resolved
  to the firm's field BEFORE field-name validation — this is the model-agnostic
  lever that makes department analytics work for any firm (it can also auto-
  discover the department VALUES from a data sample when none are passed).

**Why the Myticas (auth_mode='service') firm has NO firm_config row**
The byte-identical guarantee lives in `resolveDeptField`'s per-entity fallback,
NOT in a stored row. Leaving Myticas rowless means it always uses the known-good
fallback. A persisted row would only stay byte-identical if every DETECTED field
exactly matched the fallback — verified once live (all 6 entities matched exactly;
CorporateUser has no such field), but keeping the row out removes all ambiguity.
**How to apply:** new firms run discovery (POST /api/firms/:id/discover-config);
the service firm intentionally stays on the fallback path.

**Guard (don't let an admin break the invariant):** discovery is refused for any
firm whose `auth_mode='service'` at TWO layers — the discover-config route returns
409 ("built-in service configuration … managed by the platform") before any
Bullhorn call, and `discoverFirmConfig` itself skips the persist+cache-invalidate
as a backstop if called directly. Both key off `getFirmAuthMode(firmId)`.
**Why:** the admin "New Organization" wizard exposes a "Bullhorn setup" button on
EVERY firm including the service firm; one stray click would otherwise write a
firm_config row for Myticas and silently change its byte-identical behaviour.

**Known deferred (Myticas-specific, not yet per-firm):** reports.ts still uses a
fixed `DEPARTMENTS` value list and reads the placement department via a hardcoded
record property; only the count-based report groupBy fields go through the
resolver. Full per-firm reports need per-firm department VALUE lists + dynamic
placement-property reads.
