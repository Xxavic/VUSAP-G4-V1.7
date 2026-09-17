// notify-email — sends an email for a VUSAP in-app notification.
//
// Called fire-and-forget from app.js's liveSendEmailNotification() (inside
// pushNotification()) whenever recipientRole is 'registrar' or
// 'administrator' — the two roles that expect email, not just the in-app
// bell, per the "Notifications" gap in VUSAP-vs-MakBAMS-comparison.md.
//
// DECISION NEEDED before this does anything: this scaffold assumes Resend
// (resend.com) — a simple API, a generous free tier, and no SMTP setup.
// If a different provider is preferred (SendGrid, Postmark, an existing
// institutional SMTP relay), the only part that needs to change is the
// fetch() call near the bottom; everything else (recipient lookup, the
// app.js call site, the safe no-op-until-configured behavior) stays the same.
//
// Setup (once a provider is confirmed):
//   1. Create a Resend account and API key: https://resend.com
//   2. supabase secrets set RESEND_API_KEY=re_xxxxxxxx
//   3. supabase secrets set NOTIFY_FROM_EMAIL="VUSAP <notify@yourdomain>"
//      (a domain must be verified in Resend before sending from it — until
//      then, Resend's own onboarding@resend.dev sender works for testing)
//   4. supabase functions deploy notify-email
//
// Deploying this WITHOUT setting RESEND_API_KEY is safe — it just returns
// {skipped:true} and app.js already treats that as a normal no-op, same as
// every other live-write function in this codebase when its backend isn't
// configured yet.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Confirmed live (Sept 2026): every call from app.js's liveSendEmailNotification()
// failed with "Response to preflight request doesn't pass access control
// check" — this function never handled the browser's CORS preflight
// (an OPTIONS request) at all, and never sent Access-Control-Allow-* headers
// on any response either. supabase-js's functions.invoke() always sends a
// real browser fetch() with a JSON content-type, which triggers a preflight
// for any cross-origin caller (xxavic.github.io calling *.supabase.co) —
// there's no way around needing these headers for a function called from a
// web page, regardless of what the function itself does. Same fix Supabase's
// own docs use: answer OPTIONS immediately, and attach the same headers to
// every other response so the actual POST's response passes CORS too.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const { recipientRole, recipientId, title, body } = await req.json();

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const FROM = Deno.env.get("NOTIFY_FROM_EMAIL") || "VUSAP <onboarding@resend.dev>";

    if (!RESEND_API_KEY) {
      return new Response(
        JSON.stringify({ skipped: true, reason: "RESEND_API_KEY not set — see setup notes at the top of this file" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Service-role client — this function runs server-side, so it can read
    // the users table directly regardless of RLS (the same trust boundary
    // authProvisionAccount()'s planned create-user Edge Function in app.js
    // already assumes for admin-only operations).
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let query = supabase.from("users").select("email").eq("role", recipientRole);
    if (recipientId) query = query.eq("id", recipientId); // null recipientId = every user with this role, matching pushNotification()'s own convention
    const { data: recipients, error } = await query;

    if (error || !recipients || recipients.length === 0) {
      return new Response(
        JSON.stringify({ sent: 0, error: error?.message || "no matching recipient email(s)" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // fetch() only rejects on a network-level failure — a Resend rejection
    // (e.g. the sandbox-mode "you can only send to your own verified
    // address" 403 you get with no custom domain verified yet) resolves
    // normally with an ok:false response, so it must be checked explicitly
    // per recipient. Confirmed live (Sept 2026): reporting sendResults.length
    // as "sent" regardless of each response's actual status made a rejected
    // send look successful from the caller's side.
    const sendResults = await Promise.all(
      recipients.filter((r) => r.email).map(async (r) => {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM,
            to: r.email,
            subject: title,
            text: body,
          }),
        });
        const ok = res.ok;
        let detail = null;
        if(!ok){
          try { detail = await res.json(); } catch(_e) { detail = await res.text(); }
        }
        return { email: r.email, ok, status: res.status, error: ok ? undefined : detail };
      }),
    );

    const sent = sendResults.filter((r) => r.ok).length;
    const failed = sendResults.filter((r) => !r.ok);

    return new Response(
      JSON.stringify({ sent, failed: failed.length, results: sendResults }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    // Never let an email failure surface as an app-breaking error — the
    // caller (liveSendEmailNotification in app.js) already only logs a
    // console.warn either way.
    console.error("notify-email error:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 200, headers: corsHeaders });
  }
});
