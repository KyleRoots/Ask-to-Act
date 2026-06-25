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

## createCandidateFromResume / parseToCandidate write-path gotchas
The parse endpoint fails in a sequence of *distinct* errors, each masking the next:
1. Raw binary body + `application/octet-stream` → **500 "Bad File Uploaded"** (endpoint
   demands `multipart/form-data`; send a `FormData` part, do NOT set Content-Type).
2. multipart but `format` in **lowercase** (e.g. `docx`) → **422 "Error occurred while
   parsing resume"**. Bullhorn's parser requires the UPPERCASE enum
   `PDF/DOC/DOCX/RTF/TEXT/HTML/ODT`. Lowercase is accepted as multipart but mis-parses.
3. base64 with a `data:<mime>;base64,` prefix (ChatGPT sometimes prepends it) → corrupt
   bytes → parse/upload failure. Strip the prefix before `Buffer.from(...,"base64")`.
**Why:** the error *changes* at each fix, so it looks like a brand-new bug each deploy.
**How to apply:** when résumé upload "still fails" but the error TEXT changed, that is
progress — you cleared one layer; fix the next, do not revert.

## Body-size limit silently kills base64 file uploads (Express 100kb default)
File-upload tools (parseToCandidate/createCandidateFromResume, file attachments)
carry the file as a **base64 string inside the JSON request body**. Express's
`express.json()` defaults to a **100kb** body cap, and base64 inflates bytes ~33%.
A real document (e.g. a 161KB .docx → ~215KB base64) exceeds 100kb and the request
is rejected with 413 **before it ever reaches the tool** — the client just sees a
generic failure / "truncated" body and may try to downconvert the file (ChatGPT
re-encoded the .docx to plain .txt to shrink it).
**Why:** the cap is upstream of all tool logic, so it looks like a parser/encoding
bug, not a body-limit bug. Both MCP and REST go through the same `express.json()`,
so one limit governs both doors.
**How to apply:** raise the limit ONLY on the upload route (the MCP endpoint
`/api/mcp` is the sole file-upload door — REST/OpenAPI never carries files), keep
the global `express.json`/`urlencoded` small (1mb). Scope it by mounting
`app.use("/api/mcp", express.json({limit:"25mb"}))` BEFORE the global parser —
body-parser sets `req._body` so the global one skips already-parsed requests. Put
the rate limiter BEFORE the body parsers so oversized bodies are throttled before
allocation (DoS). A blanket 25mb global limit ahead of rate limiting is a DoS
amplification risk — don't. If résumé/file upload "fails" for big files but works
for tiny ones, suspect the body cap first.

## REST rate limit bites during probing
Bullhorn REST is **120 requests / 60s** (`RateLimit-Limit: 120; w=60`). Bursty probing
exhausts it and the MCP endpoint then returns an **empty body with no SSE `data:` line**
rather than a clean error — looks exactly like intermittent flakiness. Pace bulk/probe
calls with sleeps; a fresh 60s window resets `RateLimit-Remaining` to ~119.
