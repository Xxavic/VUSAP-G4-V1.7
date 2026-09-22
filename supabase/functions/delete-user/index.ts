// delete-user — deletes a freshly enrolled student who has no records yet, so
// they can be re-enrolled. Registrars can only REQUEST this; an Administrator
// approves (or deletes directly). Nothing here trusts the browser: the
// caller's role/faculty is re-derived from their own token, and "has no
// records" is re-checked server-side at the moment of deletion.
//
// One function, several actions (body.action):
//   status  — { universityId } -> { eligible, blockers, pending }
//             Registrar (own faculty) or Administrator. Read-only; drives the UI.
//   request — { universityId, reason } -> { request }
//             Registrar (own faculty) only. Creates a pending request.
//   decide  — { requestId, decision: 'approve'|'reject', note? } -> { ok }
//             Administrator only. Approve re-checks eligibility, then deletes.
//   delete  — { universityId } -> { ok }
//             Administrator only. Direct delete (no prior request needed).
//
// "No records" = no enrollments, attendance, or support tickets tied to the
// student. Anything else (e.g. they've been scanned into a class) is a
// suspend, not a delete — history must not be silently destroyed.
//
// Setup:
//   1. Run migrate-account-deletion-requests.sql
//   2. supabase functions deploy delete-user
// (or paste this file into a new function in the dashboard's Edge Functions)
// No new secrets — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are automatic.

