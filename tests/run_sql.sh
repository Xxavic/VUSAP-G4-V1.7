#!/usr/bin/env bash
# Runs the database-side checks against a THROWAWAY Postgres (never the live project).
# Needs psql and PGHOST/PGPORT/PGUSER/PGDATABASE (or defaults) pointing at a scratch server.
set -euo pipefail
cd "$(dirname "$0")/.."
psql -q -v ON_ERROR_STOP=1 \
  -f tests/sql/stub-schema.sql \
  -f migrate-server-side-checkin.sql \
  -f migrate-backup-pin-expiry.sql \
  -f migrate-backup-pin-expiry.sql \
  -f tests/sql/test_backup_pin_expiry.sql
