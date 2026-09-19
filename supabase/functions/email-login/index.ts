// email-login — lets a person sign in with the real email on their profile.
//
// Why: logins are created as <universityId>@vusap.internal (see create-user)
// and the real email lives only in public.users.email, so typing that email
// into the sign-in box never matched a login. The browser can't look the
// email up itself before signing in (RLS blocks anonymous reads of users),
// and this function deliberately does NOT hand the University ID back — it
// performs the password check itself and returns only a session on success.
//
// It finds every profile with that email (a parent's/shared address could
// match more than one), tries the password against each one's login, and
// returns the first session that works. Wrong password or unknown email both
// give the same generic answer, so it can't be used to discover accounts.
//
// Called signed-out, so keep the default JWT check on (the app sends the
// anon key). Needs no new secrets. Setup: deploy in the dashboard or with
//   supabase functions deploy email-login

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const FAIL = { error: "Invalid login credentials" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { email, password } = await req.json();
    const addr = String(email || "").trim();
    if (!addr || !addr.includes("@") || !password) return json(FAIL);

    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: profiles } = await admin
      .from("users")
      .select("id")
      .ilike("email", addr.replace(/[\\%_]/g, "\\$&"))
      .limit(5);
    if (!profiles?.length) return json(FAIL);

    for (const p of profiles) {
      const { data: authUser } = await admin.auth.admin.getUserById(p.id);
      const loginEmail = authUser?.user?.email;
      if (!loginEmail) continue;

      // Fresh anon-style client per attempt so sessions never bleed together.
      const attempt = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await attempt.auth.signInWithPassword({ email: loginEmail, password });
      if (!error && data?.session) {
        return json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
      }
    }
    return json(FAIL);
  } catch (e) {
    console.error("email-login error:", e);
    return json(FAIL);
  }
});
