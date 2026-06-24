---
name: Bullhorn full write-back surface
description: Cross-cutting patterns and Bullhorn API gotchas for the expanded create/update/file write tools (built on the per-user write rails).
---

# Expanded write surface (jobs, companies, contacts, tasks, appointments, tearsheets, placements, files)

All new write fns live in `bullhorn-client.ts` (after `findUsers`) and are registered as `writeTool()`s in `mcp-server.ts`. They reuse the per-user rails (see bullhorn-write-phase.md): `writeFetch` + `resolveWriteSession` + `runWriteTool`. MCP-connector only — never added to the public OpenAPI/Custom GPT door (`routes/openapi.ts`), which must stay GET-only + read-only `POST /count`.

## Cross-cutting helpers (the durable design)
- `validateWriteFields(entity, body, {mode})` — pre-flight via `meta/{entity}`. **Fails OPEN** on meta error (Bullhorn stays final authority). Rejects unknown field names always; on `create` also rejects missing `required && !readOnly` non-system fields. Required-check trusts Bullhorn meta's `required` flag — if it ever over-blocks a field Bullhorn auto-defaults, that's the lever to relax.
- `assertPicklistValue(entity, field, value)` — validates against `listFieldOptions`; fails open when not a picklist.
- `checkDuplicate(session, entity, where, ...)` — generalized from the old `checkExistingSubmission`; throws `BullhornDuplicateError` with existing ID. Applied to: company(name), contact(first+last+company), tearsheet(name+owner), placement(candidate+job). NOT applied to jobs/tasks/appointments (legit duplicates).
- Errors thrown (BullhornFieldValidationError / BullhornDuplicateError) propagate as normal MCP tool errors so the AI sees the message; only `BullhornPermissionError` is special-cased to `permission_denied` by `runWriteTool`.

## Bullhorn write-API gotchas
- **Write dates are epoch milliseconds**, not ISO. Convert with the existing `toEpochMillis(value,label)` before putting in a write body (dateBegin/dateEnd etc).
- **Tearsheet membership** = to-many association endpoint with NO body: `POST|DELETE entity/Tearsheet/{id}/candidates/{comma,ids}`. `writeFetch(...,undefined)` sends no body — correct.
- **File upload is a SEPARATE door** from JSON `entity/`: multipart `PUT file/{Entity}/{id}` (FormData + Blob, Node 24 has both globals). Built a dedicated `fileFetch` that mirrors writeFetch's 403/429/error contract but does NOT force `Content-Type: application/json` (FormData sets its own boundary). Query params carry `externalID`, `fileType` (default `SAMPLE`), `description`.
- **`resume/parseToCandidate` does NOT persist** — it returns `{candidate, skillList, ...}`. Flow = parse → take whitelisted scalar fields → merge overrideFields (overrides win) → `validateWriteFields` → `PUT entity/Candidate` → best-effort attach original file via `uploadFileToRecord`.

## Testing limit
File/résumé upload + `create_candidate_from_resume` paths could not be live-tested (no live Bullhorn file creds in this env). Wiring/annotations/connector-only are covered by `src/lib/mcp-write-tools.test.ts` (introspects `server._registeredTools` for write annotations; asserts no write op leaks into `/api/openapi.json`).
