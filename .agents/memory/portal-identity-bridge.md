---
name: Portal Clerk→AskToAct identity bridge
description: How portal (Clerk) sessions map to AskToAct users and the tenant-binding safety rule
---

# Portal Clerk → AskToAct identity bridge

Portal users sign in via Clerk; they are matched to a local `users` row by **email**
(they are provisioned by an admin before first sign-in, so there is no stored Clerk
user id to key on).

## Rule: match case-insensitively AND fail closed on duplicates
- `users.email` is **NOT unique** in the schema, and provisioning stores email with
  raw casing while Clerk emails are lowercased. So the bridge must compare with
  `lower(users.email) = <lowercased clerk email>`, not a plain `eq`.
- The bridge fetches up to 2 matches. If more than one row matches, it **refuses to
  bind** (HTTP 409) instead of picking an arbitrary row.

**Why:** picking `.limit(1)` from a non-unique email could bind a signed-in user to a
*different firm's* user row, leaking that firm's data through firm-scoped portal
endpoints (e.g. team-usage). Fail-closed is the safe default until email uniqueness
is enforced at the schema level.

**How to apply:** any future portal endpoint that trusts `req.portalUser.firmId` for
tenant scoping inherits this guarantee. If you later add a unique/normalized email
column, you can relax the duplicate check — but never scope by a client-supplied
firmId; always use the server-resolved `req.portalUser.firmId`.
