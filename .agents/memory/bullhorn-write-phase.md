---
name: Bullhorn write phase — per-user OAuth + write tools
description: Architecture and gotchas for the per-user session system enabling write MCP tools under individual Bullhorn permission gates.
---

# Per-user session architecture

## How it works
1. Admin creates a user: `POST /api/users` → returns `apiKey` (shown once), `id`, `enrollUrl`
2. User opens `GET /api/auth/user/enroll?id=<userId>` in browser → redirected to Bullhorn OAuth
3. Bullhorn OAuth callback lands at shared `/api/auth/bullhorn/callback`
4. State encodes flow: plain hex = service-account, `user:{userId}:{random}` = user enrollment
5. `userIdFromState()` extracts userId from state; `completeUserEnrollment(userId, code)` saves tokens to DB

## Token routing in MCP
- `MCP_BEARER_TOKEN` → `req.caller = { kind: 'service' }` → reads only; write tools return plain-English error
- User's personal `apiKey` → `req.caller = { kind: 'user', userId }` → reads + writes under their Bullhorn session
- `createMcpServer(caller?)` in mcp-server.ts receives the caller from the Express route

## OAuth state: shared module
- `artifacts/api-server/src/lib/oauth-state.ts` owns `rememberState / consumeState / userIdFromState`
- Both `routes/auth.ts` and `routes/users.ts` import from here — no duplicate Maps
- State TTL: 10 minutes

## Per-user session refresh
- `getUserSession(userId)` checks `sessionExpiresAt`; if expired, calls `bhLogin` with stored `refreshToken`
- Sessions cached in-process (Map); DB is source of truth for tokens across restarts

## Shared callback trick
- Single `BULLHORN_REDIRECT_URI` handles BOTH service-account and user flows
- `userIdFromState(state)` returns null for service-account states → falls through to `completeAuthorization(code)`
- No need to register two redirect URIs with Bullhorn Support

**Why:** Bullhorn Support registration is slow; one URI = simpler ops.

## Write tool safety pattern
- `resolveWriteSession()` rejects service callers with a plain-English enrollment guide
- `BullhornPermissionError` (thrown by writeFetch on 403) → returned as `{error:"permission_denied", message}` not 500
- Write tools use `runWriteTool` (wraps withLogging, NOT runTool) — writes must never be cached

## Routes mounted
- `POST /api/users` — admin creates user
- `GET  /api/users` — admin lists users (no apiKey/tokens exposed)
- `DELETE /api/users/:id` — admin removes user + drops cached session
- `GET  /api/auth/user/enroll?id=` — user opens in browser, starts OAuth

## Write tools registered (3)
- `add_note` — POST /entity/Note; needs at least one of candidateId/jobOrderId/placementId
- `update_candidate_status` — PUT /entity/Candidate/{id}
- `create_job_submission` — POST /entity/JobSubmission; caller must supply sendingUserId (their Bullhorn user ID)
