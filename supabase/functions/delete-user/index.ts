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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    async function performDelete(target: { id: string }) {
      const { data: snapshot } = await admin.from("users").select("*").eq("id", target.id).single();
      const { error: profileErr } = await admin.from("users").delete().eq("id", target.id);
      if (profileErr) return `Could not delete profile: ${profileErr.message}`;
      const { error: authErr } = await admin.auth.admin.deleteUser(target.id);
      if (authErr) {
        if (snapshot) await admin.from("users").insert(snapshot);
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
      if (action === "decide") {
        const { data } = await admin.from("account_deletion_requests").select("*").eq("id", body.requestId).maybeSingle();
        if (!data) return json({ error: "Request not found" }, 404);
        if (data.status !== "pending") return json({ error: `This request was already ${data.status}` }, 409);
        requestRow = data;
        universityId = data.target_university_id;

        if (body.decision === "reject") {
          await admin.from("account_deletion_requests").update({
            status: "rejected", decided_by_name: caller.name,
            decision_note: body.note || null, decided_at: new Date().toISOString(),
          }).eq("id", requestRow.id);
          return json({ ok: true, request: { ...requestRow, status: "rejected" } });
        }
        if (body.decision !== "approve") return json({ error: "decision must be 'approve' or 'reject'" }, 400);
      }

      const { target, error } = await loadTarget(universityId);
      if (error) return error;
      const blockers = await blockersFor(target!.id);
      if (blockers.length) return json({ error: `Can't delete — this student now has ${blockers.join(", ")}. Suspend the account instead.` }, 409);

      const failure = await performDelete(target!);
      if (failure) return json({ error: failure }, 500);

      if (requestRow) {
        await admin.from("account_deletion_requests").update({
          status: "approved", decided_by_name: caller.name,
          decision_note: body.note || null, decided_at: new Date().toISOString(),
        }).eq("id", requestRow.id);
      }
      return json({ ok: true, request: requestRow ? { ...requestRow, status: "approved" } : null });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("delete-user error:", e);
    return json({ error: String(e) }, 500);
  }
});
