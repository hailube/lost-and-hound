# Lost & Hound — Production Database Errors: Diagnosis & Fix Summary

**Date:** 2026-06-15
**Status:** Investigated, fixed, verified, and pushed to GitHub. **Not yet deployed** — holding for team review.
**Branches involved:** `fix/listings-fk-and-locations-embed` (main fix), `Shamar--Leaderboard-game-work` (proctor follow-up)

---

## TL;DR

Two database errors were appearing in production. Both are now fixed in code on a branch, verified against the real database, and pushed to GitHub — **but nothing has been deployed.** There are **no required database changes** to stop the errors; deploying the fixed backend is enough. One **optional** database change makes the fix permanent. The live app still runs the old code, so the errors continue until we deploy.

---

## The two errors

```
1. [GET /api/listings]
   Could not embed because more than one relationship was found
   for 'listings' and 'locations'

2. [POST /api/listings/cleanup]
   update or delete on table "listings" violates foreign key constraint
   "conversations_listing_id_fkey" on table "conversations"
```

---

## Error 1 — "more than one relationship" (the listings feed)

**Plain-English meaning:** When the app asks the database for listings *plus* their location, the database now sees **two different ways** a listing connects to a location, and refuses to guess which one we mean.

**Root cause:** The **Proctor Dashboard / desk drop-off feature** (commit `f051768` on the `Shamar--Leaderboard-game-work` branch) added a new column, `desk_location_id`, which is a **second foreign key** from `listings` to `locations`. The database now has two links:

| Foreign key | Column | Meaning |
|---|---|---|
| `listings_location_id_fkey` | `location_id` | where an item was **found** |
| `listings_desk_location_id_fkey` | `desk_location_id` | the **proctor desk** holding it |

Our queries asked for `locations(...)` without naming *which* link → ambiguous → rejected.

**Why it hit production specifically:** the `desk_location_id` foreign key was added to the **production database**, but the desk-feature **code is not in `main` yet**. So production runs main's old queries (which don't name the relationship) against a database that suddenly has two links. That mismatch is what surfaced the error live. *(This is the key lesson — see Next Steps #5.)*

**The fix:** name the relationship in every query → `locations!location_id(...)`. `location_id` is the *found* location, which is what every one of these views displays. (Verified against the proctor UI, which gets the desk name through a separate call, not this embed.)

---

## Error 2 — foreign-key violation on cleanup (deleting listings)

**Plain-English meaning:** When the app tries to delete a listing, the database blocks it because a **conversation still points at that listing**, and the database isn't configured to clean that up automatically.

**Root cause:** `conversations.listing_id` references `listings` with **"no action on delete"** (confirmed via database introspection: `confdeltype = 'a'`). So any listing that has a conversation cannot be deleted. **Four** code paths delete listings and all were vulnerable — we only *saw* the cleanup one because it runs automatically:

1. Account deletion
2. Moderator delete
3. **Listing cleanup** (the one in the logs)
4. Report resolution (ban + remove post)

**Note:** this error is **unrelated** to the leaderboard branch — it is a pre-existing schema gap.

**The fix:** a shared helper, `deleteListingsWithDependents()`, deletes the dependent conversations (and their messages / hidden-conversation rows) *first*, then the listings. All four delete paths now go through it.

---

## What was changed

### Branch `fix/listings-fk-and-locations-embed` (the main fix)

- **`backend/server.js`**
  - New helper `deleteListingsWithDependents()`
  - All 4 listing-delete paths routed through it
  - All 3 `locations` embeds pinned to `locations!location_id(...)`
- **`backend/migrations/fix_listing_fk_and_locations_embed.sql`** — read-only introspection queries (with our confirmed results documented) plus an optional permanent DB-level fix (STEP 2)
- **`scripts/check-location-embeds.sh`** + **`.github/workflows/embed-guard.yml`** — a CI guard that **fails any pull request** containing a bare `locations(...)` embed, so this class of error cannot silently return
- **`.gitattributes`** — keeps the shell script LF (cross-platform)
- Commits: `d5ca7b3`, `df53ed5`, `06fa36a`, `d69cf02`

### Branch `Shamar--Leaderboard-game-work` (proctor follow-up)

- **`backend/server.js`** — the 2 new proctor queries pinned to `locations!location_id(...)` (commit `8c22a31`)
- **Still has 3 bare embeds** shared with `main`. These are fixed on the fix branch; the CI guard will catch them at merge time if they aren't resolved.

### Verification already done

- Ran read-only queries against the **production database**, confirming both root causes (two distinct foreign keys to `locations`; the conversations→listings FK is "no action").
- Tested the CI guard both ways (passes when clean, fails on a bare embed).
- *Note:* a local `node` syntax check could not be run (Node isn't installed on the dev machine); changes were verified by code review.

---

## Next steps (for the team)

1. **Review the fix branch** `fix/listings-fk-and-locations-embed`.
2. **Deploy to stop the errors:** trigger the GitHub Actions "Deploy Lost & Hound" workflow from the fix branch → target `railway` → environment `production`. *(Deploying the backend is all that's required; no DB change is mandatory.)*
3. **Optional but recommended — permanent DB fix:** run **STEP 2** of the migration file in Supabase (`ON DELETE SET NULL`) so the database auto-handles conversation cleanup. Then even future code that forgets the helper cannot trigger Error 2.
4. **Merge order matters:** merge the **fix branch into `main` first** so the embed guard lands in main. After that, the leaderboard branch's pull request is auto-checked, and its 3 remaining bare embeds must be fixed to pass.
5. **Process fix (prevents a repeat of Error 1):** never apply a database schema change (such as a new foreign key) to production **ahead of** the code that handles it. Ship schema and code together, ideally validated in a staging environment first.

---

## Current status

Investigated, fixed, verified, and pushed — **awaiting team review before any deploy.** The live app is still running the old code, so the errors continue until the deploy step (Next Steps #2) is done.
