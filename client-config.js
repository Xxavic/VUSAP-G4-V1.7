// QRAST — per-client configuration.
//
// This is the ONLY file that should differ between client deployments.
// Everything else (app.js, index.html, sw.js, the SQL migrations) is the
// shared template. See MULTI-CLIENT-PACKAGING.md for the per-client runbook.
//
// The Supabase anon key is a public, browser-safe key by design (RLS is what
// protects the data), so it is fine for it to live here. Never put the
// service role key, the Resend key, or any other secret in this file.
window.QRAST_CLIENT = {
  // Supabase project for THIS client (each institution owns its own).
  supabaseUrl:  'https://eumhlccvaembpqxcuaqf.supabase.co',
  supabaseAnon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV1bWhsY2N2YWVtYnBxeGN1YXFmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg5NTA5ODEsImV4cCI6MjA5NDUyNjk4MX0.spQS7jBkRWLjOZamVAaEPDXkqQHCzWIaqBbldd_-B0E',

  // Domain used to build the synthetic login email for ID-based accounts:
  // <universityId>@<authEmailDomain>. Must match the AUTH_EMAIL_DOMAIN secret
  // on the create-user, email-login and request-password-reset Edge Functions.
  // Stays 'vusap.internal' until the @qrast.internal data migration is done
  // (see migrate-auth-emails-README.md) -- changing it alone breaks logins.
  authEmailDomain: 'vusap.internal',

  // University ID format: <idPrefix>-<programme code>-<regIntakeCode>-<nnnn>-<DAY|EVE>
  idPrefix:       'VU',
  regIntakeCode:  '2601',

  // true = ship the built-in Victoria demo seed (fictional students, staff,
  // courses, timetable) and fall back to it when the database is empty.
  // false = a real client: every list starts empty and shows only database rows.
  demoData: true,
};
