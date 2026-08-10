---
name: Tearsheet membership = PUT associate (multi-entity)
description: Tearsheet add/remove uses PUT associate / DELETE disassociate on TO_MANY paths; supports candidates, contacts, jobs, leads, opportunities from Tearsheet meta.
---

# Tearsheet membership = PUT associate, not POST

**Symptom (2026-08):** Runa Parmar created tearsheet "Salesforce FSC Architect Toronto"
(ID 1650) via AskToAct successfully; `add_candidates_to_tearsheet` failed even
one-at-a-time. Tearsheet remained empty (`candidateCount: 0`).

**Root cause (connector bug):** `addCandidatesToTearsheet` called
`POST entity/Tearsheet/{id}/candidates/{ids}`. Bullhorn REST uses:

- **PUT** `entity/{Entity}/{id}/{assoc}/{ids}` → ASSOCIATE
- **DELETE** same path → disassociate
- **POST** `entity/{Entity}/{id}` → update entity fields (wrong for membership)

Official refs: [REST API — Create To-many Associations](https://bullhorn.github.io/rest-api-docs/),
[Creating a Submission (tearsheet step)](https://bullhorn.github.io/Creating-a-Submission/).
Bullhorn Help also documents `POST massUpdate/Tearsheet` with
`{candidates:{add:[…]},ids:[tearsheetId]}` as a bulk alternate — not required
once PUT associate works.

**Not the cause:** TearsheetMember entity (this instance has `candidates` as
TO_MANY → Candidate on Tearsheet meta). Create-permission was fine (owner=Runa).
Memory previously documented the wrong verb (`POST|DELETE`).

**Fix:** switch add to PUT (also Task `secondaryOwners` association — same verb).
After deploy, Runa (or anyone) can re-run `add_candidates_to_tearsheet` on 1650.

## Multi-entity membership (verified via describe_entity Tearsheet, Myticas cls45)

Tearsheet TO_MANY shortlist associations (path segment → entity):

| Association field | Entity | Count scalar |
|---|---|---|
| `candidates` | Candidate | `candidateCount` |
| `clientContacts` | ClientContact | `clientContactCount` |
| `jobOrders` | JobOrder | `jobOrderCount` |
| `leads` | Lead | `leadCount` |
| `opportunities` | Opportunity | `opportunityCount` |

Also on meta but **not** treated as shortlist membership tools:

- `users` → CorporateUser (sheet sharing / collaborators)
- `recipients` → TearsheetRecipient (delivery recipients)

MCP tools:

- `add_candidates_to_tearsheet` / `remove_candidates_from_tearsheet` — candidate convenience wrappers
- `add_records_to_tearsheet` / `remove_records_from_tearsheet` — `entityType` + `ids` (max 50) for all five member types above

Client helpers: `addRecordsToTearsheet` / `removeRecordsFromTearsheet` with allowlist
`TEARSHEET_MEMBER_ENTITIES`. Always PUT for add, DELETE for remove; no body.
