---
name: Bullhorn address/country writes
description: How to write a location's country on Bullhorn entities — it's a numeric countryID inside the address composite, not a name/code.
---

# Bullhorn address / country writes

Bullhorn stores a location's country as a numeric **`countryID`** (a reference into Bullhorn's country list), NOT as `countryName` or `countryCode`. On writes, `address` is a **composite object** (`address1, address2, city, state, zip, countryID`), not flat dotted fields.

**Two failure modes this caused (both on OUR side, not a Bullhorn limit):**
- The MCP write value schema only accepted scalars + `{id}` association refs, so a nested `address` object was rejected before reaching Bullhorn.
- Flat keys like `address.countryName` / `address.countryCode` are not real JobOrder fields → `validateWriteFields` rejected them as invalid.

**How it's handled now:** the write value schema also accepts a composite object (record of scalars). A country given by name (`countryName`/`country`/`countryCode`) is resolved to its numeric `countryID` via the `options/Country` endpoint (memoized per firm), and the text aliases are stripped before write (they're read-only/derived). Resolution is wired into the central `createEntityRecord`/`updateEntityRecord` choke points, so every address-bearing create/update gets it.

**Why:** Bullhorn rejects name/code on write and requires the numeric id; a name→id lookup is the only reliable path. Country list is firm-wide and stable → safe to cache per firm.

**How to apply:** to set/change a location country from the AI, pass `{ address: { countryName: "Egypt" } }` (or a numeric `address.countryID`). Don't invent `address.countryName`/`address.countryCode` as top-level fields.
