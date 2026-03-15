#!/usr/bin/env bash
# seed-profiles.sh — Load all profiles_v2 from Supabase into local postgres

set -euo pipefail

SUPABASE_URL="https://yeuuzvswpmhgeyurkpek.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlldXV6dnN3cG1oZ2V5dXJrcGVrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDUwNTA1MDksImV4cCI6MjA2MDYyNjUwOX0.Aecgzj74O2QTuzAF6oBAVHkBvXGMQBZX7cAYoGaYP8U"
DB_CONTAINER="ethos-intel-pg"
DB_USER="ethos_intel"
DB_NAME="ethos_wallet_intel"
PAGE_SIZE=1000

TOTAL=0
OFFSET=0

echo "[$(date -u +%H:%M:%S)] Starting profile seed..."

while true; do
  RESPONSE=$(curl -s \
    "${SUPABASE_URL}/rest/v1/profiles_v2?select=raw_profile_id,display_name,username,primary_address,status&order=raw_profile_id.asc&limit=${PAGE_SIZE}&offset=${OFFSET}" \
    -H "apikey: ${ANON_KEY}" \
    -H "Authorization: Bearer ${ANON_KEY}")

  COUNT=$(echo "$RESPONSE" | jq 'length')

  if [ "$COUNT" -eq 0 ]; then
    echo "[$(date -u +%H:%M:%S)] No more rows. Done."
    break
  fi

  # Build and run profile upserts via temp file to avoid quoting hell
  TMPFILE=$(mktemp /tmp/seed-sql-XXXX.sql)

  echo "$RESPONSE" | jq -r '
    .[] |
    (.display_name // "" | gsub("'"'"'"; "'"'"''"'"'")) as $dn |
    (.username // "" | gsub("'"'"'"; "'"'"''"'"'")) as $un |
    (.primary_address // "") as $pa |
    (.status // "ACTIVE") as $st |
    .raw_profile_id as $id |
    "INSERT INTO profiles (external_profile_id, display_name, slug, status, primary_address) VALUES (\($id), '"'"'\($dn)'"'"', '"'"'\($un)'"'"', '"'"'\($st)'"'"', NULLIF('"'"'\($pa)'"'"', '"'"''"'"')) ON CONFLICT (external_profile_id) DO UPDATE SET display_name = EXCLUDED.display_name, slug = EXCLUDED.slug, status = EXCLUDED.status, primary_address = EXCLUDED.primary_address, updated_at = now();"
  ' >> "$TMPFILE"

  echo "$RESPONSE" | jq -r '
    .[] | select(.primary_address != null and .primary_address != "") |
    (.primary_address | gsub("'"'"'"; "'"'"''"'"'")) as $pa |
    .raw_profile_id as $id |
    "INSERT INTO wallets (profile_id, address, chain, is_primary, wallet_source) SELECT p.id, '"'"'\($pa)'"'"', '"'"'ethereum'"'"', true, '"'"'supabase_seed'"'"' FROM profiles p WHERE p.external_profile_id = \($id) ON CONFLICT (address, chain) DO NOTHING;"
  ' >> "$TMPFILE"

  docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -q < "$TMPFILE"
  rm -f "$TMPFILE"

  TOTAL=$((TOTAL + COUNT))
  echo "[$(date -u +%H:%M:%S)] Offset ${OFFSET}: +${COUNT} rows (total: ${TOTAL})"
  OFFSET=$((OFFSET + PAGE_SIZE))
  sleep 0.3
done

echo ""
echo "=== Seed complete ==="
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT
  (SELECT count(*) FROM profiles) as profiles,
  (SELECT count(*) FROM wallets)  as wallets;"
