---
name: Bullhorn Note Lucene search empty
description: How to report /search/Note returning total 0 to Bullhorn Support (connector cannot fix).
---

# Bullhorn Note search index returns 0

## Symptom (corp / REST swimlane for Myticas — rest45)

- `GET /search/Note?query=id:[1 TO *]` → `total: 0`
- `GET /search/Note?query=id:7218418` → `total: 0` even though
  `GET /entity/Note/7218418` returns the note
- `GET /query/Note?...` → 400 `Query operation not supported for Note`
  (expected: Note is an indexed /search-only entity)

So Notes exist and are readable by id / via Candidate `notes` association, but
the Lucene search index for Note appears empty or not updating.

## What we already ruled out

- Not an AskToAct connector bug: entity + association reads work; search totals
  are Bullhorn's authoritative Lucene counts.
- Not "wrong query syntax": even exact id and open range return 0.

## How to open with Bullhorn Support

**Severity:** Feature broken / data access — search API unusable for Notes.

**Subject:** Lucene `/search/Note` returns total 0 for all queries while
`/entity/Note/{id}` succeeds

**Body (paste-ready):**

> Corp token / cluster: rest45 (cls45). Note entity is search-indexed per REST
> docs, so we use `/search/Note` (not `/query`). Every Lucene query returns
> `total: 0` and empty `data`, including:
> - `id:[1 TO *]`
> - `id:<knownNoteId>` for a note that `GET entity/Note/<id>` returns successfully
> - `action:"…"` and `comments:…` variants
>
> `/query/Note` correctly returns “Query operation not supported for Note”.
> Candidate nested `notes(...)` and `GET entity/Candidate/{id}/notes` return
> notes normally.
>
> Please confirm whether the Note search index is disabled, failing to rebuild,
> or stuck for this corporation, and restore `/search/Note` indexing so action /
> comment / personReference filters work again.

Attach: one sample Note id + Candidate id, timestamps, REST URL host.

## Workaround in AskToAct

`get_notes(candidateId|jobId)` via associations + `scout_qualified_by_department`
(department → Response applicants → per-candidate notes). Not a substitute for
global Note search.
