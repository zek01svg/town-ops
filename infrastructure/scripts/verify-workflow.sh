#!/usr/bin/env bash
# TownOps synthetic Workflow verification (PRS-140 Phase 8).
#
# Drives one real request the whole way through the deployment:
#
#   browser-equivalent curl -> Gateway (public Cloud Run)
#     -> auth atom (IAM-private, via the Gateway's /api/auth/* proxy)
#     -> Temporal on the private VM (only the Gateway subnet may reach 7233)
#       -> Worker Pool (polling that same Temporal)
#         -> resident + case atoms (IAM-private, ID-token authenticated)
#
# Nothing here is mocked or stubbed: a PASS means every one of those hops is
# really working, including the ID-token minting and the per-atom IAM
# bindings. The Case it opens is left in place as evidence; re-running creates
# another one under a fresh account.
#
# R2 is NOT on this path. Reaching a proof_items row requires a CONTRACTOR
# account with an accepted assignment, and `role`/`contractorId` are
# `input: false` in the auth schema precisely so nothing can self-elect them --
# there is no public API a script could use to get there. R2 is proven
# directly instead, against the production S3 client, by
# apps/atoms/proof/scripts/smoke-r2.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TF_DIR="$REPO_ROOT/infrastructure/terraform"

# The Gateway waits up to GATEWAY_UPDATE_TIMEOUT_MS (20s) on the Workflow
# Update, and resident provisioning is a second Workflow that has to finish
# first, so the first POST legitimately answers 409 for a few seconds.
PROVISION_ATTEMPTS=20
PROVISION_SLEEP=3

RESULTS=()
FAILCOUNT=0

record() { # status check detail
  local status="$1" check="$2" detail="$3"
  RESULTS+=("$status|$check|$detail")
  printf '%-6s %-26s %s\n' "$status" "$check" "$detail"
  [[ "$status" == "FAIL" ]] && FAILCOUNT=$((FAILCOUNT + 1))
  return 0
}

summary() {
  echo
  echo "--- verify-workflow summary ---"
  printf '%s\n' "${RESULTS[@]}" | tr '|' '\t'
  if [[ "$FAILCOUNT" -gt 0 ]]; then
    echo "FAILED: $FAILCOUNT check(s)"
    exit 1
  fi
  echo "OK: all checks passed"
  exit 0
}

GATEWAY_URL="$(terraform -chdir="$TF_DIR" output -raw gateway_url 2>/dev/null || true)"
if [[ -z "$GATEWAY_URL" ]]; then
  record FAIL "gateway-url" "terraform output gateway_url is empty -- has stage 3 been applied?"
  summary
fi
record PASS "gateway-url" "$GATEWAY_URL"

# Every request below carries an Origin, because a browser always does and
# Better Auth refuses a state-changing request without one
# (MISSING_OR_NULL_ORIGIN). Sending a real frontend's origin also exercises
# AUTH_TRUSTED_ORIGINS end to end -- the Gateway forwards the header verbatim
# to the auth atom, whose baked-in list is localhost only.
BROWSER_ORIGIN="$(
  terraform -chdir="$TF_DIR" output -json frontend_urls 2>/dev/null |
    sed -n 's/.*\["\([^"]*\)".*/\1/p'
)"
if [[ -z "$BROWSER_ORIGIN" ]]; then
  record FAIL "browser-origin" "terraform output frontend_urls is empty -- has pass 2 run?"
  summary
fi
record PASS "browser-origin" "$BROWSER_ORIGIN"

COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

EMAIL="smoke-$(date +%s)-$RANDOM@townops.invalid"
PASSWORD="SmokeVerification123!"

# --- 1. sign up through the Gateway's auth proxy ------------------------------
# Proves Gateway -> auth atom, which is the ID-token path: the auth atom is
# IAM-private and a Gateway without a valid minted token gets 403 here.
signup_body="$(
  printf '{"name":"Smoke Verifier","email":"%s","password":"%s"}' \
    "$EMAIL" "$PASSWORD"
)"
signup_code="$(
  curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIE_JAR" \
    -X POST "$GATEWAY_URL/api/auth/sign-up/email" \
    -H 'Content-Type: application/json' \
    -H "Origin: $BROWSER_ORIGIN" \
    --data "$signup_body" || echo 000
)"
if [[ "$signup_code" != "200" && "$signup_code" != "201" ]]; then
  record FAIL "auth-signup" "POST /api/auth/sign-up/email -> $signup_code"
  summary
fi
record PASS "auth-signup" "created $EMAIL (http $signup_code)"

# The control for the check above: an origin nobody deployed must be refused,
# or "the frontend's origin was accepted" would prove nothing about the
# trusted-origins list.
untrusted_code="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$GATEWAY_URL/api/auth/sign-up/email" \
    -H 'Content-Type: application/json' \
    -H 'Origin: https://not-a-townops-frontend.invalid' \
    --data "$signup_body" || echo 000
)"
if [[ "$untrusted_code" == "403" ]]; then
  record PASS "auth-untrusted-origin" "an unknown Origin is refused (403)"
else
  record FAIL "auth-untrusted-origin" "an unknown Origin got $untrusted_code, expected 403"
fi

