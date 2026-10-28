# tools/

## Database access check (run these first)

1. `node tools/rls-probe.mjs` — from the repo folder. Asks the database for one row
   per table *without signing in*, like a stranger with the public key. Reads only.
   Any line that says `EXPOSED` is readable by anyone. Needs Node 18+.
2. `tools/rls-audit.sql` — paste into Supabase Dashboard -> SQL Editor and run.
   Read-only. The first result gives each table a verdict (NO RLS, OPEN TO ANYONE,
   OPEN (signed-in) writes/reads, NO POLICIES, scoped). Some "OPEN (signed-in)"
   rows are intentional, e.g. `faculties` is reference data every user may read, and
   `fraud_logs` must accept inserts from a student's own session.

Neither tool takes a password or key: the probe reads the public settings already in
`client-config.js`. Share the *output* (table names and verdicts) when asking for fixes.
