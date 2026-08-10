#!/bin/sh
set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"

tool() {
  temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" "$@"
}

tool --db temporal create
tool --db temporal setup-schema -v 0.0
tool --db temporal update-schema -d /etc/temporal/schema/postgresql/v12/temporal/versioned
tool --db temporal_visibility create
tool --db temporal_visibility setup-schema -v 0.0
tool --db temporal_visibility update-schema -d /etc/temporal/schema/postgresql/v12/visibility/versioned
