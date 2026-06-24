---
name: Drizzle raw timestamp serialization
description: How to format JS Date values when writing to a Drizzle `timestamp` (no tz) column via raw sql/VALUES, so reads stay consistent.
---

# Drizzle raw-SQL timestamp format for `timestamp` (without time zone)

When bulk-writing to a Drizzle `timestamp("col")` column with raw `sql`` / a `VALUES` join
(instead of `db.update().set({ col: dateObj })`), serialize the Date the same way Drizzle does:

```
date.toISOString().replace("T", " ").replace("Z", "") + "::timestamp"
```

e.g. `2026-06-24T20:00:00.000Z` → `2026-06-24 20:00:00.000` cast `::timestamp`.

**Why:** the column is `timestamp without time zone`. Drizzle's own writer stores the UTC
wall-clock string (drops the zone). If you instead pass an ISO string with `Z` and cast
`::timestamptz`, Postgres converts via session TZ and the value drifts vs. how Drizzle
*reads* it back (it reads the stored wall-clock as a Date), so comparisons like
`expiresAt < now` can be hours off.

**How to apply:** any time you hand-roll a multi-row UPDATE (distinct per-row values that a
single `.set()` can't express — e.g. per-user enroll tokens), build a parameterized
`VALUES (...)` join with `sql.join`, and format any timestamp literal as above. Keep values
in `sql`` placeholders (never string-concat) so they stay injection-safe.
