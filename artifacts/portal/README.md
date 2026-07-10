# Customer portal (`/portal`)

React SPA for firm admins and recruiters: dashboard, MCP connector URL, team usage (admins), and support.

Served by the api-server at `https://connect.asktoact.ai/portal/` in production.

## Auth (Clerk)

- **Identity:** Clerk Production instance (not Development shared OAuth).
- **Proxy:** `https://connect.asktoact.ai/api/__clerk` — set in Clerk Domains via proxy URL (not Frontend API CNAME).
- **Login:** Email + password (social providers require production OAuth apps in Clerk SSO connections).
- **Bridge:** After Clerk sign-in, `/api/portal/me` matches `users.email` in AskToAct (case-insensitive). Users must be provisioned in `/admin` first.

### Railway build-time vars

| Variable | Purpose |
|----------|---------|
| `VITE_CLERK_PUBLISHABLE_KEY` | Baked into portal bundle at Docker build |
| `CLERK_SECRET_KEY` | Server-side Clerk + proxy |
| `CLERK_PUBLISHABLE_KEY` | Server-side `clerkMiddleware` |

`VITE_CLERK_PROXY_URL` is optional; defaults to `/api/__clerk` in production.

### Clerk DNS (email)

Add email CNAME records from Clerk Dashboard → Domains for password reset and verification delivery. Frontend API / Account portal SSL can remain pending when using proxy mode.

## Local dev

```bash
export VITE_CLERK_PUBLISHABLE_KEY="pk_live_..."   # from Clerk Production
./scripts/portal-dev.sh
# Open http://localhost:5173/portal/
```

## Routes

| Path | Description |
|------|-------------|
| `/portal/` | Landing (signed-out) or redirect to dashboard |
| `/portal/sign-in`, `/portal/sign-up` | Clerk auth |
| `/portal/dashboard` | User home, connector URL when enrolled |
| `/portal/team-usage` | Firm admins only |
| `/portal/support` | Support form |

## Related docs

- Portal identity bridge: `.agents/memory/portal-identity-bridge.md`
- Root deploy: `/README.md`
