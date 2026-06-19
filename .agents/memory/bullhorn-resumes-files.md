---
name: Bullhorn résumés & Files API
description: Where candidate résumés actually live (parsed text on the record, not files), how the read-only Files API endpoints/shapes behave, and the REST rate limit that masquerades as flakiness.
---

# Where candidate résumés live (corp 28404 / swimlane 45)

In this corp, **candidate résumés are stored as parsed HTML in `candidate.description`**,
NOT as file attachments. Live evidence: 20/20 recent candidates had full résumé HTML in
`description` (≈4k–100k chars); candidate FILE attachments are effectively **absent** —
probed the most-recent candidates, 58 *placed* candidates, and scattered older IDs and
found **zero** files.

**Why this matters:** "read me candidate X's résumé" should read + HTML-strip
`candidate.description` as the PRIMARY path. Bulk-imported candidates (high IDs, ~985k
total) get description text set directly with no underlying file, so the Files API is a
real but rarely-populated secondary path here.

**How to apply:** a résumé reader should prefer extracted text from a *textual* résumé
attachment when one exists, else fall back to stripped `candidate.description`. Do NOT
download binary (PDF/Word) attachments hoping for text — Bullhorn does no server-side
text extraction, so only text/html/rtf/csv/etc. yield content; binaries degrade to
metadata + "open in Bullhorn".

## Files API (read-only) — accessors & shapes
- Per-candidate file accessors are the ONLY way in: `GET entityFiles/Candidate/{id}`
  (attachment metadata list) and `GET file/Candidate/{id}/{fileId}` (one file, base64
  content). There is no bulk/corp-level file listing.
- **`FileAttachment` is NOT a queryable entity** — both `/query` and `/search` reject it
  ("Unknown or unsupported entityType"). The generic entity catalog rightly excludes it;
  use the entityFiles/file endpoints instead.
- Documented file envelope (handle DEFENSIVELY — could not be live-confirmed because this
  corp has no candidate files): list under `FileAttachments`/`fileAttachments`/`data`;
  single file under `File`/`file` with base64 in `fileContent`/`content`, plus
  `contentType`/`name`/`type`/`dateAdded`. Tolerate these key variants and degrade to
  metadata-only when content is binary or absent.

## REST rate limit bites during probing
Bullhorn REST is **120 requests / 60s** (`RateLimit-Limit: 120; w=60`). Bursty probing
exhausts it and the MCP endpoint then returns an **empty body with no SSE `data:` line**
rather than a clean error — looks exactly like intermittent flakiness. Pace bulk/probe
calls with sleeps; a fresh 60s window resets `RateLimit-Remaining` to ~119.
