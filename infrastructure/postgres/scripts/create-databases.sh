#!/bin/sh
# Creates one database per atom in the shared Postgres instance, plus the
# extensions each atom's schema needs at db:push time. Runs as a one-shot
# Compose service before the atoms start (mirrors temporal-schema). Idempotent:
# safe to re-run on an existing volume.
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"

# "<database>:<space-separated extensions>". uuid-ossp backs the
# uuid_generate_v4() column defaults most atom schemas declare; btree_gist backs
# the appointment slot-claim exclusion constraint. auth uses core
# gen_random_uuid() and resident needs no extension.
databases="
townops_auth:
townops_alert:uuid-ossp
townops_appointment:uuid-ossp btree_gist
townops_assignment:uuid-ossp
townops_case:uuid-ossp
townops_metrics:uuid-ossp
townops_proof:uuid-ossp
townops_resident:
townops_contractor:uuid-ossp
"

run() {
  psql -v ON_ERROR_STOP=1 -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$@"
}

echo "$databases" | while IFS=: read -r db exts; do
  [ -z "$db" ] && continue

  if [ "$(run -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'")" != "1" ]; then
    echo "creating database $db"
    run -d postgres -c "CREATE DATABASE $db"
  else
    echo "database $db already exists"
  fi

  for ext in $exts; do
    echo "  ensuring extension $ext in $db"
    run -d "$db" -c "CREATE EXTENSION IF NOT EXISTS \"$ext\""
  done
done
