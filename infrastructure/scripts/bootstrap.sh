#!/usr/bin/env bash
# TownOps GCP bootstrap (PRS-140 Phase 1).
# Creates the Terraform state bucket, the trial budget, and the 8 Secret
# Manager secrets. Idempotent and re-runnable: anything that already exists
# is reported SKIP, never overwritten. Prints per-step PASS/FAIL/SKIP lines,
# a summary table, and exits non-zero only if any check FAILed.
set -euo pipefail

PROJECT_ID="seraphic-cocoa-505015-s9"
PROJECT_NUMBER="850982781459"
REGION="asia-southeast1"
BILLING_ACCOUNT="0126F6-2E7563-2D49AB"
STATE_BUCKET="townops-tf-state-850982781459"

RESULTS=()
FAILCOUNT=0
MISSING_PASTED_CMDS=()

record() { # status check detail
  local status="$1" check="$2" detail="$3"
  RESULTS+=("$status|$check|$detail")
  printf '%-6s %-24s %s\n' "$status" "$check" "$detail"
  [[ "$status" == "FAIL" ]] && FAILCOUNT=$((FAILCOUNT + 1))
  return 0
}

# --- Section 1: Terraform state bucket ---------------------------------------
# Deliberately gcloud, not Terraform: a module can't use the backend it is
# creating, and it would leave a local state file to keep out of git.
bootstrap_state_bucket() {
  if gcloud storage buckets describe "gs://$STATE_BUCKET" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record SKIP "state-bucket-create" "gs://$STATE_BUCKET already exists"
  else
    if gcloud storage buckets create "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
        --location="$REGION" --uniform-bucket-level-access --public-access-prevention >/dev/null 2>&1; then
      record PASS "state-bucket-create" "created gs://$STATE_BUCKET in $REGION"
    else
      record FAIL "state-bucket-create" "gcloud storage buckets create failed"
      return 0
    fi
  fi

  # Versioning is a separate call (bucket create has no --versioning flag).
  # Re-issuing --versioning on an already-versioned bucket is a no-op, so this
  # is safe to run every time, not just on first create.
  gcloud storage buckets update "gs://$STATE_BUCKET" --project="$PROJECT_ID" --versioning >/dev/null 2>&1 || true

  # `gcloud storage buckets describe` returns its own snake_case field names
  # (uniform_bucket_level_access, public_access_prevention, versioning_enabled)
  # at the top level, not the JSON API's nested iamConfiguration/versioning
  # shape - verified against real output.
  local json ubla pap ver
  json=$(gcloud storage buckets describe "gs://$STATE_BUCKET" --project="$PROJECT_ID" \
    --format="json(uniform_bucket_level_access,public_access_prevention,versioning_enabled)" 2>&1) || json="{}"
  read -r ubla pap ver <<<"$(printf '%s' "$json" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('uniform_bucket_level_access',False),
          d.get('public_access_prevention',''),
          d.get('versioning_enabled',False))
except Exception:
    print(False,'',False)
" 2>/dev/null)" || { ubla=False; pap=""; ver=False; }

  if [[ "$ubla" == "True" ]]; then
    record PASS "state-bucket-ubla" "uniformBucketLevelAccess.enabled=$ubla"
  else
    record FAIL "state-bucket-ubla" "uniformBucketLevelAccess.enabled=$ubla"
  fi
  if [[ "$pap" == "enforced" ]]; then
    record PASS "state-bucket-pap" "publicAccessPrevention=$pap"
  else
    record FAIL "state-bucket-pap" "publicAccessPrevention='$pap'"
  fi
  if [[ "$ver" == "True" ]]; then
    record PASS "state-bucket-versioning" "versioning.enabled=$ver"
  else
    record FAIL "state-bucket-versioning" "versioning.enabled=$ver"
  fi
}

# --- Section 2: Budget ---------------------------------------------------------
# `gcloud billing budgets` resolves its quota project from ambient config, not
# from a project positional/flag, so --billing-project is mandatory here even
# though every other gcloud call in this script uses --project.
bootstrap_budget() {
  local existing
  existing=$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" \
    --billing-project="$PROJECT_ID" --format="value(displayName)" 2>&1) || existing=""

  if grep -qx "townops-trial" <<<"$existing"; then
    record SKIP "budget" "townops-trial already exists"
    return 0
  fi

  # --budget-amount=120 (no currency suffix) uses the billing account's own
  # default currency (SGD here), per `gcloud billing budgets create --help`.
  if gcloud billing budgets create \
      --billing-account="$BILLING_ACCOUNT" \
      --billing-project="$PROJECT_ID" \
      --display-name="townops-trial" \
      --budget-amount=120 \
      --calendar-period=month \
      --filter-projects="projects/$PROJECT_NUMBER" \
      --threshold-rule=percent=0.5,basis=current-spend \
      --threshold-rule=percent=0.9,basis=current-spend \
      --threshold-rule=percent=1.0,basis=current-spend \
      --threshold-rule=percent=1.0,basis=forecasted-spend \
      >/dev/null 2>&1; then
    record PASS "budget" "created townops-trial: 120(account currency)/month, thresholds 50/90/100 actual + 100 forecast, filter=projects/$PROJECT_NUMBER"
  else
    record FAIL "budget" "gcloud billing budgets create failed"
  fi
}

