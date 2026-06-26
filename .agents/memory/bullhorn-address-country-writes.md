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

**ChatGPT won't use the nested address object — it FLATTENS to dotted keys:** across many fresh-thread attempts and deploys, ChatGPT never once sent `address: { countryName: "Egypt" }`. It always emits dotted top-level keys in the generic fields param (`address.countryName`, `address.countryCode`) — which Bullhorn rejects as invalid fields — and falls back to a bare `address: "Egypt"` string (Bullhorn 500). Better tool descriptions did NOT change this. **The durable fix is AI-behavior-agnostic: accept the notation ChatGPT actually uses.** `foldDottedAddressKeys` (bullhorn-client.ts) runs at the top of `validateWriteFields` (the universal write chokepoint) and folds any `<composite>.<subfield>` key whose SUBFIELD is an address sub-field back into the nested composite, before validation. Keyed on the subfield (not the prefix) so non-address dotted keys like `clientCorporation.id` are untouched, and an invalid folded prefix still fails validation. **Why:** fighting the model's tool-call style is a losing game; make the server tolerant of both nested and dotted address input.

**Silent no-op trap (Zod strips unlisted keys):** the dedicated `address` parameter on the update tools is a typed `z.object({...})`. Zod's DEFAULT is to **strip keys not declared in the object**, silently. The country resolver accepts `countryName`/`country`/`countryCode`, but if the typed schema only declares a subset, the AI's natural `country`/`countryCode` input is dropped BEFORE the resolver runs → the address collapses to `{}` → `isAddressLikeObject({})` is false → merge + resolve both skip it → an empty `address` is POSTed → Bullhorn returns **200 success but the country never changes**. Symptom: AI reports "update succeeded" yet verification still shows the old country. Fix = declare EVERY accepted alias (`countryName`, `country`, `countryCode`, `countryID`) on the typed address schema so the input keys survive to the resolver. **Why:** a success-with-no-change is far more confusing than an error; keep the write tool's input schema and the resolver's accepted keys in lockstep.
