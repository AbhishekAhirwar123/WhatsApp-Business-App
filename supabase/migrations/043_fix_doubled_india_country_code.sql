-- 043_fix_doubled_india_country_code.sql
--
-- Repairs Indian contact numbers saved with the country code twice,
-- e.g. "+91919174824860" (+91 · 91 · 9174824860). Meta rejects these as
-- undeliverable (#131026), so every broadcast to them fails.
--
-- The pattern is unambiguous: an Indian mobile number is exactly
-- 91 + 10 digits starting 6-9, so a 14-digit "9191[6-9]…" number can
-- never be valid. Rows whose repaired number already exists as another
-- contact in the same account are left untouched so the unique index
-- on (account_id, phone_normalized) from migration 022 is never hit;
-- those duplicates can be merged or deleted by hand.

UPDATE contacts AS c
SET phone = '+' || substr(c.phone_normalized, 3),
    updated_at = now()
WHERE c.phone_normalized ~ '^9191[6-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1
    FROM contacts AS d
    WHERE d.account_id = c.account_id
      AND d.phone_normalized = substr(c.phone_normalized, 3)
  );
