---
name: React role guard pattern
description: Correct pattern for gating UI on an async-loaded role — wrong pattern exposes content to unauthenticated users.
---

**Rule:** Never gate protected content on `!notAdmin` where `notAdmin = me && me.role !== "admin"`. This is falsy when `me` is `undefined` (query still loading or failed with 403), which exposes the content to non-provisioned users.

**Why:** `undefined && ...` evaluates to `undefined` (falsy), so `!notAdmin` = `!undefined` = `true` — the protected section renders for everyone until me resolves. In the portal, a non-provisioned user's `/api/portal/me` call fails with 403, meaning `me` stays `undefined` forever, and the content remains exposed indefinitely.

**Correct pattern:**
```tsx
const { data: me, isLoading: meLoading } = useQuery({ queryKey: ["portal-me"], queryFn: portalApi.me });
const isAdmin = me?.role === "admin";  // false when me is undefined

// Three explicit branches:
{meLoading && <LoadingBlock />}
{!meLoading && !isAdmin && <AccessDeniedBlock />}
{!meLoading && isAdmin && <ProtectedContent />}
```

**How to apply:**
- Any page that checks `me.role` for access control must use `isAdmin = me?.role === "admin"` (not `me && me.role !== ...`).
- Always handle three states: loading / denied / content — never collapse loading + denied into one implicit falsy check.
- Also disable queries that depend on admin role: `enabled: isAdmin` (not `!!me && me.role === "admin"` is fine, but `isAdmin` is cleaner).
- The `useQuery` `error` state (network failure, 403) leaves `data` as `undefined`, so `isAdmin` stays `false` — access denied renders correctly.
