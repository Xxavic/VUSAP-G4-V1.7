// create-user — provisions a real login for a newly-enrolled student or a
// newly-created staff account (Lecturer/Registrar/Administrator).
//
// This is the Edge Function that app.js's authProvisionAccount() and
// notify-email/index.ts both already referred to as the planned extension
// point for real account creation ("Live path: supabase.auth.admin requires
// the service-role key (not safe client-side), so we use a Supabase Edge
// Function 'create-user' that runs with service-role privileges").
//
// Why this has to be a server-side function at all: creating a Supabase Auth
// user (auth.admin.createUser) requires the service-role key, which must
// never be shipped to the browser. The browser instead calls this function
// with its own session token; this function re-derives who's calling from
// that token, checks their role itself (never trusts a role/facultyKey the
// client claims), and only then uses the service-role key server-side.
//
// What it does, in order:
//   1. Verify the caller's own session token and look up THEIR role/faculty
//      from public.users (server-side, so this can't be spoofed).
//   2. Reject unless the caller is an administrator, or a registrar acting
//      within their own faculty and only for 'student'/'lecturer' roles
//      (a registrar cannot create another registrar or an administrator).
//   3. Create the real Supabase Auth user (email = the same
//      "<universityId>@vusap.internal" synthetic address app.js's own
//      universityIdToAuthEmail() builds, so login lookups match).
//   4. Insert the matching public.users profile row.
//   5. If step 4 fails, delete the auth user created in step 3 rather than
//      leaving an orphaned login with no profile behind.
//
// Setup:
//   supabase functions deploy create-user
// No new secrets needed — SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// already provided automatically to every Edge Function, same as
// notify-email already relies on.
//
// gender/semester: confirmed live on public.users (checked directly against
// the live schema — a query for either column returns 200, not the 42703
// "column does not exist" error a fake column name produces), so both are
// written below along with the rest of the enroll-student fields.

// npm: specifier, not esm.sh -- see supabase/functions/delete-user/index.ts
// for why (an unpinned esm.sh "@2" build can break the deploy on a bad day).
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function universityIdToAuthEmail(universityId: string) {
  return `${universityId}@vusap.internal`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const callerJwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!callerJwt) return jsonResponse({ error: "Missing Authorization header" }, 401);

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Who is actually calling? Never trust a role the client claims for
    // itself — re-derive it server-side from the caller's own token.
    const { data: callerAuth, error: callerAuthErr } = await supabaseAdmin.auth.getUser(callerJwt);
    if (callerAuthErr || !callerAuth?.user) return jsonResponse({ error: "Invalid or expired session" }, 401);

    const { data: callerProfile, error: callerProfileErr } = await supabaseAdmin
      .from("users")
      .select("role, faculty_key")
      .eq("id", callerAuth.user.id)
      .single();
    if (callerProfileErr || !callerProfile) return jsonResponse({ error: "Caller has no profile" }, 403);
    if (!["administrator", "registrar"].includes(callerProfile.role)) {
      return jsonResponse({ error: "Only an Administrator or Registrar can create accounts" }, 403);
    }

    const { universityId, name, email, role, tempPassword, facultyKey, program, year, mode, gender, semester, isClassCoordinator, coordinatorForProgramme, coordinatorForYear } = await req.json();

    if (!universityId || !name || !role || !tempPassword) {
      return jsonResponse({ error: "universityId, name, role, and tempPassword are required" }, 400);
    }

    if (!["student", "lecturer", "registrar", "administrator"].includes(role)) {
      return jsonResponse({ error: "Unknown role" }, 400);
    }
    if (String(tempPassword).length < 8) {
      return jsonResponse({ error: "tempPassword must be at least 8 characters" }, 400);
    }

    // A registrar can only create student/lecturer accounts, and only
    // within their own faculty — mirrors can_write_faculty()'s intent
    // (administrator: unrestricted; registrar: own faculty only). An omitted
    // facultyKey is pinned to the registrar's own faculty rather than left
    // null, which would create an account outside every registrar's scope.
    let effectiveFacultyKey = facultyKey || null;
    if (callerProfile.role === "registrar") {
      if (!["student", "lecturer"].includes(role)) {
        return jsonResponse({ error: "Registrars can only create Student or Lecturer accounts" }, 403);
      }
      if (facultyKey && facultyKey !== callerProfile.faculty_key) {
        return jsonResponse({ error: "You can only create accounts in your own faculty" }, 403);
      }
      effectiveFacultyKey = callerProfile.faculty_key;
    }

    const authEmail = universityIdToAuthEmail(universityId);

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: authEmail,
      password: tempPassword,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return jsonResponse({ error: createErr?.message || "Auth account creation failed" }, 400);
    }

    const newUserId = created.user.id;

    const { error: profileErr } = await supabaseAdmin.from("users").insert({
      id: newUserId,
      university_id: universityId,
      name,
      role,
      email: email || authEmail,
      faculty_key: effectiveFacultyKey,
      program: program || null,
      year: year || null,
      mode: mode || null,
      gender: gender || null,
      semester: semester || null,
      must_change_password: true,
      consent_at: null,
      is_class_coordinator: !!isClassCoordinator,
      coordinator_for_programme: coordinatorForProgramme || null,
      coordinator_for_year: coordinatorForYear || null,
    });

    if (profileErr) {
      // Don't leave a login with no profile behind it.
      await supabaseAdmin.auth.admin.deleteUser(newUserId);
      if (profileErr.code === "23505" && /email/.test(profileErr.message)) {
        return jsonResponse({ error: "That email is already used by another account. Each person needs their own email." }, 409);
      }
      return jsonResponse({ error: `Profile insert failed, auth account rolled back: ${profileErr.message}` }, 400);
    }

    return jsonResponse({ id: newUserId });
  } catch (e) {
    console.error("create-user error:", e);
    return jsonResponse({ error: String(e) }, 500);
  }
});
