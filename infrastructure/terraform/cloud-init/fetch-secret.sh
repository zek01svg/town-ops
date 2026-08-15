#!/bin/sh
# Fetches the Temporal DB password from Secret Manager at boot and writes it
# to a root-only env file that temporal-schema.service and temporal.service
# pass to `docker run --env-file`. Mirrors the
# `docker run --network=host $CLOUD_SDK_IMAGE gcloud secrets versions access`
# idiom infrastructure/scripts/bootstrap-databases.sh already uses to read
# Secret Manager from this VM: gcloud auto-authenticates as the VM's service
# account via the metadata server, no `gcloud auth login` needed.
# --network=host: same reason as bootstrap-databases.sh -- avoids the
# default bridge network's NAT edge cases around the metadata server's
# 169.254.169.254 address.
#
# The password only ever touches a shell variable and this file (mode 600).
# It is never passed as a command argument, echoed, or logged.
set -eu

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${CLOUD_SDK_IMAGE:?CLOUD_SDK_IMAGE is required}"
SECRET_NAME="${SECRET_NAME:-temporal-db-password}"

DB_PASSWORD=$(docker run --rm --network=host "$CLOUD_SDK_IMAGE" \
  gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT_ID")

# Both var names are written: temporal-sql-tool (admin-tools, schema unit)
# reads SQL_PASSWORD; the temporal-server binary reads POSTGRES_PWD.
# Verified locally against the mirrored images -- see Phase 4 report.
install -d -m 700 /etc/temporal/secrets
printf 'SQL_PASSWORD=%s\nPOSTGRES_PWD=%s\n' "$DB_PASSWORD" "$DB_PASSWORD" > /etc/temporal/secrets/db-password.env
chmod 600 /etc/temporal/secrets/db-password.env
