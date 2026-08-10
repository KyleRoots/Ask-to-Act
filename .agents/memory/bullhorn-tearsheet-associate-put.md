---
name: Tearsheet candidate add needs PUT
description: add_candidates_to_tearsheet failed in prod because we used POST (entity update) instead of PUT (ASSOCIATE) on the to-many path.
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
