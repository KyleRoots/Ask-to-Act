# AskToAct

AI action layer for recruiting — connects authorized recruiters to Bullhorn ATS from ChatGPT, Claude, Gemini, and other MCP clients.

**Production:** [connect.asktoact.ai](https://connect.asktoact.ai)

## Monorepo layout

| Path | Purpose |
|------|---------|
| `artifacts/api-server` | Express API, MCP endpoint, Bullhorn OAuth, Clerk portal APIs |
| `artifacts/portal` | Customer portal (`/portal`) — Clerk auth, dashboard, team usage |
| `artifacts/admin` | Super-admin SPA (`/admin`) — firms, users, invites |
| `artifacts/exec-summary`, `artifacts/pitch-deck` | Internal GTM pages (Basic Auth in production) |
| `lib/db` | Drizzle schema and migrations |
| `docs/` | Operational runbooks (e.g. support triage) |

## Development

```bash
pnpm install
pnpm run typecheck
pnpm --filter @workspace/api-server test
```

See package-specific READMEs under `artifacts/*/README.md`.

## Deployment

- **Host:** Railway — single Docker image (`Dockerfile`) serves API + built frontends on one origin.
- **Trigger:** Push to `main` → Railway builds and deploys automatically.
- **Migrations:** Run on api-server startup before accepting traffic.

## Agent / support workflow

- **Agent instructions:** [AGENTS.md](./AGENTS.md)
- **Support triage:** [docs/support-triage.md](./docs/support-triage.md)
- **Shipping policy:** commit fixes, push to GitHub, update relevant READMEs in the same change (see `.cursor/rules/github-and-readme.mdc`).

## Key production configuration

| Concern | Where |
|---------|--------|
| Clerk (portal auth) | Railway vars + Clerk Production instance; proxy at `/api/__clerk` |
| Bullhorn OAuth | `BULLHORN_*` env vars on Railway |
| MCP access | Per-user API keys; service token `MCP_BEARER_TOKEN` |
| GTM pages | `GTM_MATERIALS_PASSWORD` on Railway |

Never commit secrets. Use Railway variables and Cursor Secrets for agents.