// npm: specifier, not esm.sh -- esm.sh's unpinned "@2" tag re-resolves to
// whatever 2.x build is current on every deploy, and that build's own
// bundling for Deno sometimes breaks (e.g. Sept 2026: 2.117.0's auth-js
// sub-dependency failed to bundle for the denonext target). npm: goes
// straight through Deno's own npm compat layer, sidestepping esm.sh
// entirely, so a bad esm.sh build day can't block a deploy.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const callerJwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!callerJwt) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: callerAuth, error: callerAuthErr } = await admin.auth.getUser(callerJwt);
    if (callerAuthErr || !callerAuth?.user) return json({ error: "Invalid or expired session" }, 401);

    const { data: caller } = await admin
      .from("users")
      .select("id, name, role, faculty_key, university_id")
      .eq("id", callerAuth.user.id)
      .single();
    if (!caller || !["administrator", "registrar"].includes(caller.role)) {
      return json({ error: "Only an Administrator or Registrar can do this" }, 403);
    }
    const isAdmin = caller.role === "administrator";

    const body = await req.json();
    const action = body.action;

    // Loads the target student and enforces "students only, and a registrar
    // only within their own faculty".
    async function loadTarget(universityId: string) {
      if (!universityId) return { error: json({ error: "universityId is required" }, 400) };
      const { data: target } = await admin
        .from("users")
        .select("id, name, role, faculty_key, university_id")
        .eq("university_id", universityId)
        .maybeSingle();
      if (!target) return { error: json({ error: "Account not found" }, 404) };
      if (target.role !== "student") return { error: json({ error: "Only student accounts can be deleted this way" }, 403) };
      if (!isAdmin && target.faculty_key !== caller.faculty_key) {
        return { error: json({ error: "You can only manage accounts in your own faculty" }, 403) };
      }
      return { target };
    }

    async function blockersFor(studentId: string) {
      const count = async (table: string, col: string) => {
        const { count, error } = await admin.from(table).select("*", { count: "exact", head: true }).eq(col, studentId);
        if (error) throw new Error(`Could not check ${table}: ${error.message}`);
        return count || 0;
      };
      const [enrollments, attendance, tickets] = await Promise.all([
        count("enrollments", "student_id"),
        count("attendance", "student_id"),
        count("support_tickets", "reporter_supabase_id"),
      ]);
      const blockers: string[] = [];
      if (enrollments) blockers.push(`${enrollments} course enrollment(s)`);
      if (attendance) blockers.push(`${attendance} attendance record(s)`);
      if (tickets) blockers.push(`${tickets} support ticket(s)`);
      return blockers;
    }

    async function pendingFor(universityId: string) {
      const { data } = await admin
        .from("account_deletion_requests")
        .select("*")
        .eq("target_university_id", universityId)
        .eq("status", "pending")
        .maybeSingle();
      return data || null;
    }

    // Deletes the profile row, then the auth login. If the auth delete fails
    // the profile is put back, so we never leave a login with no profile.
    //
    // Sept 2026 race fix: this used to SELECT a snapshot, then DELETE, and
    // trust `profileErr` (which stays null even when the DELETE matched zero
    // rows) to mean "I actually deleted this". Under a genuine race -- two
    // concurrent calls targeting the same student, e.g. two approve clicks,
    // or an approve racing a direct delete -- the second call's SELECT could
    // capture a row that was about to vanish, its own DELETE would silently
    // no-op, and it would then fail trying to delete an auth user the first
    // call already removed -- triggering the reinsert below and resurrecting
    // a profile row with no matching auth login (a ghost account). Using
    // DELETE ... RETURNING (`.delete().select()`) tells this call, for
    // certain, whether IT was the one that removed the row.
    async function performDelete(target: { id: string }) {
      const { data: deletedRows, error: profileErr } = await admin
        .from("users").delete().eq("id", target.id).select();
      if (profileErr) return `Could not delete profile: ${profileErr.message}`;
      if (!deletedRows || deletedRows.length === 0) {
        // Nothing to delete -- a concurrent call for the same student
        // already finished the job. The end state we want (no profile row)
        // already holds, so treat this as a no-op success rather than
        // chasing an already-gone auth user.
        return null;
      }
      const snapshot = deletedRows[0];
      const { error: authErr } = await admin.auth.admin.deleteUser(target.id);
      if (authErr) {
        await admin.from("users").insert(snapshot);
        return `Could not delete login: ${authErr.message}`;
      }
      return null;
    }

    if (action === "status") {
      const { target, error } = await loadTarget(body.universityId);
      if (error) return error;
      const blockers = await blockersFor(target!.id);
      return json({ eligible: blockers.length === 0, blockers, pending: await pendingFor(target!.university_id) });
    }

    if (action === "request") {
      if (isAdmin) return json({ error: "Administrators delete directly — no request needed" }, 400);
      const reason = String(body.reason || "").trim();
      if (!reason) return json({ error: "A reason is required" }, 400);
      const { target, error } = await loadTarget(body.universityId);
      if (error) return error;
      const blockers = await blockersFor(target!.id);
      if (blockers.length) return json({ error: `Can't delete — this student has ${blockers.join(", ")}. Suspend the account instead.` }, 409);

      const { data: created, error: insertErr } = await admin.from("account_deletion_requests").insert({
        target_university_id: target!.university_id,
        target_name: target!.name,
        faculty_key: target!.faculty_key,
        reason,
        requested_by_supabase_id: caller.id,
        requested_by_id: caller.university_id,
        requested_by_name: caller.name,
      }).select().single();
      if (insertErr) {
        const dup = insertErr.code === "23505";
        return json({ error: dup ? "A deletion request for this student is already pending" : insertErr.message }, dup ? 409 : 400);
      }
      return json({ request: created });
    }

    if (action === "decide" || action === "delete") {
      if (!isAdmin) return json({ error: "Only an Administrator can approve or perform deletions" }, 403);

      let universityId = body.universityId;
      let requestRow: any = null;

      // Sept 2026 race fix: decide's pending -> decided transition is now a
      // single atomic conditional UPDATE (`.eq('status', 'pending')` on the
      // WRITE, not just an earlier read) instead of "read status, then write
      // unconditionally later". That old shape let two concurrent decide
      // calls on the same request (two tabs, a double click, two admins)
      // both pass the pending check before either wrote, then both proceed
      // -- see delete-user-race-fix-notes.md for the two concrete ways that
      // corrupted data. Now only one caller can ever win the conditional
      // update; everyone else gets zero rows back and a clean "already
      // decided" error, atomically, with no window between check and act.
      if (action === "decide") {
        if (body.decision !== "approve" && body.decision !== "reject") {
          return json({ error: "decision must be 'approve' or 'reject'" }, 400);
        }
        const claimStatus = body.decision === "approve" ? "approved" : "rejected";
        const { data: claimed, error: claimErr } = await admin
          .from("account_deletion_requests")
          .update({
            status: claimStatus,
            decided_by_name: caller.name,
            decision_note: body.note || null,
            decided_at: new Date().toISOString(),
          })
          .eq("id", body.requestId)
          .eq("status", "pending") // <-- the atomic guard: only a still-pending row can be claimed
          .select()
          .maybeSingle();
        if (claimErr) return json({ error: claimErr.message }, 500);
        if (!claimed) {
          // Zero rows means either the request doesn't exist, or someone
          // else already claimed it in the window between this admin
          // loading the screen and tapping the button -- re-fetch just to
          // give an accurate message, not to decide anything (that already
          // happened, atomically, in the update above).
          const { data: current } = await admin.from("account_deletion_requests").select("status").eq("id", body.requestId).maybeSingle();
          if (!current) return json({ error: "Request not found" }, 404);
          return json({ error: `This request was already ${current.status}` }, 409);
        }

        if (body.decision === "reject") {
          // Rejecting needs no deletion and nothing to revert -- the claim
          // above already wrote the final state.
          return json({ ok: true, request: claimed });
        }

        requestRow = claimed; // decision === 'approve' -- carries on below into the shared delete path
        universityId = claimed.target_university_id;
      }

      const { target, error } = await loadTarget(universityId);
      if (error) {
        // We already claimed this request as 'approved' above -- if the
        // target turns out to be invalid, put the request back to pending
        // rather than leaving it stuck 'approved' with nothing actually
        // deleted.
        if (requestRow) await admin.from("account_deletion_requests").update({ status: "pending" }).eq("id", requestRow.id);
        return error;
      }
      const blockers = await blockersFor(target!.id);
      if (blockers.length) {
        if (requestRow) await admin.from("account_deletion_requests").update({ status: "pending" }).eq("id", requestRow.id);
        return json({ error: `Can't delete — this student now has ${blockers.join(", ")}. Suspend the account instead.` }, 409);
      }

      const failure = await performDelete(target!);
      if (failure) {
        if (requestRow) await admin.from("account_deletion_requests").update({ status: "pending" }).eq("id", requestRow.id);
        return json({ error: failure }, 500);
      }

      return json({ ok: true, request: requestRow || null });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("delete-user error:", e);
    return json({ error: String(e) }, 500);
  }
});
