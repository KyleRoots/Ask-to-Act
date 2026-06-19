---
name: Bullhorn résumés & Files API
description: Where candidate résumés live (parsed text on the record AND real file attachments), the LIVE-CONFIRMED Files API envelope shapes/quirks, and the REST rate limit that masquerades as flakiness.
---

# Where candidate résumés live (corp 28404 / swimlane 45)

Two real sources, both populated:
1. **Parsed text on the record:** `candidate.description` holds the parsed résumé
   (HTML for older hand-entered records, plain-ish text for bulk imports), ≈4k–100k chars.
2. **File attachments:** candidates DO have résumé files (PDF/.docx). An earlier note
   claimed files were "absent" — that was WRONG, caused by a listing bug (see below), not
   by missing data.

**How to apply:** a résumé reader should prefer extracted text from a *textual* résumé
attachment when one exists, else fall back to stripped `candidate.description`
(`get_candidate_resume` reports which via `resumeTextSource`). Do NOT try to read binary
(PDF/Word) attachment bytes as text — Bullhorn does no server-side text extraction, so
only text/html/rtf/csv yield content; binaries must degrade to metadata + "open in
Bullhorn / use the record's parsed text".

## Files API (read-only) — LIVE-CONFIRMED shapes & quirks
- Per-candidate accessors are the ONLY way in: `GET entityFiles/Candidate/{id}` (metadata
  list) and `GET file/Candidate/{id}/{fileId}` (one file, base64 content). No bulk/corp
  file listing. `FileAttachment` is NOT a queryable entity (`/query` and `/search` reject
  it as "Unknown or unsupported entityType").
- **CRITICAL: the list envelope key is `EntityFiles` (capital E/F)**, e.g.
  `{"EntityFiles":[{...}]}` — NOT `FileAttachments`/`fileAttachments`/`data`. Checking only
  those wrong keys returns count 0 for EVERY candidate and masks all files. Always include
  `EntityFiles` first in the key-pick list.
- **List entry splits the MIME type:** `contentType:"application"` + `contentSubType:"pdf"`
  (or `"vnd.openxmlformats-officedocument.wordprocessingml.document"`). Recombine into
  `application/pdf` before format detection. The single-file endpoint instead returns the
  FULL `contentType` (e.g. `application/vnd.openxmlformats-...`) under the `File`/`file`
  key with base64 in `fileContent`/`content`.
- **Attachment `description` is inconsistent:** sometimes the FULL parsed résumé text
  (hand-entered older records), sometimes just a label like `"Resume - <filename>.pdf"`
  (bulk imports). Do not treat it as reliable résumé text — use `candidate.description`.

## Binary detection gotcha (`isTextualContentType`)
Naively substring-matching `"xml"` in a content type FALSE-POSITIVES on
`application/vnd.openxmlformats-officedocument...` (the `.docx` MIME), so Office docs get
mis-read as text and return raw ZIP bytes (`PK\x03\x04…`) as "résumé text".
**Why:** `.docx/.xlsx/.pptx` are ZIP containers; their MIME/name contains text-looking
substrings. **How to apply:** exclude binary/office/pdf/zip/image types FIRST (match
`officedocument|opendocument|msword|ms-excel|ms-powerpoint|pdf|zip|vnd.|image/|...`), only
then allow text/* and a *word-bounded* xml/html/json/csv. Add a magic-byte safety net on
the decoded buffer (`PK\x03\x04` zip, `%PDF`, `\xD0\xCF\x11\xE0` OLE, or an embedded NUL)
so a mislabeled binary still degrades to metadata instead of emitting garbage.

## REST rate limit bites during probing
Bullhorn REST is **120 requests / 60s** (`RateLimit-Limit: 120; w=60`). Bursty probing
exhausts it and the MCP endpoint then returns an **empty body with no SSE `data:` line**
rather than a clean error — looks exactly like intermittent flakiness. Pace bulk/probe
calls with sleeps; a fresh 60s window resets `RateLimit-Remaining` to ~119.
