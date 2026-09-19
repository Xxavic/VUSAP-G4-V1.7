// request-password-reset — emails a password-reset link to a person's REAL
// email address.
//
// Why this exists: accounts are created with a synthetic login address
// (<universityId>@vusap.internal — see create-user), and the real email the
// Registrar typed is stored only in public.users.email. The browser's
// supabase.auth.resetPasswordForEmail() therefore mailed the synthetic
// address, which goes nowhere, so "Forgot password" never worked for anyone.
//
// This function takes whatever the person typed (their real email OR their
// University ID), finds the profile server-side, asks Supabase Auth to
// generate a recovery link for the matching login, and emails that link to
// users.email via Resend (same RESEND_API_KEY / NOTIFY_FROM_EMAIL secrets as
// notify-email). The link lands back in the app's existing recovery flow.
//
// Always answers {ok:true} whether or not anything matched, so it can't be
// used to discover which emails/IDs have accounts. Failures are only logged.
//
// Called by signed-out users, so it must be deployed with the default JWT
// check (the app sends the public anon key, which passes it).
//
// Setup: supabase functions deploy request-password-reset
// (or paste into a new function in the dashboard). Needs the existing secrets.
// Caveat: until a sending domain is verified in Resend, Resend only delivers
// to the Resend account owner's own address (same limit as notify-email).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ok = () =>
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { identifier, redirectTo } = await req.json();
    const id = String(identifier || "").trim();
    if (!id) return ok();

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const column = id.includes("@") ? "email" : "university_id";
    const { data: profile } = await admin
      .from("users")
      .select("id, name, email")
      .eq(column, id)
      .limit(1)
      .maybeSingle();
    if (!profile) return ok();

    if (!profile.email || profile.email.endsWith("@vusap.internal")) {
      console.warn(`request-password-reset: ${profile.id} has no real email on file`);
      return ok();
    }

    const { data: authUser, error: authUserErr } = await admin.auth.admin.getUserById(profile.id);
    if (authUserErr || !authUser?.user?.email) return ok();

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: authUser.user.email,
      options: redirectTo ? { redirectTo } : undefined,
    });
    if (linkErr || !link?.properties?.action_link) {
      console.error("request-password-reset generateLink failed:", linkErr);
      return ok();
    }

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM = Deno.env.get("NOTIFY_FROM_EMAIL") || "QRAST <onboarding@resend.dev>";
    if (!RESEND_API_KEY) {
      console.warn("request-password-reset: RESEND_API_KEY not set — no email sent");
      return ok();
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: profile.email,
        subject: "Reset your QRAST password",
        text:
          `Hello ${profile.name},\n\n` +
          `Use this link to set a new password. It expires shortly and can only be used once:\n\n` +
          `${link.properties.action_link}\n\n` +
          `If you didn't ask for this, you can ignore this email.`,
      }),
    });
    if (!res.ok) console.error("request-password-reset Resend rejected:", res.status, await res.text());

    return ok();
  } catch (e) {
    console.error("request-password-reset error:", e);
    return ok();
  }
});
