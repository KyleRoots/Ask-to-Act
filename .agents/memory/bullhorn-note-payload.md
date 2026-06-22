---
name: Bullhorn Note write payload
description: Required fields and correct structure for PUT /entity/Note — missing personReference causes silent 400
---

# Bullhorn Note Write Payload

## The Rule
Every `PUT entity/Note` MUST include `personReference: { id: <candidateId> }`.
Without it Bullhorn returns `400: error persisting an entity of type: Note` with
no further detail.

The `noteEntities` array must use `targetEntityID` (not `person: { id }`) per
Bullhorn REST schema.

## Correct minimum payload for a candidate note
```json
{
  "action": "General Notes",
  "comments": "...",
  "personReference": { "id": 4667024 },
  "noteEntities": [{ "targetName": "Candidate", "targetEntityID": 4667024 }]
}
```

**Why:** `personReference` is the primary entity link; `noteEntities` is the
to-many association list. Both are needed for the note to appear on the
candidate record in Bullhorn UI. Using `person.id` inside `noteEntities`
(instead of `targetEntityID`) is silently wrong and triggers the same 400.

**How to apply:** Any future Note write (to Contact, Lead, etc.) follows the same
pattern — set `personReference` to the primary person's ID, and
`noteEntities[].targetEntityID` for the association list.
