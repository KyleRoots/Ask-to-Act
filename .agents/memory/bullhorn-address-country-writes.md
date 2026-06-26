---
name: Bullhorn address/country writes
description: Non-obvious Bullhorn write semantics for a location's country and the address composite.
---

# Bullhorn address / country writes

Durable Bullhorn facts that the API does not make obvious:

- A location's **country is a numeric `countryID`** (a reference into Bullhorn's country list from the `options/Country` endpoint), NOT `countryName` or `countryCode`. On writes you must send the id; the name/code are read-only/derived and Bullhorn rejects them.
- `address` is a **composite object** (`address1, address2, city, state, zip, countryID`), not flat dotted fields. There is no `address.countryName`/`address.countryCode` field — guessing those returns "invalid field".
- Entities carry **more than one** address composite: e.g. Candidate `address` + `secondaryAddress`, ClientCorporation `address` + `billingAddress`. Any country fix must cover all of them, not just the one named `address`.

**Why this bit us:** the AI could create a JobOrder but couldn't set its country to "Egypt" — it tried a flat `address.countryName`/`countryCode` (invalid fields) and the raw country name (Bullhorn needs the id). The blocker was on our side, not a Bullhorn limitation.

**How to apply:** to set/change a country from the AI connector, pass an address composite with the country **by name** (resolved to `countryID` server-side) or a numeric `countryID` directly — e.g. `{ address: { countryName: "Egypt" } }` or `{ secondaryAddress: { countryName: "United States" } }`. Never invent flat `address.country*` fields.

**Silent no-op trap (Zod strips unlisted keys):** the dedicated `address` parameter on the update tools is a typed `z.object({...})`. Zod's DEFAULT is to **strip keys not declared in the object**, silently. The country resolver accepts `countryName`/`country`/`countryCode`, but if the typed schema only declares a subset, the AI's natural `country`/`countryCode` input is dropped BEFORE the resolver runs → the address collapses to `{}` → `isAddressLikeObject({})` is false → merge + resolve both skip it → an empty `address` is POSTed → Bullhorn returns **200 success but the country never changes**. Symptom: AI reports "update succeeded" yet verification still shows the old country. Fix = declare EVERY accepted alias (`countryName`, `country`, `countryCode`, `countryID`) on the typed address schema so the input keys survive to the resolver. **Why:** a success-with-no-change is far more confusing than an error; keep the write tool's input schema and the resolver's accepted keys in lockstep.
