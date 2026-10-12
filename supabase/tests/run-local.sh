#!/usr/bin/env bash
# Apply every migration to a fresh THROWAWAY database (default port 54329,
# database wacrm_test), then run the SQL test files passed as arguments.
# Never point this at a real Supabase project: it DROPs the database.
set -euo pipefail
PSQL="${PSQL:-psql}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DB=wacrm_test
P=( -h localhost -p "${PGPORT_TEST:-54329}" -U postgres -v ON_ERROR_STOP=1 -q -X )

"$PSQL" "${P[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null
"$PSQL" "${P[@]}" -d postgres -c "DO \$\$BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE 'DROP OWNED BY anon, authenticated, service_role, supabase_admin CASCADE'; END IF; END\$\$" >/dev/null 2>&1 || true
"$PSQL" "${P[@]}" -d postgres -c "CREATE DATABASE $DB" >/dev/null
# Roles are cluster-wide: create them only once.
if ! "$PSQL" "${P[@]}" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='anon'" | grep -q 1; then
  "$PSQL" "${P[@]}" -d $DB -f "$HERE/local-supabase-stub.sql" >/dev/null
else
  sed '/^CREATE ROLE/d' "$HERE/local-supabase-stub.sql" > "${TMPDIR:-/tmp}/wacrm_stub_noroles.sql"
  "$PSQL" "${P[@]}" -d $DB -f "${TMPDIR:-/tmp}/wacrm_stub_noroles.sql" >/dev/null
fi

for f in "$REPO"/supabase/migrations/*.sql; do
  name="$(basename "$f")"
  tmp="${TMPDIR:-/tmp}/wacrm_mig.sql"
  # pgvector shim (030/032 only).
  sed -e 's/CREATE EXTENSION IF NOT EXISTS vector;//' \
      -e 's/vector(1536)/real[]/g' \
      -e '/^CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_idx/,/USING hnsw/d' \
      "$f" > "$tmp"
  if ! out=$("$PSQL" "${P[@]}" -d $DB -f "$tmp" 2>&1); then
    echo "FAILED: $name"; echo "$out" | tail -20; exit 1
  fi
done
echo "migrations: ok"
"$PSQL" "${P[@]}" -d $DB -f "$REPO/supabase/ci/verify-schema.sql" >/dev/null && echo "verify-schema: ok"

for t in "$@"; do
  if ! out=$("$PSQL" "${P[@]}" -d $DB -f "$t" 2>&1); then
    echo "TEST FAILED: $(basename "$t")"; echo "$out" | tail -30; exit 1
  fi
  echo "$out" | grep -oE "PASS.*" || true
  echo "test ok: $(basename "$t")"
done
