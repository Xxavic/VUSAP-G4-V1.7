-- ============================================================================
-- Make three more administrator settings the same on every device.
--
-- Attendance Rules (minimum %, late grace, QR rotation, session window), the fraud
-- detection thresholds and the notification templates were kept only in the
-- administrator's own browser memory: saving them changed that one browser, and every
-- student, lecturer and registrar kept using the built-in defaults. They now live in
-- three JSON columns on the existing system_settings row (which only an administrator
-- can write, as before). Nothing else changes; a NULL column means "use the defaults".
--
-- Idempotent.
-- ============================================================================
alter table public.system_settings
  add column if not exists attendance_policies    jsonb,
  add column if not exists fraud_thresholds       jsonb,
  add column if not exists notification_templates jsonb;
