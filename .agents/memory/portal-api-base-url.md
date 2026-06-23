---
name: Portal API base URL
description: Why portal fetch calls must use /api/... not ${basePath}/api/... — silently routes to wrong server.
---

**Rule:** All `fetch()` calls in the portal that target the api-server must use `/api/...` (bare absolute path), never `${basePath}/api/...`.

**Why:** The portal is mounted at `/portal/`. Using `${basePath}/api/...` produces `/portal/api/...`, which the Replit proxy routes back to the portal's own Vite dev server (not the api-server). The Vite server 404s the request silently — no CORS error, no network error in most cases, just a failed response. The api-server is always mounted at `/api/` and is reachable from any artifact via that absolute path.

**How to apply:**
- `portalApi` functions in `portal/src/lib/api.ts`: use `fetch('/api' + path, ...)` ✅
- `Support.tsx` form submit: use `fetch('/api/support', ...)` ✅
- Any future portal page that calls the backend: use `/api/...` not `${basePath}/api/...`
- Admin portal (`admin/src/lib/api.ts`) already does this correctly with `const API_BASE = "/api"` — follow the same pattern.
- In production, same rule applies: the api-server is co-hosted at `/api/`.
