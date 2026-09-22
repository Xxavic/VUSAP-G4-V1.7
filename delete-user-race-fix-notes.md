# `delete-user` — Sept 2026 race-condition fix notes

Two concurrent calls into this function, both targeting the same student or
the same deletion request, used to be able to corrupt data. Neither needed
anything exotic to trigger — two admin tabs, a double-tap on a slow network,
or an approve racing a direct delete were all enough. Fixed by making the
two check-then-act sequences below atomic. Kept here (instead of only in
code comments) because the failure modes aren't obvious from reading either
version of the code in isolation — you have to interleave two calls in your
head to see them.

Related: [`TEST-DELETION-FLOW.md`](TEST-DELETION-FLOW.md) Part 9 (steps
37–39) exercises the eligibility race and the two-tabs-on-one-request race
at a black-box level. This doc explains *why* those steps used to be able
to fail before the fix, for whoever next touches this file.

---

## 1. Ghost profile row with no auth login

**Old shape of `performDelete`:**

```js
const { data: snapshot } = await admin.from("users").select("*").eq("id", target.id).single();
const { error: profileErr } = await admin.from("users").delete().eq("id", target.id);
if (profileErr) return `Could not delete profile: ${profileErr.message}`;
const { error: authErr } = await admin.auth.admin.deleteUser(target.id);
if (authErr) {
  if (snapshot) await admin.from("users").insert(snapshot);
  return `Could not delete login: ${authErr.message}`;
}
```

A plain `.delete().eq(...)` with no `.select()` returns `error: null` even
when it matched **zero rows**. The code trusted that null to mean "I just
deleted this row" — it doesn't; it only means "the DELETE statement didn't
error."

**The interleaving that broke it** — two calls (e.g. two admins each
tapping "Review & delete → Delete permanently" on the same student, or an
Administrator's direct delete racing an Approve of a pending request for
that same student) both reach `performDelete` for the same `target.id`:

1. Call A: `SELECT` snapshot — gets the row.
2. Call B: `SELECT` snapshot — also gets the row (A hasn't deleted yet).
3. Call A: `DELETE` — removes the row. `profileErr` is null. Proceeds to
   `auth.admin.deleteUser` — succeeds. Student is now fully gone.
4. Call B: `DELETE` — matches **zero rows** (A already removed it), but
   `profileErr` is still null, so B believes its own delete succeeded.
5. Call B: `auth.admin.deleteUser(target.id)` — fails, because A already
   deleted that auth user.
6. Call B's failure branch fires: `if (snapshot) await admin.from("users").insert(snapshot)`.
   B's snapshot was captured in step 2, *before* A's delete — so B
   re-inserts a full profile row for a student whose auth login no longer
   exists anywhere.

End state: a `users` row that looks like a normal student (shows up in
Register, in faculty rosters, in attendance dropdowns) but has no matching
Supabase Auth account, so the student can never log in again and nobody
can tell why just by looking at the row. The one call that "failed" (B)
is the one that leaves the mess; the one that actually did the deleting
(A) returns cleanly, so there's no error in either admin's UI pointing at
the problem.

**Fix:** `performDelete` now does `DELETE ... .select()` (Postgres
`DELETE ... RETURNING`) and checks `deletedRows.length`. Only the call
that actually removed a row gets a non-empty result and takes the snapshot
from *that* result — never from an earlier, possibly-stale `SELECT`. A
call whose `DELETE` matched nothing (because another call already did the
job) now short-circuits to a clean no-op success instead of falling into
the reinsert branch at all.

---

## 2. Deletion request status disagreeing with what actually happened

**Old shape of the `decide` branch:** read the request, check
`status === "pending"`, then — several `await`s later, after `loadTarget`,
`blockersFor`, and `performDelete` have all run — write the final status
(`approved` or `rejected`) unconditionally by id. The pending check and the
status write were two separate round-trips with real work in between, not
one atomic operation.

**The interleaving that broke it** — two `decide` calls for the *same
request id* land close together (two admin tabs open on the same pending
request; a slow first click retried as a second click):

1. Call A (Approve) and Call B (Reject) both `SELECT` the request —
   both see `status: "pending"` — both pass the check.
2. Call A carries on: `loadTarget` → `blockersFor` → `performDelete` —
   the student really is deleted.
3. Call B, in parallel, hits its `reject` branch and unconditionally
   `UPDATE`s the row to `status: "rejected"`.
4. Call A finishes and unconditionally `UPDATE`s the same row to
   `status: "approved"`.

Whichever `UPDATE` lands last wins, with no relationship to which branch
actually ran first or which one actually deleted anyone. Two outcomes were
both reachable:

- Final row reads **`rejected`**, but the student's profile and login are
  actually gone (A's delete went through, B's write landed last) — the
  Registrar sees "request rejected" and has no idea the student they
  asked about no longer exists.
- Final row reads **`approved`**, but nothing was deleted (B's reject
  wrote first, then A's approve overwrote the status to `approved` even
  though — in a variant of this race — A's own `performDelete` could
  independently hit blockers or an auth error and fail after the status
  was already staged to flip).

Either way, `account_deletion_requests` — the audit trail this whole
feature exists to keep honest — stops being trustworthy, silently.

**Fix:** the pending → decided transition is now one atomic conditional
`UPDATE ... WHERE id = ? AND status = 'pending'` with `.select()`. Postgres
only lets one of two concurrent callers match that `WHERE` clause; the
loser gets zero rows back and is told the true current status via a
fresh read, without having changed anything. The winner carries the
already-claimed row (`status` already flipped to `approved`/`rejected`)
into the rest of the function. As a second layer, if anything *after* the
claim fails on the approve path (target invalid, new blockers appeared,
the actual delete errors), the code now explicitly puts the request back
to `pending` rather than leaving it stuck on `approved` with nothing
actually deleted.

---

## Why both fixes were needed together

Fixing only #2 (the request-status race) would still leave #1 reachable
any time two deletion paths hit the same student without going through
`decide` at all — e.g. a direct Administrator delete racing an approve of
a separately-pending request for that same student. `performDelete` is
the shared bottleneck both `decide` and `delete` call through, so it had
to be correct on its own regardless of what serializes calls above it.