# --- Section 3: Secrets ---------------------------------------------------------

# ponytail: openssl rand -base64 32 always emits exactly one '=' pad char (32
# bytes mod 3 == 2), so the stored length is deterministic at 44 regardless of
# random content: 44 == the expected length asserted below, no arithmetic surprises.
gen_base64_32() { openssl rand -base64 32 | tr -d '\r\n'; }
# ponytail: hex instead of the base64->tr '+/' '-_' dance for the two DB
# passwords. Hex output ([0-9a-f]) is URL-safe by construction with zero
# reserved chars to strip, so there's no off-by-one from stripped '=' padding
# to reason about. Trade-off: 64 stored chars instead of 43-44, doesn't matter
# for a Postgres password.
gen_hex_32() { openssl rand -hex 32 | tr -d '\r\n'; }

create_generated_secret() { # name generator_fn expected_len
  local name="$1" gen_fn="$2" expected="$3" len
  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    # Re-verify on every run, not just on first create - otherwise this check
    # can never FAIL again once all 4 secrets exist, and the Phase 1 verify
    # criterion (exact byte length) silently stops being proven.
    len=$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID" 2>/dev/null | wc -c) || len=-1
    len="${len// /}"
    if [[ "$len" == "$expected" ]]; then
      record SKIP "secret-$name" "already exists, stored length=$len (expected $expected)"
    else
      record FAIL "secret-$name" "already exists, stored length=$len (expected $expected) - trailing newline/CR likely leaked into the secret"
    fi
    return 0
  fi
  if ! "$gen_fn" | gcloud secrets create "$name" --project="$PROJECT_ID" \
      --replication-policy=automatic --data-file=- >/dev/null 2>&1; then
    record FAIL "secret-$name" "gcloud secrets create failed"
    return 0
  fi
  len=$(gcloud secrets versions access latest --secret="$name" --project="$PROJECT_ID" 2>/dev/null | wc -c) || len=-1
  len="${len// /}"
  if [[ "$len" == "$expected" ]]; then
    record PASS "secret-$name" "created, stored length=$len (expected $expected)"
  else
    record FAIL "secret-$name" "created, stored length=$len (expected $expected) - trailing newline/CR likely leaked into the secret"
  fi
}

create_pasted_secret() { # name env_var_name
  local name="$1" var="$2" value="${!2:-}"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    record SKIP "secret-$name" "already exists"
    return 0
  fi
  if [[ -z "$value" ]]; then
    record SKIP "secret-$name" "env $var unset"
    MISSING_PASTED_CMDS+=("printf '%s' \"\$$var\" | gcloud secrets create $name --project=$PROJECT_ID --replication-policy=automatic --data-file=-")
    return 0
  fi
  if printf '%s' "$value" | tr -d '\r\n' | gcloud secrets create "$name" --project="$PROJECT_ID" \
      --replication-policy=automatic --data-file=- >/dev/null 2>&1; then
    record PASS "secret-$name" "created from \$$var"
  else
    record FAIL "secret-$name" "gcloud secrets create failed"
  fi
}

main() {
  echo "== TownOps GCP bootstrap (project=$PROJECT_ID region=$REGION) =="
  echo

  bootstrap_state_bucket
  bootstrap_budget

  create_generated_secret worker-service-token gen_base64_32 44
  create_generated_secret better-auth-secret gen_base64_32 44
  create_generated_secret temporal-db-password gen_hex_32 64
  create_generated_secret atoms-db-password gen_hex_32 64

  create_pasted_secret resend-api-key RESEND_API_KEY
  create_pasted_secret r2-access-key-id R2_ACCESS_KEY_ID
  create_pasted_secret r2-secret-access-key R2_SECRET_ACCESS_KEY
  # No google-maps-api-key here: the Maps key is created by Terraform as
  # google_apikeys_key (Phase 7), restricted to the Maps JavaScript API and
  # the frontend run.app referrers. It is a browser key that ships publicly in
  # window.__env, so it is not a Secret Manager secret at all.

  echo
  echo "== Summary =="
  local r status check detail
  for r in "${RESULTS[@]}"; do
    IFS='|' read -r status check detail <<<"$r"
    printf '%-6s %-24s %s\n' "$status" "$check" "$detail"
  done
  echo
  echo "checks_failed=$FAILCOUNT"

  if [[ "${#MISSING_PASTED_CMDS[@]}" -gt 0 ]]; then
    echo
    echo "== Missing pasted secrets - export the env var and re-run, or run these once the value is available =="
    local cmd
    for cmd in "${MISSING_PASTED_CMDS[@]}"; do
      echo "  $cmd"
    done
  fi

  exit "$FAILCOUNT"
}

main "$@"
