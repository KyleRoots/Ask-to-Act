---
name: Bullhorn custom-field label mapping
description: Bullhorn custom fields have opaque API names; their real meaning lives in the meta `label`. Includes this corp's known JobOrder mappings.
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

**Known JobOrder mappings for this corp (Myticas / corp 28404):**
- `correlatedCustomText1` = **Internal Department** (owning office/branch).
  Observed values: `STS-STSI` (largest), `MYT-Ottawa`, `MYT-Chicago`,
  `MYT-Clover`, `MYT-Ohio`. Populated on virtually all jobs; `categories` /
  `publishedCategory` are mostly empty — never group jobs by those.
