---
name: Bullhorn custom-field label mapping
description: Bullhorn custom fields have opaque API names; their real meaning lives in the meta `label`. Includes this corp's cross-entity "Internal Department" mapping and the describe_entity configuredCustomFields backbone.
---

# Bullhorn custom fields are opaque — map them via meta `label`

**Rule:** Bullhorn stores private-label custom fields under generic API names
(`customText1..40`, `correlatedCustomText1..10`, `customInt*`, `customDate*`,
etc.). The human-readable name a user sees in the Bullhorn UI is only available
as the field's `label` in the entity metadata (`meta/<Entity>?meta=basic`). An
LLM/client that doesn't know the mapping will guess a plausible standard field
(e.g. `categories`) and get wrong/empty answers.

**Why:** a user asked ChatGPT which "Internal Department" held the most open jobs;
it grouped by `categories` (empty on the vast majority of jobs) and reported a
wrong answer, because the real value lives in an opaquely-named custom field.

**How to apply:**
- Surface the `label` for every field in `describe_entity` so labels → API names
  is discoverable generically (the meta `label` is non-sensitive UI text).
- For the curated tools, return the relevant custom field by default and name it
  in the tool description so the model uses it without guessing.
- Keep the REAL field name in inputs and outputs (don't alias to a friendly key)
  so reads and Lucene/`where` filters stay symmetric — both
  `correlatedCustomText1:"X"` and `correlatedCustomText1='X'` work.
- This is single-tenant config: validate periodically via the meta `label`, since
  a Bullhorn field remap would silently change the mapping.

# "Internal Department" uses a DIFFERENT API name per entity (the headline gotcha)

The same business concept ("Internal Department" = owning office/branch, values
like `STS-STSI`, `MYT-Ottawa`, `MYT-Chicago`, `MYT-Clover`, `MYT-Ohio`) is stored
under a different custom field on each entity. Never assume one name everywhere:

- JobOrder → `correlatedCustomText1` (≈100% populated)
- Placement → `correlatedCustomText1` (≈100%)
- ClientContact → `customText1` (≈100%)
- Lead → `customText1` (≈94%)
- Opportunity → `customText1` (≈86%)
- Candidate → `customText3` (only ≈8% populated — sparse; get-only default)

`categories` / `publishedCategory` are mostly empty — never group by those.

# Steering trap: AIs group jobs by OWNER, not Internal Department (decoy accounts)

When asked "by office/branch/location/region", models (incl. GPT on medium power)
will reach for a job's OWNER/houseOwner or a literal `branch`/`address` field
instead of `correlatedCustomText1`. This corp has owner/user accounts NAMED after
offices (e.g. "MYT-Ottawa House"), so the wrong path looks plausible and returns a
believable-but-tiny number (filtering by owner "MYT-Ottawa House" → 1 open job vs
the true 99 via `correlatedCustomText1:"MYT-Ottawa"`). Models also tend to hand-roll
office/aging breakdowns from a record list instead of calling the report tools.

**Why:** caught in live testing — a single batch produced 3 wrong/abandoned answers
(office snapshot, MYT-Ottawa count, stale-jobs-by-office) all from owner-vs-department
confusion plus the decoy account naming; numbers themselves were fine.

**How to apply:** tool descriptions must explicitly say office = `correlatedCustomText1`
ONLY, name the decoy ("owner accounts named like offices are NOT the office"), tell the
model to ignore empty `branch`/`address`/`categories`, and route any by-office / aging
ask to `count_entity` groupBy `correlatedCustomText1` or the open_jobs_report /
job_aging_report tools. Description-only steering (no logic) — ships on next deploy.

# `describe_entity` backbone: `configuredCustomFields`

`describe_entity` returns a top-level `configuredCustomFields` array (subset of
`fields`) so a client can map a Bullhorn UI label → real API name without scanning
100–300 fields. It is computed by `isConfiguredCustomField(name,label)`: name must
be `custom*`/`correlatedCustom*` AND the label must be meaningful (not equal to the
API name and not a generic default like "Custom Text 1", "Custom Text Block 10",
"Custom Encrypted Text 1", "Custom 10", "Custom Object1s").

**Why a heuristic, not a hardcoded list:** labels are the single source of truth and
survive tenant remaps; hardcoding tenant field names rots silently. Keep it generic.

**Key distinction — discovery vs. defaults:**
- `configuredCustomFields` lists every CONFIGURED field even if it is currently
  EMPTY (e.g. Placement "Net Margin %", "Exempt", "Per Diem Rule") — it is a
  label→name map for discovery, not a claim of fill.
- Curated/`ENTITY_CATALOG` DEFAULT fields only include POPULATED fields, so default
  reads aren't padded with empty columns that mislead the model.

**Other populated customs promoted to defaults (Myticas):** JobOrder `customText2`
= Client Job Title; Placement `customText29` = External ID, `customDate1` = Original
End Date (epoch ms), `customText2` = Currency Unit; Lead `customText20` = External
ID. Candidate `customText1` = Visa Type (sparse, discover-only). Sanity-checked live
labels can drift — trust `describe_entity` over this list if they disagree.