# --- 2. exchange the session for the EdDSA JWT the Gateway verifies -----------
# Proves the auth atom's jwt plugin is live and that the Gateway can read its
# JWKS from a private atom (jwk({ keys: ... }) with a minted ID token).
token_response="$(
  curl -sS -b "$COOKIE_JAR" -H "Origin: $BROWSER_ORIGIN" \
    "$GATEWAY_URL/api/auth/token" || true
)"
JWT="$(printf '%s' "$token_response" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [[ -z "$JWT" ]]; then
  record FAIL "auth-token" "no token in GET /api/auth/token response"
  summary
fi
record PASS "auth-token" "issued a JWT (${#JWT} chars)"

# --- 3. open a Case -----------------------------------------------------------
# The first POST is expected to be 409 RESIDENT_PROFILE_PROVISIONING: the
# Gateway kicks off a provisioning Workflow and asks the caller to retry. That
# 409 is itself proof the Gateway reached Temporal -- it cannot start that
# Workflow otherwise.
# The Gateway requires a real UUID here (`z.uuid()` checks the version nibble,
# so `openssl rand -hex 16` will not do) and a missing one comes back as a 400
# that reads like a wiring bug. Git Bash on Windows ships no `uuidgen`, hence
# the fallbacks.
IDEMPOTENCY_KEY="$(
  uuidgen 2>/dev/null ||
    python -c 'import uuid;print(uuid.uuid4())' 2>/dev/null ||
    powershell -NoProfile -Command "[guid]::NewGuid().ToString()" 2>/dev/null |
    tr -d '\r'
)"
if [[ ! "$IDEMPOTENCY_KEY" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4 ]]; then
  record FAIL "idempotency-key" "no UUID generator available (tried uuidgen, python, powershell)"
  summary
fi
case_body='{"category":"PL","priority":"MEDIUM","description":"PRS-140 deployment verification","postalCode":"560123"}'

body_file="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$body_file"' EXIT

open_case() {
  curl -sS -o "$body_file" -w '%{http_code}' \
    -X POST "$GATEWAY_URL/api/cases" \
    -H "Authorization: Bearer $JWT" \
    -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
    -H "Origin: $BROWSER_ORIGIN" \
    -H 'Content-Type: application/json' \
    --data "$case_body" || echo 000
}

code=""
saw_provisioning=false
for _ in $(seq "$PROVISION_ATTEMPTS"); do
  code="$(open_case)"
  [[ "$code" == "201" ]] && break
  if [[ "$code" == "409" ]] && grep -q RESIDENT_PROFILE_PROVISIONING "$body_file"; then
    saw_provisioning=true
    sleep "$PROVISION_SLEEP"
    continue
  fi
  # Any other status is terminal -- retrying a 503 or 500 just hides it.
  break
done

if [[ "$saw_provisioning" == true ]]; then
  record PASS "resident-provisioning" "Gateway started the provisioning Workflow (409 then retried)"
fi

if [[ "$code" != "201" ]]; then
  record FAIL "open-case" "POST /api/cases -> $code: $(head -c 400 "$body_file")"
  summary
fi

CASE_ID="$(sed -n 's/.*"caseId":"\([0-9a-f-]*\)".*/\1/p' "$body_file" | head -1)"
if [[ -z "$CASE_ID" ]]; then
  record FAIL "open-case" "201 but no caseId in response: $(head -c 400 "$body_file")"
  summary
fi
record PASS "open-case" "CaseWorkflow committed case $CASE_ID"

# --- 4. read it back ----------------------------------------------------------
# A separate Gateway -> case atom round trip, so a Case that only ever existed
# in the Workflow's reply cannot pass.
read_code="$(
  curl -sS -o "$body_file" -w '%{http_code}' \
    -H "Authorization: Bearer $JWT" \
    "$GATEWAY_URL/api/cases/$CASE_ID" || echo 000
)"
if [[ "$read_code" != "200" ]]; then
  record FAIL "read-case" "GET /api/cases/$CASE_ID -> $read_code"
else
  record PASS "read-case" "case atom returned the persisted Case"
fi

# --- 5. CORS -------------------------------------------------------------------
# Everything above runs on curl, which ignores CORS entirely -- so a Gateway
# with the wrong GATEWAY_ALLOWED_ORIGINS passes every check so far and still
# fails for every real browser. This is the one browser-layer assertion the
# script can make, and it is exactly what pass 2 of the apply wires up.
preflight_allow_origin() { # origin
  curl -sS -i -X OPTIONS "$GATEWAY_URL/api/me" \
    -H "Origin: $1" \
    -H 'Access-Control-Request-Method: GET' \
    -H 'Access-Control-Request-Headers: authorization' 2>/dev/null |
    grep -ci '^access-control-allow-origin:' || true
}

if [[ "$(preflight_allow_origin "$BROWSER_ORIGIN")" != "0" ]]; then
  record PASS "cors-frontend-allowed" "preflight allows $BROWSER_ORIGIN"
else
  record FAIL "cors-frontend-allowed" "preflight sent no allow-origin for $BROWSER_ORIGIN"
fi

# The control: without this, "an origin was allowed" could just mean the
# Gateway allows everything.
if [[ "$(preflight_allow_origin "https://not-a-townops-frontend.invalid")" == "0" ]]; then
  record PASS "cors-unknown-refused" "preflight sends no allow-origin for an unknown origin"
else
  record FAIL "cors-unknown-refused" "preflight allowed an unknown origin"
fi

summary
