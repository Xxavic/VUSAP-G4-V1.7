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

// Database-backed brute-force limit (see migrate-rate-limits.sql): 5 attempts
// per email per 15 min without a success, and 30 per IP per 15 min. A
// successful login clears that email's counter. Fails OPEN if the limiter
// itself errors (e.g. migration not run yet) so a limiter fault can't lock
// everyone out — it only logs.
const WINDOW_SECONDS = 15 * 60;
async function withinLimit(admin: ReturnType<typeof createClient>, key: string, max: number) {
  const { data, error } = await admin.rpc("rate_limit_hit", { p_key: key, p_max: max, p_window_seconds: WINDOW_SECONDS });
  if (error) {
    console.warn("email-login: rate limiter unavailable, allowing:", error.message);
    return true;
  }
  return data !== false;
}

function clientIp(req: Request) {
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { email, password } = await req.json();
    const addr = String(email || "").trim();
    if (!addr || !addr.includes("@") || !password) return json(FAIL);

    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const throttleKey = `login:${addr.toLowerCase()}`;
    if (!(await withinLimit(admin, throttleKey, 5))) return json(FAIL, 429);
    const ip = clientIp(req);
    if (ip && !(await withinLimit(admin, `login-ip:${ip}`, 30))) return json(FAIL, 429);

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
        await admin.rpc("rate_limit_reset", { p_key: throttleKey });
        return json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
      }
    }
    return json(FAIL);
  } catch (e) {
    console.error("email-login error:", e);
    return json(FAIL);
  }
});
