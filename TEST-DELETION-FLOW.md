# QRAST — Real-Device Test Plan: Student Deletion / Re-enroll Flow

Covers the Registrar-request → Administrator-decision flow for deleting a freshly enrolled student, including the notification fix in `6ec9291` (decision notifications addressed by Supabase UUID) and the Sent-history label fix that followed. None of this has been run against a live backend — that's what this plan is for.

Work through it in order; later parts reuse state from earlier ones. Report plainly what actually happened at each step, including anything that didn't match.

You'll need: one Registrar account (e.g. Denis, Computing), one Administrator account, and access to the Supabase SQL editor.

---

## Part 0 — Deployment prerequisites

1. In Supabase SQL editor, confirm the table exists:
   `select count(*) from account_deletion_requests;` (should return 0 or more, not an error). If it errors, run `migrate-account-deletion-requests.sql` first.
2. Confirm the Edge Function is deployed: Supabase dashboard → Edge Functions → `delete-user` is listed and recent. If not: `supabase functions deploy delete-user`.
3. Confirm the deployed app is the latest build: the service worker cache should be `qrast-v14`. (DevTools → Application → Cache Storage, after a hard reload.)

## Part 1 — Set up test students

4. As the Registrar, enroll **three** throwaway students in the Registrar's own faculty, e.g. `Test Delete A`, `B`, `C`. Give each a real email you can identify. Confirm they appear in Register.
5. Enroll one more throwaway student, `Test Blocked`, then give it a record (enroll it in a course, or have it check in to a session) so it has at least one enrollment or attendance row.
6. Note each student's university ID.

## Part 2 — Eligibility display

7. As the Registrar, open `Test Blocked` in Register. The Delete section should say "Not available — this student already has …" and list the real count. No request form.
8. Open `Test Delete A`. It should show the reason box and **Request Deletion**.
9. As a Lecturer, open Register. Confirm there is no delete section anywhere (read-only).

## Part 3 — Registrar request

10. As the Registrar, tap **Request Deletion** on `A` with an empty reason. Expect a "reason is required" message and no row created.
11. Enter a reason (e.g. "wrong email") and submit. Expect the toast "Request sent to the Administrator" and the section to switch to "Waiting for the Administrator's approval" with your reason.
12. In SQL: `select id, target_university_id, status, requested_by_supabase_id, requested_by_name from account_deletion_requests order by id desc limit 5;`
    Expect one `pending` row for `A`, with `requested_by_supabase_id` equal to the Registrar's `users.id` (compare: `select id from users where university_id = '<registrar id>';`).
13. Reload the app and reopen `A`. The "Waiting" state should persist.
14. Try requesting deletion of `A` again (second tab, or after reload if the button is somehow available). Expect "already pending" — and still only one pending row.
15. Request deletion of `Test Blocked` if the UI lets you, or call the function directly. Expect a 409 refusal naming the blocker.

## Part 4 — Cross-faculty and role guards

16. Log in as a Registrar from a **different faculty**. Confirm `A` is not visible in their Register, and the pending-requests list at the top does not show A's request.
17. As a Registrar, try to open a Lecturer or Registrar account. No deletion option should exist (students only).
18. (Optional, needs devtools) Call the `delete-user` function as the other-faculty Registrar with `action: 'request'` for `A`. Expect a 403 "own faculty" error.

## Part 5 — Administrator sees the request

19. Log in as the Administrator. Confirm Register shows a pending-deletion row for `A` at the top.
20. Check Notifications: an "Account deletion requested" notification with the reason should be there.
21. Open `A`. It should show "Deletion requested", the Registrar's name, the reason, and **Reject** / **Review & delete**.

## Part 6 — Reject path (uses A)

22. Tap **Reject**. Expect the toast "Request rejected".
23. SQL: the row is `rejected`, with `decided_by_name` and `decided_at` filled in. `A` still exists in `users` and can still log in.
24. Check **Sent** in the Administrator's notifications: the "Deletion request rejected" entry should show the recipient as **Registrar** — not a long UUID. (This is the label fix.)
25. Log in as the Registrar. Notifications should contain "Deletion request rejected … The Administrator rejected deleting Test Delete A". (This is the `6ec9291` fix — if it's missing, the recipient id or RLS on `notifications` is the first place to look.)
26. As the Registrar, reopen `A`. It should offer **Request Deletion** again, since the old request is no longer pending. Confirm a fresh request can be created (a new `pending` row; the rejected one is kept).

## Part 7 — Approve path (uses A's new request)

27. As the Administrator, open `A` → **Review & delete**. Confirm the red "Permanent — please confirm" caution appears. Tap **Cancel** and confirm nothing was deleted.
28. Tap **Review & delete** → **Delete permanently**. Expect the toast "Test Delete A deleted" and a return to Register, where `A` is gone.
29. SQL: `select * from users where university_id = '<A id>';` returns nothing. In Authentication → Users, the login is gone too. The request row is `approved`, and the target name/ID columns are still filled in.
30. As the Registrar, check Notifications: "Deletion approved … You can now enroll them again."
31. As the Registrar, enroll the same student again with the corrected email. Expect success — the university ID and email are free to reuse.
32. Confirm the re-enrolled student can log in with the temporary password.

## Part 8 — Administrator direct delete (uses B)

33. As the Administrator, open `B`. There should be a **Delete Account…** button and no request form.
34. Delete it via the caution screen. Expect it to disappear from Register and from `users` and Auth.
35. The audit log should have an "Account deleted" entry.
36. No request row is created for a direct delete, and the Registrar receives no "approved" notification (there was no request).

## Part 9 — Race and safety checks

37. Have `C` request deletion as the Registrar. Before the Administrator decides, enroll `C` in a course (or give it a record). Then, as the Administrator, try **Delete permanently**. Expect a refusal ("now has … Suspend the account instead") and **no deletion**. Confirm `C` still exists in both `users` and Auth.
38. After that refusal, the request should still be `pending` (not silently approved). Reject it to clean up.
39. As the Administrator, open two tabs on the same pending request. Approve in one, then try to reject in the other. Expect "already approved/rejected" and no change to the finished row.

## Part 10 — Cleanup

40. Delete any remaining test students (`C`, `Test Blocked`) and confirm nothing is left in Auth. Leave the `account_deletion_requests` rows; they're the audit trail.

---

## What to report back

- Each step's result, with any that differed from the expected outcome.
- The output of the SQL checks in steps 12, 23 and 29.
- For any failure, the toast text and any browser console error.
- Specifically call out steps 24, 25 and 30. They're the ones this build changed.
