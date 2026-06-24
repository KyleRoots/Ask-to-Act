---
name: api-server test harness
description: How automated tests are written for artifacts/api-server routes/middleware.
---
artifacts/api-server uses **vitest + supertest** (`pnpm --filter @workspace/api-server test`).

**Decision:** route/access-boundary tests run as INTEGRATION tests against the real
Postgres DB (DATABASE_URL is present in the env), seeding and cleaning their own
namespaced fixtures (e.g. `test-task28-*`) in beforeAll/afterAll.
**Why:** the route handlers build drizzle query chains directly; mocking `@workspace/db`
chain-by-chain is brittle, and a real DB exercises the actual SQL/scoping.
**How to apply:** prefix fixture ids/emails so cleanup (delete by id/firm prefix) is safe;
delete tool_usage → users → firms to respect FKs; require MCP_BEARER_TOKEN for service-token routes.

**Clerk:** mock `@clerk/express` with `vi.mock` + a `vi.hoisted` mutable `{userId,email}`
state. Stub `clerkMiddleware` as passthrough, `getAuth` to return the userId, and
`clerkClient.users.getUser` to return the email. Set the state per test to act as
signed-out / recruiter / admin without a real Clerk session.

**Config:** vitest.config.ts runs serially (fileParallelism:false, pool forks,
maxWorkers/minWorkers 1) because tests share the live DB.
